// memory.decide. docs/SPEC.md section 15, "Needs OK, 6" table, row
// `memory.decide`; section 8, "Two standalone hosts: the assistant is the
// bridge" (the pending occasion and the followUp); section 13, "The call
// number is issued at commit" (a discarded proposal burns no number);
// section 4, "Trust" (confirmed: drafted by a model, confirmed in review);
// guardrails 1, 3 and 8.
//
// As Fellowship's people.decide: confirming runs the tool the proposal names,
// with the payload the owner read, through the registry; the proposal is
// marked confirmed only once that write succeeded. Rejecting runs nothing.
// A drafted memory (remember, update, supersede, add_source with a draft
// envelope) commits through that tool's own commit function instead, with
// the draft's provenance, so it lands in one commit at the right trust.

import { z } from "zod";

import type { QueuedProposal } from "../../ports.js";
import { defineTool, toToolError, ToolError, type ToolContext } from "../registry.js";
import { draftedProvenance, type DraftedProvenance } from "../shared/confirm-drafted.js";
import {
  assertProposable,
  followUpFor,
  splitPayload,
  type FollowUp,
} from "../shared/confirm-proposals.js";
import { confirmedByUser } from "../shared/inputs.js";
import { addSourceInputSchema, commitAddSource } from "../write/add-source.js";
import { commitRemember, rememberInputSchema } from "../write/remember.js";
import { commitSupersede, supersedeInputSchema } from "../write/supersede.js";
import { commitUpdate, updateInputSchema } from "../write/update.js";

/**
 * The write tools a drafted memory commits through. For these, decide does
 * not go through the public tool: it validates the payload with the tool's
 * own input schema and calls the tool's commit function with the draft's
 * provenance, so the memory commits once, at the trust a draft earns, citing
 * the material it was drafted from. Every other proposal runs its tool
 * through the registry as the owner would call it.
 */
interface DraftedCommit {
  schema: z.ZodTypeAny;
  commit(ctx: ToolContext, input: never, drafted: DraftedProvenance): Promise<unknown>;
}

const DRAFTED_COMMITS: Readonly<Record<string, DraftedCommit>> = {
  "memory.remember": { schema: rememberInputSchema, commit: commitRemember as DraftedCommit["commit"] },
  "memory.update": { schema: updateInputSchema, commit: commitUpdate as DraftedCommit["commit"] },
  "memory.supersede": { schema: supersedeInputSchema, commit: commitSupersede as DraftedCommit["commit"] },
  "memory.add_source": { schema: addSourceInputSchema, commit: commitAddSource as DraftedCommit["commit"] },
};

/**
 * The tools that make a new memory from a proposal's content. Without a
 * draft envelope such a proposal names no material, so it is refused rather
 * than landing as the owner's own words: no source, no memory, and a
 * proposal is never `stated`.
 */
const MAKES_A_MEMORY: ReadonlySet<string> = new Set(["memory.remember", "memory.supersede"]);

export type DecideResult =
  | { proposalId: string; state: "discarded"; written: false }
  | {
      proposalId: string;
      state: "confirmed";
      written: true;
      tool: string;
      /** The memory the write committed, when it committed one. */
      committed: { call: string } | null;
      /**
       * For a confirmed episode whose occasion rode in the proposal: the
       * people module's call to run, then the link back. Null otherwise. This
       * module never makes either call; whoever confirmed may, and the memory
       * stands complete if nobody does.
       */
      followUp: FollowUp | null;
      /** What the named tool returned. */
      result: unknown;
    };

/**
 * The memory a write tool's result names, when it names one: `memory` for
 * most, `replacement` for a supersede, whose new entry is what committed.
 */
function committedMemory(result: unknown): { id: string; call: string } | null {
  const shaped = result as { memory?: { id?: unknown; call?: unknown }; replacement?: { id?: unknown; call?: unknown } } | null;
  const memory = shaped?.replacement ?? shaped?.memory;
  if (memory && typeof memory.id === "string" && typeof memory.call === "string") {
    return { id: memory.id, call: memory.call };
  }
  return null;
}

