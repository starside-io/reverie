import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GetResult } from "../../../src/tools/read/get.js";
import type { SetShelvesResult } from "../../../src/tools/write/set-shelves.js";
import { testHost, type TestHost } from "../../test-host.js";
import { christmas, NOW, remember, versions } from "./helpers.js";

describe("memory.set_shelves", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  const set = (input: Record<string, unknown>) => host.invoke<SetShelvesResult>("memory.set_shelves", input);

  it("creates, renames and reorders sections; renaming keeps the code", async () => {
    const created = await set({ action: "create_section", code: "HOB", name: "Hobbies" });
    expect(created.section).toMatchObject({ code: "HOB", name: "Hobbies", order: 6 });
    const renamed = await set({ action: "rename_section", code: "HOB", name: "Pastimes" });
    expect(renamed.section).toMatchObject({ code: "HOB", name: "Pastimes" });

    const reordered = await set({ action: "reorder_sections", codes: ["HOB", "WRK", "LIF", "CRF", "REF", "DSK"] });
    expect(reordered.sections.map((section) => section.code)).toEqual(["HOB", "WRK", "LIF", "CRF", "REF", "DSK"]);
    await expect(set({ action: "reorder_sections", codes: ["HOB", "WRK"] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(set({ action: "create_section", code: "HOB", name: "Again" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("creates, renames and reorders shelves", async () => {
    const created = await set({
      action: "create_shelf",
      section: "LIF",
      code: "GRD",
      name: "Garden",
      description: "The garden: what was planted where, and what grew.",
    });
    expect(created.shelf).toMatchObject({ path: "LIF/GRD", name: "Garden", order: 5 });

    const renamed = await set({ action: "rename_shelf", shelf: "LIF/GRD", name: "Allotment" });
    expect(renamed.shelf).toMatchObject({ path: "LIF/GRD", name: "Allotment", description: created.shelf?.description });

    const reordered = await set({ action: "reorder_shelves", section: "LIF", codes: ["GRD", "GTH", "TRV", "HOM", "HLT"] });
    expect(reordered.shelves.map((shelf) => shelf.path)).toEqual(["LIF/GRD", "LIF/GTH", "LIF/TRV", "LIF/HOM", "LIF/HLT"]);
  });

  it("merges shelves: every entry reshelved, every old number aliased and resolving, one shelved event each", async () => {
    const a = await christmas(host);
    const b = await remember(host, { shelf: "LIF/GTH", occurredOn: "2026-11-02", body: "Housewarming at John Doe's." });
    const onTarget = await remember(host, { shelf: "LIF/HOM", occurredOn: "2026-12-24", body: "Fixed the oven door." });
    await host.db.project.create({ data: { slug: "parties", name: "Parties", shelf: { connect: { id: (await host.db.shelf.findFirstOrThrow({ where: { code: "GTH" } })).id } } } });
    host.events.length = 0;

    const result = await set({ action: "merge_shelves", from: "LIF/GTH", into: "LIF/HOM" });
    expect(result.deleted).toBe("LIF/GTH");
    expect(result.renumbered).toEqual([
      { memoryId: b.memory.id, from: b.memory.call, to: "LIF/HOM/2026-11-02/001" },
      { memoryId: a.memory.id, from: a.memory.call, to: "LIF/HOM/2026-12-24/002" },
    ]);
    expect(host.events.map((event) => event.name)).toEqual(["memory.memory.shelved", "memory.memory.shelved"]);
    expect(host.events[0]?.payload).toMatchObject({ memoryId: b.memory.id, via: "merge" });

    for (const old of [a, b]) {
      const got = await host.invoke<GetResult>("memory.get", { call: old.memory.call });
      expect(got.moved).toBe(true);
      expect(got.memory.id).toBe(old.memory.id);
      expect(got.memory.shelf).toBe("LIF/HOM");
    }
    expect((await host.invoke<GetResult>("memory.get", { call: onTarget.memory.call })).moved).toBe(false);
    expect(await host.db.shelf.findFirst({ where: { code: "GTH" } })).toBeNull();
    const home = await host.db.shelf.findFirstOrThrow({ where: { code: "HOM" } });
    expect((await host.db.project.findUniqueOrThrow({ where: { slug: "parties" } })).shelfId).toBe(home.id);
    expect((await versions(host, a.memory.id)).map((row) => row.operation)).toEqual(["create", "shelve"]);
  });

  it("merges sections, aliasing every number that changed", async () => {
    await set({ action: "create_section", code: "HOB", name: "Hobbies" });
    await set({ action: "create_shelf", section: "HOB", code: "GRD", name: "Garden", description: "The garden." });
    const kept = await remember(host, { shelf: "HOB/GRD", occurredOn: "2026-05-01", body: "Planted tomatoes by the fence." });

    const result = await set({ action: "merge_sections", from: "HOB", into: "LIF" });
    expect(result.renumbered).toEqual([{ memoryId: kept.memory.id, from: "HOB/GRD/2026-05-01/001", to: "LIF/GRD/2026-05-01/001" }]);
    const got = await host.invoke<GetResult>("memory.get", { call: "HOB/GRD/2026-05-01/001" });
    expect(got.memory.call).toBe("LIF/GRD/2026-05-01/001");
    expect(await host.db.section.findUnique({ where: { code: "HOB" } })).toBeNull();
    await expect(set({ action: "merge_sections", from: "DSK", into: "LIF" })).rejects.toMatchObject({ code: "refused" });
  });

  it("deletes an empty shelf and refuses one with entries: no orphan on a shelf", async () => {
    await set({ action: "create_shelf", section: "LIF", code: "GRD", name: "Garden", description: "The garden." });
    const entry = await remember(host, { shelf: "LIF/GRD", body: "Planted tomatoes by the fence." });

    await expect(set({ action: "delete_shelf", shelf: "LIF/GRD" })).rejects.toMatchObject({
      code: "refused",
      detail: { shelf: "LIF/GRD", entries: 1 },
    });
    expect(await host.db.memory.count({ where: { id: entry.memory.id } })).toBe(1);

    await host.invoke("memory.shelve", { action: "move", call: entry.memory.call, shelf: "LIF/HOM" });
    const deleted = await set({ action: "delete_shelf", shelf: "LIF/GRD" });
    expect(deleted.deleted).toBe("LIF/GRD");
    expect(await host.db.shelf.findFirst({ where: { code: "GRD" } })).toBeNull();
    const shelfIds = new Set((await host.db.shelf.findMany({ select: { id: true } })).map((shelf) => shelf.id));
    const homes = await host.db.memory.findMany({ select: { shelfId: true } });
    expect(homes.every((row) => shelfIds.has(row.shelfId))).toBe(true);
  });

  it("never merges away or deletes Returns", async () => {
    await expect(set({ action: "delete_shelf", shelf: "DSK/RET" })).rejects.toMatchObject({ code: "refused" });
    await expect(set({ action: "merge_shelves", from: "DSK/RET", into: "LIF/HOM" })).rejects.toMatchObject({ code: "refused" });
  });

  it("refuses while incognito is on", async () => {
    host.setIncognito(true);
    await expect(set({ action: "create_section", code: "HOB", name: "Hobbies" })).rejects.toMatchObject({ code: "refused" });
    expect(await host.db.section.findUnique({ where: { code: "HOB" } })).toBeNull();
  });
});
