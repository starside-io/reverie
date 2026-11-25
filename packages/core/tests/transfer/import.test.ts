import { afterEach, describe, expect, it } from "vitest";

import { createMemory } from "../../src/domain/memories.js";
import { buildExportSnapshot } from "../../src/domain/transfer/export.js";
import { importSnapshot, planImport, planReplace } from "../../src/domain/transfer/import.js";
import type { ExportSnapshot } from "../../src/domain/transfer/snapshot.js";
import { history } from "../../src/domain/versions.js";
import type { Silo } from "../../src/storage/client.js";
import { episode, openLibrary, USER } from "../domain/library.js";
import { comparable, emptySilo, richLibrary } from "./fixture.js";

const open: Silo[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) await db.$disconnect();
});

async function track<T extends Silo>(db: T): Promise<T> {
  open.push(db);
  return db;
}

function copy(snapshot: ExportSnapshot): ExportSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ExportSnapshot;
}

describe("planReplace", () => {
  it("names the row counts a replace will destroy, before it runs, and writes nothing", async () => {
    const library = await richLibrary();
    await track(library.db);
    const plan = await planReplace(library.db);
    expect(plan.destroys).toEqual({
      sections: 5,
      shelves: 14,
      projects: 1,
      tags: 5,
      sources: 6,
      memories: 4,
      memoryTags: 5,
      refs: 3,
      citations: 6,
      versions: 14,
      aliases: 2,
      links: 1,
      embeddings: 1,
    });
    expect(plan.kept).toEqual({ sessionNotes: 1, recallLogs: 1 });
    expect(await planReplace(library.db)).toEqual(plan);

    const file = await buildExportSnapshot(await track(await openLibrary()));
    const result = await importSnapshot(library.db, file, "replace");
    expect(result.destroyed).toEqual(plan);
    expect(await library.db.memory.count()).toBe(0);
    expect(await library.db.shelf.count()).toBe(14 - 1);
  });
});

describe("planImport", () => {
  it("previews a replace: what it adds, changes and removes, and what it destroys", async () => {
    const library = await richLibrary();
    await track(library.db);
    const file = copy(await buildExportSnapshot(library.db));
    const christmas = file.memories.find((m) => m.id === library.christmas)!;
    christmas.title = "Christmas at home, again";
    file.memories = file.memories.filter((m) => m.id !== library.retired);
    file.versions = file.versions.filter((v) => v.memoryId !== library.retired);

    const plan = await planImport(library.db, file, "replace");
    const memories = plan.collections.find((c) => c.collection === "memories")!;
    expect(memories).toMatchObject({ add: 0, change: 1, remove: 1 });
    expect(memories.keys.change).toEqual([library.christmas]);
    expect(memories.keys.remove).toEqual([library.retired]);
    expect(plan.collections.find((c) => c.collection === "versions")).toMatchObject({ remove: 2 });
    expect(plan.destroys?.destroys.memories).toBe(4);
    expect(plan.forgottenInFile).toEqual([]);
    expect(await library.db.memory.count()).toBe(4);
  });

  it("previews a merge: it adds and changes, never removes, and names forgotten memories it will leave out", async () => {
    const library = await richLibrary();
    await track(library.db);
    const backup = copy(await buildExportSnapshot(library.db));

    const target = await track(await openLibrary());
    const local = await createMemory(target, episode({ title: "Only here", body: "Sam Rivera visited." }), USER);
    const plan = await planImport(target, backup, "merge");
    const memories = plan.collections.find((c) => c.collection === "memories")!;
    expect(memories).toMatchObject({ add: 4, change: 0, remove: 0 });
    expect(plan.collections.find((c) => c.collection === "shelves")).toMatchObject({ add: 1, remove: 0 });
    expect(plan.destroys).toBeNull();
    expect(memories.keys.add).not.toContain(local.id);

    const withForgotten = copy(backup);
    const ghost = { ...withForgotten.memories[0]!, id: library.forgotten, callNumber: library.forgottenNumber };
    ghost.shelfId = withForgotten.shelves.find((s) => s.code === "HLT")!.id;
    ghost.occurredOn = "2026-10-10";
    ghost.refs = [];
    withForgotten.memories.push(ghost);
    const forgottenPlan = await planImport(library.db, withForgotten, "merge");
    expect(forgottenPlan.forgottenInFile).toEqual([library.forgottenNumber]);
    expect(forgottenPlan.collections.find((c) => c.collection === "memories")).toMatchObject({ add: 0 });
  });
});

