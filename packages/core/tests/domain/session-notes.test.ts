import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { liveSessionNotes, noteExpiry, writeSessionNote } from "../../src/domain/session-notes.js";
import type { Silo } from "../../src/storage/client.js";
import { openLibrary } from "./library.js";

const NOW = new Date("2026-12-27T10:00:00.000Z");

describe("session notes", () => {
  let db: Silo;

  beforeEach(async () => {
    db = await openLibrary();
  });
  afterEach(async () => {
    await db.$disconnect();
  });

  it("expires after the ttl and lists only one session's live notes", async () => {
    expect(noteExpiry(NOW, 72).toISOString()).toBe("2026-12-30T10:00:00.000Z");
    expect(() => noteExpiry(NOW, 0)).toThrow();

    await writeSessionNote(db, { sessionId: "session-1", body: "First idea.", now: NOW, ttlHours: 1 });
    await writeSessionNote(db, { sessionId: "session-2", body: "Elsewhere.", now: NOW, ttlHours: 1 });
    expect(await liveSessionNotes(db, "session-1", NOW)).toHaveLength(1);
    expect(await liveSessionNotes(db, "session-1", new Date("2026-12-27T11:00:00.000Z"))).toHaveLength(0);
    await expect(writeSessionNote(db, { sessionId: " ", body: "x", now: NOW, ttlHours: 1 })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
