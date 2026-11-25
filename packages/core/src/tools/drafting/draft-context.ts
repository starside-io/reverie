// memory.draft_context. docs/SPEC.md section 15, "Drafting, 2" and the jobs
// table under it; section 2 (filed as read in module.json); section 13, steps
// 2 to 5; section 7 (the discipline rules, handed over in words).
//
// Reads only. The module never calls a model: whatever model drives the
// caller reads this, drafts, and hands its answer to memory.propose_draft with
// the target given back here.

import { buildDraftContext, draftTargetSchema, type DraftContext } from "../../domain/drafting/context.js";
import { defineTool, ToolError } from "../registry.js";
import { readOwnerLine } from "../shared/host-values.js";
import { resolveProject } from "../shared/project.js";

export interface DraftContextResult extends DraftContext {
  /** What to do with it. */
  next: string;
}

export const tool = defineTool({
  name: "memory.draft_context",
  title: "Drafting context",
  kind: "read",
  summary:
    "Material, rules and JSON schema for one drafting job. extract: the turns or file text given, the session date, the shelf list with descriptions, the tag list with counts, and the discipline rules. reconcile: one candidate beside its nearest neighbours. consolidate: a stretch of memories with duplicate, contradiction and stale hints. core: the candidates for the core block, its token cap and the owner line as it stands. Writes nothing. Answer with JSON that fits the schema, then call memory.propose_draft with the returned target as is.",
  input: draftTargetSchema,
  async handler(ctx, input): Promise<DraftContextResult> {
    let scopeRef: string | null = null;
    if (input.job === "reconcile" && input.candidate.scope !== "global") {
      scopeRef =
        input.candidate.scope === "project"
          ? ((await resolveProject(ctx)).project?.slug ?? null)
          : input.candidate.scope === "session"
            ? ctx.session.id
            : ctx.session.agent;
      if (scopeRef === null) {
        throw new ToolError(
          "invalid_input",
          `A ${input.candidate.scope} candidate is reconciled within what it is scoped to, and this session cannot say what that is.`,
        );
      }
    }
    const ownerLine = input.job === "core" ? await readOwnerLine(ctx.ports) : null;
    const context = await buildDraftContext(ctx.db, ctx.config, input, { now: ctx.now, scopeRef, ownerLine });
    return {
      ...context,
      next: "Answer with JSON that fits schema, then call memory.propose_draft with target exactly as given here and your answer as draft. Nothing is written until the owner confirms it in review.",
    };
  },
});
