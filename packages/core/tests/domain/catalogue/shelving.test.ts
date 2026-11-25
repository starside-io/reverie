import { afterEach, describe, expect, it } from "vitest";

import { aliasesOf, resolveCallNumber } from "../../../src/domain/catalogue/call-number.js";
import {
  createSection,
  createShelf,
  defaultShelf,
  deleteShelf,
  mergeSections,
  mergeShelves,
  renameSection,
  renameShelf,
  reorderDay,
  reorderSections,
  reorderShelves,
  reshelveMemory,
  resolveShelf,
  RETURNS_PATH,
  seedLibrary,
  STARTING_LIBRARY,
  swapSeq,
} from "../../../src/domain/catalogue/shelving.js";
import { DomainError } from "../../../src/domain/errors.js";
import { createMemory } from "../../../src/domain/memories.js";
import { history } from "../../../src/domain/versions.js";
import type { Silo } from "../../../src/storage/client.js";
import { episode, openLibrary, USER } from "../library.js";

let db: Silo | undefined;

afterEach(async () => {
  await db?.$disconnect();
  db = undefined;
});

async function open(seed = true): Promise<Silo> {
  db = await openLibrary({ seed });
  return db;
}

async function callNumberOf(silo: Silo, id: string): Promise<string> {
  return (await silo.memory.findUniqueOrThrow({ where: { id } })).callNumber;
}

describe("the starting set", () => {
  it("seeds five sections and their shelves, Returns included", async () => {
    const silo = await open(false);
    expect(await seedLibrary(silo)).toEqual({ seeded: true });

    const sections = await silo.section.findMany({
      orderBy: { order: "asc" },
      include: { shelves: { orderBy: { order: "asc" } } },
    });
    expect(sections.map((section) => section.code)).toEqual(["WRK", "LIF", "CRF", "REF", "DSK"]);
    expect(sections.map((section) => section.shelves.map((shelf) => shelf.code))).toEqual([
      ["NST", "FLW", "CLI"],
      ["GTH", "TRV", "HOM", "HLT"],
      ["HOW", "TLG", "WRT"],
      ["LNK", "ACC"],
      ["RET"],
    ]);
    expect(sections.flatMap((s) => s.shelves).every((shelf) => shelf.description.length > 0)).toBe(true);
    expect(STARTING_LIBRARY).toHaveLength(5);
    expect((await defaultShelf(silo)).name).toBe("Returns");
  });

  it("seeds only an empty silo, so a shelf merged away is not brought back", async () => {
    const silo = await open();
    await mergeShelves(silo, "WRK/CLI", "WRK/NST", USER);
    expect(await seedLibrary(silo)).toEqual({ seeded: false });
    await expect(resolveShelf(silo, "WRK/CLI")).rejects.toThrow(DomainError);
  });

  it("puts a memory with no shelf on Returns", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode({ shelf: undefined }), USER);
    expect(memory.callNumber).toBe("DSK/RET/2026-12-24/001");
  });
});

describe("sections and shelves", () => {
  it("creates, renames (name only, code never) and reorders", async () => {
    const silo = await open();
    const section = await createSection(silo, { code: "FAM", name: "Family" });
    expect(section.order).toBe(6);
    await expect(createSection(silo, { code: "FAM", name: "Again" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(createSection(silo, { code: "fam", name: "Lower" })).rejects.toMatchObject({
      code: "invalid_input",
    });

    const shelf = await createShelf(silo, {
      section: "FAM",
      code: "KID",
      name: "Kids",
      description: "School, clubs, milestones.",
    });
    expect(shelf.order).toBe(1);

    const renamed = await renameShelf(silo, "FAM/KID", { name: "Children", description: "School and clubs." });
    expect(renamed).toMatchObject({ code: "KID", name: "Children", description: "School and clubs." });
    const renamedSection = await renameSection(silo, "FAM", "Household");
    expect(renamedSection).toMatchObject({ code: "FAM", name: "Household" });

    const order = await reorderSections(silo, ["DSK", "FAM", "WRK", "LIF", "CRF", "REF"]);
    expect(order.map((s) => s.code)).toEqual(["DSK", "FAM", "WRK", "LIF", "CRF", "REF"]);
    await expect(reorderSections(silo, ["DSK", "WRK"])).rejects.toMatchObject({ code: "invalid_input" });

    const shelves = await reorderShelves(silo, "LIF", ["HLT", "HOM", "TRV", "GTH"]);
    expect(shelves.map((s) => s.code)).toEqual(["HLT", "HOM", "TRV", "GTH"]);
  });

  it("keeps call numbers when a shelf is renamed", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), USER);
    await renameShelf(silo, "LIF/GTH", { name: "Get-togethers" });
    await renameSection(silo, "LIF", "Home life");
    expect(await callNumberOf(silo, memory.id)).toBe(memory.callNumber);
  });
});

