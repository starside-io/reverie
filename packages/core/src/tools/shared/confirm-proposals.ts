import { z } from "zod";

import { DraftJob } from "../../domain/drafting/schemas.js";
import type { Proposal } from "../../ports.js";
import { SourceKind, TrustTier } from "../../schemas/enums.js";
import { ToolError, type ToolContext } from "../registry.js";

/**
 * What a drafted proposal carries beside the tool input, and the one rule
 * every proposal obeys. Shared by memory.propose_draft, which queues, and
 * memory.decide, which settles. docs/SPEC.md section 15, guardrail 8;
 * section 8, "When a model inferred it".
 */

/**
 * Tools a proposal may not name. Deciding or proposing from inside a
 * proposal would let a draft confirm another draft, which is the one loop the
 * review queue exists to rule out (guardrail 8). Checked when a proposal is
 * queued and again when it is decided.
 */
export const NOT_PROPOSABLE: ReadonlySet<string> = new Set(["memory.decide", "memory.propose_draft"]);

export function assertProposable(tool: string): void {
  if (NOT_PROPOSABLE.has(tool)) {
    throw new ToolError("refused", `A proposal may not name ${tool}: a draft never decides or proposes another draft.`, {
      tool,
    });
  }
}

/** Every proposal this module queues goes through here, so none names decide or propose_draft. */
export async function queueProposal(ctx: ToolContext, proposal: Proposal): Promise<{ id: string }> {
  assertProposable(proposal.tool);
  return ctx.ports.review.propose(proposal);
}

/** The key in a proposal's payload that holds the draft's provenance. The named tool ignores it. */
export const DRAFT_KEY = "draft";

/**
 * The occasion an episode implies, riding inside the episode's proposal
 * (section 8). Nothing is queued in the people module; decide hands it back
 * as a followUp for whoever confirmed to run.
 */
export const pendingOccasionSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.string().min(1).max(40),
  occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The episode's attendees as named. Never a person the story does not name. */
  participants: z.array(z.string().min(1).max(200)).min(1).max(30),
});
export type PendingOccasion = z.infer<typeof pendingOccasionSchema>;

/**
 * Provenance a drafted proposal carries under `draft`. The owner reads it with
 * the rest of the payload; decide reads it to land the memory at the right
 * trust, citing the material it was drafted from.
 */
export const draftEnvelopeSchema = z.object({
  job: DraftJob,
  /** The trust the memory lands at when confirmed: `confirmed`, or `external` for external material. */
  trust: z.enum(["confirmed", "external"]).optional(),
  /** The trust of the material the quote was found in. */
  sourceTrust: TrustTier.optional(),
  source: z
    .object({
      kind: SourceKind,
      label: z.string().min(1).max(200),
      uri: z.string().min(1).max(2000).optional(),
      occurredAt: z.string().optional(),
      trust: TrustTier,
    })
    .optional(),
  quote: z.string().min(1).max(500).optional(),
  sessionDate: z.string().optional(),
  pendingOccasion: pendingOccasionSchema.nullable().optional(),
  /** Names that could be more than one person, asked rather than guessed. */
  questions: z.array(z.string()).optional(),
  newTags: z.array(z.string()).optional(),
});
export type DraftEnvelope = z.infer<typeof draftEnvelopeSchema>;

/** A payload split into the tool's input and the draft envelope, when there is one. */
export function splitPayload(payload: unknown): { input: Record<string, unknown>; draft: DraftEnvelope | null } {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const { [DRAFT_KEY]: raw, ...input } = record;
  if (raw === undefined) return { input, draft: null };
  const parsed = draftEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ToolError("invalid_input", "The proposal's draft provenance is not in the shape this module writes.", {
      issues: parsed.error.issues.slice(0, 10),
    });
  }
  return { input, draft: parsed.data };
}

/**
 * The followUp decide returns for a confirmed episode with a pending
 * occasion, exactly as section 8 shows it: the people module's call and its
 * input, then the link back. This module never makes either call itself.
 */
export interface FollowUp {
  tool: "people.log_interaction";
  input: { title: string; type: string; occurredAt: string; participants: string[] };
  then: { tool: "memory.link_occasion"; call: string };
}

export function followUpFor(occasion: PendingOccasion, call: string): FollowUp {
  return {
    tool: "people.log_interaction",
    input: {
      title: occasion.title,
      type: occasion.type,
      occurredAt: occasion.occurredAt,
      participants: [...occasion.participants],
    },
    then: { tool: "memory.link_occasion", call },
  };
}
