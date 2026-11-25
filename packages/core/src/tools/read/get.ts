// memory.get. docs/SPEC.md section 15, "Read, 18" table, row `memory.get`;
// section 5, "The call number" (it survives a move, it is never reissued) and
// "Finding things" (`get { call }`).

import { z } from "zod";

import { RECALL_NOTICE } from "../../domain/recall/frame.js";
import { defineTool } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import { findByCall, memoryView, type MemoryView } from "../shared/views.js";

export interface GetResult {
  notice: typeof RECALL_NOTICE;
  /** True when the number asked for is an old one: `memory.call` is where it lives now. */
  moved: boolean;
  memory: MemoryView;
}

export const tool = defineTool({
  name: "memory.get",
  title: "Get a memory",
  kind: "read",
  summary:
    "One memory by its call number, whatever its state. An old number from before a reshelve still resolves, and the answer gives the number it has now. A forgotten number answers not_found and says it was forgotten.",
  input: z.object({ call: callSchema }),
  async handler(ctx, input): Promise<GetResult> {
    const found = await findByCall(ctx, input.call);
    const memory = await memoryView(ctx, found.memoryId);
    return { notice: RECALL_NOTICE, moved: found.via === "alias", memory };
  },
  auditIds: (input, result) => ({
    calls: result ? [input.call, result.memory.call] : [input.call],
    ...(result ? { memoryIds: [result.memory.id] } : {}),
  }),
});
