// memory.recall. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.recall`; section 14, the whole recall path (search twice, fuse,
// weigh, floor and pack, frame, abstention); section 4, "Scopes" and
// "Projects" (what a session may recall); section 17 (halfLifeDays, recall,
// embedding); guardrails 9 and 10; gates "Abstention" and "Scope isolation".

import { z } from "zod";

import type { Prisma } from "../../../generated/prisma/index.js";
import { atomic } from "../../domain/db.js";
import { decodeVector, rankByCosine } from "../../domain/queries/vectors.js";
import { fuse } from "../../domain/recall/fuse.js";
import { packAndFrame, RECALL_NOTICE, type FramedItem, type ScoredMemory } from "../../domain/recall/frame.js";
import { scoreMemory } from "../../domain/recall/score.js";
import { dateTimeSchema } from "../../schemas/common.js";
import type { MemoryKind, MemoryState, SourceKind, TrustTier } from "../../schemas/enums.js";
import { searchMemoryFts, toNeighbourQuery } from "../../storage/search.js";
import { defineTool, type ToolContext } from "../registry.js";
import { callPrefixWhere, callQuerySchema, tagFilterSchema, tagWhere } from "../shared/read-entries.js";
import { scopeWhere, visibleScopes } from "../shared/read-scope.js";
import { writeRecallLog } from "../shared/recall-log.js";

/** How many FTS hits one recall reads before filtering. Starting value. */
export const FTS_POOL = 200;

export const recallInputSchema = z.object({
  /** What the task is about, in words. Never logged. */
  query: z.string().trim().min(1, "A query is required").max(2000),
  /** Only this shelf or call number prefix: "WRK/NST", "LIF/GTH/2026-12". */
  shelf: callQuerySchema.optional(),
  /** Only memories carrying at least one of these tags. */
  tags: tagFilterSchema,
  /** No memory carrying any of these tags. */
  excludeTags: tagFilterSchema,
  /** What was valid at this time, rather than what is active now. */
  asOf: dateTimeSchema.optional(),
  /** Token budget for this call. Defaults to recall.tokenBudget. */
  budget: z.number().int().min(100).max(20000).optional(),
  /** Item cap for this call. Defaults to recall.maxItems. */
  maxItems: z.number().int().min(1).max(50).optional(),
});

export type RecallInput = z.input<typeof recallInputSchema>;

/** How the candidates were found. FTS alone says why. */
export interface RecallRetrieval {
  vectors: boolean;
  /**
   * Present when vectors did not run. `partial_embeddings`: some active
   * memories this recall could return have no vector of the configured model
   * yet (a re-embed under way, or an embed that failed), so ranking by vector
   * would favour the part of the library that has one.
   */
  ftsOnlyReason?: "no_models_port" | "no_embedding_model" | "no_embeddings" | "partial_embeddings";
  /** With `partial_embeddings`: how many of those memories have no vector yet. */
  missingEmbeddings?: number;
}

export type RecallResult =
  | {
      sufficient: true;
      notice: typeof RECALL_NOTICE;
      items: Array<FramedItem & { id: string }>;
      retrieval: RecallRetrieval;
      /**
       * The RecallLog row this call wrote, for memory.explain. Null while
       * incognito is on: incognito writes nothing (section 7), so no row is
       * logged and no recall is counted.
       */
      recallId: string | null;
    }
  | { items: []; sufficient: false };

const CANDIDATE_INCLUDE = {
  tags: { include: { tag: { select: { slug: true } } } },
  refs: true,
  sources: { include: { source: true } },
} as const satisfies Prisma.MemoryInclude;

type CandidateRow = Prisma.MemoryGetPayload<{ include: typeof CANDIDATE_INCLUDE }>;

function frameMemory(row: CandidateRow): Omit<ScoredMemory, "score"> {
  const attendees = row.refs
    .filter((ref) => ref.role === "attendee")
    .map((ref) => ref.uri ?? ref.label)
    .sort();
  const occasionRef = row.refs.find((ref) => ref.role === "occasion");
  // The first source cited, oldest first: the one the memory was made from.
  const first = [...row.sources].sort(
    (a, b) =>
      a.source.createdAt.getTime() - b.source.createdAt.getTime() ||
      (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0),
  )[0];
  return {
    call: row.callNumber,
    kind: row.kind as MemoryKind,
    body: row.body,
    tags: row.tags.map((entry) => entry.tag.slug).sort(),
    attendees,
    occasion: occasionRef ? (occasionRef.uri ?? occasionRef.label) : null,
    trust: row.trust as TrustTier,
    occurredOn: row.occurredOn,
    source: first
      ? { kind: first.source.kind as SourceKind, label: first.source.label }
      : { kind: "conversation", label: "unknown" },
  };
}

/** The filter every candidate passes: scope, state or validity, shelf, tags. */
function candidateWhere(
  input: z.output<typeof recallInputSchema>,
  scopes: Prisma.MemoryWhereInput,
): { where: Prisma.MemoryWhereInput; states: MemoryState[] } {
  const and: Prisma.MemoryWhereInput[] = [scopes, ...tagWhere(input.tags, input.excludeTags)];
  let states: MemoryState[] = ["active"];
  if (input.asOf) {
    // What was valid then: an entry superseded since was active at the time.
    // Retired entries are in the stacks and out of recall either way.
    states = ["active", "superseded"];
    and.push({ validFrom: { lte: input.asOf } }, { OR: [{ validTo: null }, { validTo: { gt: input.asOf } }] });
  }
  and.push({ state: { in: states } });
  if (input.shelf) and.push(callPrefixWhere(input.shelf));
  return { where: { AND: and }, states };
}

