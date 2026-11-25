import { activate, type ModuleApi } from "../src/activate.js";
import { DEFAULT_CONFIG, mergeConfig, type ConfigPatch, type ModuleConfig } from "../src/config/index.js";
import { seedLibrary } from "../src/domain/catalogue/shelving.js";
import type {
  AuditEntry,
  HostPorts,
  LocalPath,
  ModuleEventName,
  Proposal,
  QueuedProposal,
  RefResolution,
} from "../src/ports.js";
import { openSilo, type Silo } from "../src/storage/client.js";
import type { InvokeOptions, SessionInfo } from "../src/tools/registry.js";
import { normaliseFolder } from "../src/tools/shared/project.js";
import { freshSiloPath } from "./storage/throwaway.js";

/**
 * A host made of nothing but records: a real migrated silo in the OS temp
 * directory, and an in-memory port for every outward thing the module can
 * reach, each one keeping what it was asked to do. Tool tests and the gates
 * assert against these. Lifted from Fellowship's tests/gates/harness.ts.
 *
 * The refs port answers `unavailable` for everything until a test primes it
 * with people, which is the "works without Fellowship" case by default. The
 * optional ports (models, connectors, privacy) are absent unless asked for,
 * because a tool has to behave without them.
 *
 * Never point this at the live silo: every name in these tests is invented.
 */

export interface RecordedEvent {
  name: ModuleEventName;
  payload: Record<string, unknown>;
}

export interface TestHostOptions {
  /** Config on top of the defaults. */
  config?: ConfigPatch;
  /** Seed the starting library. On by default. */
  seed?: boolean;
  /** Where the caller is working, for every invoke that does not say. */
  session?: Partial<SessionInfo>;
  /** Pins `now` for every invoke that does not say. */
  now?: Date;
  /** Give the host a models port whose embed returns a fixed small vector. */
  models?: boolean;
  /** Give the host connectors and privacy ports that return nothing and pass text through. */
  optionalPorts?: boolean;
  /** Folder paths already registered, as host.db would hold them. */
  localPaths?: LocalPath[];
  /** Leave settings.localPaths out, as a host without folder support would. */
  noLocalPaths?: boolean;
  /** Leave settings.values out, as a host that keeps no settings values would. */
  noValues?: boolean;
}

export interface TestHost {
  api: ModuleApi;
  ports: HostPorts;
  db: Silo;
  audit: AuditEntry[];
  events: RecordedEvent[];
  proposals: QueuedProposal[];
  localPaths: LocalPath[];
  /** The host's settings values (owner line, consolidation state), as host.db would hold them. */
  values: Map<string, unknown>;
  embedCalls: string[][];
  config: ModuleConfig;
  session: Partial<SessionInfo>;
  now: Date | undefined;
  /**
   * Calls a tool as a transport would, with the host's session and now unless
   * the options say otherwise.
   */
  invoke<T = unknown>(name: string, input?: unknown, options?: InvokeOptions): Promise<T>;
  /** Makes the refs port answer for this URI with this label. */
  primeRef(uri: string, label: string, detail?: Record<string, unknown>): void;
  /** Primes `module://people/person/<id>` for each person. */
  primePeople(people: ReadonlyArray<{ id: string; name: string }>): void;
  /** Turns incognito on or off. */
  setIncognito(on: boolean): void;
  close(): Promise<void>;
}

/** Invented people, for tests that prime the refs port. */
export const PEOPLE = {
  jane: { id: "p_jane", name: "Jane Doe", uri: "module://people/person/p_jane" },
  john: { id: "p_john", name: "John Doe", uri: "module://people/person/p_john" },
  sam: { id: "p_sam", name: "Sam Rivera", uri: "module://people/person/p_sam" },
} as const;

