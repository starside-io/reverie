// memory.retire. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.retire`; section 4, "Lifecycle" (`retired`: moved to the stacks,
// out of recall, still browsable on request); section 14, "browse versus
// recall"; gate "Supersede, never overwrite"; guardrail 9.

import { z } from "zod";

import { retireMemory } from "../../domain/memories.js";
import { defineTool } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import { memoryView, type MemoryView } from "../shared/views.js";
import { loadByCall, mutation, refuseSuperseded } from "../shared/write-common.js";

export interface RetireToolResult {
  memory: MemoryView;
}

export const tool = defineTool({
  name: "memory.retire",
  title: "Retire",
  kind: "write",
  summary:
    "Moves an active memory to the stacks: out of recall, still browsable on request, its number and history kept. Writes a retire version. Destroys nothing; memory.forget is the one that does.",
  input: z.object({ call: callSchema }),
  async handler(ctx, input): Promise<RetireToolResult> {
    const { row } = await loadByCall(ctx, input.call);
    await refuseSuperseded(ctx, row, "retired");
    const retired = await retireMemory(ctx.db, { id: row.id }, mutation(ctx));
    return { memory: await memoryView(ctx, retired.id) };
  },
  auditIds: (input, result) =>
    result ? { memoryIds: [result.memory.id], calls: [result.memory.call] } : { calls: [input.call] },
});
