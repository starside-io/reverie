// Reconcile: each candidate beside its nearest neighbours, one verb back.
// docs/SPEC.md section 13.
//
// Three parts. `findNeighbours` finds the active memories a candidate is
// nearest to, among those it could be recalled with. `duplicateGuard` is the
// direct door's check that `remember` is not about to multiply a memory that
// is already shelved. `applyVerdict` commits one verb in one transaction by
// composing the commit primitives in memories.ts.
//
// Reconcile runs after discipline in the write path and calls no model: the
// verb comes from the drafter (or the owner), and nothing here proposes or
// queues. The review queue is the host's.

import type { Memory, Prisma } from "../../generated/prisma/index.js";
import { dayKey } from "../schemas/common.js";
import type { MemoryKind, MemoryScope } from "../schemas/enums.js";
import {
  memoryCreateSchema,
  NO_SOURCE_MESSAGE,
  type MemoryCreateInput,
  type MemoryUpdateInput,
} from "../schemas/memory.js";
import {
  reconcileVerdictSchema,
  type ReconcileVerdict,
  type ReconcileVerdictInput,
} from "../schemas/reconcile.js";
import type { ShelfRef } from "../schemas/shelf.js";
import { normaliseTagSlug } from "../schemas/tag.js";
import { searchMemoryFts, toNeighbourQuery } from "../storage/search.js";
import { resolveShelf } from "./catalogue/shelving.js";
import { attachTagsRaw } from "./catalogue/tags.js";
import { atomic, type Db, type Tx } from "./db.js";
import { DomainError, parseInput } from "./errors.js";
import {
  attachSourceRaw,
  createMemory,
  supersedeMemory,
  touchMemory,
  updateMemory,
} from "./memories.js";
import { fuse } from "./recall/fuse.js";
import { appendVersion, memoryIdOf, type MutationOptions } from "./versions.js";

export {
  ReconcileVerb,
  reconcileVerdictSchema,
  type ReconcileVerdict,
  type ReconcileVerdictInput,
} from "../schemas/reconcile.js";

// Scope ----------------------------------------------------------------------

export interface ScopePair {
  scope: MemoryScope;
  scopeRef: string | null;
}

/**
 * The scopes a candidate could be recalled alongside, and so the only ones it
 * is reconciled against. A project, agent or session candidate sees global
 * entries and its own scope's. A global candidate sees global entries only:
 * reconciling a global statement against one project's entry would let a verb
 * cross the scope boundary, a refine of that project's entry from outside it,
 * or a duplicate that hides a global fact inside one project. Starting value.
 */
export function visibleScopes(candidate: { scope?: MemoryScope; scopeRef?: string | null }): ScopePair[] {
  const scope = candidate.scope ?? "global";
  if (scope === "global") return [{ scope: "global", scopeRef: null }];
  const scopeRef = candidate.scopeRef?.trim() ?? "";
  if (scopeRef.length === 0) {
    throw new DomainError("invalid_input", `A ${scope} candidate names what it is scoped to (scopeRef).`);
  }
  return [
    { scope: "global", scopeRef: null },
    { scope, scopeRef },
  ];
}

function scopeWhere(pairs: readonly ScopePair[]): Prisma.MemoryWhereInput {
  return {
    OR: pairs.map((pair) =>
      pair.scope === "global" ? { scope: "global" } : { scope: pair.scope, scopeRef: pair.scopeRef },
    ),
  };
}

function isVisible(memory: { scope: string; scopeRef: string | null }, pairs: readonly ScopePair[]): boolean {
  return pairs.some((pair) =>
    pair.scope === "global" ? memory.scope === "global" : memory.scope === pair.scope && memory.scopeRef === pair.scopeRef,
  );
}

// Body similarity ------------------------------------------------------------

/**
 * A body reduced to what it says. In order: Unicode compatibility
 * decomposition (NFKD), combining marks dropped (so "café" reads "cafe"),
 * lowercased, every run of anything that is not a letter or a digit
 * (punctuation, whitespace, the # of an inline tag) turned into one space,
 * trimmed. Two bodies that differ only in case, accents, punctuation, spacing
 * or tag marks normalise to the same text. Starting value.
 */
