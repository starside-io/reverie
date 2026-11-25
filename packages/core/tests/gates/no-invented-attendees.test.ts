import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AboutResult } from "../../src/tools/read/about.js";
import type { LinkOccasionToolResult } from "../../src/tools/write/link-occasion.js";
import { PEOPLE, type TestHost } from "../test-host.js";
import { candidate, draft, extractAndConfirm, gateHost, remember, runEveryTool, SESSION_DATE, turns } from "./harness.js";

/**
 * Gate: no invented attendees (guardrail 7). A name that does not resolve
 * stays an unresolved label. It is never turned into a person, and never
 * guessed at when ambiguous. No URI lands on a memory that nobody gave.
 */

const TELLING = "Hosted Christmas on 2026-12-24 with Jane Doe, John Doe and Sam Rivera. The oven died so we ordered pizza.";

describe("no invented attendees", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  const refs = () => host.db.memoryRef.findMany({ orderBy: [{ role: "asc" }, { label: "asc" }] });

  it("the direct door keeps a name as a label, unresolved, and a URI as given", async () => {
    const made = await remember(host, {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas. The oven died, so we ordered pizza.",
      attendees: ["Jane Doe", PEOPLE.john.uri],
      mentions: ["Sam Rivera"],
    });
    expect(made.unresolved).toEqual(["Jane Doe", "Sam Rivera"]);
    expect((await refs()).map((ref) => [ref.role, ref.label, ref.uri])).toEqual([
      ["attendee", "Jane Doe", null],
      ["attendee", PEOPLE.john.uri, PEOPLE.john.uri],
      ["mentions", "Sam Rivera", null],
    ]);
  });

  it("a draft naming someone the material does not mention is rejected", async () => {
    const proposed = await draft(
      host,
      { job: "extract", material: turns(TELLING), sessionDate: SESSION_DATE },
      {
        candidates: [
          candidate({
            kind: "episode",
            shelf: "LIF/GTH",
            occurredOn: "2026-12-24",
            body: "Hosted Christmas.",
            people: [{ name: "Jane Doe" }, { name: "Alex Smith" }],
            quote: "The oven died so we ordered pizza.",
          }),
        ],
      },
    );
    expect(proposed.queued).toEqual([]);
    expect(proposed.rejected[0]).toMatchObject({ code: "person-not-in-material", detail: { name: "Alex Smith" } });
  });

  it("an ambiguous name stays a label and becomes a question, never a guess", async () => {
    host.primePeople([PEOPLE.sam, { id: "p_sam2", name: "Sam Rivera" }]);
    const { proposed } = await extractAndConfirm(
      host,
      turns(TELLING),
      candidate({
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "Hosted Christmas. The oven died, so we ordered pizza.",
        people: [
          { name: "Jane Doe", uri: PEOPLE.jane.uri },
          { name: "Sam Rivera", candidates: [PEOPLE.sam.uri, "module://people/person/p_sam2"] },
        ],
        quote: "The oven died so we ordered pizza.",
      }),
    );
    expect(proposed.questions).toEqual([expect.stringContaining("Sam Rivera")]);
    const attendees = (await refs()).filter((ref) => ref.role === "attendee");
    // Jane Doe was not primed, so the people module did not resolve her URI: she stays a label too.
    expect(attendees.map((ref) => [ref.label, ref.uri])).toEqual([
      ["Jane Doe", null],
      ["Sam Rivera", null],
    ]);
  });

  it("a name resolved to exactly one person keeps that person's URI", async () => {
    host.primePeople([PEOPLE.jane]);
    await extractAndConfirm(
      host,
      turns(TELLING),
      candidate({
        kind: "episode",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        body: "Hosted Christmas. The oven died, so we ordered pizza.",
        people: [{ name: "Jane Doe", uri: PEOPLE.jane.uri }, { name: "John Doe" }],
        quote: "The oven died so we ordered pizza.",
      }),
    );
    expect((await refs()).map((ref) => [ref.label, ref.uri])).toEqual([
      ["Jane Doe", PEOPLE.jane.uri],
      ["John Doe", null],
    ]);
  });

  it("linking an occasion takes URIs only for names that match a participant, and keeps the rest as told", async () => {
    const made = await remember(host, {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas. The oven died, so we ordered pizza.",
      attendees: ["Jane Doe", "Sam Rivera", "Alex Smith"],
    });
    const occasion = "module://people/event/e_8812";
    host.primeRef(occasion, "Christmas at home", {
      participants: [
        { uri: PEOPLE.jane.uri, label: PEOPLE.jane.name },
        { uri: PEOPLE.sam.uri, label: PEOPLE.sam.name },
      ],
    });
    const linked = await host.invoke<LinkOccasionToolResult>("memory.link_occasion", { call: made.memory.call, occasion });
    expect(linked.keptNames).toEqual(["Alex Smith"]);
    const attendees = (await refs()).filter((ref) => ref.role === "attendee");
    expect(attendees.find((ref) => ref.label === "Alex Smith")?.uri).toBeNull();
  });

  it("about a person with the people module absent matches the unresolved name", async () => {
    await remember(host, { kind: "episode", shelf: "LIF/GTH", body: "Skated on the canal.", attendees: ["Sam Rivera"] });
    const about = await host.invoke<AboutResult>("memory.about", { person: "Sam Rivera" });
    expect(about.items).toHaveLength(1);
  });

  it("after a session over every tool, every URI on a memory is one somebody gave", async () => {
    await runEveryTool(host);
    const given = new Set(["module://people/person/p_sam", "module://people/event/e_8812"]);
    for (const ref of await refs()) {
      if (ref.uri !== null) expect(given.has(ref.uri), ref.uri).toBe(true);
    }
    expect(host.audit.every((line) => line.tool.startsWith("memory."))).toBe(true);
  });
});