describe("importSnapshot, merge", () => {
  it("keeps what is there, lets the file win row by row, and matches the library by code and slug", async () => {
    const source = await richLibrary();
    await track(source.db);
    const file = await buildExportSnapshot(source.db);

    // Seeded separately, so every section, shelf and Returns has another id here.
    const target = await track(await openLibrary());
    const local = await createMemory(target, episode({ title: "Only here", body: "Sam Rivera visited." }), USER);
    const result = await importSnapshot(target, file, "merge");
    expect(result.counts.memories).toBe(4);
    expect(result.needsEmbedding.sort()).toEqual(file.memories.map((m) => m.id).sort());

    expect(await target.section.count()).toBe(5);
    expect(await target.shelf.count()).toBe(14);
    expect(await target.memory.findUnique({ where: { id: local.id } })).not.toBeNull();
    const christmas = await target.memory.findUniqueOrThrow({
      where: { id: source.christmas },
      include: { shelf: { include: { section: true } } },
    });
    expect(`${christmas.shelf.section.code}/${christmas.shelf.code}`).toBe("LIF/GTH");
    expect(christmas.callNumber).toBe("LIF/GTH/2026-12-25/001");
    // The local memory took LIF/GTH/2026-12-24/001 before the file's alias for
    // that number arrived; the number is live here, so it resolves to its holder.
    expect(local.callNumber).toBe("LIF/GTH/2026-12-24/001");
  });

  it("writes a version when it changes a memory's content and the file records none for it", async () => {
    const library = await richLibrary();
    await track(library.db);
    const file = copy(await buildExportSnapshot(library.db));
    file.memories.find((m) => m.id === library.editorNow)!.body = "Write commit subjects in the imperative. Always.";

    const result = await importSnapshot(library.db, file, "merge", { actor: "import", at: new Date("2027-02-01T00:00:00Z") });
    expect(result.counts.versionsAppended).toBe(1);
    expect(result.needsEmbedding).toEqual([library.editorNow]);
    const versions = await history(library.db, library.editorNow);
    expect(versions.at(-1)).toMatchObject({ operation: "update", actor: "import" });
    expect(versions.at(-1)?.content?.body).toBe("Write commit subjects in the imperative. Always.");
    // The previous content is still readable: supersede, never overwrite.
    expect(versions.some((v) => v.content?.body === "Write commit subjects in the imperative, under seventy two characters.")).toBe(true);
  });

  it("carries a redaction across and never restores redacted content", async () => {
    const library = await richLibrary();
    await track(library.db);
    const file = copy(await buildExportSnapshot(library.db));
    const target = await track(await emptySilo());
    await importSnapshot(target, file, "replace");

    const create = file.versions.find((v) => v.memoryId === library.christmas && v.operation === "create")!;
    const redactedFile = copy(file);
    const row = redactedFile.versions.find((v) => v.id === create.id)!;
    row.body = null;
    row.contentSha256 = null;
    await importSnapshot(target, redactedFile, "merge");
    expect((await target.memoryVersion.findUniqueOrThrow({ where: { id: create.id } })).body).toBeNull();

    await importSnapshot(target, file, "merge");
    expect((await target.memoryVersion.findUniqueOrThrow({ where: { id: create.id } })).body).toBeNull();
  });

  it("refuses a call number another memory holds here, and writes nothing", async () => {
    const library = await richLibrary();
    await track(library.db);
    const file = copy(await buildExportSnapshot(library.db));
    const target = await track(await openLibrary());
    await createMemory(target, episode({ occurredOn: "2026-12-25", title: "Here first", body: "John Doe came by." }), USER);
    const before = comparable(await buildExportSnapshot(target));

    await expect(importSnapshot(target, file, "merge")).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("LIF/GTH/2026-12-25/001"),
    });
    expect(comparable(await buildExportSnapshot(target))).toEqual(before);
  });
});

describe("importSnapshot, refusals", () => {
  it("refuses a replace with a file that has no Returns shelf", async () => {
    const library = await richLibrary();
    await track(library.db);
    const file = copy(await buildExportSnapshot(library.db));
    const desk = file.sections.find((s) => s.code === "DSK")!;
    file.shelves = file.shelves.filter((s) => s.sectionId !== desk.id);
    file.sections = file.sections.filter((s) => s.id !== desk.id);
    await expect(importSnapshot(library.db, file, "replace")).rejects.toMatchObject({ code: "refused" });
    expect(await library.db.memory.count()).toBe(4);
  });

  it("refuses a file that does not hold together", async () => {
    const library = await richLibrary();
    await track(library.db);
    const file = await buildExportSnapshot(library.db);
    const target = await track(await emptySilo());

    const badNumber = copy(file);
    badNumber.memories[0]!.callNumber = "LIF/GTH/2026-12-31/001";
    await expect(importSnapshot(target, badNumber, "replace")).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("does not match its shelf"),
    });

    const noSource = copy(file);
    noSource.memories[0]!.sources = [];
    await expect(importSnapshot(target, noSource, "replace")).rejects.toMatchObject({ code: "invalid_input" });

    const danglingCitation = copy(file);
    danglingCitation.sources = [];
    await expect(importSnapshot(target, danglingCitation, "replace")).rejects.toMatchObject({ code: "invalid_input" });

    const longQuote = copy(file);
    longQuote.memories[0]!.sources[0]!.quote = "q".repeat(501);
    await expect(importSnapshot(target, longQuote, "replace")).rejects.toMatchObject({ code: "invalid_input" });

    await expect(importSnapshot(target, { ...copy(file), version: 2 }, "replace")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(importSnapshot(target, file, "overwrite" as never)).rejects.toMatchObject({ code: "invalid_input" });
    expect(await target.memory.count()).toBe(0);
  });
});
