// memory.review. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.review`; section 12, the review port (the host's queue, never the
// silo); section 8, "Writing it: one telling, three proposals" (groups).

import { z } from "zod";

import type { ProposalGroup, ProposalState } from "../../ports.js";
import { defineTool } from "../registry.js";

export interface ReviewItem {
  id: string;
  /** The tool that would run on confirmation. */
  tool: string;
  /** The payload it would run with, exactly as queued. */
  payload: unknown;
  summary: string | null;
  memoryId: string | null;
  /** The memory's number now, when the proposal is about one that is still shelved. */
  call: string | null;
  group: ProposalGroup | null;
  state: ProposalState;
  createdAt: string;
  decidedAt: string | null;
}

export interface ReviewResult {
  state: ProposalState | "all";
  /** Oldest first, as queued. */
  proposals: ReviewItem[];
}

export const tool = defineTool({
  name: "memory.review",
  title: "Review queue",
  kind: "read",
  summary:
    "The proposals waiting for the owner, each naming the tool it would run and the payload, with its group heading when it has one. Confirm or discard one with memory.decide.",
  input: z.object({ state: z.enum(["pending", "confirmed", "discarded", "all"]).default("pending") }),
  async handler(ctx, input): Promise<ReviewResult> {
    const queued = await ctx.ports.review.list(input.state);
    const memoryIds = [...new Set(queued.flatMap((row) => (row.memoryId ? [row.memoryId] : [])))];
    const live =
      memoryIds.length === 0
        ? []
        : await ctx.db.memory.findMany({ where: { id: { in: memoryIds } }, select: { id: true, callNumber: true } });
    const callOf = new Map(live.map((row) => [row.id, row.callNumber]));
    return {
      state: input.state,
      proposals: [...queued]
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        .map((row) => ({
          id: row.id,
          tool: row.tool,
          payload: row.payload,
          summary: row.summary ?? null,
          memoryId: row.memoryId ?? null,
          call: row.memoryId ? (callOf.get(row.memoryId) ?? null) : null,
          group: row.group ?? null,
          state: row.state,
          createdAt: row.createdAt,
          decidedAt: row.decidedAt,
        })),
    };
  },
  auditIds: (_input, result) => (result ? { proposalIds: result.proposals.map((row) => row.id) } : undefined),
});
