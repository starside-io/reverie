import type { MaterialInput } from "../../src/domain/drafting/gates.js";
import type { ExtractCandidateInput } from "../../src/domain/drafting/schemas.js";
import type { DecideResult } from "../../src/tools/confirm/decide.js";
import type { DraftContextResult } from "../../src/tools/drafting/draft-context.js";
import type { ProposeDraftResult } from "../../src/tools/drafting/propose-draft.js";
import type { RememberResult } from "../../src/tools/write/remember.js";
import { testHost, type TestHost, type TestHostOptions } from "../test-host.js";

/**
 * What the gate tests share, on top of the test host in tests/test-host.ts.
 * Every gate runs through `host.invoke`, as a transport would: tools, never
 * domain functions. Every silo is a throwaway one in the OS temp directory
 * and every name is invented (Jane Doe, John Doe, Sam Rivera).
 */

export const NOW = new Date("2026-12-27T10:00:00.000Z");
export const SESSION_DATE = "2026-12-27";

export function gateHost(options: TestHostOptions = {}): Promise<TestHost> {
  return testHost({ now: NOW, session: { id: "session-1" }, ...options });
}

export type Confirmed = Extract<DecideResult, { state: "confirmed" }>;

export function remember(host: TestHost, input: Record<string, unknown>): Promise<RememberResult> {
  return host.invoke<RememberResult>("memory.remember", { kind: "fact", ...input });
}

/** The owner's turn, and optionally more turns after it. */
export function turns(userText: string, more: Array<{ role: "user" | "assistant" | "tool"; text: string }> = []): MaterialInput {
  return { kind: "turns", turns: [{ role: "user", text: userText }, ...more] };
}

/** A file handed over: external unless the caller says otherwise. */
export function file(text: string, trust: "stated" | "external" = "external"): MaterialInput {
  return { kind: "file", name: "notes.html", text, trust } as MaterialInput;
}

/** A drafted fact whose quote is its body, unless overridden. */
export function candidate(overrides: Partial<ExtractCandidateInput> = {}): ExtractCandidateInput {
  const body = overrides.body ?? "Prefers oat milk in coffee.";
  return {
    kind: "fact",
    title: "Oat milk",
    body,
    shelf: "LIF/HOM",
    occurredOn: SESSION_DATE,
    tags: [],
    people: [],
    occasion: null,
    quote: body,
    ...overrides,
  };
}

export function confirm(host: TestHost, proposalId: string): Promise<Confirmed> {
  return host.invoke<Confirmed>("memory.decide", { proposalId, decision: "confirm", confirmedByUser: true });
}

/** draft_context, then propose_draft with the target it returned, as is. */
export async function draft(host: TestHost, target: Record<string, unknown>, answer: unknown): Promise<ProposeDraftResult> {
  const context = await host.invoke<DraftContextResult>("memory.draft_context", target);
  return host.invoke<ProposeDraftResult>("memory.propose_draft", { target: context.target, draft: answer });
}

/** One extract candidate drafted from the material, queued, and confirmed. */
export async function extractAndConfirm(
  host: TestHost,
  material: MaterialInput,
  drafted: ExtractCandidateInput,
): Promise<{ proposed: ProposeDraftResult; decided: Confirmed }> {
  const proposed = await draft(host, { job: "extract", material, sessionDate: SESSION_DATE }, { candidates: [drafted] });
  const id = proposed.queued[0]?.id;
  if (!id) throw new Error(`Nothing was queued: ${JSON.stringify(proposed.rejected)}`);
  return { proposed, decided: await confirm(host, id) };
}

/** One reconcile verb for one candidate, queued and confirmed. */
export async function reconcileAndConfirm(
  host: TestHost,
  material: MaterialInput,
  drafted: ExtractCandidateInput,
  verdict: { verb: "add" | "refine" | "supersede" | "duplicate"; target: string | null; reason?: string },
): Promise<{ proposed: ProposeDraftResult; decided: Confirmed }> {
  const proposed = await draft(
    host,
    { job: "reconcile", material, sessionDate: SESSION_DATE, candidate: drafted },
    { reason: "Drafted in a test.", ...verdict },
  );
  const id = proposed.queued[0]?.id;
  if (!id) throw new Error(`Nothing was queued: ${JSON.stringify(proposed.rejected)}`);
  return { proposed, decided: await confirm(host, id) };
}

/**
 * Every row of every table in the silo, the FTS tables among them, as one
 * text: for asserting what never lands there. Each column is read as text,
 * so a blob or a large integer reads too.
 */
