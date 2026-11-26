import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DecideResult } from "../../src/tools/confirm/decide.js";
import type { AboutResult } from "../../src/tools/read/about.js";
import type { GetResult } from "../../src/tools/read/get.js";
import type { ReviewResult } from "../../src/tools/read/review.js";
import type { LinkOccasionToolResult, ReportResult } from "../../src/tools/write/link-occasion.js";
import type { RememberResult } from "../../src/tools/write/remember.js";
import type { UpdateToolResult } from "../../src/tools/write/update.js";
import { candidate, draft, gateHost, SESSION_DATE, turns, type Confirmed } from "../gates/harness.js";
import { PEOPLE, type TestHost } from "../test-host.js";

/**
 * docs/SPEC.md section 8, the Fellowship link, row by row, from Reverie's
 * side. The people module is never called: where a test plays it, it is the
 * assistant reading back what people.log_interaction returned. All data is
 * invented.
 */

const OCCASION = "module://people/event/e_8812";
const TELLING =
  "I organised Christmas at mine on 2026-12-24 with Jane Doe, John Doe and Sam Rivera. The oven died so we ordered pizza. Sam Rivera brought his new partner.";

function christmas(overrides: Parameters<typeof candidate>[0] = {}) {
  return candidate({
    kind: "episode",
    title: "Christmas at home",
    body: "Hosted Christmas. The oven died, so we ordered pizza. Sam brought his new partner.",
    shelf: "LIF/GTH",
    occurredOn: "2026-12-24",
    tags: ["christmas"],
    people: [{ name: "Jane Doe" }, { name: "John Doe" }, { name: "Sam Rivera" }],
    occasion: { title: "Christmas at home", type: "PARTY" },
    notes: [{ person: "Sam Rivera", body: "Brought a new partner to Christmas 2026." }],
    quote: "The oven died so we ordered pizza.",
    ...overrides,
  });
}

async function proposeChristmas(host: TestHost, overrides: Parameters<typeof candidate>[0] = {}) {
  const proposed = await draft(host, { job: "extract", material: turns(TELLING), sessionDate: SESSION_DATE }, { candidates: [christmas(overrides)] });
  const id = proposed.queued[0]?.id;
  if (!id) throw new Error(JSON.stringify(proposed.rejected));
  return id;
}

function decide(host: TestHost, proposalId: string, decision: "confirm" | "reject", pending?: Record<string, unknown>) {
  return host.invoke<DecideResult>("memory.decide", { proposalId, decision, confirmedByUser: true, ...(pending ? { pending } : {}) });
}

