import type { Prisma } from "../../../generated/prisma/index.js";
import type { Db } from "../../domain/db.js";
import type { MemoryScope } from "../../schemas/enums.js";

/**
 * One RecallLog row per recall (section 14, guardrail 9): when, in which
 * scope, the memory ids in returned order with their scores, and the budget
 * packed against. Ids and numbers only. There is no field for the query text,
 * so there is no way to log it by accident.
 */
export interface RecallLogEntry {
  at: Date;
  scope: MemoryScope;
  scopeRef?: string | null;
  /** In returned order. An abstention logs an empty list. */
  items: ReadonlyArray<{ memoryId: string; score: number }>;
  budget: number;
}

export async function writeRecallLog(db: Db, entry: RecallLogEntry): Promise<{ id: string }> {
  const row = await db.recallLog.create({
    data: {
      at: entry.at,
      scope: entry.scope,
      scopeRef: entry.scope === "global" ? null : (entry.scopeRef ?? null),
      memoryIds: entry.items.map((item) => item.memoryId) as Prisma.InputJsonValue,
      scores: entry.items.map((item) => item.score) as Prisma.InputJsonValue,
      budget: entry.budget,
    },
    select: { id: true },
  });
  return row;
}
