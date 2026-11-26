import { afterEach, describe, expect, it } from "vitest";

import { diffSnapshots, formatDiff } from "../../src/domain/transfer/diff.js";
import { buildExportSnapshot } from "../../src/domain/transfer/export.js";
import {
  assembleSnapshot,
  buildMirror,
  fileSlug,
  folderName,
  memoryFileName,
  MIRROR_MANIFEST_PATH,
  readMirror,
  stableId,
  type MirrorDocument,
  type MirrorReadFile,
} from "../../src/domain/transfer/mirror.js";
import { snapshotSchema, type ExportSnapshot } from "../../src/domain/transfer/snapshot.js";
import type { Silo } from "../../src/storage/client.js";
import { richLibrary } from "./fixture.js";

/**
 * The mirror as documents, with no disk: core's half of the markdown mirror
 * (docs/SPEC.md section 19). The adapter's half, bytes on disk, has its own
 * tests; the whole trip through a folder is in the mini-host's.
 */

const open: Silo[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) await db.$disconnect();
});

/** What the adapter hands back for documents it wrote and nobody touched, through JSON as front matter goes. */
function asRead(documents: readonly MirrorDocument[]): MirrorReadFile[] {
  return documents.map((document) => ({
    path: document.path,
    format: document.format,
    data: JSON.parse(JSON.stringify(document.data)) as Record<string, unknown>,
    body: document.format === "markdown" ? document.body : "",
    owned: true,
    unchanged: true,
    sha256: null,
    modifiedAt: null,
    error: null,
  }));
}

function liveHistory(snapshot: ExportSnapshot): ExportSnapshot {
  const live = new Set(snapshot.memories.map((memory) => memory.id));
  return { ...snapshot, versions: snapshot.versions.filter((version) => live.has(version.memoryId)) };
}

describe("the mirror as documents", () => {
  it("rebuilds the snapshot it was built from, bar the forgotten memory's redacted history", async () => {
    const library = await richLibrary();
    open.push(library.db);
    const snapshot = await buildExportSnapshot(library.db);
    const documents = buildMirror(snapshot);
    expect(documents).toHaveLength(snapshot.memories.length + 1);

    const read = readMirror(asRead(documents));
    expect(read.problems).toEqual([]);
    const { snapshot: back } = assembleSnapshot(read);
    expect(snapshotSchema.safeParse(back).success).toBe(true);
    const diff = diffSnapshots(liveHistory(snapshot), back, { maxRowsReported: Number.POSITIVE_INFINITY });
    expect(diff.identical, formatDiff(diff)).toBe(true);
    expect(back.aliases).toContainEqual(expect.objectContaining({ oldCallNumber: library.forgottenNumber, memoryId: null }));
  });

  it("is deterministic and holds nothing of a forgotten memory but its retired number", async () => {
    const library = await richLibrary();
    open.push(library.db);
    const snapshot = await buildExportSnapshot(library.db);
    expect(JSON.stringify(buildMirror(snapshot))).toBe(JSON.stringify(buildMirror(await buildExportSnapshot(library.db))));
    const text = JSON.stringify(buildMirror(snapshot));
    expect(text).not.toContain(library.forgotten);
    expect(text).not.toMatch(/molar/);
    expect(text).toContain(library.forgottenNumber);
  });

  it("names files by the rest of the call number and a slug, folders by name", () => {
    expect(memoryFileName("LIF/GTH/2026-12-24/001", "Christmas at home!")).toBe("2026-12-24-001 christmas-at-home.md");
    expect(memoryFileName("LIF/GTH/2026-12-24/002", "Café à Port Aster")).toBe("2026-12-24-002 cafe-a-port-aster.md");
    expect(fileSlug("!!!")).toBe("memory");
    expect(folderName("../../Escape", "LIF")).toBe("-..-Escape");
    expect(folderName("..", "GTH")).toBe("GTH");
    expect(folderName(".hidden", "HID")).toBe("hidden");
    expect(folderName("a:b*c?", "ABC")).toBe("a-b-c-");
  });

  it("reads an edited file as the memory it now says, and reports a broken one on its own", async () => {
    const library = await richLibrary();
    open.push(library.db);
    const documents = buildMirror(await buildExportSnapshot(library.db));
    const files = asRead(documents);
    const christmas = files.find((file) => file.data?.["id"] === library.christmas) as MirrorReadFile;
    christmas.body = "Edited in the folder.";
    (christmas.data as Record<string, unknown>)["tags"] = ["christmas", "New-Tag"];
    const retired = files.find((file) => file.data?.["id"] === library.retired) as MirrorReadFile;
    (retired.data as Record<string, unknown>)["call"] = "ZZZ/ZZZ/2026-01-01/001";
    files.push({ ...christmas, path: "Copy.md", owned: false, unchanged: false });

    const read = readMirror(files);
    expect(read.problems.map((problem) => problem.path).sort()).toEqual(["Copy.md", retired.path].sort());
    const record = read.records.find((entry) => entry.memory.id === library.christmas);
    expect(record?.memory.body).toBe("Edited in the folder.");
    const added = read.tags.find((tag) => tag.slug === "new-tag");
    expect(added?.id).toBe(stableId("tag:new-tag"));
    expect(record?.memory.tagIds).toContain(added?.id);
  });

  it("takes a file with no id as a note written by hand, on the shelf its folder stands for", async () => {
    const library = await richLibrary();
    open.push(library.db);
    const files = asRead(buildMirror(await buildExportSnapshot(library.db)));
    const note = (path: string): MirrorReadFile => ({ ...files[0]!, path, format: "markdown", data: null, body: "A note.", owned: false, unchanged: false });
    const read = readMirror([...files, note("Life/Gatherings/note.md"), note("LIF/TRV/note.md"), note("loose.md"), note("Nowhere/Else/note.md")]);
    expect(read.fresh.map((entry) => [entry.path, entry.folderShelf])).toEqual([
      ["LIF/TRV/note.md", "LIF/TRV"],
      ["Life/Gatherings/note.md", "LIF/GTH"],
      ["Nowhere/Else/note.md", null],
      ["loose.md", null],
    ]);
  });

  it("refuses a manifest that does not parse, and leaves memories of a folder with none to be reported", () => {
    const broken: MirrorReadFile = {
      path: MIRROR_MANIFEST_PATH,
      format: "json",
      data: { format: "something-else" },
      body: "",
      owned: false,
      unchanged: false,
      sha256: null,
      modifiedAt: null,
      error: null,
    };
    expect(() => readMirror([broken])).toThrow(/library\.json/);
    expect(readMirror([]).hasManifest).toBe(false);
  });
});
