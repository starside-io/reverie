// memory.review. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.review`; section 12, the review port (the host's queue, never the
// silo); section 8, "Writing it: one telling, three proposals" (groups: a
// group is a heading, not a transaction) and "Two standalone hosts" (the
// occasion rides inside the episode's proposal, occasion pending); section
// 20, the front desk.

import { z } from "zod";

import { PEOPLE_TOOLS } from "../../domain/people-link.js";
import type { ProposalGroup, ProposalState, QueuedProposal } from "../../ports.js";
import { defineTool } from "../registry.js";
import { splitPayload } from "../shared/confirm-proposals.js";
import { readFrontDesk, type FrontDeskLink } from "../shared/front-desk.js";

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

/**
 * One line under a group heading. A proposal is one step; the occasion and
 * each note riding inside it are steps of their own, decided one by one with
 * memory.decide's `pending`.
 */
export interface ReviewStep {
  /** 1, 2, 3 in the order section 8 commits them: occasions, then memories, then notes. */
  step: number;
  part: "occasion" | "memory" | "note";
  proposalId: string;
  /** For a note: its place in memory.decide's `pending.notes`. */
  noteIndex?: number;
  /** The call it becomes: a memory tool here, or the people module's tool for whoever confirmed to run. */
  tool: string;
  summary: string;
}

export interface ReviewGroup {
  id: string;
  title: string;
  detail: string | null;
  steps: ReviewStep[];
}

export interface ReviewResult {
  state: ProposalState | "all";
  /** Oldest first, as queued. */
  proposals: ReviewItem[];
  /** The proposals that share a group, as headings with their steps. A proposal with no group is in proposals only. */
  groups: ReviewGroup[];
  /** The Fellowship link's part of the front desk: occasion pending, occasions with no story yet, unresolved names. */
  frontDesk: FrontDeskLink;
}

function stepsFor(row: QueuedProposal): Array<Omit<ReviewStep, "step">> {
  let draft = null;
  try {
    draft = splitPayload(row.payload).draft;
  } catch {
    draft = null;
  }
  const steps: Array<Omit<ReviewStep, "step">> = [];
  const occasion = draft?.pendingOccasion;
  if (occasion) {
    const who = occasion.participants.length > 0 ? `, with ${occasion.participants.join(", ")}` : ", nobody named as in it yet";
    steps.push({
      part: "occasion",
      proposalId: row.id,
      tool: PEOPLE_TOOLS.logInteraction,
      summary: `Occasion: ${occasion.title}, ${occasion.type}, ${occasion.occurredAt}${who}`,
    });
  }
  steps.push({ part: "memory", proposalId: row.id, tool: row.tool, summary: row.summary ?? row.tool });
  for (const [index, note] of (draft?.pendingNotes ?? []).entries()) {
    steps.push({
      part: "note",
      proposalId: row.id,
      noteIndex: index,
      tool: PEOPLE_TOOLS.addNote,
      summary: `Note on ${note.person}: ${note.body}`,
    });
  }
  return steps;
}

const ORDER: Record<ReviewStep["part"], number> = { occasion: 0, memory: 1, note: 2 };

export const tool = defineTool({
  name: "memory.review",
  title: "Review queue",
  kind: "read",
  summary:
    "The proposals waiting for the owner, each naming the tool it would run and the payload, and the groups they share as headings with numbered steps: an occasion and notes riding inside an episode's proposal are steps of their own, decided one by one with memory.decide's pending. Also the front desk for the people link: occasion pending (with the call to resume), occasions with no story yet, and unresolved names. Confirm or discard with memory.decide.",
  input: z.object({ state: z.enum(["pending", "confirmed", "discarded", "all"]).default("pending") }),
  async handler(ctx, input): Promise<ReviewResult> {
    const queued = await ctx.ports.review.list(input.state);
    const memoryIds = [...new Set(queued.flatMap((row) => (row.memoryId ? [row.memoryId] : [])))];
    const live =
      memoryIds.length === 0
        ? []
        : await ctx.db.memory.findMany({ where: { id: { in: memoryIds } }, select: { id: true, callNumber: true } });
    const callOf = new Map(live.map((row) => [row.id, row.callNumber]));
    const sorted = [...queued].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

    const groups = new Map<string, { group: ProposalGroup; steps: Array<Omit<ReviewStep, "step">> }>();
    for (const row of sorted) {
      if (!row.group) continue;
      const entry = groups.get(row.group.id) ?? { group: row.group, steps: [] };
      entry.steps.push(...stepsFor(row));
      groups.set(row.group.id, entry);
    }

    return {
      state: input.state,
      proposals: sorted.map((row) => ({
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
      groups: [...groups.values()].map(({ group, steps }) => ({
        id: group.id,
        title: group.title,
        detail: group.detail ?? null,
        // Stable: within a part, in the order queued.
        steps: steps
          .map((step, index) => ({ step, index }))
          .sort((a, b) => ORDER[a.step.part] - ORDER[b.step.part] || a.index - b.index)
          .map(({ step }, index) => ({ step: index + 1, ...step })),
      })),
      frontDesk: await readFrontDesk(ctx),
    };
  },
  auditIds: (_input, result) => (result ? { proposalIds: result.proposals.map((row) => row.id) } : undefined),
});
