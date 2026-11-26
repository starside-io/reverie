// memory.explain. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.explain`; section 14, "The framed result" (its last paragraph:
// "why did you bring that up", answered with the numbers) and "Scoring";
// guardrail 9 (the log holds ids and scores, never the query, so neither does
// this answer).

import { z } from "zod";

import { importanceFactor, recency, TRUST_WEIGHT, daysSince } from "../../domain/recall/score.js";
import type { MemoryKind, MemoryScope, TrustTier } from "../../schemas/enums.js";
import { defineTool, ToolError } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import { limitSchema } from "../shared/read-entries.js";
import { readLoggedScores, type LoggedRanks } from "../shared/recall-log.js";
import { findByCall } from "../shared/views.js";

export const explainInputSchema = z
  .object({
    /** Why was this memory brought up: the recalls that returned it, newest first. */
    call: callSchema.optional(),
    /** One recall, as memory.recall returned its id. */
    recallId: z.string().trim().min(1).max(128).optional(),
    limit: limitSchema(10, 100),
  })
  .refine((value) => value.call !== undefined || value.recallId !== undefined, {
    message: "Give a call number, a recallId, or both",
  });

export interface ExplainedItem {
  rank: number;
  memoryId: string;
  /** Its number now; null when it was forgotten since. */
  call: string | null;
  score: number;
}

export interface ExplainedRecall {
  recallId: string;
  at: string;
  scope: MemoryScope;
  scopeRef: string | null;
  budget: number;
  /** Everything that recall returned, in returned order. */
  items: ExplainedItem[];
  /** The asked memory's place in it, when a call was given. */
  match: { rank: number; score: number } | null;
  /**
   * Whether that recall's vector search ran. Null for a row logged before
   * ranks were, which says nothing either way.
   */
  vectors: boolean | null;
  /**
   * Each item's rank in the FTS search and in the vector search, parallel to
   * `items`, 1 based, null where it was absent from a list or the list did
   * not run. Null for a row logged before ranks were.
   */
  ranks: LoggedRanks[] | null;
  /** The asked memory's two ranks, when a call was given and the row holds them. */
  matchRanks: LoggedRanks | null;
}

/**
 * The parts of the score that do not depend on the query, as they stand now:
 * the factors recall multiplies relevance by. Relevance itself came from the
 * query, which is never logged, so it cannot be rebuilt here.
 */
export interface ExplainWeights {
  kind: MemoryKind;
  importance: number;
  importanceFactor: number;
  trust: TrustTier;
  trustWeight: number;
  lastConfirmedAt: string;
  /** Recency now, from lastConfirmedAt: 1 for a procedure. */
  recency: number;
  /** Null for a procedure, which has none. */
  halfLifeDays: number | null;
}

export interface ExplainResult {
  call: string | null;
  memoryId: string | null;
  weights: ExplainWeights | null;
  /** Newest first. */
  recalls: ExplainedRecall[];
}

type LogRow = { id: string; at: Date; scope: string; scopeRef: string | null; memoryIds: unknown; scores: unknown; budget: number };

function asArray<T>(value: unknown, guard: (entry: unknown) => entry is T): T[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.filter(guard) : [];
}

const isString = (entry: unknown): entry is string => typeof entry === "string";
const isNumber = (entry: unknown): entry is number => typeof entry === "number";

export const tool = defineTool({
  name: "memory.explain",
  title: "Explain a recall",
  kind: "read",
  summary:
    "Why a memory was recalled, read from RecallLog: each recall that returned it, its rank and score, its rank in the full text and the vector search, and the weights behind the score as they stand now. Or one recall by id, with everything it returned. Ids and numbers only, never the query.",
  input: explainInputSchema,
  async handler(ctx, input): Promise<ExplainResult> {
    const found = input.call ? await findByCall(ctx, input.call) : null;

    let logs: LogRow[];
    if (input.recallId) {
      const row = await ctx.db.recallLog.findUnique({ where: { id: input.recallId } });
      if (!row) throw new ToolError("not_found", `No recall with id ${input.recallId}.`);
      logs = [row];
    } else {
      const ids = await ctx.db.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT DISTINCT r."id" AS "id"
           FROM "RecallLog" AS r, json_each(r."memoryIds") AS j
          WHERE j."value" = ?`,
        found!.memoryId,
      );
      logs = await ctx.db.recallLog.findMany({
        where: { id: { in: ids.map((row) => row.id) } },
        orderBy: [{ at: "desc" }, { id: "asc" }],
        take: input.limit,
      });
    }

    const allIds = [...new Set(logs.flatMap((log) => asArray(log.memoryIds, isString)))];
    const live = await ctx.db.memory.findMany({ where: { id: { in: allIds } }, select: { id: true, callNumber: true } });
    const callOf = new Map(live.map((row) => [row.id, row.callNumber]));

    const recalls = logs.map((log): ExplainedRecall => {
      const memoryIds = asArray(log.memoryIds, isString);
      const logged = readLoggedScores(memoryIds.length, asArray(log.scores, isNumber));
      const scores = logged.scores;
      const items = memoryIds.map((memoryId, index) => ({
        rank: index + 1,
        memoryId,
        call: callOf.get(memoryId) ?? null,
        score: scores[index] ?? 0,
      }));
      const hit = found ? items.find((item) => item.memoryId === found.memoryId) : undefined;
      return {
        recallId: log.id,
        at: log.at.toISOString(),
        scope: log.scope as MemoryScope,
        scopeRef: log.scopeRef,
        budget: log.budget,
        items,
        match: hit ? { rank: hit.rank, score: hit.score } : null,
        vectors: logged.vectors,
        ranks: logged.ranks,
        matchRanks: hit && logged.ranks ? (logged.ranks[hit.rank - 1] ?? null) : null,
      };
    });

    let weights: ExplainWeights | null = null;
    if (found) {
      const row = await ctx.db.memory.findUniqueOrThrow({ where: { id: found.memoryId } });
      const kind = row.kind as MemoryKind;
      const trust = row.trust as TrustTier;
      weights = {
        kind,
        importance: row.importance,
        importanceFactor: importanceFactor(row.importance),
        trust,
        trustWeight: TRUST_WEIGHT[trust],
        lastConfirmedAt: row.lastConfirmedAt.toISOString(),
        recency: recency(kind, daysSince(row.lastConfirmedAt, ctx.now), ctx.config.halfLifeDays),
        halfLifeDays: kind === "procedure" ? null : ctx.config.halfLifeDays[kind],
      };
    }

    return { call: found?.call ?? null, memoryId: found?.memoryId ?? null, weights, recalls };
  },
  auditIds: (input, result) => ({
    ...(input.call ? { calls: [input.call] } : {}),
    ...(result?.memoryId ? { memoryIds: [result.memoryId] } : {}),
  }),
});
