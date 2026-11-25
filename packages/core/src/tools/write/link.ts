// memory.link. docs/SPEC.md section 15, "Write, 13" table, row `memory.link`;
// section 11, `MemoryLink` (`contradicts` is what the conflicts screen
// reads); guardrail 9.

import { z } from "zod";

import { createLink } from "../../domain/links.js";
import { LinkRelation } from "../../schemas/enums.js";
import { defineTool } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import { loadByCall } from "../shared/write-common.js";

export interface LinkToolResult {
  link: {
    id: string;
    relation: LinkRelation;
    fromId: string;
    toId: string;
    /** The numbers each end has now. */
    from: string;
    to: string;
  };
}

export const tool = defineTool({
  name: "memory.link",
  title: "Link memories",
  kind: "write",
  summary:
    "Writes a MemoryLink from one memory to another: elaborates, contradicts or derived-from. contradicts is what memory.conflicts reads, and reads the same both ways. A memory is never linked to itself, and a link that already exists is refused.",
  input: z.object({
    /** Current or old number. */
    from: callSchema,
    to: callSchema,
    relation: LinkRelation,
  }),
  async handler(ctx, input): Promise<LinkToolResult> {
    const from = await loadByCall(ctx, input.from);
    const to = await loadByCall(ctx, input.to);
    const link = await createLink(ctx.db, { fromId: from.row.id, toId: to.row.id, relation: input.relation });
    return {
      link: {
        id: link.id,
        relation: link.relation as LinkRelation,
        fromId: link.fromId,
        toId: link.toId,
        from: from.row.callNumber,
        to: to.row.callNumber,
      },
    };
  },
  auditIds: (input, result) =>
    result
      ? { memoryIds: [result.link.fromId, result.link.toId], calls: [result.link.from, result.link.to] }
      : { calls: [input.from, input.to] },
});