export async function testHost(options: TestHostOptions = {}): Promise<TestHost> {
  const db = await openSilo({ path: freshSiloPath() });
  if (options.seed !== false) await seedLibrary(db);

  const refs = new Map<string, { label: string; detail?: Record<string, unknown> }>();

  const host: TestHost = {
    api: undefined as unknown as ModuleApi,
    ports: undefined as unknown as HostPorts,
    db,
    audit: [],
    events: [],
    proposals: [],
    localPaths: [...(options.localPaths ?? [])],
    values: new Map(),
    embedCalls: [],
    config: mergeConfig(DEFAULT_CONFIG, options.config ?? {}),
    session: { ...(options.session ?? {}) },
    now: options.now,
    invoke: async <T>(name: string, input: unknown = {}, invokeOptions: InvokeOptions = {}) =>
      (await host.api.invoke(name, input, {
        ...(host.now ? { now: host.now } : {}),
        session: host.session,
        ...invokeOptions,
      })) as T,
    primeRef: (uri, label, detail) => {
      refs.set(uri, { label, ...(detail ? { detail } : {}) });
    },
    primePeople: (people) => {
      for (const person of people) refs.set(`module://people/person/${person.id}`, { label: person.name });
    },
    setIncognito: (on) => {
      host.config = { ...host.config, incognito: on };
    },
    close: async () => {
      await db.$disconnect();
    },
  };

  const ports: HostPorts = {
    storage: { silo: () => db },
    review: {
      propose: async (proposal: Proposal) => {
        const id = `proposal-${host.proposals.length + 1}`;
        host.proposals.push({
          ...proposal,
          id,
          state: "pending",
          createdAt: new Date().toISOString(),
          decidedAt: null,
        });
        return { id };
      },
      list: async (state = "pending") =>
        host.proposals.filter((row) => state === "all" || row.state === state),
      get: async (id) => host.proposals.find((row) => row.id === id) ?? null,
      decide: async (id, state) => {
        const row = host.proposals.find((entry) => entry.id === id);
        if (!row || row.state !== "pending") return false;
        row.state = state;
        row.decidedAt = new Date().toISOString();
        return true;
      },
    },
    bus: {
      emit: (name, payload) => {
        host.events.push({ name, payload });
      },
    },
    audit: {
      log: async (entry) => {
        host.audit.push(entry);
      },
    },
    settings: {
      get: async () => host.config,
      set: async (patch) => {
        host.config = mergeConfig(host.config, patch as ConfigPatch);
        return host.config;
      },
      ...(options.noValues
        ? {}
        : {
            values: {
              get: async (key: string) => host.values.get(key),
              set: async (key: string, value: unknown) => {
                host.values.set(key, value);
              },
            },
          }),
      ...(options.noLocalPaths
        ? {}
        : {
            localPaths: {
              list: async (project?: string) =>
                host.localPaths.filter((entry) => project === undefined || entry.project === project),
              add: async (project: string, path: string) => {
                const folder = normaliseFolder(path) ?? path;
                const held = host.localPaths.find((entry) => entry.path === folder);
                if (held) return { added: false as const, heldBy: held.project };
                host.localPaths.push({ project, path: folder });
                return { added: true as const };
              },
              remove: async (path: string) => {
                const folder = normaliseFolder(path) ?? path;
                const index = host.localPaths.findIndex((entry) => entry.path === folder);
                if (index < 0) return false;
                host.localPaths.splice(index, 1);
                return true;
              },
            },
          }),
    },
    refs: {
      resolve: async (ref): Promise<RefResolution> => {
        const known = refs.get(ref);
        if (known) return { status: "resolved", ref, label: known.label, ...(known.detail ? { detail: known.detail } : {}) };
        return { status: "unavailable", ref, reason: "The people module is not reachable from this host." };
      },
    },
    ...(options.models
      ? {
          models: {
            embed: async (texts: string[]) => {
              host.embedCalls.push(texts);
              return texts.map((text) => [text.length % 7, 1, 0]);
            },
          },
        }
      : {}),
    ...(options.optionalPorts
      ? {
          connectors: { pull: async () => ({ items: [], cursor: null }) },
          privacy: { redact: (text: string) => text },
        }
      : {}),
  };

  host.ports = ports;
  host.api = activate(ports);
  return host;
}

/** Every string in every audit line, for asserting that no text leaked into the log. */
export function auditStrings(host: TestHost): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  for (const entry of host.audit) walk({ ...entry, at: undefined });
  return out;
}