export const tool = defineTool({
  name: "memory.decide",
  title: "Decide a proposal",
  kind: "needs-ok",
  summary:
    "Records the owner's decision on one proposal, alone or as a member of its group. confirm runs the tool the proposal names with the payload the owner read; only a write that succeeded marks it confirmed, and a refused one stays pending with the error. reject writes nothing and burns no call number. A confirmed episode with an occasion pending returns a followUp naming the people module call to run, then memory.link_occasion. Only call this after the owner said yes or no to that exact proposal.",
  input: z.object({
    proposalId: z.string().trim().min(1).max(128),
    decision: z.enum(["confirm", "reject"]),
    confirmedByUser,
  }),
  async handler(ctx, input): Promise<DecideResult> {
    const review = ctx.ports.review;
    const proposal = await review.get(input.proposalId);
    if (!proposal) throw new ToolError("not_found", `No proposal with id "${input.proposalId}".`);
    if (proposal.state !== "pending") throw alreadyDecided(proposal.id, proposal.state);

    // Several processes share the queue (one MCP server per session). The
    // claim makes this the only one deciding the proposal, so its write runs
    // once: a second decision of it at the same moment is a conflict.
    if (review.claim && !(await review.claim(proposal.id))) {
      const now = await review.get(proposal.id);
      if (now && now.state !== "pending") throw alreadyDecided(proposal.id, now.state);
      throw new ToolError("conflict", "That proposal is being decided in another session right now.", {
        proposalId: proposal.id,
        state: "pending",
      });
    }
    try {
      return await settle(ctx, proposal, input.decision);
    } finally {
      await review.release?.(proposal.id);
    }
  },
  auditIds: (input, result) => {
    const memory = result && result.state === "confirmed" ? committedMemory(result.result) : null;
    return {
      proposalIds: [input.proposalId],
      ...(memory ? { memoryIds: [memory.id], calls: [memory.call] } : {}),
    };
  },
});

function alreadyDecided(proposalId: string, state: string): ToolError {
  return new ToolError("conflict", `That proposal is already ${state}.`, { proposalId, state });
}

/** The decision itself, once this call holds the proposal. */
async function settle(
  ctx: ToolContext,
  proposal: QueuedProposal,
  decision: "confirm" | "reject",
): Promise<DecideResult> {
  if (decision === "reject") {
    if (!(await ctx.ports.review.decide(proposal.id, "discarded"))) throw alreadyDecided(proposal.id, "decided");
    return { proposalId: proposal.id, state: "discarded", written: false };
  }

  // Guardrail 8, again at decide time: a proposal that reached the queue by
  // another door still cannot run decide or propose_draft.
  assertProposable(proposal.tool);

  const { input: toolInput, draft } = splitPayload(proposal.payload);
  const actor = `proposal:${proposal.id}`;
  const drafted = DRAFTED_COMMITS[proposal.tool];

  let result: unknown;
  try {
    if (drafted && draft) {
      const parsed = drafted.schema.safeParse(toolInput);
      if (!parsed.success) {
        throw new ToolError("invalid_input", `The proposal's payload is not valid input for ${proposal.tool}.`, {
          issues: parsed.error.issues.slice(0, 10),
        });
      }
      result = await drafted.commit({ ...ctx, actor }, parsed.data as never, draftedProvenance(draft));
    } else if (MAKES_A_MEMORY.has(proposal.tool)) {
      throw new ToolError(
        "refused",
        `No source, no memory: a proposal for ${proposal.tool} carries the draft it came from, and this one carries none.`,
      );
    } else {
      // confirmedByUser goes with it: the owner's yes to this proposal is
      // the yes the named tool asks for. A write tool ignores the flag.
      result = await ctx.invoke(proposal.tool, { ...toolInput, confirmedByUser: true }, { actor });
    }
  } catch (raw) {
    // The write did not happen, so the decision is not made: the proposal
    // stays pending, and the inner refusal comes back beside this one.
    const error = toToolError(raw);
    if (error instanceof ToolError) {
      throw new ToolError(
        "refused",
        `The proposed ${proposal.tool} was refused, so nothing was written and the proposal stays pending: ${error.message}`,
        { proposalId: proposal.id, state: "pending", code: error.code, detail: error.detail },
      );
    }
    throw error;
  }

  const memory = committedMemory(result);
  await ctx.ports.review.decide(proposal.id, "confirmed");

  const occasion = draft?.pendingOccasion ?? null;
  return {
    proposalId: proposal.id,
    state: "confirmed",
    written: true,
    tool: proposal.tool,
    committed: memory ? { call: memory.call } : null,
    followUp: occasion && memory ? followUpFor(occasion, memory.call) : null,
    result,
  };
}
