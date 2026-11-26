// memory.draft_context. docs/SPEC.md section 15, "Drafting, 2" and the jobs
// table under it; section 2 (filed as read in module.json); section 13, steps
// 2 to 5; section 7 (the discipline rules, handed over in words; incognito:
// no capture runs); section 18 (host.session.ended marks a session ready
// for extraction); section 19 (SessionEnd leaves a pointer to the
// transcript).
//
// Reads only. The module never calls a model: whatever model drives the
// caller reads this, drafts, and hands its answer to memory.propose_draft with
// the target given back here.

import { buildDraftContext, draftTargetSchema, type DraftContext, type DraftTarget } from "../../domain/drafting/context.js";
import { defineTool, ToolError } from "../registry.js";
import {
  EXTRACT_PAGE_MAX_CHARS,
  incognitoCapture,
  pageNotice,
  readSessionPage,
  readySessions,
  requireReady,
  type ReadySession,
  type TranscriptStatus,
} from "../shared/extraction.js";
import { readOwnerLine } from "../shared/host-values.js";
import { resolveProject } from "../shared/project.js";

export interface DraftContextResult extends DraftContext {
  /** What to do with it. */
  next: string;
}

/** extract with neither material nor session: the finished sessions waiting for extraction. */
export interface ReadySessionsResult {
  job: "extract";
  ready: ReadySession[];
  /** True when this host can hand over transcript turns at all. */
  transcripts: boolean;
  /** While incognito is on no session can be read: no capture runs. */
  incognito: boolean;
  next: string;
}

/** extract for one finished session: one page of its notes and transcript turns. */
export interface SessionContextResult extends DraftContextResult {
  session: {
    id: string;
    notes: number;
    notesLeftOut: number;
    turns: number;
    transcript: TranscriptStatus;
    transcriptReason: string | null;
    /** What this page holds, in one line. */
    notice: string;
  };
  /**
   * The target for the next page, to pass to memory.draft_context once this
   * page is proposed, or null when this page reaches the end. The session
   * stays ready until its last page is proposed.
   */
  continuation: DraftTarget | null;
}

export const tool = defineTool({
  name: "memory.draft_context",
  title: "Drafting context",
  kind: "read",
  summary:
    "Material, rules and JSON schema for one drafting job. extract: the turns or file text given as material, the session date, the shelf list with descriptions, the tag list with counts, and the discipline rules. extract with no material and no session lists the finished sessions waiting for extraction; extract with session (one of those ids) hands over that session's notes and its transcript turns, a page at a time with a continuation, or the notes alone when no transcript can be read, saying so. reconcile: one candidate beside its nearest neighbours. consolidate: a stretch of memories with duplicate, contradiction and stale hints. core: the candidates for the core block, its token cap and the owner line as it stands. Writes nothing. Answer with JSON that fits the schema, then call memory.propose_draft with the returned target as is.",
  input: draftTargetSchema,
  async handler(ctx, input): Promise<DraftContextResult | ReadySessionsResult | SessionContextResult> {
    if (input.job === "extract" && !input.material) {
      if (input.session === undefined) {
        if (input.cursor !== undefined) {
          throw new ToolError("invalid_input", "A cursor pages through one session: name the session too.");
        }
        const ready = await readySessions(ctx);
        return {
          job: "extract",
          ready,
          transcripts: ctx.ports.connectors !== undefined,
          incognito: ctx.incognito,
          next: ctx.incognito
            ? "Incognito is on, so no session is read for extraction until the owner turns it off."
            : ready.length === 0
              ? "No finished session is waiting for extraction."
              : "Call memory.draft_context with job extract and session set to one of these ids, draft from what it hands over, then memory.propose_draft with the target it returns. A session stops waiting once its last page is proposed.",
        };
      }
      return sessionContext(ctx, input.session, input.cursor ?? 0, input.sessionDate);
    }
    if (input.job === "extract" && (input.session !== undefined || input.cursor !== undefined)) {
      throw new ToolError(
        "invalid_input",
        "Give the material, or name a finished session, not both: a session's material is read by the module, never passed in.",
      );
    }

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

async function sessionContext(
  ctx: Parameters<typeof tool.handler>[0],
  session: string,
  cursor: number,
  sessionDate: string | undefined,
): Promise<SessionContextResult> {
  // Reading a finished session's notes and transcript is capture (section 7).
  if (ctx.incognito) throw incognitoCapture();
  await requireReady(ctx, session);
  const page = await readSessionPage(ctx, session, cursor, sessionDate);
  const context = await buildDraftContext(
    ctx.db,
    ctx.config,
    { job: "extract", material: page.material, sessionDate: page.sessionDate },
    { now: ctx.now },
  );
  const notice = pageNotice(page);
  return {
    ...context,
    counts: { ...context.counts, notes: page.notes, transcriptTurns: page.turns, pageMaxCharacters: EXTRACT_PAGE_MAX_CHARS },
    // The target names the session and the page, never the material: propose_draft reads the same page again.
    target: { job: "extract", session, cursor: page.cursor, sessionDate: page.sessionDate },
    session: {
      id: session,
      notes: page.notes,
      notesLeftOut: page.notesLeftOut,
      turns: page.turns,
      transcript: page.transcript,
      transcriptReason: page.transcriptReason,
      notice,
    },
    continuation: page.next === null ? null : { job: "extract", session, cursor: page.next, sessionDate: page.sessionDate },
    next: `${notice} Answer with JSON that fits schema, then call memory.propose_draft with target exactly as given here and your answer as draft. A [note] line is a session note the assistant kept, not the owner's words. Nothing is written until the owner confirms it in review.`,
  };
}
