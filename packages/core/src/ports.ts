import type { ModuleConfig } from "./config/index.js";
import type { Silo } from "./storage/client.js";

/**
 * The only thing core knows about a host. docs/SPEC.md section 12.
 *
 * Fellowship's HostPorts contract, lifted: the same ports with the same
 * shapes, minus `media` (Reverie fetches nothing), with Reverie's own event
 * names, and with `models` narrowed to `embed()`, the one model call core may
 * make. Everything that reaches outside the silo is here. A module that holds
 * this interface runs on the mini-host, on a host kernel, or on a test double,
 * and cannot tell the difference.
 *
 * module.json lists storage, review, bus, audit, settings and refs as
 * required, and models, connectors and privacy as optional. The optional ones
 * are optional here too, so a tool that wants one says what it does without
 * it rather than assuming it.
 *
 * What is deliberately absent: a network client, a filesystem, a logger that
 * writes anywhere, and any way to reach another module's data.
 */
export interface HostPorts {
  storage: StoragePort;
  review: ReviewPort;
  bus: BusPort;
  audit: AuditPort;
  settings: SettingsPort;
  refs: RefsPort;
  models?: ModelsPort;
  connectors?: ConnectorsPort;
  privacy?: PrivacyPort;
}

/** The silo, and nothing else. One writer, pragmas already asserted. */
export interface StoragePort {
  silo(): Silo;
}

/**
 * Embeddings only. An embedding is a pure function of the body and the model:
 * it drafts nothing, decides nothing and reaches no review, which is why core
 * may call it when Fellowship's core calls no model at all. Core never asks a
 * model to complete anything; a host that runs a local drafter does that on
 * its own side of this line. Without this port recall runs on FTS alone and
 * says so.
 */
export interface ModelsPort {
  /** One vector per text, in order, of the configured model's dimension. */
  embed(texts: string[]): Promise<number[][]>;
}

/** A write an assistant wants, waiting for the owner to confirm or discard. */
export interface Proposal {
  /** The tool that would run on confirmation. Never decide or propose_draft. */
  tool: string;
  /** The memory the proposal is about, when it is about one already shelved. */
  memoryId?: string | null;
  payload: unknown;
  /** One line the host can render without understanding the payload. */
  summary?: string;
  /**
   * Proposals drafted together, such as one session's extraction, share a
   * group so the host can show them under one heading and decide them
   * together. Each one is still confirmed on its own: a group is a heading,
   * not a transaction.
   */
  group?: ProposalGroup;
}

export interface ProposalGroup {
  id: string;
  /** What the group is, in one line. */
  title: string;
  /** A longer line under the title. */
  detail?: string;
  /** Whatever the drafter needs to read back later. The host stores it as is. */
  meta?: Record<string, unknown>;
}

export type ProposalState = "pending" | "confirmed" | "discarded";

