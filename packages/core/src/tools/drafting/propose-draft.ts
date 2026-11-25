// memory.propose_draft. docs/SPEC.md section 15, "Drafting, 2" and the jobs
// table under it, guardrails 2, 3, 4, 5, 7 and 8; section 2 (filed as write in
// module.json); section 13, steps 3 to 6; section 8 ("When a model inferred
// it": the pending occasion); section 18 (memory.consolidation.proposed).
//
// Writes only to the review queue, never the silo. The registry refuses it
// while incognito is on, so not even a proposal is queued then.

import { z } from "zod";

import { draftTargetSchema, type DraftTarget } from "../../domain/drafting/context.js";
import { DRAFT_SCHEMAS, type DraftJob } from "../../domain/drafting/schemas.js";
import type { ProposalGroup } from "../../ports.js";
import { dayKey } from "../../schemas/common.js";
import { defineTool, ToolError } from "../registry.js";
import { queueProposal } from "../shared/confirm-proposals.js";
import { recordConsolidation } from "../shared/host-values.js";
import {
  consolidateOutcome,
  coreOutcome,
  extractOutcome,
  reconcileOutcome,
  type DraftOutcome,
  type DraftRejection,
} from "../shared/drafting-propose.js";

export interface ProposeDraftResult {
  job: DraftJob;
  queued: Array<{ id: string; tool: string; summary: string | null; groupId: string | null }>;
  groups: Array<{ id: string; title: string; detail: string | null }>;
  /** Each refused candidate, action or pin, with its reason. */
  rejected: DraftRejection[];
  /** For the owner: the drafter's own questions, and every name that could be more than one person. */
  questions: string[];
  /** Nothing reaches the silo until the owner confirms a proposal with memory.decide. */
  written: false;
}

function parseDraft(job: DraftJob, draft: unknown) {
  const checked = DRAFT_SCHEMAS[job].safeParse(draft);
  if (!checked.success) {
    throw new ToolError("invalid_input", "The draft is not in the shape the job's schema asks for.", {
      issues: checked.error.issues.slice(0, 10),
    });
  }
  return checked.data;
}

function requireCalls<T extends { calls?: string[] | undefined }>(target: T, job: string): T & { calls: string[] } {
  if (!target.calls) {
    throw new ToolError(
      "invalid_input",
      `A ${job} draft is bound to the context it was drafted from: pass the target memory.draft_context returned, with its calls, as is.`,
    );
  }
  return target as T & { calls: string[] };
}

async function outcomeFor(
  ctx: Parameters<typeof extractOutcome>[0],
  target: DraftTarget,
  draft: unknown,
): Promise<DraftOutcome & { group?: ProposalGroup }> {
  switch (target.job) {
    case "extract":
      return extractOutcome(
        ctx,
        { ...target, sessionDate: target.sessionDate ?? dayKey(ctx.now) },
        parseDraft("extract", draft) as never,
      );
    case "reconcile":
      return reconcileOutcome(
        ctx,
        { ...target, sessionDate: target.sessionDate ?? dayKey(ctx.now) },
        parseDraft("reconcile", draft) as never,
      );
    case "consolidate":
      return consolidateOutcome(ctx, requireCalls(target, "consolidate"), parseDraft("consolidate", draft) as never);
    case "core":
      return coreOutcome(ctx, requireCalls(target, "core"), parseDraft("core", draft) as never);
  }
}

export const tool = defineTool({
  name: "memory.propose_draft",
  title: "Propose a draft",
  kind: "write",
  summary:
    "Hands back an answer to memory.draft_context, with the target it returned. The answer is validated against the job's schema and the gates: every quote appears in the material, discipline passes, a procedure becomes a memory.promote_procedure proposal and is refused from external material, names stay labels and an ambiguous name becomes a question, nothing external targets the core block. What survives waits in the review queue, grouped per session or per event; each refused part comes back with its reason. Writes nothing to the library.",
  input: z.object({ target: draftTargetSchema, draft: z.unknown() }).strict(),
  async handler(ctx, input): Promise<ProposeDraftResult> {
    const outcome = await outcomeFor(ctx, input.target, input.draft);

    const queued: ProposeDraftResult["queued"] = [];
    const groups = new Map<string, ProposeDraftResult["groups"][number]>();
    for (const proposal of outcome.proposals) {
      const { id } = await queueProposal(ctx, proposal);
      queued.push({ id, tool: proposal.tool, summary: proposal.summary ?? null, groupId: proposal.group?.id ?? null });
      if (proposal.group && !groups.has(proposal.group.id)) {
        groups.set(proposal.group.id, {
          id: proposal.group.id,
          title: proposal.group.title,
          detail: proposal.group.detail ?? null,
        });
      }
    }

    // Consolidation only proposes. The event says so, after the queue holds them,
    // and the host's values record that it ran, for consolidateEvery.
    if (input.target.job === "consolidate" && queued.length > 0) {
      await recordConsolidation(ctx.ports, ctx.now);
      ctx.emit("memory.consolidation.proposed", {
        groupId: outcome.group?.id ?? null,
        proposalIds: queued.map((entry) => entry.id),
        count: queued.length,
      });
    }

    return {
      job: input.target.job,
      queued,
      groups: [...groups.values()],
      rejected: outcome.rejected,
      questions: [...new Set(outcome.questions)],
      written: false,
    };
  },
  auditIds: (_input, result) => (result ? { proposalIds: result.queued.map((entry) => entry.id) } : undefined),
});
