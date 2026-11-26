import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { createTranscriptsConnector } from "@reverie/connector-transcripts";
import { config as coreConfig, domain, tools as coreTools } from "@reverie/core";
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

import { HostStore, type ProposalRow } from "./host-store.js";

export * from "./host-store.js";

const SETTINGS_KEY = "module.config";

export interface PortsOptions {
  silo: Silo;
  store: HostStore;
  /** In-process listeners for the bus. The feed reads host.db instead. */
  emitter?: EventEmitter;
  /**
   * An embedding model, handed in by whoever starts the host. Absent by
   * default: Reverie declares network none, so the mini-host opens no model
   * endpoint of its own, and recall runs on FTS alone and says so.
   */
  models?: ModelsPort;
  /**
   * The transcripts connector (docs/SPEC.md section 12), on by default.
   * False leaves the connectors port out, so extraction from a finished
   * session hands over its notes alone and says so.
   */
  transcripts?: boolean;
}

export interface MiniHostPorts {
  ports: HostPorts;
  emitter: EventEmitter;
  /** Reads the stored config without going through the port. */
  readConfig(): ModuleConfig;
}

/** Thrown by settings.set when a change cannot be applied as asked. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/**
 * Every port the module can reach, over one silo and one host.db. Lifted
 * from Fellowship's ports/index.ts, minus media, and with Reverie's own
 * transcripts connector behind the connectors port.
 *
 * The two that carry a rule rather than a lookup:
 *
 * settings.set re-embeds every memory before a change to embedding.model
 * counts as applied (docs/SPEC.md section 17, the re-embed hook). Embedding
 * is a cache of body and model, so saving a new model without the re-embed
 * leaves every vector silently stale. With no models port there is nothing
 * to re-embed with, so naming a model is refused rather than stored as if it
 * applied.
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

  const storagePort: StoragePort = { silo: () => silo };

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

  const settings: SettingsPort = {
    get: async () => readConfig(),
    set: async (patch) => {
      const before = readConfig();
      const next = coreConfig.mergeConfig(before, patch);

      const model = next.embedding.model;
      if (model !== null && model !== before.embedding.model) {
        if (!options.models) {
          throw new SettingsError(
            `No embedding model is reachable from this host, so embedding.model "${model}" cannot be applied: nothing would compute its vectors. Recall stays on full text search.`,
          );
        }
        // Before the new value counts as applied, not after.
        const models = options.models;
        await domain.embeddings.reembedAll(silo, (texts) => models.embed(texts), {
          model,
          dim: next.embedding.dim,
        });
      }

      store.writeSetting(SETTINGS_KEY, next);
      return next;
    },
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
  // name a file to read. The markdown connector is not built yet (M7).
  const transcripts = createTranscriptsConnector({
    pointerFor: (session) => {
      const ready = store.readValue(coreTools.shared.READY_FOR_EXTRACTION_KEY);
      if (!Array.isArray(ready) || !ready.includes(session)) return null;
      const pointers = store.readValue(coreTools.shared.TRANSCRIPTS_KEY) as Record<string, unknown> | undefined;
      const pointer = pointers && typeof pointers === "object" ? pointers[session] : undefined;
      return typeof pointer === "string" ? pointer : null;
    },
  });
  const connectors: ConnectorsPort = {
    pull: async (name, cursor) => {
      if (name === transcripts.name) return transcripts.pull(cursor);
      throw Object.assign(new Error(`This host has no ${name} connector.`), { code: "unknown_connector" });
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
    ...(options.models ? { models: options.models } : {}),
    ...(options.transcripts === false ? {} : { connectors }),
  };

  return { ports, emitter, readConfig };
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
