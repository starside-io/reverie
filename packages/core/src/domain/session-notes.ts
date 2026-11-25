// Session scratch. docs/SPEC.md section 11, `SessionNote` (sessionId, body,
// expiresAt; scratch for one working session; input to extraction, never
// recalled outside it); section 4, "Scopes" (SessionNote is not a scope of
// Memory); section 17, `sessionNoteTtlHours`.
//
// A note has no relation to Memory, no call number and no version: it is not
// part of the library. Nothing in recall reads this table.

import type { SessionNote } from "../../generated/prisma/index.js";
import type { Db } from "./db.js";
import { DomainError } from "./errors.js";

const HOUR_MS = 3_600_000;

export function noteExpiry(now: Date, ttlHours: number): Date {
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    throw new DomainError("invalid_input", "sessionNoteTtlHours is a positive number of hours.");
  }
  return new Date(now.getTime() + ttlHours * HOUR_MS);
}

export async function writeSessionNote(
  db: Db,
  input: { sessionId: string; body: string; now: Date; ttlHours: number },
): Promise<SessionNote> {
  const sessionId = input.sessionId.trim();
  if (sessionId.length === 0) throw new DomainError("invalid_input", "A session note belongs to a session id.");
  const body = input.body.trim();
  if (body.length === 0) throw new DomainError("invalid_input", "A session note needs a body.");
  return db.sessionNote.create({
    data: { sessionId, body, expiresAt: noteExpiry(input.now, input.ttlHours), createdAt: input.now },
  });
}

/** One session's notes that have not expired at `now`, oldest first. */
export async function liveSessionNotes(db: Db, sessionId: string, now: Date): Promise<SessionNote[]> {
  return db.sessionNote.findMany({
    where: { sessionId, expiresAt: { gt: now } },
    orderBy: { createdAt: "asc" },
  });
}