describe("no orphan on a shelf", () => {
  it("refuses to delete a shelf with entries", async () => {
    const silo = await open();
    await createMemory(silo, episode(), USER);
    await expect(deleteShelf(silo, "LIF/GTH")).rejects.toMatchObject({
      code: "refused",
      detail: { shelf: "LIF/GTH", entries: 1 },
    });
    expect(await silo.shelf.count({ where: { code: "GTH" } })).toBe(1);
  });

  it("deletes an empty shelf, and never Returns", async () => {
    const silo = await open();
    await deleteShelf(silo, "LIF/HOM");
    await expect(resolveShelf(silo, "LIF/HOM")).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteShelf(silo, RETURNS_PATH)).rejects.toMatchObject({ code: "refused" });
    await expect(mergeShelves(silo, RETURNS_PATH, "LIF/GTH", USER)).rejects.toMatchObject({
      code: "refused",
    });
    await expect(mergeSections(silo, "DSK", "LIF", USER)).rejects.toMatchObject({ code: "refused" });
  });

  it("refuses to delete the shelf a project points at", async () => {
    const silo = await open();
    const shelf = await resolveShelf(silo, "WRK/CLI");
    await silo.project.create({ data: { slug: "acme", name: "Acme", shelfId: shelf.id } });
    await expect(deleteShelf(silo, "WRK/CLI")).rejects.toMatchObject({ code: "refused" });
  });
});