describe("the Fellowship link, from Reverie's side", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  describe("writing, when the owner told it", () => {
    it("writes the episode with attendees as people refs with label snapshots and the occasion ref, and hands back the back reference", async () => {
      // The occasion was logged first (people.log_interaction), so its id exists.
      const made = await host.invoke<RememberResult>("memory.remember", {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        title: "Christmas at home",
        body: "Hosted Christmas. The oven died, so we ordered pizza.",
        attendees: [
          { uri: PEOPLE.jane.uri, label: PEOPLE.jane.name },
          { uri: PEOPLE.john.uri, label: PEOPLE.john.name },
          { uri: PEOPLE.sam.uri, label: PEOPLE.sam.name },
        ],
        occasion: { uri: OCCASION, label: "Christmas at home, 2026-12-24" },
      });
      expect(made.memory.call).toBe("LIF/GTH/2026-12-24/001");
      const refs = await host.db.memoryRef.findMany({ where: { memoryId: made.memory.id }, orderBy: [{ role: "asc" }, { label: "asc" }] });
      expect(refs.map((ref) => [ref.role, ref.uri, ref.label, ref.resolved])).toEqual([
        ["attendee", PEOPLE.jane.uri, "Jane Doe", true],
        ["attendee", PEOPLE.john.uri, "John Doe", true],
        ["attendee", PEOPLE.sam.uri, "Sam Rivera", true],
        ["occasion", OCCASION, "Christmas at home, 2026-12-24", true],
      ]);
      expect(made.backRef).toMatchObject({
        tool: "people.update_interaction",
        input: {
          eventId: "e_8812",
          patch: { refs: [{ uri: "module://memory/memory/LIF/GTH/2026-12-24/001", label: "Christmas at home" }] },
        },
      });
      expect(made.backRef?.merge).toContain("replaces the occasion's whole list");
    });

    it("with no occasion URI there is no back reference to run", async () => {
      const made = await host.invoke<RememberResult>("memory.remember", {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "Hosted Christmas.",
        attendees: ["Jane Doe"],
      });
      expect(made.backRef).toBeNull();
    });
  });

  describe("writing, when a model inferred it", () => {
    it("queues one Reverie proposal carrying the occasion and the note as pending payloads", async () => {
      await proposeChristmas(host);
      expect(host.proposals).toHaveLength(1);
      expect(host.proposals[0]).toMatchObject({
        tool: "memory.remember",
        group: { title: "Christmas at home, 2026-12-24" },
        payload: {
          draft: {
            pendingOccasion: {
              title: "Christmas at home",
              type: "PARTY",
              occurredAt: "2026-12-24",
              participants: ["Jane Doe", "John Doe", "Sam Rivera"],
            },
            pendingNotes: [{ person: "Sam Rivera", uri: null, body: "Brought a new partner to Christmas 2026.", occurredAt: "2026-12-24" }],
          },
        },
      });
    });

    it("decide returns the followUp in the spec's shape with the real people.log_interaction input and the back reference", async () => {
      const id = await proposeChristmas(host);
      const decided = (await decide(host, id, "confirm")) as Confirmed;
      expect({ committed: decided.committed, followUp: decided.followUp }).toEqual({
        committed: { call: "LIF/GTH/2026-12-24/001" },
        followUp: {
          tool: "people.log_interaction",
          input: {
            title: "Christmas at home",
            type: "PARTY",
            occurredAt: "2026-12-24",
            participants: [{ name: "Jane Doe" }, { name: "John Doe" }, { name: "Sam Rivera" }],
            refs: [{ uri: "module://memory/memory/LIF/GTH/2026-12-24/001", label: "Christmas at home" }],
          },
          then: { tool: "memory.link_occasion", call: "LIF/GTH/2026-12-24/001" },
        },
      });
      expect(decided.noteFollowUps).toEqual([
        {
          tool: "people.add_note",
          input: {
            personId: null,
            body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Brought a new partner to Christmas 2026." }] }] },
            occurredAt: "2026-12-24",
          },
          person: { uri: null, label: "Sam Rivera" },
          resolveFirst: { tool: "people.resolve_person", input: { name: "Sam Rivera" } },
        },
      ]);
    });

    it("an attendee the people module resolved goes by personId in the follow up", async () => {
      host.primePeople([PEOPLE.sam]);
      const id = await proposeChristmas(host, {
        people: [{ name: "Jane Doe" }, { name: "Sam Rivera", uri: PEOPLE.sam.uri }],
        notes: [{ person: "Sam Rivera", body: "Brought a new partner to Christmas 2026." }],
      });
      const decided = (await decide(host, id, "confirm")) as Confirmed;
      expect(decided.followUp?.input.participants).toEqual([{ name: "Jane Doe" }, { personId: "p_sam" }]);
      expect(decided.noteFollowUps[0]).toMatchObject({ input: { personId: "p_sam" }, resolveFirst: null });
    });

    it("link_occasion completes it: the occasion ref, attendees resolved from the participants passed through, off the front desk", async () => {
      const id = await proposeChristmas(host);
      const decided = (await decide(host, id, "confirm")) as Confirmed;
      let review = await host.invoke<ReviewResult>("memory.review");
      expect(review.frontDesk.occasionPending.map((item) => item.call)).toEqual(["LIF/GTH/2026-12-24/001"]);
      expect(review.frontDesk.occasionPending[0]?.followUp).toEqual(decided.followUp);

      // The assistant ran the follow up; Fellowship answered with the event
      // and its participants, which the refs port here cannot read.
      const linked = await host.invoke<LinkOccasionToolResult>("memory.link_occasion", {
        call: decided.followUp!.then!.call,
        occasion: OCCASION,
        label: "Christmas at home, 2026-12-24",
        participants: [
          { uri: PEOPLE.jane.uri, label: PEOPLE.jane.name },
          { uri: PEOPLE.john.uri, label: PEOPLE.john.name },
          { uri: PEOPLE.sam.uri, label: PEOPLE.sam.name },
        ],
      });
      expect(linked).toMatchObject({ synced: true, resolvedNames: ["Jane Doe", "John Doe", "Sam Rivera"], alsoLinkedFrom: [] });
      expect(linked.memory.occasion).toMatchObject({ uri: OCCASION, status: "unavailable", label: "Christmas at home, 2026-12-24" });
      expect(linked.memory.attendees.map((ref) => ref.uri)).toEqual([PEOPLE.jane.uri, PEOPLE.john.uri, PEOPLE.sam.uri]);
      review = await host.invoke<ReviewResult>("memory.review");
      expect(review.frontDesk.occasionPending).toEqual([]);
    });

    it("nobody runs the follow up: the memory stands with named attendees and is listed as occasion pending", async () => {
      const id = await proposeChristmas(host);
      await decide(host, id, "confirm");
      const got = await host.invoke<GetResult>("memory.get", { call: "LIF/GTH/2026-12-24/001" });
      expect(got.memory).toMatchObject({ state: "active", occasion: null });
      expect(got.memory.attendees.map((ref) => ref.status)).toEqual(["unresolved", "unresolved", "unresolved"]);
      const review = await host.invoke<ReviewResult>("memory.review");
      expect(review.frontDesk.occasionPending).toMatchObject([
        { call: "LIF/GTH/2026-12-24/001", occasion: { title: "Christmas at home", type: "PARTY", occurredAt: "2026-12-24" } },
      ]);
    });
  });

  describe("grouped proposals: a group is a heading, not a transaction", () => {
    it("review shows the occasion, the episode and the note as one group, in commit order", async () => {
      const id = await proposeChristmas(host);
      const review = await host.invoke<ReviewResult>("memory.review");
      expect(review.groups).toHaveLength(1);
      expect(review.groups[0]).toMatchObject({ title: "Christmas at home, 2026-12-24", detail: "With Jane Doe, John Doe, Sam Rivera" });
      expect(review.groups[0]?.steps.map((step) => [step.step, step.part, step.tool, step.proposalId])).toEqual([
        [1, "occasion", "people.log_interaction", id],
        [2, "memory", "memory.remember", id],
        [3, "note", "people.add_note", id],
      ]);
      expect(review.groups[0]?.steps[2]).toMatchObject({ noteIndex: 0, summary: "Note on Sam Rivera: Brought a new partner to Christmas 2026." });
    });

    it("reject the occasion: the episode still stands, with named attendees and no occasion, and the note still comes back", async () => {
      const id = await proposeChristmas(host);
      const decided = (await decide(host, id, "confirm", { occasion: "reject" })) as Confirmed;
      expect(decided).toMatchObject({ state: "confirmed", committed: { call: "LIF/GTH/2026-12-24/001" }, followUp: null });
      expect(decided.noteFollowUps).toHaveLength(1);
      expect((await host.invoke<ReviewResult>("memory.review")).frontDesk.occasionPending).toEqual([]);
      expect(await host.db.memoryRef.count({ where: { role: "occasion" } })).toBe(0);
    });

    it("reject the note: the episode and the occasion stand", async () => {
      const id = await proposeChristmas(host);
      const decided = (await decide(host, id, "confirm", { notes: ["reject"] })) as Confirmed;
      expect(decided.followUp?.tool).toBe("people.log_interaction");
      expect(decided.noteFollowUps).toEqual([]);
    });

    it("reject the episode: nothing is written here, and the occasion and note the owner kept still come back", async () => {
      const id = await proposeChristmas(host);
      const decided = await decide(host, id, "reject", { occasion: "confirm", notes: ["confirm"] });
      expect(decided.state).toBe("discarded");
      expect(decided.followUp).toMatchObject({
        tool: "people.log_interaction",
        input: { title: "Christmas at home", participants: [{ name: "Jane Doe" }, { name: "John Doe" }, { name: "Sam Rivera" }] },
        then: null,
      });
      expect(decided.followUp?.input).not.toHaveProperty("refs");
      expect(decided.noteFollowUps).toHaveLength(1);
      expect(await host.db.memory.count()).toBe(0);
    });

    it("a plain reject turns every part down", async () => {
      const id = await proposeChristmas(host);
      const decided = await decide(host, id, "reject");
      expect(decided).toMatchObject({ state: "discarded", followUp: null, noteFollowUps: [] });
    });

    it("a note about someone the candidate does not name is refused at propose time", async () => {
      const proposed = await draft(
        host,
        { job: "extract", material: turns(TELLING), sessionDate: SESSION_DATE },
        { candidates: [christmas({ notes: [{ person: "Morgan Lee", body: "Moved to Lisbon." }] })] },
      );
      expect(proposed.rejected).toMatchObject([{ code: "note-person-unknown" }]);
    });
  });

  describe("reading: asking about people", () => {
    async function story(occurredOn: string, body: string, attendees: unknown[]) {
      return (
        await host.invoke<RememberResult>("memory.remember", { kind: "episode", shelf: "LIF/GTH", occurredOn, body, attendees })
      ).memory.call;
    }

    it("about a person, newest first, by people URI and by unresolved name", async () => {
      const older = await story("2026-11-02", "Climbed at the Elmwood wall.", [{ uri: PEOPLE.sam.uri, label: "Sam Rivera" }]);
      const newer = await story("2026-12-20", "Coffee at the harbour kiosk.", [{ uri: PEOPLE.sam.uri, label: "Sam Rivera" }]);
      const named = await story("2026-12-22", "Board games at the Elmwood library.", ["Sam Rivera"]);
      const byUri = await host.invoke<AboutResult>("memory.about", { person: PEOPLE.sam.uri });
      expect(byUri.items.map((item) => item.call)).toEqual([newer, older]);
      const byName = await host.invoke<AboutResult>("memory.about", { person: "sam rivera" });
      expect(byName.items.map((item) => [item.call, item.matchedBy])).toEqual([[named, "label"]]);
      const both = await host.invoke<AboutResult>("memory.about", { person: { uri: PEOPLE.sam.uri, name: "Sam Rivera" } });
      expect(both.items.map((item) => item.call)).toEqual([named, newer, older]);
    });

    it("episodes carrying two people: only those both were at", async () => {
      const both = await story("2026-12-24", "Christmas dinner at home.", [
        { uri: PEOPLE.jane.uri, label: "Jane Doe" },
        { uri: PEOPLE.john.uri, label: "John Doe" },
      ]);
      await story("2026-12-25", "Walk with Jane on the canal.", [{ uri: PEOPLE.jane.uri, label: "Jane Doe" }]);
      await story("2026-12-26", "John fixed the gate.", [{ uri: PEOPLE.john.uri, label: "John Doe" }]);
      const about = await host.invoke<AboutResult>("memory.about", { person: [PEOPLE.jane.uri, PEOPLE.john.uri] });
      expect(about.items.map((item) => item.call)).toEqual([both]);
      expect(about.with).toEqual([{ subject: expect.objectContaining({ uri: PEOPLE.john.uri }), name: null }]);
    });

    it("with the people module absent, the labels still name who was there and recall finds the story", async () => {
      const call = await story("2026-12-24", "Hosted Christmas. The oven died, so we ordered pizza.", [
        { uri: PEOPLE.sam.uri, label: "Sam Rivera" },
      ]);
      const got = await host.invoke<GetResult>("memory.get", { call });
      expect(got.memory.attendees).toEqual([expect.objectContaining({ label: "Sam Rivera", status: "unavailable" })]);
      const recalled = await host.invoke<{ items: Array<{ call: string; attendees: string[] }> }>("memory.recall", { query: "oven pizza" });
      expect(recalled.items).toMatchObject([{ call, attendees: [PEOPLE.sam.uri] }]);
    });
  });

  describe("no second occasion on a retry", () => {
    it("decide links to an occasion the people module logged since, instead of handing back a second log", async () => {
      host.primePeople([PEOPLE.jane, PEOPLE.sam]);
      const id = await proposeChristmas(host, {
        people: [
          { name: "Jane Doe", uri: PEOPLE.jane.uri },
          { name: "Sam Rivera", uri: PEOPLE.sam.uri },
        ],
        notes: [],
      });
      // Meanwhile the owner logged it in Fellowship, and Reverie heard.
      await host.invoke("memory.link_occasion", {
        report: { event: "people.interaction.logged", payload: { eventId: "e_8812", personIds: ["p_sam", "p_jane"], occurredAt: "2026-12-24T00:00:00.000Z" } },
      });
      const decided = (await decide(host, id, "confirm")) as Confirmed;
      expect(decided.followUp).toBeNull();
      expect(decided.linkedOccasion).toMatchObject({ uri: OCCASION, via: "logged" });
      const got = await host.invoke<GetResult>("memory.get", { call: decided.committed!.call });
      expect(got.memory.occasion?.uri).toBe(OCCASION);
    });

    it("an occasion already linked from another memory: both link, and the result says so", async () => {
      const first = await host.invoke<RememberResult>("memory.remember", {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "Hosted Christmas.",
        attendees: ["Jane Doe"],
        occasion: { uri: OCCASION, label: "Christmas at home" },
      });
      const second = await host.invoke<RememberResult>("memory.remember", {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "The playlist argument after dinner.",
        attendees: ["Jane Doe"],
      });
      const linked = await host.invoke<LinkOccasionToolResult>("memory.link_occasion", { call: second.memory.call, occasion: OCCASION });
      expect(linked.alsoLinkedFrom).toEqual([first.memory.call]);
      expect(linked.notice).toContain("memory.merge");
      expect(linked.backRef?.input.patch.refs).toEqual([{ uri: `module://memory/memory/${second.memory.call}`, label: second.memory.title }]);
    });

    it("the back reference merges into the refs the occasion already carries", async () => {
      const made = await host.invoke<RememberResult>("memory.remember", {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "The playlist argument after dinner.",
        attendees: ["Jane Doe"],
      });
      const other = { uri: "module://memory/memory/LIF/GTH/2026-12-24/009", label: "Christmas lunch" };
      const linked = await host.invoke<LinkOccasionToolResult>("memory.link_occasion", {
        call: made.memory.call,
        occasion: OCCASION,
        occasionRefs: [other, { uri: `module://memory/memory/${made.memory.call}`, label: "older label" }],
      });
      expect(linked.backRef?.input).toEqual({
        eventId: "e_8812",
        patch: { refs: [other, { uri: `module://memory/memory/${made.memory.call}`, label: made.memory.title }] },
      });
    });
  });

  describe("label refresh: a snapshot, never the authority", () => {
    it("update with people moves the labels to what the people module shows now", async () => {
      const made = await host.invoke<RememberResult>("memory.remember", {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "Hosted Christmas.",
        attendees: [{ uri: PEOPLE.sam.uri, label: "Sam R." }, "Jane Doe"],
      });
      const updated = await host.invoke<UpdateToolResult>("memory.update", {
        call: made.memory.call,
        people: [
          { uri: PEOPLE.sam.uri, label: "Sam Rivera" },
          { uri: PEOPLE.jane.uri, label: "Jane Doe", name: "Jane Doe" },
        ],
      });
      expect(updated).toMatchObject({ changed: true, people: { refreshed: 1, resolvedNames: ["Jane Doe"] } });
      expect(updated.memory.attendees.map((ref) => [ref.uri, ref.label])).toEqual([
        [PEOPLE.sam.uri, "Sam Rivera"],
        [PEOPLE.jane.uri, "Jane Doe"],
      ]);
      expect(updated.memory.body).toBe("Hosted Christmas.");
      const again = await host.invoke<UpdateToolResult>("memory.update", { call: made.memory.call, people: [{ uri: PEOPLE.sam.uri, label: "Sam Rivera" }] });
      expect(again.changed).toBe(false);
    });

    it("a stored label stands when the people module is absent, and the port's answer wins when it is present", async () => {
      const made = await host.invoke<RememberResult>("memory.remember", {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "Hosted Christmas.",
        attendees: [{ uri: PEOPLE.sam.uri, label: "Sam R." }],
      });
      expect((await host.invoke<GetResult>("memory.get", { call: made.memory.call })).memory.attendees[0]?.label).toBe("Sam R.");
      host.primePeople([PEOPLE.sam]);
      expect((await host.invoke<GetResult>("memory.get", { call: made.memory.call })).memory.attendees[0]).toMatchObject({
        label: "Sam Rivera",
        status: "resolved",
      });
    });
  });

  describe("both directions, through the tools when no bus delivers", () => {
    it("report people.interaction.changed with participants updates the attendee refs; removed marks the occasion unavailable; the text is untouched", async () => {
      const made = await host.invoke<RememberResult>("memory.remember", {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "Hosted Christmas. The oven died.",
        attendees: ["Jane Doe", "Sam Rivera"],
        occasion: { uri: OCCASION, label: "Christmas at home" },
      });
      const changed = await host.invoke<ReportResult>("memory.link_occasion", {
        report: {
          event: "people.interaction.changed",
          payload: {
            eventId: "e_8812",
            change: "participants",
            occurredAt: "2026-12-24T00:00:00.000Z",
            title: "Christmas at home",
            participants: [
              { personId: "p_jane", name: "Jane Doe" },
              { personId: "p_john", name: "John Doe" },
            ],
          },
        },
      });
      expect(changed.report).toMatchObject({ handled: true, detail: { change: "participants", changed: [made.memory.id] } });
      let got = await host.invoke<GetResult>("memory.get", { call: made.memory.call });
      expect(got.memory.attendees.map((ref) => [ref.uri, ref.label])).toEqual(
        expect.arrayContaining([
          [PEOPLE.jane.uri, "Jane Doe"],
          [PEOPLE.john.uri, "John Doe"],
          [null, "Sam Rivera"],
        ]),
      );

      await host.invoke("memory.link_occasion", {
        report: { event: "people.interaction.changed", payload: { eventId: "e_8812", change: "removed", occurredAt: null, title: null, participants: [] } },
      });
      got = await host.invoke<GetResult>("memory.get", { call: made.memory.call });
      expect(got.memory.occasion).toMatchObject({ uri: OCCASION, status: "unavailable" });
      expect(got.memory.body).toBe("Hosted Christmas. The oven died.");
    });

    it("report people.person.created queues the resolution for review, never applying it", async () => {
      const made = await host.invoke<RememberResult>("memory.remember", {
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "Hosted Christmas.",
        attendees: ["Sam Rivera"],
      });
      const result = await host.invoke<ReportResult>("memory.link_occasion", {
        report: { event: "people.person.created", payload: { personId: "p_sam", displayName: "Sam Rivera" } },
      });
      expect(result.report).toMatchObject({ handled: true, detail: { proposed: 1, matches: [made.memory.call] } });
      expect((await host.invoke<GetResult>("memory.get", { call: made.memory.call })).memory.attendees[0]?.uri).toBeNull();
      const review = await host.invoke<ReviewResult>("memory.review");
      expect(review.groups[0]).toMatchObject({ title: "Names that now match Sam Rivera", steps: [{ part: "memory", tool: "memory.update" }] });
    });

    it("report people.interaction.logged lists the occasion with no story yet, and a telling attaches to it", async () => {
      host.primePeople([PEOPLE.jane, PEOPLE.sam]);
      await host.invoke("memory.link_occasion", {
        report: { event: "people.interaction.logged", payload: { eventId: "e_8812", personIds: ["p_jane", "p_sam"], occurredAt: "2026-12-24T00:00:00.000Z" } },
      });
      expect((await host.invoke<ReviewResult>("memory.review")).frontDesk.occasionsWithNoStory.map((item) => item.occasion)).toEqual([OCCASION]);
      expect(await host.db.memory.count()).toBe(0);

      await draft(
        host,
        { job: "extract", material: turns(TELLING), sessionDate: SESSION_DATE },
        {
          candidates: [
            christmas({
              people: [
                { name: "Jane Doe", uri: PEOPLE.jane.uri },
                { name: "Sam Rivera", uri: PEOPLE.sam.uri },
              ],
              notes: [],
            }),
          ],
        },
      );
      expect(host.proposals[0]?.payload).toMatchObject({ occasion: { uri: OCCASION }, draft: { pendingOccasion: null } });
      expect(host.proposals[0]?.summary).toContain("the people module logged that day");
    });

    it("the front desk lists unresolved names with the memories that carry them", async () => {
      await host.invoke("memory.remember", { kind: "episode", shelf: "LIF/GTH", occurredOn: "2026-12-20", body: "Coffee.", attendees: ["Sam Rivera"] });
      await host.invoke("memory.remember", { kind: "fact", body: "Knows a good bakery.", mentions: ["sam  rivera"] });
      const review = await host.invoke<ReviewResult>("memory.review");
      expect(review.frontDesk.unresolvedNames).toEqual([{ name: "Sam Rivera", calls: expect.arrayContaining([expect.any(String)]) }]);
      expect(review.frontDesk.unresolvedNames[0]?.calls).toHaveLength(2);
    });

    it("report refuses to mix with a link", async () => {
      await expect(
        host.invoke("memory.link_occasion", {
          call: "LIF/GTH/2026-12-24/001",
          occasion: OCCASION,
          report: { event: "people.person.created", payload: {} },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });
});
