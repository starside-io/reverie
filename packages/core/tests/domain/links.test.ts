import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLink, linksOf } from "../../src/domain/links.js";
import { createMemory } from "../../src/domain/memories.js";
import type { Silo } from "../../src/storage/client.js";
import { episode, openLibrary, USER } from "./library.js";

describe("links", () => {
  let db: Silo;

  beforeEach(async () => {
    db = await openLibrary();
  });
  afterEach(async () => {
    await db.$disconnect();
  });

  it("links two memories, refusing a self link and a duplicate, and cascades on delete", async () => {
    const a = await createMemory(db, episode(), USER);
    const b = await createMemory(db, episode({ title: "Pizza", body: "We ordered pizza." }), USER);

    await createLink(db, { fromId: a.id, toId: b.id, relation: "elaborates" });
    await expect(createLink(db, { fromId: a.id, toId: a.id, relation: "elaborates" })).rejects.toMatchObject({ code: "refused" });
    await expect(createLink(db, { fromId: a.id, toId: b.id, relation: "elaborates" })).rejects.toMatchObject({ code: "conflict" });
    await createLink(db, { fromId: b.id, toId: a.id, relation: "elaborates" });
    await createLink(db, { fromId: b.id, toId: a.id, relation: "contradicts" });
    await expect(createLink(db, { fromId: a.id, toId: b.id, relation: "contradicts" })).rejects.toMatchObject({ code: "conflict" });
    await expect(createLink(db, { fromId: a.id, toId: "00000000-0000-4000-8000-000000000000", relation: "elaborates" })).rejects.toMatchObject({
      code: "not_found",
    });

    expect(await linksOf(db, a.id)).toHaveLength(3);
    await db.memory.delete({ where: { id: b.id } });
    expect(await linksOf(db, a.id)).toHaveLength(0);
  });
});
