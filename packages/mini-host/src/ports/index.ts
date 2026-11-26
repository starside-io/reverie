import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { createMarkdownConnector } from "@reverie/adapter-markdown";
import { createTranscriptsConnector } from "@reverie/connector-transcripts";
import { config as coreConfig, storage, tools as coreTools } from "@reverie/core";
import type {
  AuditPort,
  BusPort,
  ConnectorsPort,
  HostPorts,
  LocalPathsPort,
  ModelsPort,
  ModuleConfig,
  ModuleEventName,
  PrivacyPort,
  QueuedProposal,
  RefResolution,
  RefsPort,
  ReviewPort,
  SettingsPort,
  SettingsValuesPort,
  Silo,
  StoragePort,
} from "@reverie/core";

import { createHostModels, resolveEmbedder, type EmbedderSettings } from "../models/index.js";
import { createEmbeddingHook, injectedEmbedder, type EmbeddingHook } from "./embedding-hook.js";
import { HostStore, type ProposalRow } from "./host-store.js";

export * from "./embedding-hook.js";
export * from "./host-store.js";

const SETTINGS_KEY = "module.config";

export interface PortsOptions {
  silo: Silo;
  store: HostStore;
  /** In-process listeners for the bus. The feed reads host.db instead. */
  emitter?: EventEmitter;
  /**
   * An embedding model, handed in by whoever starts the host (tests). It
   * computes whatever model config names. Without one the host offers its
   * own models port (models/index.ts): the built-in lexical embedder, or a
   * local endpoint on loopback, chosen by embedding.model. Off by default
   * either way: with embedding.model null nothing is computed and recall runs
   * on FTS alone and says so.
   */
  models?: ModelsPort;
  /** Where the host's own endpoint embedders look, and how long they wait. */
  embedders?: EmbedderSettings;
  /**
   * The transcripts connector (docs/SPEC.md section 12), on by default.
   * False leaves the connectors port out, so extraction from a finished
   * session hands over its notes alone and says so.
   */
  transcripts?: boolean;
  /**
   * The silo's own path. With it, the storage port takes the backup every
   * import asks for (docs/SPEC.md section 25), into a backups folder beside
   * the silo. Without it, imports run with no backup and say so.
   */
  siloPath?: string;
}

/** Where the backup before an import goes: beside the silo, named by the time to the millisecond. */
export function importBackupPath(siloPath: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(dirname(siloPath), "backups", `reverie-before-import-${stamp}.db`);
}

export interface MiniHostPorts {
  ports: HostPorts;
  emitter: EventEmitter;
  /** Reads the stored config without going through the port. */
  readConfig(): ModuleConfig;
  /** The re-embed hook: settings changes, resume after a restart, and status. */
  embedding: EmbeddingHook;
}

/**
 * Every port the module can reach, over one silo and one host.db. Lifted
 * from Fellowship's ports/index.ts, minus media, and with Reverie's own
 * transcripts connector behind the connectors port.
 *
 * The two that carry a rule rather than a lookup:
 *
 * settings.set re-embeds every memory before a change to embedding.model
 * or dim counts as applied (docs/SPEC.md section 17, the re-embed hook; see
 * embedding-hook.ts for how it tracks progress and resumes). Embedding is a
 * cache of body and model, so saving a new model without the re-embed leaves
 * every vector silently stale. A model this host has nothing to compute with
 * is refused rather than stored as if it applied.
 *
 * privacy.redact is the identity function and stays that way, as in
 * Fellowship: a redactor that did nothing but look like protection would be
 * worse than none.
 */
