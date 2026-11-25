import { afterEach, describe, expect, it } from "vitest";

import { forgetMemory } from "../../src/domain/versions.js";
import { diffSnapshots, formatDiff } from "../../src/domain/transfer/diff.js";
import { buildExportSnapshot } from "../../src/domain/transfer/export.js";
import { importSnapshot } from "../../src/domain/transfer/import.js";
import { SNAPSHOT_VERSION, summariseSnapshot, type ExportSnapshot } from "../../src/domain/transfer/snapshot.js";
import type { Silo } from "../../src/storage/client.js";
import { searchMemoryFts } from "../../src/storage/search.js";
import { comparable, emptySilo, richLibrary } from "./fixture.js";

/**
 * The snapshot round trip gate (section 16, carried over from Fellowship):
 * export, import into an empty silo, export again, and the two files are
 * equal. Call numbers, aliases and version history survive verbatim, and
 * search finds what came in.
 */

const open: Silo[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) await db.$disconnect();
});

async function track<T extends Silo>(db: T): Promise<T> {
  open.push(db);
  return db;
}

async function ftsIds(db: Silo, word: string): Promise<string[]> {
  const hits = await searchMemoryFts(db, `"${word}"`, { states: ["active", "superseded", "retired"], limit: 50 });
  return hits.map((hit) => hit.id).sort();
}

async function ftsIntegrity(db: Silo): Promise<void> {
  await db.$executeRawUnsafe(`INSERT INTO "memory_fts"("memory_fts") VALUES ('integrity-check')`);
}

describe("the snapshot round trip", () => {
  it("loses nothing: export, import into an empty silo, export again, equal", async () => {
    const library = await richLibrary();
    await track(library.db);
    const first = await buildExportSnapshot(library.db);

    const target = await track(await emptySilo());
    const result = await importSnapshot(target, first, "replace");
    expect(result.counts).toMatchObject({
      memories: first.memories.length,
      versions: first.versions.length,
      aliases: first.aliases.length,
      links: first.links.length,
      sources: first.sources.length,
    });
    const second = await buildExportSnapshot(target);

    const diff = diffSnapshots(first, second);
    expect(diff.identical, formatDiff(diff)).toBe(true);
    expect(comparable(second)).toEqual(comparable(first));
  });

  it("loses nothing through a merge into an empty silo either", async () => {
    const library = await richLibrary();
    await track(library.db);
    const first = await buildExportSnapshot(library.db);
    const target = await track(await emptySilo());
    const result = await importSnapshot(target, first, "merge");
    expect(result.counts.versionsAppended).toBe(0);
    expect(comparable(await buildExportSnapshot(target))).toEqual(comparable(first));
  });

  it("is stable: merging a silo's own export back changes nothing", async () => {
    const library = await richLibrary();
    await track(library.db);
    const once = await buildExportSnapshot(library.db);
    const result = await importSnapshot(library.db, once, "merge");
    expect(result.counts.versionsAppended).toBe(0);
    expect(result.counts.forgottenSkipped).toBe(0);
    expect(comparable(await buildExportSnapshot(library.db))).toEqual(comparable(once));
  });

  it("survives JSON: the file is plain text and reads back the same", async () => {
    const library = await richLibrary();
    await track(library.db);
    const first = await buildExportSnapshot(library.db);
    const text = JSON.stringify(first);
    const target = await track(await emptySilo());
    await importSnapshot(target, JSON.parse(text), "replace");
    expect(JSON.stringify(comparable(await buildExportSnapshot(target)))).toBe(JSON.stringify(comparable(first)));
  });

  it("keeps call numbers, aliases and history verbatim", async () => {
    const library = await richLibrary();
    await track(library.db);
    const first = await buildExportSnapshot(library.db);
    const target = await track(await emptySilo());
    await importSnapshot(target, first, "replace");

    const christmas = await target.memory.findUniqueOrThrow({ where: { id: library.christmas } });
    expect(christmas.callNumber).toBe("LIF/GTH/2026-12-25/001");
    const alias = await target.callNumberAlias.findUniqueOrThrow({ where: { oldCallNumber: "LIF/GTH/2026-12-24/001" } });
    expect(alias.memoryId).toBe(library.christmas);
    const retiredNumber = await target.callNumberAlias.findUniqueOrThrow({ where: { oldCallNumber: library.forgottenNumber } });
    expect(retiredNumber.memoryId).toBeNull();

    const before = await library.db.memoryVersion.findMany({ orderBy: [{ memoryId: "asc" }, { at: "asc" }] });
    const after = await target.memoryVersion.findMany({ orderBy: [{ memoryId: "asc" }, { at: "asc" }] });
    expect(after).toEqual(before);
    expect(after.some((v) => v.operation === "refine")).toBe(true);
    expect(after.some((v) => v.operation === "redact")).toBe(true);
  });

  it("leaves memory_fts correct: search finds every imported memory, tags included", async () => {
    const library = await richLibrary();
    await track(library.db);
    const first = await buildExportSnapshot(library.db);
    const target = await track(await emptySilo());
    await importSnapshot(target, first, "replace");

    await ftsIntegrity(target);
    expect(await ftsIds(target, "cafe")).toEqual([library.christmas]);
    expect(await ftsIds(target, "household")).toEqual([library.christmas]);
    expect(await ftsIds(target, "git")).toEqual([library.editorNow]);
    expect(await ftsIds(target, "imperative")).toEqual([library.editor, library.editorNow].sort());
    expect(await ftsIds(target, "dashboard")).toEqual([library.retired]);
    expect(await ftsIds(target, "molar")).toEqual([]);

    // And again after replacing over a silo that already held all of it.
    await importSnapshot(target, first, "replace");
    await ftsIntegrity(target);
    expect(await ftsIds(target, "cafe")).toEqual([library.christmas]);
  });
});

