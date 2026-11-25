// memory.redact. docs/SPEC.md section 15, "Needs OK, 6" table, row
// `memory.redact` (a starting reading); section 11, MemoryVersion
// ("Redaction clears the content and keeps the actor and the time");
// guardrail 1.

import { z } from "zod";

import { redactMemory } from "../../domain/versions.js";
import { defineTool } from "../registry.js";
import { callSchema, confirmedByUser } from "../shared/inputs.js";
import { findByCall } from "../shared/views.js";

export interface RedactToolResult {
  redacted: {
    memoryId: string;
    call: string;
    /** Past versions whose content and hash were cleared. Operation, actor and time stay on each. */
    versionsCleared: number;
  };
}

export const tool = defineTool({
  name: "memory.redact",
  title: "Redact history",
  kind: "needs-ok",
  summary:
    "Clears the content of every past version of a memory that stays: the memory as it reads now is kept, what it said before is gone from history, and each version keeps its operation, actor and time. Takes a current or an old number. Show the owner what will be cleared and get an explicit yes first.",
  input: z.object({ call: callSchema, confirmedByUser }),
  async handler(ctx, input): Promise<RedactToolResult> {
    const found = await findByCall(ctx, input.call);
    const result = await redactMemory(ctx.db, found.memoryId, { actor: ctx.actor, at: ctx.now });
    return { redacted: { memoryId: found.memoryId, call: found.call, versionsCleared: result.redacted } };
  },
  auditIds: (input, result) =>
    result ? { memoryIds: [result.redacted.memoryId], calls: [result.redacted.call] } : { calls: [input.call] },
});
