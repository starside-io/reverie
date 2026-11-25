import { afterEach, describe, expect, it } from "vitest";

import { addSource, createMemory, supersedeMemory } from "../../src/domain/memories.js";
import { history } from "../../src/domain/versions.js";
import type { Silo } from "../../src/storage/client.js";
import { episode, openLibrary, USER } from "./library.js";

let db: Silo | undefined;

afterEach(async () => {
  await db?.$disconnect();
  db = undefined;
});

async function open(): Promise<Silo> {
  db = await openLibrary();
  return db;
}

const PAGE = { kind: "page", label: "Sam Rivera's blog", uri: "https://example.test/sam", trust: "external" } as const;

describe("addSource", () => {
  it("cites a new source with its quote and writes one update version holding it", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), USER);
    const result = await addSource(
      silo,
      memory.callNumber,
      { source: PAGE, quote: "Christmas dinner at Jane's" },
      { actor: "user", at: new Date("2026-12-28T09:00:00Z") },
    );
    expect(result).toMatchObject({ added: true, sourceCreated: true });

    const citations = await silo.memorySource.findMany({ where: { memoryId: memory.id }, include: { source: true } });
    expect(citations).toHaveLength(2);
    expect(citations.find((row) => row.sourceId === result.sourceId)).toMatchObject({
      quote: "Christmas dinner at Jane's",
      source: { kind: "page", uri: "https://example.test/sam", trust: "external" },
    });

    const versions = await history(silo, memory.id);
    expect(versions.map((v) => v.operation)).toEqual(["create", "update"]);
    expect(versions[1]?.content?.sources.map((s) => s.sourceId)).toContain(result.sourceId);
  });

  it("reuses an existing source by id, and an identical descriptor rather than duplicating it", async () => {
    const silo = await open();
    const first = await createMemory(silo, episode(), USER);
    const second = await createMemory(silo, episode({ title: "Boxing Day walk", body: "Walked the dunes with Sam Rivera." }), USER);

    const byDescriptor = await addSource(silo, first, { source: PAGE, quote: "dinner at Jane's" }, USER);
    const sameDescriptor = await addSource(silo, second, { source: PAGE, quote: "a walk on the dunes" }, USER);
    expect(sameDescriptor).toMatchObject({ added: true, sourceCreated: false, sourceId: byDescriptor.sourceId });

    const sessionSource = await silo.memorySource.findFirstOrThrow({ where: { memoryId: first.id, NOT: { sourceId: byDescriptor.sourceId } } });
    const byId = await addSource(silo, second, { sourceId: sessionSource.sourceId, quote: "everyone over" }, USER);
    expect(byId).toMatchObject({ added: true, sourceCreated: false, sourceId: sessionSource.sourceId });
    expect(await silo.source.count()).toBe(3);
  });

  it("writes nothing when the memory already cites the source: the first quote stands", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), USER);
    const cited = await silo.memorySource.findFirstOrThrow({ where: { memoryId: memory.id } });
    const result = await addSource(silo, memory, { sourceId: cited.sourceId, quote: "a different quote" }, USER);
    expect(result.added).toBe(false);
    expect((await silo.memorySource.findFirstOrThrow({ where: { memoryId: memory.id } })).quote).toBe(cited.quote);
    expect((await history(silo, memory.id)).map((v) => v.operation)).toEqual(["create"]);
  });

  it("refuses a quote over 500 characters, an unknown source, an unknown memory and a superseded one", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), USER);
    await expect(addSource(silo, memory, { source: PAGE, quote: "x".repeat(501) }, USER)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(addSource(silo, memory, { source: PAGE, quote: "y".repeat(500) }, USER)).resolves.toMatchObject({
      added: true,
    });
    await expect(
      addSource(silo, memory, { sourceId: "00000000-0000-4000-8000-000000000000", quote: "q" }, USER),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(addSource(silo, "LIF/GTH/2026-12-24/099", { source: PAGE, quote: "q" }, USER)).rejects.toMatchObject({
      code: "not_found",
    });

    await supersedeMemory(silo, memory, episode({ body: "Hosted Christmas with Jane Doe only." }), {
      actor: "user",
      at: new Date("2027-01-02T00:00:00Z"),
    });
    await expect(addSource(silo, memory, { source: { ...PAGE, label: "other" }, quote: "q" }, USER)).rejects.toMatchObject({
      code: "refused",
    });
  });
});
