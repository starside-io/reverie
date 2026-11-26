import type { EventEmitter } from "node:events";

import { activate, domain, storage, type ModuleApi } from "@reverie/core";
import type {
  DeliveryResult,
  HostPorts,
  ListenedEventName,
  ModelsPort,
  ModuleConfig,
  Silo,
} from "@reverie/core";

import { openHostDb, resolveHostDbPath, type HostDb } from "./host-db.js";
import { HostStore, createPorts } from "./ports/index.js";

/**
 * The mini-host itself: one process, two SQLite files, one module.
 *
 * It owns the silo and is its only writer. Everything the module can reach
 * goes through the ports built here, so the standalone app and a host kernel
 * differ in what is behind the ports and in nothing else. Lifted from
 * Fellowship's host.ts.
 */

export interface MiniHost {
  api: ModuleApi;
  ports: HostPorts;
  silo: Silo;
  host: HostDb;
  store: HostStore;
  /** In-process listeners: every event the module emits, after it commits. */
  emitter: EventEmitter;
  config(): ModuleConfig;
  /**
   * Hands a listened event (docs/SPEC.md section 18) to the module, in this
   * process. It is recorded in the feed first, then delivered. There is no
   * cross-process delivery: a separately running Fellowship cannot reach
   * this, which section 12 leaves open.
   */
  publish(name: ListenedEventName, payload: Record<string, unknown>): Promise<DeliveryResult>;
  siloPath: string;
  hostPath: string;
  close(): Promise<void>;
}

export interface MiniHostOptions {
  /** The silo. Defaults to the platform path, or REVERIE_DB_PATH. */
  dbPath?: string;
  /** host.db. Defaults to beside the silo, or REVERIE_HOST_DB_PATH. */
  hostDbPath?: string;
  env?: NodeJS.ProcessEnv;
  /** An embedding model. Absent by default: recall runs on FTS alone. */
  models?: ModelsPort;
  /** False runs without the transcripts connector. On by default. */
  transcripts?: boolean;
}

export async function startMiniHost(options: MiniHostOptions = {}): Promise<MiniHost> {
  const env = options.env ?? process.env;
  const siloPath = options.dbPath ?? storage.resolveDbPath(env);
  const hostPath = options.hostDbPath ?? resolveHostDbPath(env);

  // A file that is not there yet, or is behind, is brought up to date before
  // it is opened: an assistant driving this over stdio has no other way to run
  // a migration, and refusing to start would make "no UI at all" a lie.
  const migration = storage.migrateSilo(siloPath);
  if (migration.changed.length > 0) {
    process.stderr.write(
      `Warning: ${migration.changed.join(", ")} changed since it was applied to ${siloPath}.\n`,
    );
  }

  // openSilo asserts the pragmas and refuses a file where foreign keys are off.
  const silo = await storage.openSilo({ path: siloPath });
  let host: HostDb;
  try {
    // The starting sections and shelves, on a silo that has none yet. A
    // shelf the owner merged away is never brought back.
    await domain.shelving.seedLibrary(silo);
    host = openHostDb(hostPath);
  } catch (error) {
    await silo.$disconnect();
    throw error;
  }
  const store = new HostStore(host);

  const { ports, emitter, readConfig } = createPorts({
    silo,
    store,
    ...(options.models ? { models: options.models } : {}),
    ...(options.transcripts === false ? { transcripts: false } : {}),
  });
  const api = activate(ports);

  return {
    api,
    ports,
    silo,
    host,
    store,
    emitter,
    config: readConfig,
    publish: async (name, payload) => {
      store.recordEvent(name, payload);
      return api.deliver(name, payload);
    },
    siloPath,
    hostPath,
    close: async () => {
      host.close();
      await silo.$disconnect();
    },
  };
}
