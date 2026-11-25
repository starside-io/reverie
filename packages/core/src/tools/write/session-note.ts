// memory.session_note. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.session_note`; section 11, `SessionNote`; section 17,
// `sessionNoteTtlHours`; section 7 (the secret scan); guardrail 9.

import { z } from "zod";

import { checkSecrets } from "../../domain/discipline.js";
import { liveSessionNotes, writeSessionNote } from "../../domain/session-notes.js";
import { BODY_MAX_LENGTH } from "../../schemas/memory.js";
import { defineTool, ToolError } from "../registry.js";
import { refuseFindings } from "../shared/discipline.js";

export interface SessionNoteResult {
  note: { id: string; sessionId: string; expiresAt: string };
  /** Notes in this session that have not expired, this one included. */
  liveNotes: number;
}

export const tool = defineTool({
  name: "memory.session_note",
  title: "Session note",
  kind: "write",
  summary:
    "Scratch for this working session: a note kept against the session id, expiring after sessionNoteTtlHours. It is input to extraction at the end of the session and never recalled outside it; it is not a memory and gets no call number. Refused when the call carries no session id. Secrets are refused.",
  input: z.object({
    body: z.string().trim().min(1, "A body is required").max(BODY_MAX_LENGTH),
  }),
  async handler(ctx, input): Promise<SessionNoteResult> {
    const sessionId = ctx.session.id;
    if (!sessionId) {
      throw new ToolError(
        "refused",
        "A session note belongs to one working session, and this call carries no session id. Use memory.remember to keep something for good.",
      );
    }
    refuseFindings(checkSecrets({ kind: "fact", title: "", body: input.body, sourceTrust: "stated" }).findings);

    const note = await writeSessionNote(ctx.db, {
      sessionId,
      body: input.body,
      now: ctx.now,
      ttlHours: ctx.config.sessionNoteTtlHours,
    });
    const live = await liveSessionNotes(ctx.db, sessionId, ctx.now);
    return {
      note: { id: note.id, sessionId: note.sessionId, expiresAt: note.expiresAt.toISOString() },
      liveNotes: live.length,
    };
  },
});