export function createPorts(options: PortsOptions): MiniHostPorts {
  const { silo, store } = options;
  const emitter = options.emitter ?? new EventEmitter();

  function readConfig(): ModuleConfig {
    const stored = store.readSetting(SETTINGS_KEY);
    const parsed = coreConfig.safeParseConfig(stored ?? {});
    if (parsed.success) return parsed.data;

    // A hand edited row that no longer validates falls back to the defaults
    // rather than taking the host down with it.
    process.stderr.write(
      `The stored module config is invalid, using the defaults: ${parsed.error.message}\n`,
    );
    return coreConfig.DEFAULT_CONFIG;
  }

  const siloPath = options.siloPath;
  const storagePort: StoragePort = {
    silo: () => silo,
    ...(siloPath
      ? {
          backup: async () => {
            // VACUUM INTO, then the copy's search index checked. backupSilo
            // refuses a path that exists, so the name carries the millisecond.
            const path = importBackupPath(siloPath);
            mkdirSync(dirname(path), { recursive: true });
            await storage.backupSilo(silo, path);
            return { file: basename(path) };
          },
        }
      : {}),
  };

  const values: SettingsValuesPort = {
    get: async (key) => store.readValue(key),
    set: async (key, value) => {
      store.writeValue(key, value);
    },
    // Under host.db's write lock: several processes end sessions at once.
    update: async (keys, change) => store.updateValues(keys, change),
  };

  const localPaths: LocalPathsPort = {
    list: async (project) => store.listLocalPaths(project),
    add: async (project, path) => {
      const folder = coreTools.shared.normaliseFolder(path) ?? path;
      const heldBy = store.localPathHolder(folder);
      if (heldBy !== null) return { added: false, heldBy };
      store.addLocalPath(project, folder);
      return { added: true };
    },
    remove: async (path) => store.removeLocalPath(coreTools.shared.normaliseFolder(path) ?? path),
  };

  const models: ModelsPort = options.models ?? createHostModels(readConfig, options.embedders ?? {});
  const injected = options.models;
  const embedding = createEmbeddingHook({
    silo,
    store,
    readConfig,
    writeConfig: (config) => store.writeSetting(SETTINGS_KEY, config),
    embedderFor: injected
      ? injectedEmbedder(injected)
      : (model, dim) => resolveEmbedder(model, dim, options.embedders ?? {}),
  });

  const settings: SettingsPort = {
    get: async () => readConfig(),
    set: (patch) => embedding.set(patch),
    values,
    localPaths,
  };

  const holder = `${process.pid}:${randomUUID()}`;

  const queued = (row: ProposalRow): QueuedProposal => ({
    id: row.id,
    tool: row.tool,
    memoryId: row.memoryId,
    payload: row.payload,
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.group === null ? {} : { group: row.group }),
    state: row.state,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  });

  const review: ReviewPort = {
    propose: async (proposal) => store.propose(proposal),
    list: async (state = "pending") => store.listProposals(state).map(queued),
    get: async (id) => {
      const row = store.getProposal(id);
      return row ? queued(row) : null;
    },
    decide: async (id, state) => store.decideProposal(id, state),
    // One holder per host instance: another process, or another instance in
    // this one, sees the proposal as taken until this one lets go.
    claim: async (id) => store.claimProposal(id, holder),
    release: async (id) => store.releaseProposal(id, holder),
  };

  const bus: BusPort = {
    emit: (name: ModuleEventName, payload) => {
      // The registry calls this once the handler has returned, so after its
      // transactions committed: the feed never shows an event for a write
      // that did not land.
      store.recordEvent(name, payload);
      emitter.emit(name, payload);
      emitter.emit("*", { name, payload });
    },
  };

  const audit: AuditPort = {
    log: async (entry) => {
      store.logAudit(entry);
    },
  };

  // The transcripts connector reads one file: the pointer the SessionEnd
  // hook stored for a session that is still waiting for extraction. The
  // session id comes from core; the path never does, so no tool input can
  // name a file to read.
  const transcripts = createTranscriptsConnector({
    pointerFor: (session) => {
      const ready = store.readValue(coreTools.shared.READY_FOR_EXTRACTION_KEY);
      if (!Array.isArray(ready) || !ready.includes(session)) return null;
      const pointers = store.readValue(coreTools.shared.TRANSCRIPTS_KEY) as Record<string, unknown> | undefined;
      const pointer = pointers && typeof pointers === "object" ? pointers[session] : undefined;
      return typeof pointer === "string" ? pointer : null;
    },
  });
  // The markdown connector reads and writes the folder a tool call names:
  // a mirror folder, or a Claude Code memory directory it only ever reads.
  // It refuses anything that would leave that folder or follow a symlink.
  const markdown = createMarkdownConnector();
  const unknown = (name: string) =>
    Object.assign(new Error(`This host has no ${name} connector.`), { code: "unknown_connector" });
  const connectors: ConnectorsPort = {
    pull: async (name, cursor) => {
      if (name === transcripts.name) return transcripts.pull(cursor);
      if (name === markdown.name) return markdown.pull(cursor);
      throw unknown(name);
    },
    push: async (name, payload) => {
      if (name === markdown.name) return markdown.push(payload);
      throw unknown(name);
    },
  };

  const privacy: PrivacyPort = { redact: (text) => text };

  const refs: RefsPort = { resolve: (ref) => resolveRef(silo, ref) };

  const ports: HostPorts = {
    storage: storagePort,
    review,
    bus,
    audit,
    settings,
    refs,
    privacy,
    models,
    ...(options.transcripts === false ? {} : { connectors }),
  };

  return { ports, emitter, readConfig, embedding };
}

/**
 * The memory URI this host answers: `module://memory/memory/<id>` or
 * `module://memory/memory/<call number>`, the call number current or old.
 * The shape mirrors Fellowship's `module://people/person/<id>`; the spec
 * names the `module://memory/` prefix and nothing after it, so this is a
 * starting reading.
 */
export const MEMORY_URI_PREFIX = "module://memory/memory/";

/**
 * docs/SPEC.md section 12. The mini-host hosts one module, so it answers its
 * own memories and nothing else. A people ref comes back unavailable: how a
 * standalone Reverie reaches a separately running Fellowship is not settled
 * (section 24), and this host does not invent a way.
 */
export async function resolveRef(silo: Silo, raw: string): Promise<RefResolution> {
  const ref = raw.trim();
  if (ref.startsWith("module://people/")) {
    return {
      status: "unavailable",
      ref,
      reason: "The people module is not reachable from this host. People references show as unavailable.",
    };
  }
  if (!ref.startsWith(MEMORY_URI_PREFIX)) {
    return { status: "unavailable", ref, reason: "The mini-host answers module://memory/ references only." };
  }

  const key = ref.slice(MEMORY_URI_PREFIX.length);
  let memory = await silo.memory.findFirst({
    where: { OR: [{ id: key }, { callNumber: key }] },
    select: { id: true, callNumber: true, title: true, kind: true, state: true },
  });
  if (!memory) {
    const alias = await silo.callNumberAlias.findUnique({
      where: { oldCallNumber: key },
      select: { memoryId: true },
    });
    if (alias?.memoryId) {
      memory = await silo.memory.findUnique({
        where: { id: alias.memoryId },
        select: { id: true, callNumber: true, title: true, kind: true, state: true },
      });
    }
  }
  if (!memory) return { status: "unavailable", ref, reason: "No memory by that id or call number." };

  return {
    status: "resolved",
    ref,
    label: memory.title,
    detail: { memoryId: memory.id, call: memory.callNumber, kind: memory.kind, state: memory.state },
  };
}