/** A proposal as the queue holds it. */
export interface QueuedProposal extends Proposal {
  id: string;
  state: ProposalState;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * The review queue. The host owns it (it lives in host.db, never in the
 * silo), and the module reads and decides through it so that any model,
 * behind any assistant, can propose a draft and the owner can confirm it, with
 * the same gates either way.
 */
export interface ReviewPort {
  propose(proposal: Proposal): Promise<{ id: string }>;
  list(state?: ProposalState | "all"): Promise<QueuedProposal[]>;
  get(id: string): Promise<QueuedProposal | null>;
  /** Marks a pending proposal. False when it was not pending. */
  decide(id: string, state: "confirmed" | "discarded"): Promise<boolean>;
}

/** The events this module emits, as docs/SPEC.md section 18 lists them. */
export type ModuleEventName =
  | "memory.memory.written"
  | "memory.memory.superseded"
  | "memory.memory.forgotten"
  | "memory.memory.shelved"
  | "memory.consolidation.proposed";

/** Every event this module emits, in the order module.json lists them. */
export const MODULE_EVENTS: readonly ModuleEventName[] = [
  "memory.memory.written",
  "memory.memory.superseded",
  "memory.memory.forgotten",
  "memory.memory.shelved",
  "memory.consolidation.proposed",
];

/** The events this module listens to, as section 18 lists them. */
export type ListenedEventName =
  | "people.person.created"
  | "people.interaction.logged"
  | "people.interaction.changed"
  | "host.session.ended";

export interface BusPort {
  /**
   * Emitted after the transaction commits, never before. With a single SQLite
   * writer, emitting early is the easiest bug in this module to write by
   * accident. Payloads carry ids and call numbers, never memory text.
   */
  emit(name: ModuleEventName, payload: Record<string, unknown>): void | Promise<void>;
}

/** One normalized item handed over by a connector. */
export interface ConnectorItem {
  id: string;
  payload: unknown;
}

export interface ConnectorPull {
  items: ConnectorItem[];
  cursor?: string | null;
}

/** `transcripts` and `markdown`, as module.json declares them. */
export interface ConnectorsPort {
  pull(connector: string, cursor?: string | null): Promise<ConnectorPull>;
}

/** Pass-through, as in Fellowship. Nothing here should look like protection that is not there. */
export interface PrivacyPort {
  redact(text: string): string;
}

/**
 * Ids and call numbers one call touched. Plain handles, never text: the audit
 * log is not a second copy of the library.
 */
export interface AuditIds {
  memoryIds?: string[];
  calls?: string[];
  proposalIds?: string[];
}

export interface AuditEntry {
  tool: string;
  /** read, write, or needs-ok, as the registry classifies the tool. */
  kind: string;
  at: Date;
  /** What the call touched, by id and call number. */
  ids?: AuditIds;
  /** Counts, flags and refusal codes only. Never memory text, never query text. */
  detail?: Record<string, unknown>;
}

/** Append only. Never updated, never deleted by the module. */
export interface AuditPort {
  log(entry: AuditEntry): Promise<void>;
}

/** One folder on this machine that is a project: a clone or a worktree. */
export interface LocalPath {
  /** The project's slug in the silo. Slug and repository are the portable identity. */
  project: string;
  /** Absolute, as the host stores it. */
  path: string;
}

/**
 * `added: false` when the folder is already registered: `heldBy` names the
 * project that holds it, which is this one when nothing needed changing.
 */
export type LocalPathAddResult = { added: true } | { added: false; heldBy: string };

/**
 * The local folder paths of each project. docs/SPEC.md section 4: a path is
 * true on one machine only, so it lives in host.db beside the cursors and
 * never in the silo, never in an export, never in the mirror. One project may
 * have many folders; a folder belongs to at most one project, and `add`
 * refuses a folder another project holds by returning who holds it.
 */
export interface LocalPathsPort {
  /** Every registered folder, or one project's. */
  list(project?: string): Promise<LocalPath[]>;
  add(project: string, path: string): Promise<LocalPathAddResult>;
  /** False when the folder was not registered. */
  remove(path: string): Promise<boolean>;
}

export interface SettingsPort {
  get(): Promise<ModuleConfig>;
  /**
   * A change to embedding.model must re-embed every memory before the new
   * value counts as applied, because Embedding is a cache of body and model
   * (section 17, the re-embed hook). The host owns that hook.
   */
  set(patch: Partial<ModuleConfig>): Promise<ModuleConfig>;
  /**
   * The project folders on this machine, kept in host.db with the rest of
   * what describes this machine rather than the library. Reverie's one
   * addition to Fellowship's settings port, and optional so the shared shape
   * stays Fellowship's: without it project resolution skips the folder step
   * and goes straight to the git remote, and folder edits are refused as
   * unavailable.
   */
  localPaths?: LocalPathsPort;
  /**
   * Host level values that are not config: how the core block opens and
   * when consolidation last ran. Kept in host.db with the settings, never in
   * the silo. Optional, as localPaths is, so the shared shape stays
   * Fellowship's: without it the owner line stays empty, consolidation is
   * never reported due, and setting the owner line is refused as unavailable.
   * The keys core uses are in tools/shared/host-values.ts.
   */
  values?: SettingsValuesPort;
}

/** A small key value store the host keeps beside the settings. Values are JSON. */
export interface SettingsValuesPort {
  /** Undefined when the key was never set. */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export type RefResolution =
  | { status: "resolved"; ref: string; label: string; detail?: Record<string, unknown> }
  | { status: "unavailable"; ref: string; reason: string };

/**
 * Resolves `module://people/...` URIs for attendees and occasions, and answers
 * `module://memory/...` for the other side. Anything it cannot resolve comes
 * back `unavailable`, which every tool renders rather than fails on.
 */
export interface RefsPort {
  resolve(ref: string): Promise<RefResolution>;
}