describe("what a snapshot holds and leaves out", () => {
  it("carries a format version and every collection", async () => {
    const library = await richLibrary();
    await track(library.db);
    const snapshot = await buildExportSnapshot(library.db, { now: new Date("2027-01-05T00:00:00Z") });
    expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    expect(snapshot.exportedAt).toBe("2027-01-05T00:00:00.000Z");
    expect(Object.keys(snapshot).sort()).toEqual(
      ["aliases", "exportedAt", "links", "memories", "projects", "sections", "shelves", "sources", "tags", "version", "versions"],
    );
    expect(summariseSnapshot(snapshot)).toMatchObject({
      version: 1,
      memories: snapshot.memories.length,
      versions: snapshot.versions.length,
    });
    expect(summariseSnapshot({ version: 9 })).toBeNull();
  });

  it("omits embeddings, session notes and recall logs, and an import leaves the last two alone", async () => {
    const library = await richLibrary();
    await track(library.db);
    const snapshot = await buildExportSnapshot(library.db);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("test-embed");
    expect(text).not.toContain("scratch about Sam Rivera");

    const result = await importSnapshot(library.db, snapshot, "replace");
    expect(result.destroyed?.destroys.embeddings).toBe(1);
    expect(result.destroyed?.kept).toEqual({ sessionNotes: 1, recallLogs: 1 });
    expect(await library.db.embedding.count()).toBe(0);
    expect(await library.db.sessionNote.count()).toBe(1);
    expect(await library.db.recallLog.count()).toBe(1);
    expect(result.needsEmbedding.sort()).toEqual(snapshot.memories.map((m) => m.id).sort());
  });

  it("forget is real: no forgotten memory, text or source in the export, only its retired number and redacted versions", async () => {
    const library = await richLibrary();
    await track(library.db);
    const snapshot = await buildExportSnapshot(library.db);
    const text = JSON.stringify(snapshot);
    expect(snapshot.memories.some((m) => m.id === library.forgotten)).toBe(false);
    expect(text).not.toContain("molar");
    expect(text).not.toContain("Dentist");
    expect(snapshot.links.some((l) => l.toId === library.forgotten)).toBe(false);
    expect(snapshot.aliases).toContainEqual(expect.objectContaining({ oldCallNumber: library.forgottenNumber, memoryId: null }));
    const versions = snapshot.versions.filter((v) => v.memoryId === library.forgotten);
    expect(versions.map((v) => v.operation)).toEqual(["create", "forget"]);
    expect(versions.every((v) => v.body === null && v.contentSha256 === null)).toBe(true);
  });

  it("a merge of an older backup never brings a forgotten memory back", async () => {
    const library = await richLibrary();
    await track(library.db);
    const christmas = await library.db.memory.findUniqueOrThrow({ where: { id: library.christmas } });
    const backup = await buildExportSnapshot(library.db);
    await forgetMemory(library.db, christmas, { actor: "user" });

    const result = await importSnapshot(library.db, backup, "merge");
    expect(result.counts.forgottenSkipped).toBe(1);
    expect(await library.db.memory.findUnique({ where: { id: library.christmas } })).toBeNull();
    expect(await ftsIds(library.db, "cafe")).toEqual([]);
    const versions = await library.db.memoryVersion.findMany({ where: { memoryId: library.christmas } });
    expect(versions.every((v) => v.body === null)).toBe(true);
    for (const number of ["LIF/GTH/2026-12-24/001", "LIF/GTH/2026-12-25/001"]) {
      expect((await library.db.callNumberAlias.findUniqueOrThrow({ where: { oldCallNumber: number } })).memoryId).toBeNull();
    }
    const text = JSON.stringify(await buildExportSnapshot(library.db));
    expect(text).not.toContain("Café");
    expect(text).not.toContain("Photo album");
  });
});

describe("paths stay home", () => {
  const PATH_SHAPED = /^(\/|~\/|[A-Za-z]:[\\/]|\\\\)/;

  function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const entry of value) strings(entry, out);
    else if (value !== null && typeof value === "object") for (const entry of Object.values(value)) strings(entry, out);
    return out;
  }

  it("no project field is a folder path, and the project shape has no field for one", async () => {
    const library = await richLibrary();
    await track(library.db);
    const snapshot = await buildExportSnapshot(library.db);
    expect(snapshot.projects).toHaveLength(1);
    for (const project of snapshot.projects) {
      expect(Object.keys(project).sort()).toEqual(
        ["archived", "createdAt", "description", "id", "name", "repoUrl", "shelfId", "slug", "tagId", "updatedAt"],
      );
      for (const value of Object.values(project)) {
        if (typeof value === "string") expect(value).not.toMatch(PATH_SHAPED);
      }
      expect(project.repoUrl).toBe("github.com/jane-doe/reverie");
    }
    expect(strings(snapshot).filter((text) => PATH_SHAPED.test(text))).toEqual([]);
  });

  it("drops a folder path a hand edited file carries, so it is never written", async () => {
    const library = await richLibrary();
    await track(library.db);
    const snapshot = await buildExportSnapshot(library.db);
    const edited: ExportSnapshot = JSON.parse(JSON.stringify(snapshot));
    (edited.projects[0] as Record<string, unknown>)["localPaths"] = ["/Users/jane/code/reverie"];
    (edited.projects[0] as Record<string, unknown>)["path"] = "/Users/jane/code/reverie";

    const target = await track(await emptySilo());
    await importSnapshot(target, edited, "replace");
    const text = JSON.stringify(await buildExportSnapshot(target));
    expect(text).not.toContain("/Users/jane");
    expect(comparable(await buildExportSnapshot(target))).toEqual(comparable(snapshot));
  });
});
