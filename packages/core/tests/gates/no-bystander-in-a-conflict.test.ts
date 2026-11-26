import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LinkOccasionToolResult } from "../../src/tools/write/link-occasion.js";
import type { RememberResult } from "../../src/tools/write/remember.js";
import { PEOPLE, type TestHost } from "../test-host.js";
import { candidate, draft, gateHost, SESSION_DATE, turns, type Confirmed } from "./harness.js";

/**
 * Gate: a conflict occasion never gains a bystander (docs/SPEC.md section 8,
 * "It works in both directions, and alone"). An attendee on the memory is not
 * automatically a participant on a conflict occasion: the follow up names
 * only who the draft says was in it, or nobody and a question, and linking a
 * conflict drops no attendee for not being in it.
 */

const TELLING =
  "At the 2026-12-24 dinner with Jane Doe, John Doe and Sam Rivera, Jane Doe and John Doe argued about the playlist. The oven died so we ordered pizza.";

function argument(participants: string[] | null) {
  return candidate({
    kind: "episode",
    title: "The playlist argument",
    body: "Jane and John argued about the playlist at Christmas dinner.",
    shelf: "LIF/GTH",
    occurredOn: "2026-12-24",
    people: [{ name: "Jane Doe" }, { name: "John Doe" }, { name: "Sam Rivera" }],
    occasion: { title: "The playlist argument", type: "CONFLICT", participants },
    quote: "Jane Doe and John Doe argued about the playlist.",
  });
}

describe("no bystander in a conflict", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  async function confirmDrafted(participants: string[] | null): Promise<Confirmed> {
    const proposed = await draft(
      host,
      { job: "extract", material: turns(TELLING), sessionDate: SESSION_DATE },
      { candidates: [argument(participants)] },
    );
    const id = proposed.queued[0]?.id;
    if (!id) throw new Error(JSON.stringify(proposed.rejected));
    return host.invoke<Confirmed>("memory.decide", { proposalId: id, decision: "confirm", confirmedByUser: true });
  }

  it("the follow up names only who was in it, never the attendee who was there", async () => {
    const decided = await confirmDrafted(["Jane Doe", "John Doe"]);
    expect(decided.followUp?.input).toMatchObject({ type: "CONFLICT", participants: [{ name: "Jane Doe" }, { name: "John Doe" }] });
    expect(JSON.stringify(decided.followUp)).not.toContain("Sam Rivera");
    expect(decided.followUp?.notice).toBeUndefined();
  });

  it("with nobody named as in it, nobody is assumed: the follow up has no participants and says to ask", async () => {
    const decided = await confirmDrafted(null);
    expect(decided.followUp?.input.participants).toEqual([]);
    expect(decided.followUp?.notice).toContain("Ask the owner who was in it");
    const memory = await host.db.memory.findFirstOrThrow({ include: { refs: true } });
    expect(memory.refs.filter((ref) => ref.role === "attendee")).toHaveLength(3);
  });

  it("someone the episode does not have as an attendee cannot be put in it", async () => {
    const proposed = await draft(
      host,
      { job: "extract", material: turns(TELLING), sessionDate: SESSION_DATE },
      { candidates: [argument(["Jane Doe", "Morgan Lee"])] },
    );
    expect(proposed.rejected).toMatchObject([{ code: "conflict-participant-not-attendee" }]);
  });

  it("linking a conflict keeps every attendee on the memory, adding only who was in it", async () => {
    const made = await host.invoke<RememberResult>("memory.remember", {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Jane and John argued about the playlist at Christmas dinner.",
      attendees: [
        { uri: PEOPLE.jane.uri, label: "Jane Doe" },
        { uri: PEOPLE.john.uri, label: "John Doe" },
        { uri: PEOPLE.sam.uri, label: "Sam Rivera" },
      ],
    });
    const linked = await host.invoke<LinkOccasionToolResult>("memory.link_occasion", {
      call: made.memory.call,
      occasion: "module://people/event/e_9001",
      type: "CONFLICT",
      participants: [
        { uri: PEOPLE.jane.uri, label: "Jane Doe" },
        { uri: PEOPLE.john.uri, label: "John Doe" },
      ],
    });
    expect(linked.removed).toEqual([]);
    expect(linked.memory.attendees.map((ref) => ref.uri).sort()).toEqual([PEOPLE.jane.uri, PEOPLE.john.uri, PEOPLE.sam.uri].sort());
    expect(linked.notice).toContain("A conflict");
  });
});
