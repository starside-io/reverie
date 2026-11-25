import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionNoteResult } from "../../../src/tools/write/session-note.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";
import { NOW } from "./helpers.js";

describe("memory.session_note", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" }, config: { sessionNoteTtlHours: 24 } });
  });
  afterEach(async () => {
    await host.close();
  });

  const note = (body: string, options = {}) =>
    host.invoke<SessionNoteResult>("memory.session_note", { body }, options);

  it("keeps scratch for the session, expiring after sessionNoteTtlHours", async () => {
    const result = await note("Trying the billing page refactor first, then the tests.");
    expect(result.note).toMatchObject({ sessionId: "session-1", expiresAt: "2026-12-28T10:00:00.000Z" });
    expect(result.liveNotes).toBe(1);

    // Relative dates are fine in scratch: only the secret scan runs.
    const second = await note("Revisit this tomorrow.");
    expect(second.liveNotes).toBe(2);

    const later = await note("Billing page done.", { now: new Date("2026-12-28T11:00:00.000Z") });
    expect(later.liveNotes).toBe(1);
    expect(await host.db.sessionNote.count()).toBe(3);
  });

  it("is not a memory: no row, no call number, no event", async () => {
    await note("Trying the billing page refactor first.");
    expect(await host.db.memory.count()).toBe(0);
    expect(await host.db.memoryVersion.count()).toBe(0);
    expect(host.events).toEqual([]);
    expect(auditStrings(host).some((text) => text.includes("billing"))).toBe(false);
  });

  it("is refused without a session id", async () => {
    await expect(note("Something.", { session: { id: null } })).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("session id"),
    });
    expect(await host.db.sessionNote.count()).toBe(0);
  });

  it("refuses a secret", async () => {
    await expect(note("the staging password: hunter22 for now")).rejects.toMatchObject({
      code: "refused",
      detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "secret" })]) },
    });
    expect(await host.db.sessionNote.count()).toBe(0);
  });

  it("refuses while incognito is on", async () => {
    host.setIncognito(true);
    await expect(note("Something.")).rejects.toMatchObject({ code: "refused", detail: { incognito: true } });
    expect(await host.db.sessionNote.count()).toBe(0);
  });
});