async function vectorList(
  ctx: ToolContext,
  query: string,
  where: Prisma.MemoryWhereInput,
): Promise<{ list: string[] | null; retrieval: RecallRetrieval }> {
  const models = ctx.ports.models;
  if (!models) return { list: null, retrieval: { vectors: false, ftsOnlyReason: "no_models_port" } };
  const model = ctx.config.embedding.model;
  if (!model) return { list: null, retrieval: { vectors: false, ftsOnlyReason: "no_embedding_model" } };

  const rows = await ctx.db.embedding.findMany({
    where: { model, memory: where },
    select: { memoryId: true, dim: true, vector: true },
  });
  const candidates = rows.flatMap((row) => {
    const vector = decodeVector(row.vector, row.dim);
    return vector ? [{ id: row.memoryId, vector }] : [];
  });
  if (candidates.length === 0) return { list: null, retrieval: { vectors: false, ftsOnlyReason: "no_embeddings" } };

  // Until every active candidate has a vector of this model (section 17: until
  // the re-embed finishes), recall runs on FTS alone and says so.
  const missing = await ctx.db.memory.count({
    where: {
      AND: [where, { state: "active" }, { OR: [{ embedding: null }, { embedding: { model: { not: model } } }] }],
    },
  });
  if (missing > 0) {
    return {
      list: null,
      retrieval: { vectors: false, ftsOnlyReason: "partial_embeddings", missingEmbeddings: missing },
    };
  }

  const [embedded] = await models.embed([query]);
  if (!embedded) return { list: null, retrieval: { vectors: false, ftsOnlyReason: "no_embeddings" } };
  return { list: rankByCosine(embedded, candidates), retrieval: { vectors: true } };
}

export const tool = defineTool({
  name: "memory.recall",
  title: "Recall",
  kind: "read",
  summary:
    "Ranked, framed, budgeted retrieval for a task: hybrid search fused by rank, weighed by recency, importance and trust, floored and packed into the token budget. Abstains with sufficient: false when nothing clears the floor. Writes one RecallLog row, except while incognito is on.",
  input: recallInputSchema,
  async handler(ctx, input): Promise<RecallResult> {
    const scopes = await visibleScopes(ctx);
    const { where, states } = candidateWhere(input, scopeWhere(scopes.pairs));

    // FTS: any of the query's words, BM25 order, then the full filter, keeping that order.
    const match = toNeighbourQuery(input.query);
    const ftsHits = match
      ? await searchMemoryFts(ctx.db, match.expression, { states, scopes: scopes.pairs, limit: FTS_POOL })
      : [];
    const allowed = new Set(
      ftsHits.length === 0
        ? []
        : (
            await ctx.db.memory.findMany({
              where: { AND: [where, { id: { in: ftsHits.map((hit) => hit.id) } }] },
              select: { id: true },
            })
          ).map((row) => row.id),
    );
    const fts = ftsHits.map((hit) => hit.id).filter((id) => allowed.has(id));

    const vectors = await vectorList(ctx, input.query, where);
    const fused = fuse({ fts, vector: vectors.list });

    const rows =
      fused.length === 0
        ? []
        : await ctx.db.memory.findMany({
            where: { id: { in: fused.map((hit) => hit.id) } },
            include: CANDIDATE_INCLUDE,
          });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const candidates: Array<ScoredMemory & { id: string }> = [];
    for (const hit of fused) {
      const row = byId.get(hit.id);
      if (!row) continue;
      const { score } = scoreMemory(
        {
          relevance: hit.relevance,
          kind: row.kind as MemoryKind,
          importance: row.importance,
          trust: row.trust as TrustTier,
          lastConfirmedAt: row.lastConfirmedAt,
        },
        { now: ctx.now, halfLifeDays: ctx.config.halfLifeDays },
      );
      candidates.push({ ...frameMemory(row), score, id: row.id });
    }

    const limits = {
      floor: ctx.config.recall.floor,
      maxItems: input.maxItems ?? ctx.config.recall.maxItems,
      tokenBudget: input.budget ?? ctx.config.recall.tokenBudget,
    };
    const { result, packed } = packAndFrame(candidates, limits, ctx.now);
    const idByCall = new Map(candidates.map((candidate) => [candidate.call, candidate.id]));
    const returned = packed.items.map((entry) => ({
      memoryId: idByCall.get(entry.framed.call) as string,
      score: entry.score,
    }));

    // The one write a recall makes: its log row, and the recall bookkeeping
    // on what it returned. updatedAt is kept as it was: being recalled is not
    // an edit. Skipped while incognito is on, because incognito writes nothing.
    const log = ctx.incognito ? null : await atomic(ctx.db, async (tx) => {
      const row = await writeRecallLog(tx, {
        at: ctx.now,
        scope: scopes.logScope.scope,
        scopeRef: scopes.logScope.scopeRef,
        items: returned,
        budget: limits.tokenBudget,
      });
      for (const item of returned) {
        const current = byId.get(item.memoryId);
        if (!current) continue;
        await tx.memory.update({
          where: { id: item.memoryId },
          data: { lastRecalledAt: ctx.now, recallCount: { increment: 1 }, updatedAt: current.updatedAt },
        });
      }
      return row;
    });

    if (!result.sufficient) return { items: [], sufficient: false };
    return {
      sufficient: true,
      notice: RECALL_NOTICE,
      items: result.items.map((item) => ({ ...item, id: idByCall.get(item.call) as string })),
      retrieval: vectors.retrieval,
      recallId: log?.id ?? null,
    };
  },
  auditIds: (_input, result) =>
    result && result.sufficient
      ? { memoryIds: result.items.map((item) => item.id), calls: result.items.map((item) => item.call) }
      : undefined,
});
