import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { retireMemory } from "../../../src/domain/memories.js";
import type { AboutResult } from "../../../src/tools/read/about.js";
import { auditStrings, PEOPLE, testHost, type TestHost } from "../../test-host.js";
import { NOW, seed } from "./fixtures.js";

const SAM_ID = "11111111-1111-4111-8111-111111111111";
const SAM_URI = `module://people/person/${SAM_ID}`;
const PARTY_URI = "module://people/event/22222222-2222-4222-8222-222222222222";

describe("memory.about", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  async function stories() {
    const summer = await seed(host, {
      title: "Summer barbecue",
      body: "Barbecue in the garden.",
      occurredOn: "2026-07-04",
      refs: [{ role: "attendee", uri: SAM_URI, label: "Sam Rivera" }],
    });
    const christmas = await seed(host, {
      refs: [
        { role: "attendee", uri: SAM_URI, label: "Sam Rivera" },
        { role: "attendee", label: "Jane Doe" },
        { role: "occasion", uri: PARTY_URI, label: "Christmas at home" },
      ],
    });
    const walk = await seed(host, {
      title: "Walk",
      body: "A walk on Boxing Day.",
      occurredOn: "2026-12-26",
      refs: [{ role: "mentions", label: "Sam  Rivera" }],
    });
    return { summer, christmas, walk };
  }

  it("finds a person by Fellowship id or module URI, newest first", async () => {
    const { summer, christmas } = await stories();
    for (const person of [SAM_ID, SAM_URI, { id: SAM_ID }, { uri: SAM_URI }]) {
      const result = await host.invoke<AboutResult>("memory.about", { person });
      expect(result.items.map((item) => item.call)).toEqual([christmas.callNumber, summer.callNumber]);
      expect(result.items.every((item) => item.matchedBy === "uri" && item.role === "attendee")).toBe(true);
    }
  });

  it("renders the subject as unavailable with the people module absent, and as resolved once primed", async () => {
    await stories();
    const without = await host.invoke<AboutResult>("memory.about", { person: SAM_URI });
    expect(without.subject).toMatchObject({ uri: SAM_URI, status: "unavailable" });

    host.primeRef(SAM_URI, "Sam Rivera");
    const primed = await host.invoke<AboutResult>("memory.about", { person: SAM_URI });
    expect(primed.subject).toMatchObject({ uri: SAM_URI, label: "Sam Rivera", status: "resolved" });
  });

  it("matches a name against unresolved labels only, never guessing it into a person", async () => {
    const { christmas, walk } = await stories();
    const jane = await host.invoke<AboutResult>("memory.about", { person: "jane doe" });
    expect(jane.subject).toBeNull();
    expect(jane.items.map((item) => [item.call, item.matchedBy])).toEqual([[christmas.callNumber, "label"]]);

    // "Sam Rivera" by name finds the walk, where he was a name, and not the URI references.
    const sam = await host.invoke<AboutResult>("memory.about", { person: "Sam Rivera" });
    expect(sam.items.map((item) => [item.call, item.role])).toEqual([[walk.callNumber, "mentions"]]);

    const both = await host.invoke<AboutResult>("memory.about", { person: { id: SAM_ID, name: "Sam Rivera" } });
    expect(both.items).toHaveLength(3);
    expect(both.total).toBe(3);
  });

  it("finds an occasion by its URI", async () => {
    const { christmas } = await stories();
    const result = await host.invoke<AboutResult>("memory.about", { occasion: PARTY_URI });
    expect(result.items.map((item) => [item.call, item.role])).toEqual([[christmas.callNumber, "occasion"]]);
    const byName = await host.invoke<AboutResult>("memory.about", { occasion: "Christmas at home" });
    expect(byName.items).toEqual([]);
  });

  it("leaves retired entries out unless asked, and takes exactly one subject", async () => {
    const { summer } = await stories();
    await retireMemory(host.db, { id: summer.id }, { actor: "user", at: NOW });
    expect((await host.invoke<AboutResult>("memory.about", { person: SAM_ID })).items).toHaveLength(1);
    expect((await host.invoke<AboutResult>("memory.about", { person: SAM_ID, includeRetired: true })).items).toHaveLength(2);
    await expect(host.invoke("memory.about", {})).rejects.toMatchObject({ code: "invalid_input" });
    await expect(host.invoke("memory.about", { person: SAM_ID, occasion: PARTY_URI })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("audits ids and numbers only", async () => {
    await stories();
    host.audit.length = 0;
    await host.invoke("memory.about", { person: "Jane Doe" });
    expect(auditStrings(host).some((text) => text.includes("Jane") || text.includes(PEOPLE.jane.name))).toBe(false);
  });
});
