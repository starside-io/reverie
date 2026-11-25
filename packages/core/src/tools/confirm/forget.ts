// memory.forget. docs/SPEC.md section 15, "Needs OK, 6" table, row
// `memory.forget`; section 11 (CallNumberAlias holds forgotten numbers,
// MemoryVersion redaction); section 4, "Lifecycle" (`forgotten`); section 16,
// gate "Forget is real"; section 18 (`memory.memory.forgotten`); guardrail 1.

import { z } from "zod";

import { forgetMemory } from "../../domain/versions.js";
import { defineTool } from "../registry.js";
import { callSchema, confirmedByUser } from "../shared/inputs.js";
import { findByCall } from "../shared/views.js";

export interface ForgetToolResult {
  forgotten: {
    memoryId: string;
    call: string;
    /** Every number that named it. Each now points at nothing and is never reissued. */
    retiredNumbers: string[];
  };
  /** Sources cited by no other memory, deleted with it. */
  sourcesDeleted: number;
  /** Tags no other memory carries and no project points at, deleted with it. */
  tagsDeleted: number;
}

export const tool = defineTool({
  name: "memory.forget",
  title: "Forget a memory",
  kind: "needs-ok",
  summary:
    "Forgets one memory for good: the row, its FTS entry, its vector and any tag left on no other memory go, every version loses its content, and its call number is retired, never reissued. Takes a current or an old number. Show the owner the memory and get an explicit yes first.",
  input: z.object({ call: callSchema, confirmedByUser }),
  async handler(ctx, input): Promise<ForgetToolResult> {
    const found = await findByCall(ctx, input.call);
    const result = await forgetMemory(ctx.db, { id: found.memoryId }, { actor: ctx.actor, at: ctx.now });

    ctx.emit("memory.memory.forgotten", {
      memoryId: result.memoryId,
      call: result.callNumber,
      retiredNumbers: result.retiredNumbers,
    });

    return {
      forgotten: {
        memoryId: result.memoryId,
        call: result.callNumber,
        retiredNumbers: result.retiredNumbers,
      },
      sourcesDeleted: result.sourcesDeleted,
      tagsDeleted: result.tagsDeleted,
    };
  },
  auditIds: (input, result) =>
    result
      ? { memoryIds: [result.forgotten.memoryId], calls: result.forgotten.retiredNumbers }
      : { calls: [input.call] },
});