export async function siloText(host: TestHost): Promise<string> {
  const tables = await host.db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  const quoteName = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const dump: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const columns = await host.db.$queryRawUnsafe<Array<{ name: string }>>(`SELECT name FROM pragma_table_info('${name.replace(/'/g, "''")}')`);
    if (columns.length === 0) continue;
    // A blob is read as hex and decoded byte for byte, so text inside it (an FTS segment) still shows.
    const select = columns
      .map((column) => {
        const col = quoteName(column.name);
        return `CASE WHEN typeof(${col}) = 'blob' THEN 'blob:' || hex(${col}) ELSE CAST(${col} AS TEXT) END AS ${col}`;
      })
      .join(", ");
    const rows = await host.db.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT ${select} FROM ${quoteName(name)}`);
    dump[name] = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "string" && value.startsWith("blob:") ? Buffer.from(value.slice(5), "hex").toString("latin1") : value,
        ]),
      ),
    );
  }
  return JSON.stringify(dump);
}

/** Row counts of every table, for asserting that nothing was written. */
export async function rowCounts(host: TestHost): Promise<Record<string, number>> {
  const tables = await host.db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`,
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const [row] = await host.db.$queryRawUnsafe<Array<{ n: number | bigint }>>(
      `SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`,
    );
    counts[name] = Number(row?.n ?? 0);
  }
  return counts;
}

/* ------------------------------------------------------- a scripted session */

/** Every string of memory text and query text the scripted session uses, to look for where it must not be. */
export const SCRIPT_TEXT = {
  christmas: "Hosted Christmas. The oven died, so we ordered pizza.",
  key: "The spare key hangs by the back door.",
  keyMoved: "The spare key hangs by the side door.",
  keyQuote: "The key is by the side door, under the blue pot.",
  milk: "Prefers oat milk in coffee.",
  milkNow: "Prefers soy milk in coffee since 2026-12-20.",
  bike: "The old bike waits in the shed.",
  kettle: "Bought a new kettle with a long spout.",
  latte: "Likes oat milk lattes with cinnamon.",
  gone: "Lent the ladder to the neighbours on Elm Street.",
  note: "Working through the kettle notes this session.",
  coffee: "We met Sam Rivera for coffee on 2026-12-26 at the station cafe.",
  coffeeBody: "Met Sam Rivera for coffee at the station cafe.",
  rule: "Write commit messages in the imperative mood.",
  ruleWhy: "It reads as an instruction to the codebase.",
  ruleHow: "Every commit subject line.",
  recallQuery: "ordered pizza oven",
  searchQuery: "kettle spout",
} as const;

/** The memory texts and queries, as a list: none may appear in an audit line or a RecallLog row. */
export const SCRIPT_STRINGS: readonly string[] = Object.values(SCRIPT_TEXT);

export interface ScriptResult {
  /** Every tool the script called, in order, each once or more. */
  called: string[];
  calls: Record<string, string>;
}

/**
 * A session that touches every one of the 41 tools with input that should
 * succeed, in an order where each call has what it needs. The refs port is
 * whatever the host gives it, and no optional port is required.
 */
