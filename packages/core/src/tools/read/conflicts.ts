// memory.conflicts. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.conflicts`; section 11, MemoryLink (relation `contradicts`).

import { z } from "zod";

import type { MemoryState } from "../../schemas/enums.js";
import { defineTool } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import { limitSchema } from "../shared/read-entries.js";
import { findByCall } from "../shared/views.js";

export interface ConflictSide {
  memoryId: string;
  call: string;
  title: string;
  state: MemoryState;
}

export interface ConflictPair {
  linkId: string;
  createdAt: string;
  /** The memory the link was written from: it contradicts `to`. */
  from: ConflictSide;
  to: ConflictSide;
}

export interface ConflictsResult {
  /** By the from side's call number, then the to side's. */
  pairs: ConflictPair[];
  total: number;
}

const SIDE = { select: { id: true, callNumber: true, title: true, state: true } } as const;

export const tool = defineTool({
  name: "memory.conflicts",
  title: "Conflicts",
  kind: "read",
  summary:
    "Pairs joined by a contradicts link, each side with its number, title and state. With a call number, only the pairs that memory is in.",
  input: z.object({
    /** Only the pairs this memory is on either side of. */
    call: callSchema.optional(),
    limit: limitSchema(50, 200),
  }),
  async handler(ctx, input): Promise<ConflictsResult> {
    const found = input.call ? await findByCall(ctx, input.call) : null;
    const where = {
      relation: "contradicts",
      ...(found ? { OR: [{ fromId: found.memoryId }, { toId: found.memoryId }] } : {}),
    };
    const links = await ctx.db.memoryLink.findMany({ where, include: { from: SIDE, to: SIDE } });
    const side = (row: { id: string; callNumber: string; title: string; state: string }): ConflictSide => ({
      memoryId: row.id,
      call: row.callNumber,
      title: row.title,
      state: row.state as MemoryState,
    });
    const pairs = links
      .map((link) => ({ linkId: link.id, createdAt: link.createdAt.toISOString(), from: side(link.from), to: side(link.to) }))
      .sort((a, b) =>
        a.from.call < b.from.call ? -1 : a.from.call > b.from.call ? 1 : a.to.call < b.to.call ? -1 : a.to.call > b.to.call ? 1 : 0,
      );
    return { pairs: pairs.slice(0, input.limit), total: pairs.length };
  },
  auditIds: (_input, result) =>
    result
      ? {
          memoryIds: result.pairs.flatMap((pair) => [pair.from.memoryId, pair.to.memoryId]),
          calls: result.pairs.flatMap((pair) => [pair.from.call, pair.to.call]),
        }
      : undefined,
});
