import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reshelveMemory } from "../../../src/domain/catalogue/shelving.js";
import { retireMemory } from "../../../src/domain/memories.js";
import type { RelatedResult } from "../../../src/tools/read/related.js";
import { PEOPLE, testHost, type TestHost } from "../../test-host.js";
import { NOW, seed } from "./fixtures.js";

describe("memory.related", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  async function week() {
    const christmas = await seed(host, {
      tags: ["christmas", "hosting"],
      refs: [
        { role: "attendee", uri: PEOPLE.jane.uri, label: "Jane Doe" },
        { role: "attendee", label: "Sam Rivera" },
        { role: "occasion", uri: "module://people/event/e_1", label: "Christmas at home" },
      ],
    });
    const prep = await seed(host, {
      title: "Party prep",
      body: "Bought lights.",
      occurredOn: "2026-12-20",
      tags: ["christmas", "hosting"],
      refs: [{ role: "attendee", uri: PEOPLE.jane.uri, label: "Jane Doe" }],
    });
    const photos = await seed(host, {
      title: "Photos",
      body: "Sorted the photos.",
      occurredOn: "2026-12-26",
      refs: [{ role: "occasion", uri: "module://people/event/e_1", label: "Christmas at home" }],
    });
    const walk = await seed(host, {
      title: "Walk",
      body: "A walk.",
      occurredOn: "2026-12-26",
      refs: [{ role: "mentions", label: "sam rivera" }],
    });
    await seed(host, { title: "Unrelated", body: "Nothing shared.", occurredOn: "2026-12-26" });
    return { christmas, prep, photos, walk };
  }

  it("ranks by how much is shared and gives the reason for each", async () => {
    const { christmas, prep, photos, walk } = await week();
    const result = await host.invoke<RelatedResult>("memory.related", { call: christmas.callNumber });
    expect(result.call).toBe(christmas.callNumber);
    expect(result.items.map((item) => [item.call, item.reason])).toEqual([
      [prep.callNumber, "2 tags, 1 person"],
      [photos.callNumber, "1 occasion"],
      [walk.callNumber, "1 person"],
    ]);
    expect(result.items[0]).toMatchObject({ sharedTags: ["christmas", "hosting"], sharedPeople: ["Jane Doe"], score: 3 });
  });

  it("resolves an old number and leaves retired entries out unless asked", async () => {
    const { christmas, prep } = await week();
    await retireMemory(host.db, { id: prep.id }, { actor: "user", at: NOW });
    await reshelveMemory(host.db, christmas.callNumber, { shelf: "LIF/HOM" }, { actor: "user" });

    const result = await host.invoke<RelatedResult>("memory.related", { call: christmas.callNumber });
    expect(result.call).toBe("LIF/HOM/2026-12-24/001");
    expect(result.items.some((item) => item.id === prep.id)).toBe(false);
    const all = await host.invoke<RelatedResult>("memory.related", { call: christmas.callNumber, includeRetired: true });
    expect(all.items[0]!.id).toBe(prep.id);
  });

  it("works with the people module absent and answers not_found for an unknown number", async () => {
    const { christmas } = await week();
    await expect(host.invoke("memory.related", { call: christmas.callNumber })).resolves.toBeDefined();
    await expect(host.invoke("memory.related", { call: "LIF/GTH/2026-01-01/001" })).rejects.toMatchObject({ code: "not_found" });
  });
});
