import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RememberResult } from "../../src/tools/write/remember.js";
import { PEOPLE, type TestHost } from "../test-host.js";
import { candidate, confirm, draft, gateHost, remember, SESSION_DATE, turns } from "./harness.js";

/**
 * Gate: one event, not two. Telling the story of an occasion the people
 * module already holds links to it. No second occasion is proposed for the
 * same people on the same day without asking.
 *
 * What core enforces: a telling that names an existing occasion URI, by the
 * direct door or in a draft, links the memory to it and yields no pending
 * occasion and no followUp; and a drafted episode that matches an episode
 * already linked to an occasion on that day, with the same people, links to
 * that occasion instead of proposing a second. A draft for a day and people
 * core has no linked episode for still carries a pending occasion, which is
 * a proposal the owner decides: that is the asking.
 *
 * What is the skill's job, not core's: before running the people module's
 * log_interaction from a followUp, looking in the people module for an
 * occasion on that date with those participants and linking to it when
 * there is one (section 8, "No second occasion on a retry"). Core never
 * calls the people module, so it cannot see an occasion that no memory here
 * links to yet; the assistant, which sees both tool sets, does that lookup.
 */

const OCCASION = "module://people/event/e_8812";
const TELLING = "Hosted Christmas on 2026-12-24 with Jane Doe and Sam Rivera. The oven died so we ordered pizza.";

function episode(overrides: Parameters<typeof candidate>[0] = {}) {
  return candidate({
    kind: "episode",
    title: "Christmas at home",
    body: "Hosted Christmas. The oven died, so we ordered pizza.",
    shelf: "LIF/GTH",
    occurredOn: "2026-12-24",
    people: [{ name: "Jane Doe" }, { name: "Sam Rivera" }],
    occasion: { title: "Christmas at home", type: "PARTY" },
    quote: "The oven died so we ordered pizza.",
    ...overrides,
  });
}

describe("one event, not two", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  const occasionRefs = () => host.db.memoryRef.findMany({ where: { role: "occasion" }, include: { memory: true } });

  it("the direct door, told the occasion's URI, links to it and returns no followUp", async () => {
    const made = await remember(host, {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas. The oven died, so we ordered pizza.",
      attendees: ["Jane Doe", "Sam Rivera"],
      occasion: { uri: OCCASION, label: "Christmas at home" },
    });
    expect(made.memory.occasion).toMatchObject({ uri: OCCASION });
    expect(made).not.toHaveProperty("followUp");
  });

  it("a draft that names the occasion's URI links to it: no pending occasion, no followUp", async () => {
    const proposed = await draft(
      host,
      { job: "extract", material: turns(TELLING), sessionDate: SESSION_DATE },
      { candidates: [episode({ occasion: { title: "Christmas at home", type: "PARTY", uri: OCCASION } })] },
    );
    const queued = host.proposals[0]!;
    expect(queued.payload).toMatchObject({ occasion: { uri: OCCASION }, draft: { pendingOccasion: null } });
    expect(queued.summary).toContain("already held");
    const decided = await confirm(host, proposed.queued[0]!.id);
    expect(decided.followUp).toBeNull();
    expect((await occasionRefs()).map((ref) => ref.uri)).toEqual([OCCASION]);
  });

  it("a draft of an occasion already linked on that day with the same people links to it and proposes no second", async () => {
    await remember(host, {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      title: "Christmas lunch",
      body: "Lunch before the party: soup and bread.",
      attendees: ["Jane Doe", { uri: PEOPLE.sam.uri, label: PEOPLE.sam.name }],
      occasion: { uri: OCCASION, label: "Christmas at home" },
    });
    const proposed = await draft(host, { job: "extract", material: turns(TELLING), sessionDate: SESSION_DATE }, { candidates: [episode()] });
    expect(host.proposals[0]?.payload).toMatchObject({ occasion: { uri: OCCASION }, draft: { pendingOccasion: null } });
    const decided = await confirm(host, proposed.queued[0]!.id);
    expect(decided.followUp).toBeNull();
    const refs = await occasionRefs();
    expect(refs.map((ref) => ref.uri)).toEqual([OCCASION, OCCASION]);
  });

  it("another day, or other people, still proposes an occasion for the owner to decide", async () => {
    await remember(host, {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      title: "Christmas lunch",
      body: "Lunch before the party: soup and bread.",
      attendees: ["Jane Doe"],
      occasion: { uri: OCCASION, label: "Christmas at home" },
    });
    await draft(host, { job: "extract", material: turns(TELLING), sessionDate: SESSION_DATE }, { candidates: [episode()] });
    expect(host.proposals[0]?.payload).toMatchObject({
      draft: { pendingOccasion: { occurredAt: "2026-12-24", participants: ["Jane Doe", "Sam Rivera"] } },
    });
    expect(host.proposals[0]?.payload).not.toHaveProperty("occasion");
  });

  it("a second telling by the direct door attaches to the occasion the first one linked", async () => {
    const first = await remember(host, {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas. The oven died, so we ordered pizza.",
      attendees: ["Jane Doe", "Sam Rivera"],
      occasion: OCCASION,
    });
    const second = await host.invoke<RememberResult>("memory.remember", {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Sam Rivera brought his new partner to the party.",
      attendees: ["Sam Rivera"],
      occasion: first.memory.occasion!.uri!,
    });
    expect(second.memory.occasion?.uri).toBe(OCCASION);
    expect(new Set((await occasionRefs()).map((ref) => ref.uri))).toEqual(new Set([OCCASION]));
  });
});