describe("moving memories", () => {
  it("reshelves with a new number and keeps the old one as an alias", async () => {
    const silo = await open();
    const memory = await createMemory(silo, episode(), USER);
    const moved = await reshelveMemory(silo, memory.callNumber, { shelf: "LIF/TRV" }, USER);
    expect(moved).toEqual({
      memoryId: memory.id,
      from: "LIF/GTH/2026-12-24/001",
      to: "LIF/TRV/2026-12-24/001",
    });
    expect(await aliasesOf(silo, memory.id)).toEqual(["LIF/GTH/2026-12-24/001"]);

    const again = await reshelveMemory(silo, memory.id, { occurredOn: "2026-12-23" }, USER);
    expect(again.to).toBe("LIF/TRV/2026-12-23/001");
    // Both old numbers still resolve to it.
    for (const old of [moved.from, moved.to]) {
      const resolved = await resolveCallNumber(silo, old);
      expect(resolved).toMatchObject({ status: "alias", memoryId: memory.id, callNumber: again.to });
    }
    const ops = (await history(silo, memory.id)).map((v) => v.operation);
    expect(ops).toEqual(["create", "shelve", "shelve"]);
    await expect(reshelveMemory(silo, memory.id, { shelf: "LIF/TRV" }, USER)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("merges shelves: every entry reshelved, every old number resolves, the shelf is gone", async () => {
    const silo = await open();
    const target = await createMemory(silo, episode({ shelf: "WRK/NST" }), USER);
    const a = await createMemory(silo, episode({ shelf: "WRK/CLI" }), USER);
    const b = await createMemory(silo, episode({ shelf: "WRK/CLI" }), USER);
    const c = await createMemory(silo, episode({ shelf: "WRK/CLI", occurredOn: "2026-12-25" }), USER);
    const shelf = await resolveShelf(silo, "WRK/CLI");
    await silo.project.create({ data: { slug: "acme", name: "Acme", shelfId: shelf.id } });

    const result = await mergeShelves(silo, "WRK/CLI", "WRK/NST", USER);
    expect(result.reshelved).toBe(3);
    await expect(resolveShelf(silo, "WRK/CLI")).rejects.toMatchObject({ code: "not_found" });

    expect(await callNumberOf(silo, target.id)).toBe("WRK/NST/2026-12-24/001");
    expect(await callNumberOf(silo, a.id)).toBe("WRK/NST/2026-12-24/002");
    expect(await callNumberOf(silo, b.id)).toBe("WRK/NST/2026-12-24/003");
    expect(await callNumberOf(silo, c.id)).toBe("WRK/NST/2026-12-25/001");
    for (const memory of [a, b, c]) {
      expect(await resolveCallNumber(silo, memory.callNumber)).toMatchObject({
        status: "alias",
        memoryId: memory.id,
      });
    }
    const project = await silo.project.findUniqueOrThrow({ where: { slug: "acme" } });
    expect(project.shelfId).toBe((await resolveShelf(silo, "WRK/NST")).id);
  });

  it("merges sections: a new shelf moves across keeping its sequences, a clashing one merges", async () => {
    const silo = await open();
    await createSection(silo, { code: "FAM", name: "Family" });
    await createShelf(silo, { section: "FAM", code: "GTH", name: "Family gatherings", description: "Family only." });
    await createShelf(silo, { section: "FAM", code: "KID", name: "Kids", description: "School and clubs." });

    const life = await createMemory(silo, episode({ shelf: "LIF/GTH" }), USER);
    const gathering = await createMemory(silo, episode({ shelf: "FAM/GTH" }), USER);
    const kid1 = await createMemory(silo, episode({ shelf: "FAM/KID" }), USER);
    const kid2 = await createMemory(silo, episode({ shelf: "FAM/KID" }), USER);

    const result = await mergeSections(silo, "FAM", "LIF", USER);
    expect(result).toEqual({ moved: 2, reshelved: 3 });
    expect(await silo.section.findUnique({ where: { code: "FAM" } })).toBeNull();

    expect(await callNumberOf(silo, life.id)).toBe("LIF/GTH/2026-12-24/001");
    expect(await callNumberOf(silo, gathering.id)).toBe("LIF/GTH/2026-12-24/002");
    expect(await callNumberOf(silo, kid1.id)).toBe("LIF/KID/2026-12-24/001");
    expect(await callNumberOf(silo, kid2.id)).toBe("LIF/KID/2026-12-24/002");
    for (const memory of [gathering, kid1, kid2]) {
      expect(await resolveCallNumber(silo, memory.callNumber)).toMatchObject({
        status: "alias",
        memoryId: memory.id,
      });
    }
  });

  it("swaps sequence numbers within a day and aliases each number that moved", async () => {
    const silo = await open();
    const first = await createMemory(silo, episode({ title: "Arrivals" }), USER);
    const second = await createMemory(silo, episode({ title: "Dinner" }), USER);
    const third = await createMemory(silo, episode({ title: "Presents" }), USER);

    const moves = await swapSeq(silo, first.id, third.callNumber, USER);
    expect(moves.map((m) => [m.from, m.to]).sort()).toEqual([
      ["LIF/GTH/2026-12-24/001", "LIF/GTH/2026-12-24/003"],
      ["LIF/GTH/2026-12-24/003", "LIF/GTH/2026-12-24/001"],
    ]);
    expect(await callNumberOf(silo, first.id)).toBe("LIF/GTH/2026-12-24/003");
    expect(await callNumberOf(silo, second.id)).toBe("LIF/GTH/2026-12-24/002");
    expect(await callNumberOf(silo, third.id)).toBe("LIF/GTH/2026-12-24/001");
    expect(await aliasesOf(silo, first.id)).toEqual(["LIF/GTH/2026-12-24/001"]);
    expect(await aliasesOf(silo, third.id)).toEqual(["LIF/GTH/2026-12-24/003"]);
    // A number that is both live and an alias resolves to its live holder.
    expect(await resolveCallNumber(silo, "LIF/GTH/2026-12-24/001")).toMatchObject({
      status: "current",
      memoryId: third.id,
    });
  });

  it("reorders a whole day and refuses an order that is not every entry once", async () => {
    const silo = await open();
    const a = await createMemory(silo, episode({ title: "A" }), USER);
    const b = await createMemory(silo, episode({ title: "B" }), USER);
    const c = await createMemory(silo, episode({ title: "C" }), USER);
    await reorderDay(silo, { shelf: "LIF/GTH", occurredOn: "2026-12-24", order: [c.id, a.id, b.id] }, USER);
    const titles = (
      await silo.memory.findMany({ where: { shelf: { code: "GTH" } }, orderBy: { callNumber: "asc" } })
    ).map((m) => m.title);
    expect(titles).toEqual(["C", "A", "B"]);
    await expect(
      reorderDay(silo, { shelf: "LIF/GTH", occurredOn: "2026-12-24", order: [a.id, b.id] }, USER),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
