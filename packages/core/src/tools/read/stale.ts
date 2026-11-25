// memory.stale. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.stale` (a starting reading); section 17, staleAfterDays.
//
// Active entries whose lastConfirmedAt is more than staleAfterDays before
// now, oldest confirmation first. Every kind counts, procedures included: a
// procedure never decays in recall, but a rule nobody has confirmed in half a
// year is still worth asking about. Starting reading.

import { z } from "zod";

import { DAY_MS } from "../../domain/recall/score.js";
import { RECALL_NOTICE } from "../../domain/recall/frame.js";
import { defineTool } from "../registry.js";
import { ENTRY_INCLUDE, limitSchema, toEntry, type EntryView } from "../shared/read-entries.js";

export interface StaleResult {
  notice: typeof RECALL_NOTICE;
  staleAfterDays: number;
  /** Confirmed before this instant means stale. */
  cutoff: string;
  items: Array<EntryView & { daysSinceConfirmed: number }>;
  /** How many are stale in all; items stops at limit. */
  total: number;
}

export const tool = defineTool({
  name: "memory.stale",
  title: "Stale entries",
  kind: "read",
  summary:
    "Active entries not confirmed in staleAfterDays, oldest confirmation first, with the days since each was last confirmed. memory.touch confirms one.",
  input: z.object({ limit: limitSchema(50, 200) }),
  async handler(ctx, input): Promise<StaleResult> {
    const days = ctx.config.staleAfterDays;
    const cutoff = new Date(ctx.now.getTime() - days * DAY_MS);
    const where = { state: "active", lastConfirmedAt: { lt: cutoff } };
    const [rows, total] = await Promise.all([
      ctx.db.memory.findMany({
        where,
        orderBy: [{ lastConfirmedAt: "asc" }, { callNumber: "asc" }],
        take: input.limit,
        include: ENTRY_INCLUDE,
      }),
      ctx.db.memory.count({ where }),
    ]);
    return {
      notice: RECALL_NOTICE,
      staleAfterDays: days,
      cutoff: cutoff.toISOString(),
      items: rows.map((row) => ({
        ...toEntry(row),
        daysSinceConfirmed: Math.floor((ctx.now.getTime() - row.lastConfirmedAt.getTime()) / DAY_MS),
      })),
      total,
    };
  },
  auditIds: (_input, result) =>
    result ? { memoryIds: result.items.map((item) => item.id), calls: result.items.map((item) => item.call) } : undefined,
});
