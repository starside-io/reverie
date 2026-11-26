import type { Prisma } from "../../../generated/prisma/index.js";
import type { Db } from "../../domain/db.js";
import type { MemoryScope } from "../../schemas/enums.js";

/**
 * One RecallLog row per recall (section 14, guardrail 9): when, in which
 * scope, the memory ids in returned order with their scores, and the budget
 * packed against. Ids and numbers only. There is no field for the query text,
 * so there is no way to log it by accident.
 *
 * The ranks each item had in the two searches ride in `scores` too, so
 * memory.explain can show both without a migration. Starting layout, for N
 * items:
 *
 *   scores = [score_1 .. score_N, rankFts_1 .. rankFts_N, rankVec_1 .. rankVec_N]
 *
 * A rank of 0 means the item was absent from that list; a vector rank of -1
 * means the vector search did not run. A row of exactly N scores (written
 * before ranks were logged) reads as having no ranks.
 */
export interface RecallLogEntry {
  at: Date;
  scope: MemoryScope;
  scopeRef?: string | null;
  /** In returned order. An abstention logs an empty list. */
  items: ReadonlyArray<{ memoryId: string; score: number; rankFts?: number | null; rankVec?: number | null }>;
  budget: number;
  /** Whether the vector search ran. Absent writes no ranks. */
  vectors?: boolean;
}

export async function writeRecallLog(db: Db, entry: RecallLogEntry): Promise<{ id: string }> {
  const scores = entry.items.map((item) => item.score);
  if (entry.vectors !== undefined && entry.items.length > 0) {
    scores.push(...entry.items.map((item) => item.rankFts ?? 0));
    scores.push(...entry.items.map((item) => (entry.vectors ? (item.rankVec ?? 0) : -1)));
  }
  const row = await db.recallLog.create({
    data: {
      at: entry.at,
      scope: entry.scope,
      scopeRef: entry.scope === "global" ? null : (entry.scopeRef ?? null),
      memoryIds: entry.items.map((item) => item.memoryId) as Prisma.InputJsonValue,
      scores: scores as Prisma.InputJsonValue,
      budget: entry.budget,
    },
    select: { id: true },
  });
  return row;
}

/** One item's ranks as a log row holds them, null where absent. */
export interface LoggedRanks {
  fts: number | null;
  vector: number | null;
}

/**
 * Reads a row's scores back: the scores parallel to its ids, and the ranks
 * when the row holds them. `vectors` is null for a row with no ranks.
 */
export function readLoggedScores(
  count: number,
  raw: readonly number[],
): { scores: number[]; ranks: LoggedRanks[] | null; vectors: boolean | null } {
  const scores = raw.slice(0, count);
  if (count === 0 || raw.length !== count * 3) return { scores, ranks: null, vectors: null };
  const fts = raw.slice(count, count * 2);
  const vec = raw.slice(count * 2, count * 3);
  const vectors = !vec.every((value) => value === -1);
  const ranks = fts.map((rank, index) => ({
    fts: rank > 0 ? rank : null,
    vector: vectors && (vec[index] ?? 0) > 0 ? (vec[index] as number) : null,
  }));
  return { scores, ranks, vectors };
}
