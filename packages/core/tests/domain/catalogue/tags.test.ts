import { afterEach, describe, expect, it } from "vitest";

import {
  attachTags,
  detachTags,
  mergeTags,
  normaliseTag,
  parseInlineTags,
  renameTag,
  tagsOf,
  tagVocabulary,
} from "../../../src/domain/catalogue/tags.js";
import { DomainError } from "../../../src/domain/errors.js";
import { createMemory, updateMemory } from "../../../src/domain/memories.js";
import { history } from "../../../src/domain/versions.js";
import type { Silo } from "../../../src/storage/client.js";
import { episode, ftsHits, openLibrary, USER } from "../library.js";

let db: Silo | undefined;

afterEach(async () => {
  await db?.$disconnect();
  db = undefined;
});

async function open(): Promise<Silo> {
  db = await openLibrary();
  return db;
}

async function rowidOf(silo: Silo, id: string): Promise<number> {
  const rows = await silo.$queryRawUnsafe<Array<{ rowid: bigint | number }>>(
    `SELECT rowid FROM "Memory" WHERE id = ?`,
    id,
  );
  return Number(rows[0]!.rowid);
}

describe("normalising and parsing", () => {
  it("makes #NightStash, #nightstash and nightstash one tag", () => {
    expect(normaliseTag("#NightStash")).toBe("nightstash");
    expect(normaliseTag("nightstash")).toBe("nightstash");
    expect(() => normaliseTag("two words")).toThrow(DomainError);
  });

  it("parses inline tags in order, once each, and leaves anchors, entities and headings alone", () => {
    const body =
      "# Pricing call\nDecided on #NightStash pricing while on #vacation (#work). " +
      "See example.com/#section and &#39;quoted&#39;. #nightstash again, #ns- trailing.";
    expect(parseInlineTags(body)).toEqual(["nightstash", "vacation", "work", "ns"]);
    expect(parseInlineTags("#" + "a".repeat(65))).toEqual([]);
  });
});

describe("attaching and detaching", () => {
  it("attaches given and inline tags at create and keeps tagText in step for FTS", async () => {
    const silo = await open();
    const memory = await createMemory(
      silo,
      episode({ tags: ["#Christmas", "family"], body: "Hosted Christmas, very #cosy." }),
      USER,
    );
    expect(await tagsOf(silo, memory.id)).toEqual(["christmas", "cosy", "family"]);
    expect((await silo.memory.findUniqueOrThrow({ where: { id: memory.id } })).tagText).toBe(
      "christmas cosy family",
    );
    const rowid = await rowidOf(silo, memory.id);
    expect(await ftsHits(silo, "family")).toEqual([rowid]);

    await attachTags(silo, memory.id, ["#NightStash"], USER);
    await detachTags(silo, memory.id, ["family"], USER);
    expect((await silo.memory.findUniqueOrThrow({ where: { id: memory.id } })).tagText).toBe(
      "christmas cosy nightstash",
    );
    expect(await ftsHits(silo, "nightstash")).toEqual([rowid]);
    expect(await ftsHits(silo, "family")).toEqual([]);

    const ops = (await history(silo, memory.id)).map((v) => v.operation);
    expect(ops).toEqual(["create", "update", "update"]);
  });

  it("writes no version when attaching what is already there", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode({ tags: ["family"] }), USER);
    const result = await attachTags(silo, memory.id, ["#Family"], USER);
    expect(result.added).toEqual([]);
    expect(await history(silo, memory.id)).toHaveLength(1);
  });

  it("attaches inline tags from a changed body", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), USER);
    await updateMemory(silo, memory.id, { body: "Hosted Christmas, now with #snow." }, USER);
    expect(await tagsOf(silo, memory.id)).toEqual(["snow"]);
  });
});

describe("one vocabulary", () => {
  it("renames a tag across every memory, keeping its id", async () => {
    const silo = await open();
    const a = await createMemory(silo, episode({ tags: ["ns"] }), USER);
    const b = await createMemory(silo, episode({ tags: ["ns", "work"] }), USER);
    const before = await silo.tag.findUniqueOrThrow({ where: { slug: "ns" } });

    const renamed = await renameTag(silo, "#NS", "NightStash");
    expect(renamed).toEqual({ id: before.id, slug: "nightstash", memories: 2 });
    expect(await tagsOf(silo, a.id)).toEqual(["nightstash"]);
    expect((await silo.memory.findUniqueOrThrow({ where: { id: b.id } })).tagText).toBe("nightstash work");
    expect(await ftsHits(silo, "ns")).toEqual([]);
    await expect(renameTag(silo, "work", "nightstash")).rejects.toMatchObject({ code: "conflict" });
  });

  it("merges a tag: join rows only, nothing left on the old slug, a memory carrying both keeps one", async () => {
    const silo = await open();
    const onlyOld = await createMemory(silo, episode({ tags: ["ns"] }), USER);
    const both = await createMemory(silo, episode({ tags: ["ns", "nightstash"] }), USER);
    const onlyNew = await createMemory(silo, episode({ tags: ["nightstash"] }), USER);
    const oldTag = await silo.tag.findUniqueOrThrow({ where: { slug: "ns" } });
    await silo.project.create({ data: { slug: "nightstash", name: "NightStash", tagId: oldTag.id } });
    const bodiesBefore = (await silo.memory.findMany({ orderBy: { callNumber: "asc" } })).map((m) => m.body);

    const result = await mergeTags(silo, "#ns", "#NightStash");
    expect(result).toEqual({ into: "nightstash", moved: 1, alreadyTagged: 1 });

    expect(await silo.tag.findUnique({ where: { slug: "ns" } })).toBeNull();
    expect(await silo.memoryTag.count({ where: { tagId: oldTag.id } })).toBe(0);
    for (const memory of [onlyOld, both, onlyNew]) {
      expect(await tagsOf(silo, memory.id)).toEqual(["nightstash"]);
    }
    const target = await silo.tag.findUniqueOrThrow({ where: { slug: "nightstash" } });
    expect(await silo.memoryTag.count({ where: { tagId: target.id } })).toBe(3);
    expect((await silo.project.findUniqueOrThrow({ where: { slug: "nightstash" } })).tagId).toBe(target.id);
    const bodiesAfter = (await silo.memory.findMany({ orderBy: { callNumber: "asc" } })).map((m) => m.body);
    expect(bodiesAfter).toEqual(bodiesBefore);
    expect(await ftsHits(silo, "ns")).toEqual([]);
    expect(await ftsHits(silo, "nightstash")).toHaveLength(3);
  });

  it("lists the vocabulary with counts, most used first", async () => {
    const silo = await open();
    await createMemory(silo, episode({ tags: ["christmas", "family"] }), USER);
    await createMemory(silo, episode({ tags: ["family"] }), USER);
    await createMemory(silo, episode({ tags: ["work"] }), USER);
    const vocabulary = await tagVocabulary(silo);
    expect(vocabulary.map((entry) => [entry.slug, entry.count])).toEqual([
      ["family", 2],
      ["christmas", 1],
      ["work", 1],
    ]);
    expect(vocabulary.every((entry) => /^#[0-9a-f]{6}$/.test(entry.colour))).toBe(true);
  });
});
