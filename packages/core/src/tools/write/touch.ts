// memory.touch. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.touch` (starting reading: the owner says it is still true);
// section 14, "Scoring" (recency runs from lastConfirmedAt); section 17,
// `staleAfterDays`; guardrail 9.

import { z } from "zod";

import { touchMemory } from "../../domain/memories.js";
import { defineTool } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import { memoryView, type MemoryView } from "../shared/views.js";
import { loadByCall, refuseSuperseded } from "../shared/write-common.js";

export interface TouchToolResult {
  memory: MemoryView;
  /** lastConfirmedAt before this call, ISO. */
  previousConfirmedAt: string;
}

export const tool = defineTool({
  name: "memory.touch",
  title: "Still true",
  kind: "write",
  summary:
    "The owner says a memory is still true: moves its lastConfirmedAt to now, which is what recency and the stale list run from. Bookkeeping, so it writes no version. A superseded entry is refused: confirm the one that replaced it.",
  input: z.object({ call: callSchema }),
  async handler(ctx, input): Promise<TouchToolResult> {
    const { row } = await loadByCall(ctx, input.call);
    await refuseSuperseded(ctx, row, "confirmed as still true");
    await touchMemory(ctx.db, { id: row.id }, { at: ctx.now });
    return {
      memory: await memoryView(ctx, row.id),
      previousConfirmedAt: row.lastConfirmedAt.toISOString(),
    };
  },
  auditIds: (input, result) =>
    result ? { memoryIds: [result.memory.id], calls: [result.memory.call] } : { calls: [input.call] },
});
