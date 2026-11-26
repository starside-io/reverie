import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { history } from "../src/domain/versions.js";
import { LISTENED_EVENTS } from "../src/listeners.js";
import { READY_FOR_EXTRACTION_KEY, TRANSCRIPTS_KEY } from "../src/tools/shared/host-values.js";
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
        detail: { sessionId: "session-1", readyForExtraction: true, counted: true, sessionsSince: 1, transcript: false },
      });
      const again = await host.api.deliver("host.session.ended", { sessionId: "session-1" });
      expect(again).toMatchObject({ handled: true, detail: { counted: false, sessionsSince: null } });
      expect(host.values.get(READY_FOR_EXTRACTION_KEY)).toEqual(["session-1"]);
    });

    it("keeps a pointer to the transcript beside the marker, and only the pointer", async () => {
      const path = "/tmp/elmwood/transcripts/session-2.jsonl";
      const result = await host.api.deliver("host.session.ended", { sessionId: "session-2", transcriptPath: path });
      expect(result).toMatchObject({ handled: true, detail: { sessionId: "session-2", transcript: true } });
      expect(host.values.get(TRANSCRIPTS_KEY)).toEqual({ "session-2": path });
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
    it("proposes resolving the unresolved names that now match, one proposal per memory, and writes nothing", async () => {
      const memory = await episode(["Sam Rivera", "Jane Doe"]);
      const versions = await host.db.memoryVersion.count();
      const result = await host.api.deliver("people.person.created", { personId: PEOPLE.sam.id, displayName: "Sam Rivera" });
      expect(result).toEqual({
        event: "people.person.created",
        handled: true,
        detail: { person: PEOPLE.sam.uri, matches: [memory.call], proposed: 1, proposalIds: ["proposal-1"] },
      });
      expect(host.proposals[0]).toMatchObject({
        tool: "memory.update",
        memoryId: memory.id,
        payload: { call: memory.call, people: [{ uri: PEOPLE.sam.uri, label: "Sam Rivera", name: "Sam Rivera" }] },
        group: { id: `person:${PEOPLE.sam.uri}` },
        state: "pending",
      });
      expect(await host.db.memoryVersion.count()).toBe(versions);
      expect((await refs(memory.id)).filter((ref) => ref.role === "attendee").every((ref) => ref.uri === null)).toBe(true);
    });

    it("delivered twice, queues the proposal once", async () => {
      await episode(["Sam Rivera"]);
      await host.api.deliver("people.person.created", { personId: PEOPLE.sam.id, displayName: "Sam Rivera" });
      const again = await host.api.deliver("people.person.created", { personId: PEOPLE.sam.id, displayName: "Sam Rivera" });
      expect(again).toMatchObject({ handled: true, detail: { proposed: 0 } });
      expect(host.proposals).toHaveLength(1);
    });

    it("confirmed, resolves the name to the person; rejected, leaves it a name", async () => {
      const memory = await episode(["Sam Rivera", "Jane Doe"]);
      await host.api.deliver("people.person.created", { personId: PEOPLE.sam.id, displayName: "Sam Rivera" });
      await host.api.deliver("people.person.created", { personId: PEOPLE.jane.id, displayName: "Jane Doe" });
      await host.invoke("memory.decide", { proposalId: "proposal-1", decision: "confirm", confirmedByUser: true });
      await host.invoke("memory.decide", { proposalId: "proposal-2", decision: "reject", confirmedByUser: true });
      const attendees = (await refs(memory.id)).filter((ref) => ref.role === "attendee");
      expect(attendees).toEqual([
        { role: "attendee", uri: null, label: "Jane Doe", resolved: false },
        { role: "attendee", uri: PEOPLE.sam.uri, label: "Sam Rivera", resolved: true },
      ]);
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

  describe("people.interaction.logged", () => {
    const LOGGED = "module://people/event/e_4410";

    it("lists the occasion under occasions with no story yet, in host values, and invents no story", async () => {
      const before = await host.db.memory.count();
      const result = await host.api.deliver("people.interaction.logged", {
        eventId: "e_4410",
        personIds: [PEOPLE.sam.id, PEOPLE.jane.id],
        occurredAt: "2026-12-20T00:00:00.000Z",
      }, { now: NOW });
      expect(result).toEqual({
        event: "people.interaction.logged",
        handled: true,
        detail: { occasion: LOGGED, listed: true, added: true },
      });
      expect(await host.db.memory.count()).toBe(before);
      const review = await host.invoke<{ frontDesk: { occasionsWithNoStory: unknown[] } }>("memory.review");
      expect(review.frontDesk.occasionsWithNoStory).toEqual([
        {
          occasion: LOGGED,
          title: null,
          occurredOn: "2026-12-20",
          people: [PEOPLE.jane.uri, PEOPLE.sam.uri],
          loggedAt: NOW.toISOString(),
        },
      ]);
    });

    it("drops off the list once a story links to it", async () => {
      await host.api.deliver("people.interaction.logged", { eventId: "e_4410", personIds: [PEOPLE.sam.id], occurredAt: "2026-12-20" });
      await host.invoke("memory.remember", {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-20",
        body: "Walked the canal path at Elmwood with Sam Rivera.",
        attendees: [{ uri: PEOPLE.sam.uri, label: "Sam Rivera" }],
        occasion: { uri: LOGGED, label: "Canal walk" },
      });
      const review = await host.invoke<{ frontDesk: { occasionsWithNoStory: unknown[] } }>("memory.review");
      expect(review.frontDesk.occasionsWithNoStory).toEqual([]);
      expect(await host.api.deliver("people.interaction.logged", { eventId: "e_4410", personIds: [], occurredAt: "2026-12-20" })).toMatchObject({
        handled: true,
        detail: { listed: false },
      });
    });

    it("says so when the host keeps no settings values", async () => {
      const bare = await testHost({ now: NOW, noValues: true });
      try {
        expect(await bare.api.deliver("people.interaction.logged", { eventId: "e_4410", personIds: [] })).toMatchObject({
          handled: false,
          reason: "no_settings_values",
        });
      } finally {
        await bare.close();
      }
    });
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
        detail: { occasion: OCCASION, change: "updated", memoryIds: [memory.id], changed: [memory.id], attendeesSynced: true },
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
