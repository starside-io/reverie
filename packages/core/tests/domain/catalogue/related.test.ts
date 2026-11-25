import { afterEach, describe, expect, it } from "vitest";

import { relatedMemories, relatedReason } from "../../../src/domain/catalogue/related.js";
import { createMemory, retireMemory } from "../../../src/domain/memories.js";
import type { Silo } from "../../../src/storage/client.js";
import { episode, openLibrary, USER } from "../library.js";

let db: Silo | undefined;

afterEach(async () => {
  await db?.$disconnect();
  db = undefined;
});

const JANE = { role: "attendee" as const, label: "Jane Doe", uri: "module://people/person/jane" };
const JOHN = { role: "attendee" as const, label: "John Doe", uri: "module://people/person/john" };
const PARTY = { role: "occasion" as const, label: "Christmas at home", uri: "module://people/event/xmas" };

describe("relatedReason", () => {
  it("says what was shared", () => {
    expect(relatedReason(2, 1, false)).toBe("2 tags, 1 person");
    expect(relatedReason(1, 2, true)).toBe("1 tag, 2 people, 1 occasion");
    expect(relatedReason(0, 0, true)).toBe("1 occasion");
  });
});

describe("relatedMemories", () => {
  it("ranks others by how much they share, each with its reason", async () => {
    db = await openLibrary();
    const party = await createMemory(
      db,
      episode({ tags: ["christmas", "family"], refs: [JANE, JOHN, PARTY] }),
      USER,
    );
    const photos = await createMemory(
      db,
      episode({ title: "Photos from the party", tags: ["christmas", "family"], refs: [JANE] }),
      USER,
    );
    const toast = await createMemory(
      db,
      episode({ title: "Sam's toast", refs: [PARTY, { role: "mentions", label: "John Doe", uri: JOHN.uri }] }),
      USER,
    );
    const work = await createMemory(
      db,
      episode({ shelf: "WRK/NST", title: "Pricing", tags: ["family"] }),
      USER,
    );
    await createMemory(db, episode({ title: "Unrelated", tags: ["garden"] }), USER);

    const related = await relatedMemories(db, party.callNumber);
    expect(related.map((r) => [r.callNumber, r.reason])).toEqual([
      [photos.callNumber, "2 tags, 1 person"],
      [toast.callNumber, "1 person, 1 occasion"],
      [work.callNumber, "1 tag"],
    ]);
    expect(related[0]).toMatchObject({ sharedTags: ["christmas", "family"], sharedPeople: ["Jane Doe"], score: 3 });
    expect(related.some((r) => r.memoryId === party.id)).toBe(false);
  });

  it("matches an unresolved name only to the same unresolved name, and skips the stacks", async () => {
    db = await openLibrary();
    const told = await createMemory(db, episode({ refs: [{ role: "attendee", label: "Sam Rivera" }] }), USER);
    const sameName = await createMemory(db, episode({ refs: [{ role: "attendee", label: "sam rivera " }] }), USER);
    await createMemory(
      db,
      episode({ refs: [{ role: "attendee", label: "Sam Rivera", uri: "module://people/person/sam" }] }),
      USER,
    );
    const retired = await createMemory(db, episode({ refs: [{ role: "attendee", label: "Sam Rivera" }] }), USER);
    await retireMemory(db, retired.id, USER);

    const related = await relatedMemories(db, told.id);
    expect(related.map((r) => r.memoryId)).toEqual([sameName.id]);
    expect(related[0]!.reason).toBe("1 person");

    const withStacks = await relatedMemories(db, told.id, { states: ["active", "retired"] });
    expect(withStacks.map((r) => r.memoryId).sort()).toEqual([sameName.id, retired.id].sort());
  });
});
