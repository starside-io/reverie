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
import { readSessionPage, requireReady, type SessionPage } from "../shared/extraction.js";
import { clearReadyForExtraction, endSession, recordConsolidation, transcriptPointer } from "../shared/host-values.js";
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
  /**
   * For an extract from a finished session: which page this was, whether the
   * session stopped waiting for extraction (it does once its last page is
   * proposed with something queued, or with no candidates at all; a page
   * whose every candidate was refused leaves it waiting, to draft again),
   * and the target of the next page when there is one.
   */
  extraction?: {
    session: string;
    cursor: number;
    lastPage: boolean;
    cleared: boolean;
    continuation: DraftTarget | null;
  };
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
  page: SessionPage | null,
): Promise<DraftOutcome & { group?: ProposalGroup }> {
  switch (target.job) {
    case "extract": {
      const material = page?.material ?? target.material;
      if (!material) {
        throw new ToolError(
          "invalid_input",
          "An extract draft is bound to its material: pass the target memory.draft_context returned, which carries the material or names the session.",
        );
      }
      return extractOutcome(
        ctx,
        { ...target, material, sessionDate: page?.sessionDate ?? target.sessionDate ?? dayKey(ctx.now) },
        parseDraft("extract", draft) as never,
      );
    }
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
    "Hands back an answer to memory.draft_context, with the target it returned. The answer is validated against the job's schema and the gates: every quote appears in the material, discipline passes, a procedure becomes a memory.promote_procedure proposal and is refused from external material, names stay labels and an ambiguous name becomes a question, nothing external targets the core block. What survives waits in the review queue, grouped per session or per event; each refused part comes back with its reason. An extract target that names a finished session is checked against that session's page, read again here; once its last page is proposed the session stops waiting for extraction. Writes nothing to the library.",
  input: z.object({ target: draftTargetSchema, draft: z.unknown() }).strict(),
  async handler(ctx, input): Promise<ProposeDraftResult> {
    const target = input.target;
    // A finished session's page is read again here, so every quote is
    // checked against exactly what draft_context handed over: the material
    // never travels in the target, and no caller can substitute its own.
    let page: SessionPage | null = null;
    if (target.job === "extract" && (target.session !== undefined || target.cursor !== undefined)) {
      if (target.material || target.session === undefined) {
        throw new ToolError(
          "invalid_input",
          "Give the material, or name a finished session, not both: a session's material is read by the module, never passed in.",
        );
      }
      await requireReady(ctx, target.session).catch((error: unknown) => {
        throw error instanceof ToolError
          ? new ToolError("conflict", "That session is no longer waiting for extraction: its last page was already proposed, or it was never ready.", {
              session: target.session,
            })
          : error;
      });
      page = await readSessionPage(ctx, target.session, target.cursor ?? 0, target.sessionDate);
    }

    const outcome = await outcomeFor(ctx, target, input.draft, page);

    // The session stops waiting once its last page is proposed: taken off the
    // ready list, its transcript pointer with it, in one step, before
    // anything is queued, so two sessions proposing the same page at once
    // queue it once. A last page whose every candidate was refused leaves it
    // waiting, so the drafter can fix the draft and propose again.
    let extraction: ProposeDraftResult["extraction"];
    if (page) {
      const draftCandidates = (input.draft as { candidates?: unknown[] } | null)?.candidates?.length ?? 0;
      const lastPage = page.next === null;
      let cleared = false;
      let pointer: string | null = null;
      if (lastPage && (outcome.proposals.length > 0 || draftCandidates === 0)) {
        pointer = await transcriptPointer(ctx.ports, page.session);
        cleared = await clearReadyForExtraction(ctx.ports, page.session);
        if (!cleared) {
          throw new ToolError("conflict", "That session is no longer waiting for extraction: its last page was proposed in another session just now.", {
            session: page.session,
          });
        }
      }
      extraction = {
        session: page.session,
        cursor: page.cursor,
        lastPage,
        cleared,
        continuation: lastPage
          ? null
          : { job: "extract", session: page.session, cursor: page.next as number, sessionDate: page.sessionDate },
      };
      if (cleared) {
        try {
          return await queueAll(ctx, input.target, outcome, extraction);
        } catch (error) {
          // Nothing reached the queue for certain: the session waits again.
          await endSession(ctx.ports, page.session, pointer, { count: false }).catch(() => undefined);
          throw error;
        }
      }
    }
    return queueAll(ctx, input.target, outcome, extraction);
  },
  auditIds: (_input, result) => (result ? { proposalIds: result.queued.map((entry) => entry.id) } : undefined),
});

/** Every proposal that survived the gates, queued, and the answer handed back. */
async function queueAll(
  ctx: Parameters<typeof extractOutcome>[0],
  target: DraftTarget,
  outcome: DraftOutcome & { group?: ProposalGroup },
  extraction: ProposeDraftResult["extraction"],
): Promise<ProposeDraftResult> {
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
  if (target.job === "consolidate" && queued.length > 0) {
    await recordConsolidation(ctx.ports, ctx.now);
    ctx.emit("memory.consolidation.proposed", {
      groupId: outcome.group?.id ?? null,
      proposalIds: queued.map((entry) => entry.id),
      count: queued.length,
    });
  }

  return {
    job: target.job,
    queued,
    groups: [...groups.values()],
    rejected: outcome.rejected,
    questions: [...new Set(outcome.questions)],
    written: false,
    ...(extraction ? { extraction } : {}),
  };
}
