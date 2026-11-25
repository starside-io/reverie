import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { history } from "../src/domain/versions.js";
import { LISTENED_EVENTS } from "../src/listeners.js";
import { READY_FOR_EXTRACTION_KEY } from "../src/tools/shared/host-values.js";
import type { RememberResult } from "../src/tools/write/remember.js";
import { PEOPLE, testHost, type TestHost } from "./test-host.js";

/**
 * The four events of docs/SPEC.md section 18 "Listened to", delivered as the
 * host's bus would, through ModuleApi.deliver. All data is invented.
 */

const NOW = new Date("2026-12-27T10:00:00.000Z");
const OCCASION = "module://people/event/e_8812";

describe("listened events", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  it("are the four module.json lists", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, "..", "..", "..", "module.json"), "utf8")) as {
      events: { listens: string[] };
    };
    expect([...LISTENED_EVENTS]).toEqual(manifest.events.listens);
  });

  async function episode(attendees: unknown[]) {
    const written = await host.invoke<RememberResult>("memory.remember", {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas. The oven died, so we ordered pizza.",
      attendees,
      occasion: { uri: OCCASION, label: "Christmas at home" },
    });
    return written.memory;
  }

  async function refs(memoryId: string) {
    return host.db.memoryRef.findMany({
      where: { memoryId },
      select: { role: true, uri: true, label: true, resolved: true },
      orderBy: [{ role: "asc" }, { label: "asc" }],
    });
  }

  describe("host.session.ended", () => {
    it("marks the session ready for extraction and counts it, once", async () => {
      const first = await host.api.deliver("host.session.ended", { sessionId: "session-1" });
      expect(first).toEqual({
        event: "host.session.ended",
        handled: true,
        detail: { sessionId: "session-1", readyForExtraction: true, counted: true, sessionsSince: 1 },
      });
      const again = await host.api.deliver("host.session.ended", { sessionId: "session-1" });
      expect(again).toMatchObject({ handled: true, detail: { counted: false, sessionsSince: null } });
      expect(host.values.get(READY_FOR_EXTRACTION_KEY)).toEqual(["session-1"]);
    });

    it("marks nothing while incognito is on", async () => {
      host.setIncognito(true);
      expect(await host.api.deliver("host.session.ended", { sessionId: "session-1" })).toEqual({
        event: "host.session.ended",
        handled: false,
        reason: "incognito",
      });
      expect(host.values.size).toBe(0);
    });

    it("says what it needs from a payload it cannot read", async () => {
      expect(await host.api.deliver("host.session.ended", {})).toMatchObject({ handled: false, reason: "invalid_payload" });
    });
  });

  describe("people.person.created", () => {
    it("finds the unresolved names that now match, and writes nothing", async () => {
      const memory = await episode(["Sam Rivera", "Jane Doe"]);
      const versions = await host.db.memoryVersion.count();
      const result = await host.api.deliver("people.person.created", { uri: PEOPLE.sam.uri, name: "sam rivera" });
      expect(result).toEqual({
        event: "people.person.created",
        handled: true,
        detail: { person: PEOPLE.sam.uri, matches: [memory.call], proposed: 0 },
      });
      expect(await host.db.memoryVersion.count()).toBe(versions);
      expect((await refs(memory.id)).filter((ref) => ref.role === "attendee").every((ref) => ref.uri === null)).toBe(true);
    });

    it("asks the refs port for the name when the payload carries only the id", async () => {
      const memory = await episode(["John Doe"]);
      host.primePeople([PEOPLE.john]);
      expect(await host.api.deliver("people.person.created", { personId: PEOPLE.john.id })).toMatchObject({
        handled: true,
        detail: { matches: [memory.call] },
      });
    });
  });

  it("people.interaction.logged is left to the front desk of a later milestone, and invents no story", async () => {
    const before = await host.db.memory.count();
    expect(await host.api.deliver("people.interaction.logged", { uri: OCCASION })).toMatchObject({
      handled: false,
      reason: "deferred",
    });
    expect(await host.db.memory.count()).toBe(before);
  });

  describe("people.interaction.changed", () => {
    it("syncs the attendees of every memory linked to the occasion to its participants", async () => {
      const memory = await episode([{ uri: PEOPLE.jane.uri, label: "Jane Doe" }, "Sam Rivera"]);
      const result = await host.api.deliver("people.interaction.changed", {
        uri: OCCASION,
        label: "Christmas at home",
        participants: [
          { uri: PEOPLE.john.uri, name: "John Doe" },
          { uri: PEOPLE.sam.uri, name: "Sam Rivera" },
        ],
      });
      expect(result).toEqual({
        event: "people.interaction.changed",
        handled: true,
        detail: { occasion: OCCASION, memoryIds: [memory.id], changed: [memory.id], attendeesSynced: true },
      });
      expect(await refs(memory.id)).toEqual([
        { role: "attendee", uri: PEOPLE.john.uri, label: "John Doe", resolved: true },
        { role: "attendee", uri: PEOPLE.sam.uri, label: "Sam Rivera", resolved: true },
        { role: "occasion", uri: OCCASION, label: "Christmas at home", resolved: true },
      ]);
      const versions = await history(host.db, memory.id);
      expect(versions.at(-1)).toMatchObject({ operation: "update", actor: "event:people.interaction.changed" });
    });

    it("reads the participants from the refs port when the payload has none", async () => {
      const memory = await episode(["Jane Doe"]);
      host.primeRef(OCCASION, "Christmas at home", { participants: [{ uri: PEOPLE.jane.uri, name: "Jane Doe" }] });
      await host.api.deliver("people.interaction.changed", { uri: OCCASION });
      expect((await refs(memory.id)).find((ref) => ref.role === "attendee")).toEqual({
        role: "attendee",
        uri: PEOPLE.jane.uri,
        label: "Jane Doe",
        resolved: true,
      });
    });

    it("marks the occasion unavailable when it is removed, and keeps the attendees", async () => {
      const memory = await episode(["Jane Doe"]);
      const result = await host.api.deliver("people.interaction.changed", { uri: OCCASION, removed: true });
      expect(result).toMatchObject({ handled: true, detail: { removed: true, memoryIds: [memory.id] } });
      expect(await refs(memory.id)).toEqual([
        { role: "attendee", uri: null, label: "Jane Doe", resolved: false },
        { role: "occasion", uri: OCCASION, label: "Christmas at home", resolved: false },
      ]);
    });

    it("changes nothing while incognito is on", async () => {
      const memory = await episode(["Jane Doe"]);
      const before = await refs(memory.id);
      host.setIncognito(true);
      expect(await host.api.deliver("people.interaction.changed", { uri: OCCASION, removed: true })).toMatchObject({
        handled: false,
        reason: "incognito",
      });
      expect(await refs(memory.id)).toEqual(before);
    });
  });
});