export async function runEveryTool(host: TestHost): Promise<ScriptResult> {
  const called: string[] = [];
  const call = async <T = any>(name: string, input: Record<string, unknown>): Promise<T> => {
    const result = await host.invoke<T>(name, input);
    called.push(name);
    return result;
  };
  const T = SCRIPT_TEXT;
  const ok = { confirmedByUser: true } as const;

  const christmas = await call<RememberResult>("memory.remember", {
    kind: "episode",
    shelf: "LIF/GTH",
    occurredOn: "2026-12-24",
    title: "Christmas at home",
    body: T.christmas,
    tags: ["christmas"],
    attendees: ["Jane Doe", "module://people/person/p_sam"],
  });
  const key = await call<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: T.key, tags: ["home"] });
  const milk = await call<RememberResult>("memory.remember", { kind: "preference", shelf: "LIF/HOM", body: T.milk, occurredOn: "2026-01-10" });
  const bike = await call<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: T.bike });
  const kettle = await call<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: T.kettle });
  const latte = await call<RememberResult>("memory.remember", { kind: "preference", shelf: "LIF/HOM", body: T.latte });
  const gone = await call<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: T.gone });

  await call("memory.update", { call: key.memory.call, body: T.keyMoved });
  await call("memory.supersede", { call: milk.memory.call, body: T.milkNow, occurredOn: "2026-12-20" });
  await call("memory.touch", { call: key.memory.call });
  await call("memory.pin", { call: key.memory.call, pinned: true });
  await call("memory.retire", { call: bike.memory.call });
  const moved = await call<{ memory: { call: string } }>("memory.shelve", {
    action: "move",
    call: kettle.memory.call,
    occurredOn: "2026-12-26",
  });
  await call("memory.set_tags", { action: "memory", call: christmas.memory.call, attach: ["hosting"] });
  await call("memory.set_shelves", {
    action: "create_shelf",
    section: "LIF",
    code: "GDN",
    name: "Garden",
    description: "Plants, beds and the shed.",
  });
  await call("memory.set_projects", {
    action: "create",
    slug: "nightstash",
    name: "NightStash",
    repoUrl: "https://github.com/jane-doe/nightstash",
    shelf: "WRK/NST",
  });
  await call("memory.link", { from: key.memory.call, to: moved.memory.call, relation: "elaborates" });
  await call("memory.link_occasion", {
    call: christmas.memory.call,
    occasion: "module://people/event/e_8812",
    label: "Christmas at home",
  });
  await call("memory.add_source", { call: key.memory.call, quote: T.keyQuote });
  await call("memory.session_note", { body: T.note });

  const proposed = await call<ProposeDraftResult>("memory.propose_draft", {
    target: { job: "extract", material: turns(T.coffee), sessionDate: SESSION_DATE },
    draft: {
      candidates: [
        candidate({
          kind: "episode",
          title: "Coffee with Sam",
          body: T.coffeeBody,
          shelf: "LIF/GTH",
          occurredOn: "2026-12-26",
          people: [{ name: "Sam Rivera" }],
          quote: T.coffee,
        }),
      ],
    },
  });
  const drafted = await call<Confirmed>("memory.decide", {
    proposalId: proposed.queued[0]!.id,
    decision: "confirm",
    ...ok,
  });
  await call("memory.promote_procedure", {
    body: T.rule,
    why: T.ruleWhy,
    howToApply: T.ruleHow,
    shelf: "CRF/HOW",
    ...ok,
  });
  await call("memory.merge", { survivor: moved.memory.call, absorbed: latte.memory.call, ...ok });
  await call("memory.redact", { call: key.memory.call, ...ok });
  await call("memory.forget", { call: gone.memory.call, ...ok });

  // Reads.
  await call("memory.recall", { query: T.recallQuery });
  await call("memory.browse", { shelf: "LIF/GTH", order: "asc" });
  await call("memory.get", { call: christmas.memory.call });
  await call("memory.search", { query: T.searchQuery });
  await call("memory.related", { call: christmas.memory.call });
  await call("memory.about", { person: "Jane Doe" });
  await call("memory.shelves", {});
  await call("memory.tags", {});
  await call("memory.projects", {});
  await call("memory.core", {});
  await call("memory.history", { call: key.memory.call });
  await call("memory.explain", { call: christmas.memory.call });
  await call("memory.sources", { call: key.memory.call });
  await call("memory.stale", {});
  await call("memory.conflicts", {});
  await call("memory.stats", {});
  const exported = await call<{ snapshot: unknown }>("memory.export", {});
  await call("memory.review", { state: "all" });
  await call("memory.fs_view", {});
  await call("memory.draft_context", { job: "extract", material: turns(T.coffee), sessionDate: SESSION_DATE });
  await call("memory.import", { snapshot: exported.snapshot, mode: "merge", ...ok });

  return {
    called,
    calls: {
      christmas: christmas.memory.call,
      key: key.memory.call,
      milk: milk.memory.call,
      bike: bike.memory.call,
      kettle: moved.memory.call,
      latte: latte.memory.call,
      gone: gone.memory.call,
      coffee: drafted.committed!.call,
    },
  };
}

/** The whole library as fs_view shows it, every directory listing and every file, as one text. */
export async function fsViewText(host: TestHost): Promise<string> {
  type Entry = { path: string; type: "directory" | "file" };
  type View = { type: "directory"; text: string; entries: Entry[] } | { type: "file"; content: string };
  const out: string[] = [];
  const walk = async (path: string) => {
    const view = await host.invoke<View>("memory.fs_view", { path });
    out.push(view.type === "directory" ? view.text : view.content);
    if (view.type === "directory") for (const entry of view.entries) await walk(entry.path);
  };
  await walk("/memories");
  return out.join("\n");
}
