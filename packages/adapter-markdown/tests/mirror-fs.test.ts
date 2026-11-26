import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createMarkdownConnector } from "../src/connector.js";
import { adoptFiles, readMirror, writeMirror, type MirrorDocument } from "../src/mirror-fs.js";
import { safeSegments } from "../src/paths.js";

/** Throwaway folders only. Every name is invented. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "reverie-mirror-"));
}

function memoryDoc(path: string, id: string, body: string, extra: Record<string, unknown> = {}): MirrorDocument {
  return { path, format: "markdown", data: { id, call: "LIF/GTH/2026-12-24/001", title: "Christmas at home", ...extra }, body };
}

const manifest: MirrorDocument = { path: ".reverie/library.json", format: "json", data: { format: "reverie-mirror", version: 1 } };

function allFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return allFiles(join(dir, entry.name), rel);
    return [rel];
  });
}

describe("writing the mirror", () => {
  it("writes one file per document and nothing when written again unchanged", () => {
    const root = tempDir();
    const docs = [manifest, memoryDoc("Life/Gatherings/2026-12-24-001 christmas-at-home.md", "m1", "Hosted Christmas.")];
    expect(writeMirror(root, docs)).toMatchObject({ written: 2, unchanged: 0, removed: 0, kept: [] });
    expect(readFileSync(join(root, "Life/Gatherings/2026-12-24-001 christmas-at-home.md"), "utf8")).toContain("Hosted Christmas.");
    expect(writeMirror(root, docs)).toMatchObject({ written: 0, unchanged: 2, removed: 0 });
  });

  it("never writes over or deletes a file it did not write, and never puts the folder's own path in a file", () => {
    const root = tempDir();
    mkdirSync(join(root, "Life", "Gatherings"), { recursive: true });
    writeFileSync(join(root, "Life", "Gatherings", "my own note.md"), "Mine. Jane Doe wrote this.\n");
    writeFileSync(join(root, "Life", "Gatherings", "2026-12-24-001 christmas-at-home.md"), "A note of mine at that very path.\n");
    writeFileSync(join(root, "todo.txt"), "not markdown\n");

    const report = writeMirror(root, [manifest, memoryDoc("Life/Gatherings/2026-12-24-001 christmas-at-home.md", "m1", "Hosted Christmas.")]);
    expect(report.kept).toEqual([{ path: "Life/Gatherings/2026-12-24-001 christmas-at-home.md", reason: expect.stringMatching(/did not write/) }]);
    expect(readFileSync(join(root, "Life", "Gatherings", "2026-12-24-001 christmas-at-home.md"), "utf8")).toBe("A note of mine at that very path.\n");

    // A later mirror with no documents removes only what it wrote.
    writeMirror(root, []);
    expect(readFileSync(join(root, "Life", "Gatherings", "my own note.md"), "utf8")).toBe("Mine. Jane Doe wrote this.\n");
    expect(existsSync(join(root, "todo.txt"))).toBe(true);
    expect(existsSync(join(root, ".reverie", "library.json"))).toBe(false);

    for (const file of allFiles(root)) expect(readFileSync(join(root, file), "utf8"), file).not.toContain(root);
  });

  it("removes a file it wrote once the memory leaves the mirror, and the folders that leaves empty", () => {
    const root = tempDir();
    writeMirror(root, [manifest, memoryDoc("Life/Gatherings/2026-12-24-001 christmas-at-home.md", "m1", "Hosted Christmas.")]);
    const report = writeMirror(root, [manifest, memoryDoc("Life/Travel/2026-12-24-001 christmas-at-home.md", "m1", "Hosted Christmas.")]);
    expect(report).toMatchObject({ written: 1, removed: 1 });
    expect(existsSync(join(root, "Life", "Gatherings"))).toBe(false);
    expect(existsSync(join(root, "Life", "Travel", "2026-12-24-001 christmas-at-home.md"))).toBe(true);
  });

  it("keeps an edit that was not imported yet, and writes over it once the import adopted it", () => {
    const root = tempDir();
    const path = "Life/Gatherings/2026-12-24-001 christmas-at-home.md";
    writeMirror(root, [manifest, memoryDoc(path, "m1", "Hosted Christmas.")]);
    writeFileSync(join(root, path), readFileSync(join(root, path), "utf8").replace("Hosted Christmas.", "Hosted Christmas, edited."));

    const kept = writeMirror(root, [manifest, memoryDoc(path, "m1", "Hosted Christmas, newer.")]);
    expect(kept.kept).toEqual([{ path, reason: expect.stringMatching(/not imported yet/) }]);
    expect(readFileSync(join(root, path), "utf8")).toContain("edited");

    const read = readMirror(root).find((file) => file.path === path);
    expect(read).toMatchObject({ owned: true, unchanged: false });
    expect(adoptFiles(root, { [path]: read?.sha256 })).toEqual({ adopted: 1 });
    expect(adoptFiles(root, { [path]: "0".repeat(64) })).toEqual({ adopted: 0 });

    expect(writeMirror(root, [manifest, memoryDoc(path, "m1", "Hosted Christmas, newer.")])).toMatchObject({ written: 1, kept: [] });
    expect(readFileSync(join(root, path), "utf8")).toContain("newer");
  });

  it("deletes a forgotten memory's file even when it was edited: forget is real", () => {
    const root = tempDir();
    const path = "Life/Health/2026-10-10-001 dentist.md";
    writeMirror(root, [manifest, memoryDoc(path, "m-forgotten", "Saw the dentist.")]);
    writeFileSync(join(root, path), "edited by hand\n");
    expect(writeMirror(root, [manifest], { forgotten: ["m-forgotten"] })).toMatchObject({ removed: 1, kept: [] });
    expect(existsSync(join(root, path))).toBe(false);
  });

  it("refuses every path that would leave the folder, and writes nothing outside it", () => {
    const outer = tempDir();
    const root = join(outer, "mirror");
    const bad = [
      "../escape.md",
      "Life/../../escape.md",
      "/etc/escape.md",
      "C:/escape.md",
      "Life\\..\\escape.md",
      "Life/\uff0e\uff0e/escape.md",
      "Life/./x.md",
      "Life//x.md",
      "Life/\u0000.md",
      ".reverie/owned.json",
      ".reverie/other.json",
    ];
    for (const path of bad) {
      expect(() => writeMirror(root, [memoryDoc(path, "m1", "x")]), path).toThrow();
    }
    expect(readdirSync(outer)).toEqual(["mirror"]);
    expect(allFiles(root)).toEqual([]);
  });

  it("does not follow a symlink, writing or reading", () => {
    const outside = tempDir();
    writeFileSync(join(outside, "secret.md"), "---\nid: x\n---\nnot yours\n");
    const root = tempDir();
    symlinkSync(outside, join(root, "Life"));
    symlinkSync(join(outside, "secret.md"), join(root, "linked.md"));

    const report = writeMirror(root, [manifest, memoryDoc("Life/escape.md", "m1", "x")]);
    expect(report.kept).toEqual([{ path: "Life/escape.md", reason: expect.stringMatching(/symlink/) }]);
    expect(readdirSync(outside)).toEqual(["secret.md"]);

    const read = readMirror(root).map((file) => file.path);
    expect(read).toEqual([".reverie/library.json"]);
  });

  it("refuses a relative folder, and a folder that is a file", () => {
    expect(() => writeMirror("relative/mirror", [])).toThrow(/absolute/);
    const root = tempDir();
    writeFileSync(join(root, "file"), "x");
    expect(() => writeMirror(join(root, "file"), [])).toThrow(/not a folder/);
    expect(() => readMirror(join(root, "missing"))).toThrow(/does not exist/);
  });

  it("refuses to write when owned.json does not read, rather than guess which files are its own", () => {
    const root = tempDir();
    mkdirSync(join(root, ".reverie"));
    writeFileSync(join(root, ".reverie", "owned.json"), "{ not json");
    expect(() => writeMirror(root, [manifest])).toThrow(/does not read/);
  });
});

describe("reading the mirror", () => {
  it("hands over every markdown file below the folder, skipping dot folders, with each file's own problem", () => {
    const root = tempDir();
    writeMirror(root, [manifest, memoryDoc("Life/Gatherings/2026-12-24-001 christmas-at-home.md", "m1", "Hosted Christmas.")]);
    mkdirSync(join(root, ".obsidian"));
    writeFileSync(join(root, ".obsidian", "workspace.md"), "editor state");
    writeFileSync(join(root, "Life", "hand note.md"), "Walked with Sam Rivera.\n");
    writeFileSync(join(root, "Life", "broken.md"), "---\na: 1\na: 2\n---\nbody\n");

    const files = readMirror(root);
    expect(files.map((file) => file.path)).toEqual([
      ".reverie/library.json",
      "Life/Gatherings/2026-12-24-001 christmas-at-home.md",
      "Life/broken.md",
      "Life/hand note.md",
    ]);
    const byPath = new Map(files.map((file) => [file.path, file]));
    expect(byPath.get("Life/Gatherings/2026-12-24-001 christmas-at-home.md")).toMatchObject({
      owned: true,
      unchanged: true,
      body: "Hosted Christmas.",
      data: { id: "m1" },
    });
    expect(byPath.get("Life/hand note.md")).toMatchObject({ owned: false, unchanged: false, data: null, body: "Walked with Sam Rivera." });
    expect(byPath.get("Life/broken.md")?.error).toMatch(/appears twice/);
  });

  it("answers through the connector shape, refusing a bad cursor or payload", async () => {
    const root = tempDir();
    const connector = createMarkdownConnector();
    await connector.push({ op: "write_mirror", folder: root, documents: [manifest] });
    const pulled = await connector.pull(JSON.stringify({ op: "read_mirror", folder: root }));
    expect(pulled.cursor).toBeNull();
    expect(pulled.items.map((item) => item.id)).toEqual([".reverie/library.json"]);
    await expect(connector.pull("nope")).rejects.toMatchObject({ code: "bad_cursor" });
    await expect(connector.pull(JSON.stringify({ op: "delete", folder: root }))).rejects.toMatchObject({ code: "bad_cursor" });
    await expect(connector.push({ op: "write_mirror", folder: root, documents: "x" })).rejects.toMatchObject({ code: "bad_payload" });
    await expect(connector.push({ op: "rm", folder: root })).rejects.toMatchObject({ code: "bad_payload" });
  });

  it("checks segments the way the writer does", () => {
    expect(safeSegments("Life/Gatherings/a b.md")).toEqual(["Life", "Gatherings", "a b.md"]);
    expect(() => safeSegments("a/../b")).toThrow();
  });
});