export function normaliseBody(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function trigrams(text: string): Map<string, number> {
  const padded = `  ${text} `;
  const grams = new Map<string, number>();
  const chars = [...padded];
  for (let index = 0; index + 3 <= chars.length; index += 1) {
    const gram = chars.slice(index, index + 3).join("");
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/**
 * How alike two bodies are, 0 to 1: the Dice coefficient over the character
 * trigrams of their normalised text, counted as multisets. 1 means the
 * normalised bodies are equal. Linear in the length of the bodies, so it is
 * safe on a 20,000 character body. Starting value.
 */
export function bodySimilarity(a: string, b: string): number {
  const left = normaliseBody(a);
  const right = normaliseBody(b);
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const gramsA = trigrams(left);
  const gramsB = trigrams(right);
  let shared = 0;
  let totalA = 0;
  let totalB = 0;
  for (const count of gramsA.values()) totalA += count;
  for (const [gram, count] of gramsB) {
    totalB += count;
    shared += Math.min(count, gramsA.get(gram) ?? 0);
  }
  return (2 * shared) / (totalA + totalB);
}

// Neighbours -----------------------------------------------------------------

/** What reconcile needs of a candidate to find its neighbours. */
export interface NeighbourCandidate {
  title?: string;
  body: string;
  kind?: MemoryKind;
  shelf?: ShelfRef;
  tags?: readonly string[];
  scope?: MemoryScope;
  scopeRef?: string | null;
}

/** How many neighbours the reconcile job is handed. Starting value. */
export const NEIGHBOUR_LIMIT = 5;

/** How many FTS hits are read for each neighbour returned, before fusing. Starting value. */
export const NEIGHBOUR_POOL_FACTOR = 4;

export interface NeighbourOptions {
  /** How many to return. Defaults to NEIGHBOUR_LIMIT. */
  limit?: number;
  /**
   * Memory ids in cosine order, best first, from the vector search. Absent or
   * null in M1: no model, FTS alone. From M8 the host passes the vector list
   * here and it is fused with FTS by reciprocal rank, as recall does. Ids
   * outside the candidate's scopes or not active are dropped.
   */
  vector?: readonly string[] | null;
}

export interface Neighbour {
  memoryId: string;
  callNumber: string;
  /** "LIF/GTH" */
  shelf: string;
  /** "2026-12-24" */
  occurredOn: string;
  kind: MemoryKind;
  scope: MemoryScope;
  scopeRef: string | null;
  trust: string;
  title: string;
  body: string;
  why: string | null;
  howToApply: string | null;
  tags: string[];
  lastConfirmedAt: Date;
  /** 1 based rank in the FTS list, null when it came from vectors alone. */
  rankFts: number | null;
  /** 1 based rank in the vector list, null when absent or when vectors did not run. */
  rankVec: number | null;
  /** Fused relevance, 1.0 for rank 1 in every list that ran. */
  relevance: number;
  /** bodySimilarity to the candidate's body. */
  similarity: number;
  sameShelf: boolean;
  sameKind: boolean;
  sharedTags: string[];
}

function candidateTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const tag of tags ?? []) {
    const slug = normaliseTagSlug(tag);
    if (slug !== null && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * The active memories nearest a candidate, among the ones it could be
 * recalled with (visibleScopes), best first.
 *
 * The FTS query is every distinct word of the title, body and tags, any of
 * them, ranked by weighted BM25 (storage/search.ts). The list is fused with
 * the vector list when one is given; with FTS alone the order is BM25's. Each
 * neighbour carries the signals the drafter weighs: body similarity, same
 * shelf, same kind, shared tags.
 */
export async function findNeighbours(
  db: Db,
  candidate: NeighbourCandidate,
  options: NeighbourOptions = {},
): Promise<Neighbour[]> {
  const pairs = visibleScopes(candidate);
  const limit = Math.max(1, Math.floor(options.limit ?? NEIGHBOUR_LIMIT));
  const tags = candidateTags(candidate.tags);
  const shelfPath =
    candidate.shelf === undefined
      ? null
      : await resolveShelf(db, candidate.shelf).then((shelf) => `${shelf.section.code}/${shelf.code}`);

  const query = toNeighbourQuery(candidate.title ?? "", candidate.body, tags.join(" "));
  const ftsIds =
    query === null
      ? []
      : (await searchMemoryFts(db, query.expression, { scopes: pairs, limit: limit * NEIGHBOUR_POOL_FACTOR })).map(
          (hit) => hit.id,
        );
  const vector = options.vector ?? null;
  const fused = fuse({ fts: ftsIds, vector });
  if (fused.length === 0) return [];

  const rows = await db.memory.findMany({
    where: { id: { in: fused.map((hit) => hit.id) }, state: "active", ...scopeWhere(pairs) },
    include: { shelf: { include: { section: true } }, tags: { include: { tag: true } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  const out: Neighbour[] = [];
  for (const hit of fused) {
    const row = byId.get(hit.id);
    if (!row) continue;
    const rowTags = row.tags.map((entry) => entry.tag.slug).sort();
    const shelf = `${row.shelf.section.code}/${row.shelf.code}`;
    out.push({
      memoryId: row.id,
      callNumber: row.callNumber,
      shelf,
      occurredOn: dayKey(row.occurredOn),
      kind: row.kind as MemoryKind,
      scope: row.scope as MemoryScope,
      scopeRef: row.scopeRef,
      trust: row.trust,
      title: row.title,
      body: row.body,
      why: row.why,
      howToApply: row.howToApply,
      tags: rowTags,
      lastConfirmedAt: row.lastConfirmedAt,
      rankFts: hit.rankFts,
      rankVec: hit.rankVec,
      relevance: hit.relevance,
      similarity: bodySimilarity(candidate.body, row.body),
      sameShelf: shelfPath !== null && shelfPath === shelf,
      sameKind: candidate.kind !== undefined && candidate.kind === row.kind,
      sharedTags: rowTags.filter((slug) => tags.includes(slug)),
    });
    if (out.length >= limit) break;
  }
  return out;
}

// The duplicate guard --------------------------------------------------------

/**
 * At or above this bodySimilarity a candidate is a near-exact duplicate. A one
 * character typo in a sixty character body scores about 0.95; rewording a
 * clause drops well below. Starting value, to tune against the eval corpus.
 */
export const DUPLICATE_SIMILARITY = 0.9;

/** How many neighbours the guard compares against. Starting value. */
export const DUPLICATE_POOL = 10;

export type DuplicateCheck =
  | { duplicate: false; checked: number }
  | {
      duplicate: true;
      /** `exact` when the normalised bodies are equal, `near` above the threshold. */
      match: "exact" | "near";
      similarity: number;
      memoryId: string;
      callNumber: string;
      checked: number;
    };

/**
 * The direct door's duplicate guard (section 13). Reports an active memory,
 * among those the candidate could be recalled with, whose body is equal to the
 * candidate's after normaliseBody, or at least DUPLICATE_SIMILARITY alike, so
 * `remember` can refuse to multiply it (and the caller can offer the
 * `duplicate` verb instead). The best match wins; ties go to the lower call
 * number. Reads only.
 */
export async function duplicateGuard(
  db: Db,
  candidate: NeighbourCandidate,
  options: { threshold?: number; vector?: readonly string[] | null } = {},
): Promise<DuplicateCheck> {
  const threshold = options.threshold ?? DUPLICATE_SIMILARITY;
  const pairs = visibleScopes(candidate);
  const neighbours = await findNeighbours(db, candidate, {
    limit: DUPLICATE_POOL,
    ...(options.vector !== undefined ? { vector: options.vector } : {}),
  });
  const pool = neighbours.map((n) => ({ memoryId: n.memoryId, callNumber: n.callNumber, body: n.body }));

  // A body of nothing but stopwords gives FTS nothing to search for; the same
  // text stored verbatim is still caught.
  const verbatim = await db.memory.findMany({
    where: { body: candidate.body.trim(), state: "active", ...scopeWhere(pairs) },
    select: { id: true, callNumber: true, body: true },
  });
  for (const row of verbatim) {
    if (!pool.some((entry) => entry.memoryId === row.id)) {
      pool.push({ memoryId: row.id, callNumber: row.callNumber, body: row.body });
    }
  }

  let best: { memoryId: string; callNumber: string; similarity: number } | null = null;
  for (const entry of pool) {
    const similarity = bodySimilarity(candidate.body, entry.body);
    if (similarity < threshold) continue;
    if (
      best === null ||
      similarity > best.similarity ||
      (similarity === best.similarity && entry.callNumber < best.callNumber)
    ) {
      best = { memoryId: entry.memoryId, callNumber: entry.callNumber, similarity };
    }
  }
  if (best === null) return { duplicate: false, checked: pool.length };
  return {
    duplicate: true,
    match: best.similarity === 1 ? "exact" : "near",
    similarity: best.similarity,
    memoryId: best.memoryId,
    callNumber: best.callNumber,
    checked: pool.length,
  };
}

// Applying a verb ------------------------------------------------------------

export type ReconcileOutcome =
  | { verb: "add"; memory: Memory }
  | {
      verb: "refine";
      memory: Memory;
      /** False when the wording matched what was stored. */
      changed: boolean;
      sourcesAdded: number;
      tagsAdded: string[];
    }
  | { verb: "supersede"; old: Memory; replacement: Memory }
  | { verb: "duplicate"; memory: Memory; sourcesAdded: number };

/**
 * The memory a refine, supersede or duplicate acts on, checked: it exists, it
 * is active, and the candidate could be recalled with it. Null for `add`.
 */
export async function resolveVerdictTarget(
  db: Db,
  verdict: ReconcileVerdict,
  candidate: { scope?: MemoryScope; scopeRef?: string | null },
): Promise<Memory | null> {
  if (verdict.verb === "add") return null;
  const memoryId = await memoryIdOf(db, verdict.target);
  const target = await db.memory.findUnique({ where: { id: memoryId } });
  if (!target) throw new DomainError("not_found", `No memory ${verdict.target} to ${verdict.verb}.`);
  if (target.state !== "active") {
    throw new DomainError(
      "refused",
      `${target.callNumber} is ${target.state}; ${verdict.verb} names an active entry.`,
    );
  }
  if (!isVisible(target, visibleScopes(candidate))) {
    throw new DomainError(
      "refused",
      `${target.callNumber} is outside the candidate's scope; a verb only acts on an entry the candidate could be recalled with.`,
    );
  }
  return target;
}

function requireSource(input: unknown): void {
  const sources = (input as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(sources) || sources.length === 0) throw new DomainError("refused", NO_SOURCE_MESSAGE);
}

/** The refine patch: the candidate's wording, and only what it actually says. */
function refinePatch(raw: MemoryCreateInput, parsed: ReturnType<typeof memoryCreateSchema.parse>): MemoryUpdateInput {
  return {
    title: parsed.title,
    body: parsed.body,
    ...(parsed.why !== undefined ? { why: parsed.why } : {}),
    ...(parsed.howToApply !== undefined ? { howToApply: parsed.howToApply } : {}),
    // The schema defaults importance to 3; a candidate that did not say keeps the target's.
    ...(raw.importance !== undefined ? { importance: parsed.importance } : {}),
  };
}

async function attachSources(
  tx: Tx,
  memoryId: string,
  sources: ReturnType<typeof memoryCreateSchema.parse>["sources"],
): Promise<number> {
  let added = 0;
  for (const entry of sources) if ((await attachSourceRaw(tx, memoryId, entry)).added) added += 1;
  return added;
}

/**
 * Commit one verb for one candidate, in one transaction:
 *
 * - `add`: createMemory. A new active memory, a new call number.
 * - `refine`: the target gains the candidate's sources and tags, then
 *   updateMemory with operation `refine` takes the candidate's title, body,
 *   and whichever of why, howToApply and importance it states. Same memory,
 *   same call number, one `refine` version holding all of it. Kind, shelf and
 *   scope stay the target's. When the wording matched, an `update` version
 *   records the new sources alone, and nothing is written when nothing moved.
 * - `supersede`: supersedeMemory. The target gets validTo and stays on its
 *   shelf marked superseded; the candidate is shelved at its own date, on the
 *   target's shelf unless it names one.
 * - `duplicate`: nothing new. The target gains the candidate's sources (one
 *   `update` version when any is new) and its lastConfirmedAt moves to the
 *   commit time.
 *
 * The candidate is a full create input for every verb, because no source, no
 * memory holds whatever the verb. Refine, supersede and duplicate name an
 * existing active target the candidate could be recalled with
 * (resolveVerdictTarget).
 */
export async function applyVerdict(
  db: Db,
  verdictInput: ReconcileVerdictInput,
  candidate: MemoryCreateInput,
  options: MutationOptions,
): Promise<ReconcileOutcome> {
  const verdict = parseInput(reconcileVerdictSchema, verdictInput);
  requireSource(candidate);
  const parsed = parseInput(memoryCreateSchema, candidate);

  return atomic(db, async (tx) => {
    const at = options.at ?? new Date();
    const mutation: MutationOptions = { ...options, at };
    const target = await resolveVerdictTarget(tx, verdict, parsed);

    switch (verdict.verb) {
      case "add":
        return { verb: "add", memory: await createMemory(tx, candidate, mutation) };

      case "refine": {
        const id = (target as Memory).id;
        const sourcesAdded = await attachSources(tx, id, parsed.sources);
        const tagsAdded = await attachTagsRaw(tx, id, parsed.tags);
        const result = await updateMemory(tx, { id }, refinePatch(candidate, parsed), {
          ...mutation,
          operation: "refine",
        });
        if (!result.changed && (sourcesAdded > 0 || tagsAdded.length > 0)) {
          await appendVersion(tx, id, { ...mutation, operation: "update" });
        }
        return {
          verb: "refine",
          memory: await tx.memory.findUniqueOrThrow({ where: { id } }),
          changed: result.changed,
          sourcesAdded,
          tagsAdded,
        };
      }

      case "supersede": {
        const result = await supersedeMemory(tx, { id: (target as Memory).id }, candidate, mutation);
        return { verb: "supersede", old: result.old, replacement: result.replacement };
      }

      case "duplicate": {
        const id = (target as Memory).id;
        const sourcesAdded = await attachSources(tx, id, parsed.sources);
        if (sourcesAdded > 0) await appendVersion(tx, id, { ...mutation, operation: "update" });
        const memory = await touchMemory(tx, { id }, { at });
        return { verb: "duplicate", memory, sourcesAdded };
      }
    }
  });
}
