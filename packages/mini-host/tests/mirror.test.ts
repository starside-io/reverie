import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { domain } from "@reverie/core";

import type { MiniHost } from "../src/host.js";
import { throwawayDir, throwawayHost } from "./harness.js";

/**
 * M7 (docs/SPEC.md section 23): "Round trip through a folder loses nothing."
 *
 * A library with every kind, several shelves, tags, attendee, occasion and
 * mention refs, sources with quotes, a multi-version memory, a moved one
 * with an alias, a superseded one, a retired one, a pinned one, a project
 * scoped one and a forgotten one is written to a mirror folder through
 * memory.export, read into an empty silo through memory.import, and the two
 * silos are compared with the snapshot diff, field by field. Then the gates:
 * forget is real in the mirror, paths stay home, and nothing a file or a
 * name says reaches outside the folder.
 *
 * Throwaway silos and temp folders only; every name is invented.
 */

const FOLDER = "/Users/janedoe/code/nightstash";

const hosts: MiniHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

async function fresh(): Promise<MiniHost> {
  const host = await throwawayHost();
  hosts.push(host);
  return host;
}

let clock = Date.parse("2026-12-01T09:00:00.000Z");
function tick(): Date {
  clock += 60_000;
  return new Date(clock);
}

async function call<T = Record<string, unknown>>(host: MiniHost, name: string, input: Record<string, unknown>): Promise<T> {
  return (await host.api.invoke(name, input, { now: tick() })) as T;
}

type Made = { memory: { id: string; call: string } };

interface Library {
  host: MiniHost;
  christmas: Made;
  preference: Made;
  coffee: Made;
  forgotten: Made;
  procedure: Made;
}

async function library(): Promise<Library> {
  const host = await fresh();
  await call(host, "memory.set_shelves", {
    action: "create_shelf",
    section: "LIF",
    code: "GDN",
    name: "Garden",
    description: "The garden at Port Aster: what grows, what failed.",
  });
  await call(host, "memory.set_projects", {
    action: "create",
    slug: "nightstash",
    name: "NightStash",
    repoUrl: "https://github.com/jane-doe/nightstash",
    shelf: "WRK/NST",
    folders: [FOLDER],
  });

  const coffee = await call<Made>(host, "memory.remember", {
    kind: "fact",
    shelf: "LIF/HOM",
    occurredOn: "2026-10-01",
    body: "Jane Doe takes her coffee black.",
  });
  await call(host, "memory.supersede", {
    call: coffee.memory.call,
    body: "Jane Doe takes her coffee with oat milk since 2026-11-01.",
    occurredOn: "2026-11-01",
  });
  const preference = await call<Made>(host, "memory.remember", {
    kind: "preference",
    shelf: "LIF/TRV",
    occurredOn: "2026-09-12",
    body: "Prefers a window seat on the train to Port Aster. #travel",
    importance: 2,
  });
  const christmas = await call<Made>(host, "memory.remember", {
    kind: "episode",
    shelf: "LIF/GTH",
    occurredOn: "2026-12-24",
    title: "Christmas at home",
    body: 'Hosted Christmas with Jane Doe, John Doe and Sam Rivera. Café au lait, "quotes", and a\nsecond line.',
    tags: ["christmas", "family"],
    attendees: ["Jane Doe", "Sam Rivera", "module://people/person/john-doe"],
    occasion: "Christmas 2026",
    mentions: ["Robin Doe"],
    importance: 4,
  });
  await call(host, "memory.add_source", {
    call: christmas.memory.call,
    quote: "Christmas Eve, everyone at the table",
    source: { kind: "page", uri: "https://example.test/photos/xmas", label: "Photo album", occurredAt: "2026-12-24T19:30:00Z", trust: "external" },
  });
  await call(host, "memory.update", {
    call: christmas.memory.call,
    body: "Hosted Christmas with Jane Doe, John Doe and Sam Rivera at Port Aster. Café au lait, \"quotes\", and a\nsecond line.",
    why: "The first Christmas at the new house.",
  });
  await call(host, "memory.pin", { call: christmas.memory.call, pinned: true });

  const reference = await call<Made>(host, "memory.remember", {
    kind: "reference",
    shelf: "REF/LNK",
    occurredOn: "2026-08-01",
    body: "The old build board lived at https://builds.example.test/legacy.",
  });
  await call(host, "memory.retire", { call: reference.memory.call });

  const procedure = await call<Made>(host, "memory.promote_procedure", {
    body: "Write commit subjects in the imperative, under seventy two characters.",
    why: "The log reads as a list of changes.",
    howToApply: "Before every commit in the NightStash repository.",
    scope: "project",
    scopeRef: "nightstash",
    shelf: "WRK/NST",
    occurredOn: "2026-11-02",
    confirmedByUser: true,
  });
  await call(host, "memory.remember", {
    kind: "fact",
    scope: "project",
    scopeRef: "nightstash",
    occurredOn: "2026-11-20",
    body: "NightStash pricing goes up on 2027-03-01.",
  });

  await call(host, "memory.shelve", { action: "move", call: preference.memory.call, shelf: "LIF/GDN" });
  await call(host, "memory.link", { from: christmas.memory.call, to: preference.memory.call, relation: "elaborates" });

  const forgotten = await call<Made>(host, "memory.remember", {
    kind: "episode",
    shelf: "LIF/HLT",
    occurredOn: "2026-10-10",
    title: "Dentist",
    body: "Saw the dentist about a cracked molar.",
    explicitAsk: true,
  });
  await call(host, "memory.link", { from: christmas.memory.call, to: forgotten.memory.call, relation: "contradicts" });
  await call(host, "memory.forget", { call: forgotten.memory.call, confirmedByUser: true });
  await call(host, "memory.set_tags", { action: "rename", from: "family", to: "household" });

  return { host, christmas, preference, coffee, forgotten, procedure };
}

function mirrorDir(): string {
  return join(mkdtempSync(join(tmpdir(), "reverie-m7-")), "mirror");
}

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(join(dir, entry.name), rel) : [rel];
  });
}

async function snapshotOf(host: MiniHost) {
  return domain.transfer.buildExportSnapshot(host.silo);
}

/** The library as the mirror carries it: a forgotten memory's redacted version rows stay out, by design. */
function withoutForgottenHistory(snapshot: Awaited<ReturnType<typeof snapshotOf>>) {
  const live = new Set(snapshot.memories.map((memory) => memory.id));
  return { ...snapshot, versions: snapshot.versions.filter((version) => live.has(version.memoryId)) };
}

async function exportMirror(host: MiniHost, folder: string) {
  return call<{ to: string; memories: number; files: number; mirror: { written: number; unchanged: number; removed: number; kept: Array<{ path: string; reason: string }> } }>(
    host,
    "memory.export",
    { to: "markdown", folder },
  );
}

type FolderResult = {
  written: boolean;
  folder: {
    files: number;
    memories: number;
    unchanged: number;
    applied: number;
    conflicts: Array<{ path: string; message: string }>;
    problems: Array<{ path: string; message: string }>;
    forgotten: Array<{ path: string; message: string }>;
    notes: Array<{ path: string; action: string; call?: string; message?: string; kind?: string; scope?: string; title?: string }>;
  };
  counts: Record<string, number>;
  wouldDestroy?: Record<string, number> | null;
  acknowledgement?: string | null;
  backup?: string | null;
  links?: number;
};

async function importMirror(host: MiniHost, folder: string, extra: Record<string, unknown> = {}) {
  return call<FolderResult>(host, "memory.import", { from: "markdown", folder, confirmedByUser: true, ...extra });
}

describe("M7: a round trip through a mirror folder loses nothing", () => {
  it("export to a folder, import into an empty silo, and the two silos are equal field by field", async () => {
    const source = await library();
    const folder = mirrorDir();
    const exported = await exportMirror(source.host, folder);
    expect(exported).toMatchObject({ to: "markdown", memories: 7, files: 8, mirror: { written: 8, kept: [] } });

    const files = filesUnder(folder);
    expect(files).toContain(".reverie/library.json");
    expect(files).toContain(".reverie/owned.json");
    expect(files).toContain("Life/Gatherings/2026-12-24-001 christmas-at-home.md");
    expect(files.some((file) => file.startsWith("Life/Garden/2026-09-12-001 "))).toBe(true);
    expect(files.some((file) => file.startsWith("Work/NightStash/2026-11-02-001 "))).toBe(true);
    expect(files.some((file) => file.startsWith("Reference/Links/2026-08-01-001 "))).toBe(true);

    // A plain merge into an empty silo, then a replace into another one.
    for (const mode of ["merge", "replace"] as const) {
      const target = await fresh();
      const plan = await importMirror(target, folder, { mode, dryRun: true });
      expect(plan.written).toBe(false);
      expect(plan.folder).toMatchObject({ memories: 7, applied: 7, problems: [], conflicts: [] });
      const result = await importMirror(target, folder, {
        mode,
        ...(mode === "replace" ? { acknowledge: plan.acknowledgement } : {}),
      });
      expect(result).toMatchObject({ written: true, counts: { memories: 7, versionsAppended: 0 } });
      expect(result.backup).toMatch(/^reverie-before-import-.*\.db$/);

      const before = withoutForgottenHistory(await snapshotOf(source.host));
      const after = await snapshotOf(target);
      const diff = domain.transfer.diffSnapshots(before, after, { maxRowsReported: Number.POSITIVE_INFINITY });
      expect(diff.identical, domain.transfer.formatDiff(diff)).toBe(true);

      // The forgotten memory is absent, and its number stays retired.
      expect(after.memories.some((memory) => memory.id === source.forgotten.memory.id)).toBe(false);
      expect(after.versions.some((version) => version.memoryId === source.forgotten.memory.id)).toBe(false);
      expect(after.aliases).toContainEqual(expect.objectContaining({ oldCallNumber: source.forgotten.memory.call, memoryId: null }));
      // An old number still resolves after the trip.
      const moved = (await call<{ memory: { id: string } }>(target, "memory.get", { call: source.preference.memory.call })).memory;
      expect(moved.id).toBe(source.preference.memory.id);
    }
  });

  it("an unchanged folder imports as a no-op, and writing the mirror again writes nothing", async () => {
    const { host } = await library();
    const folder = mirrorDir();
    await exportMirror(host, folder);
    const before = await snapshotOf(host);
    const result = await importMirror(host, folder);
    expect(result.folder).toMatchObject({ unchanged: 7, applied: 0, problems: [], conflicts: [] });
    expect(result.counts).toMatchObject({ memories: 0, versionsAppended: 0 });
    expect(domain.transfer.diffSnapshots(before, await snapshotOf(host)).identical).toBe(true);
    expect((await exportMirror(host, folder)).mirror).toMatchObject({ written: 0, unchanged: 8, removed: 0 });
  });

  it("an edit in the folder comes back as a new version, the old one in history, never in place", async () => {
    const { host, christmas } = await library();
    const folder = mirrorDir();
    await exportMirror(host, folder);
    const path = join(folder, "Life/Gatherings/2026-12-24-001 christmas-at-home.md");
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace("at Port Aster.", "at Port Aster, with snow.").replace('importance: 4', "importance: 5"));
    const versionsBefore = await host.silo.memoryVersion.count({ where: { memoryId: christmas.memory.id } });

    const plan = await importMirror(host, folder, { dryRun: true });
    expect(plan.folder).toMatchObject({ applied: 1, unchanged: 6 });
    const result = await importMirror(host, folder);
    expect(result.counts.versionsAppended).toBe(1);

    const row = await host.silo.memory.findUniqueOrThrow({ where: { id: christmas.memory.id } });
    expect(row.body).toContain("with snow");
    expect(row.importance).toBe(5);
    expect(row.callNumber).toBe(christmas.memory.call);
    const history = await call<{ versions: Array<{ operation: string; content: { body: string } | null }> }>(host, "memory.history", {
      call: christmas.memory.call,
    });
    expect(history.versions).toHaveLength(versionsBefore + 1);
    expect(history.versions.some((version) => version.content?.body.includes("at Port Aster.") && !version.content.body.includes("snow"))).toBe(true);

    // Taken in, the edit is the mirror's again: importing again is a no-op, and the next export writes over it.
    const again = await importMirror(host, folder);
    expect(again.folder).toMatchObject({ unchanged: 7, applied: 0 });
    expect((await exportMirror(host, folder)).mirror).toMatchObject({ written: 2, kept: [] });
  });

  it("an edit made while the library also changed is a conflict, left alone", async () => {
    const { host, christmas } = await library();
    const folder = mirrorDir();
    await exportMirror(host, folder);
    const path = join(folder, "Life/Gatherings/2026-12-24-001 christmas-at-home.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("at Port Aster.", "at Port Aster, in the folder."));
    await call(host, "memory.update", { call: christmas.memory.call, body: "Hosted Christmas, changed in the library." });

    const result = await importMirror(host, folder);
    expect(result.folder.conflicts).toEqual([{ path: "Life/Gatherings/2026-12-24-001 christmas-at-home.md", message: expect.stringMatching(/also changed/) }]);
    expect((await host.silo.memory.findUniqueOrThrow({ where: { id: christmas.memory.id } })).body).toBe("Hosted Christmas, changed in the library.");
    // And the export keeps the unimported edit rather than writing over it.
    expect((await exportMirror(host, folder)).mirror.kept).toEqual([
      { path: "Life/Gatherings/2026-12-24-001 christmas-at-home.md", reason: expect.stringMatching(/not imported yet/) },
    ]);
  });

  it("an edit cannot raise trust or make a procedure", async () => {
    const { host, christmas } = await library();
    const folder = mirrorDir();
    await exportMirror(host, folder);
    const path = join(folder, "Life/Gatherings/2026-12-24-001 christmas-at-home.md");
    writeFileSync(path, readFileSync(path, "utf8").replace('kind: "episode"', 'kind: "procedure"'));
    const result = await importMirror(host, folder);
    expect(result.folder.problems).toEqual([{ path: "Life/Gatherings/2026-12-24-001 christmas-at-home.md", message: expect.stringMatching(/procedure/) }]);
    expect((await host.silo.memory.findUniqueOrThrow({ where: { id: christmas.memory.id } })).kind).toBe("episode");
  });

  it("a folder missing a file deletes nothing; a replace names what it destroys, and then the file's numbers stay retired", async () => {
    const { host, preference } = await library();
    const folder = mirrorDir();
    await exportMirror(host, folder);
    const file = filesUnder(folder).find((path) => path.startsWith("Life/Garden/")) as string;
    unlinkSync(join(folder, file));

    await importMirror(host, folder);
    expect(await host.silo.memory.findUnique({ where: { id: preference.memory.id } })).not.toBeNull();

    const plan = await importMirror(host, folder, { mode: "replace", dryRun: true });
    expect(plan.wouldDestroy).toMatchObject({ memories: 7 });
    expect(plan.acknowledgement).toMatch(/^replace:v1:/);
    await expect(importMirror(host, folder, { mode: "replace" })).rejects.toMatchObject({ code: "refused" });
    await importMirror(host, folder, { mode: "replace", acknowledge: plan.acknowledgement });
    expect(await host.silo.memory.findUnique({ where: { id: preference.memory.id } })).toBeNull();
    const retired = await host.silo.callNumberAlias.findMany({ where: { memoryId: null } });
    expect(retired.map((row) => row.oldCallNumber)).toContain(preference.memory.call);
  });

  it("a note written by hand lands sensibly, is not duplicated on a second import, and a malformed file stops only itself", async () => {
    const { host } = await library();
    const folder = mirrorDir();
    await exportMirror(host, folder);
    writeFileSync(join(folder, "Life", "Gatherings", "walk with sam.md"), "Walked along the Port Aster harbour with Sam Rivera on 2026-12-26.\n");
    writeFileSync(join(folder, "loose idea.md"), "---\ntitle: Garden bench\ntags: [garden, idea]\n---\nBuild a cedar bench for the garden.\n");
    writeFileSync(join(folder, "Life", "broken.md"), "---\ntitle: [unclosed\n---\nbody\n");
    writeFileSync(join(folder, "Life", "procedure.md"), "---\nkind: procedure\n---\nAlways do the thing.\n");

    const result = await importMirror(host, folder);
    const notes = new Map(result.folder.notes.map((note) => [note.path, note]));
    expect(notes.get("Life/Gatherings/walk with sam.md")).toMatchObject({ action: "create", call: expect.stringMatching(/^LIF\/GTH\//) });
    expect(notes.get("loose idea.md")).toMatchObject({ action: "create", call: expect.stringMatching(/^DSK\/RET\//), title: "Garden bench" });
    expect(notes.get("Life/procedure.md")).toMatchObject({ action: "refused", message: expect.stringMatching(/promote_procedure/) });
    expect(result.folder.problems).toEqual([{ path: "Life/broken.md", message: expect.stringMatching(/front matter/) }]);

    const walk = await host.silo.memory.findFirstOrThrow({
      where: { body: { contains: "harbour with Sam Rivera" } },
      include: { sources: { include: { source: true } }, tags: { include: { tag: true } } },
    });
    expect(walk.trust).toBe("stated");
    expect(walk.sources[0]?.source).toMatchObject({ kind: "file", uri: "mirror:Life/Gatherings/walk with sam.md", trust: "stated" });
    const bench = await host.silo.memory.findFirstOrThrow({ where: { title: "Garden bench" }, include: { tags: { include: { tag: true } } } });
    expect(bench.tags.map((row) => row.tag.slug).sort()).toEqual(["garden", "idea"]);

    const count = await host.silo.memory.count();
    const again = await importMirror(host, folder);
    expect(await host.silo.memory.count()).toBe(count);
    expect(again.folder.notes.filter((note) => note.action === "unchanged")).toHaveLength(2);

    // An edit to the hand written note is a new version of the memory it became.
    writeFileSync(join(folder, "Life", "Gatherings", "walk with sam.md"), "Walked along the Port Aster harbour with Sam Rivera and John Doe on 2026-12-26.\n");
    const edited = await importMirror(host, folder);
    expect(edited.folder.notes.find((note) => note.path === "Life/Gatherings/walk with sam.md")).toMatchObject({ action: "update" });
    expect((await host.silo.memory.findUniqueOrThrow({ where: { id: walk.id } })).body).toContain("John Doe");
    expect(await host.silo.memoryVersion.count({ where: { memoryId: walk.id } })).toBe(2);
  });
});

describe("M7 gates on the mirror", () => {
  it("forget is real: the forgotten memory, its history and its text are absent from every mirror file", async () => {
    const { host, forgotten } = await library();
    const folder = mirrorDir();
    await exportMirror(host, folder);
    for (const file of filesUnder(folder)) {
      const text = readFileSync(join(folder, file), "utf8");
      expect(text, file).not.toContain(forgotten.memory.id);
      expect(text, file).not.toMatch(/molar|dentist/i);
    }
    // The number alone stays, retired: it is never reissued.
    expect(readFileSync(join(folder, ".reverie/library.json"), "utf8")).toContain(forgotten.memory.call);
  });

  it("forgetting after an export removes the file on the next export, even one edited by hand", async () => {
    const { host, christmas } = await library();
    const folder = mirrorDir();
    await exportMirror(host, folder);
    const path = join(folder, "Life/Gatherings/2026-12-24-001 christmas-at-home.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nedited\n`);
    await call(host, "memory.forget", { call: christmas.memory.call, confirmedByUser: true });
    const report = await exportMirror(host, folder);
    expect(report.mirror.removed).toBe(1);
    expect(existsSync(path)).toBe(false);
    for (const file of filesUnder(folder)) expect(readFileSync(join(folder, file), "utf8"), file).not.toContain(christmas.memory.id);
  });

  it("paths stay home: no mirror file holds a local folder path", async () => {
    const { host } = await library();
    const folder = mirrorDir();
    await exportMirror(host, folder);
    const forbidden = [FOLDER, folder, tmpdir(), homedir()];
    for (const file of filesUnder(folder)) {
      const text = readFileSync(join(folder, file), "utf8");
      for (const path of forbidden) expect(text, `${file} holds ${path}`).not.toContain(path);
    }
    const manifest = JSON.parse(readFileSync(join(folder, ".reverie/library.json"), "utf8")) as { projects: Array<Record<string, unknown>> };
    expect(manifest.projects).toEqual([expect.objectContaining({ slug: "nightstash", repoUrl: "github.com/jane-doe/nightstash" })]);
    expect(Object.keys(manifest.projects[0] as object).sort()).toEqual(
      ["archived", "createdAt", "description", "id", "name", "repoUrl", "shelfId", "slug", "tagId", "updatedAt"].sort(),
    );
  });

  it("a section or shelf name cannot steer a file outside the mirror", async () => {
    const host = await fresh();
    await call(host, "memory.set_shelves", { action: "rename_section", code: "LIF", name: "../../Escape" });
    await call(host, "memory.set_shelves", { action: "rename_shelf", shelf: "LIF/GTH", name: ".." });
    await call(host, "memory.remember", { kind: "episode", shelf: "LIF/GTH", occurredOn: "2026-12-24", body: "Hosted Christmas with Sam Rivera." });
    const outer = mkdtempSync(join(tmpdir(), "reverie-m7-outer-"));
    const folder = join(outer, "mirror");
    await exportMirror(host, folder);
    expect(readdirSync(outer)).toEqual(["mirror"]);
    const files = filesUnder(folder);
    expect(files.some((file) => file.endsWith(" hosted-christmas-with-sam-rivera.md"))).toBe(true);
    for (const file of files) expect(file.split("/").every((segment) => segment !== ".." && segment !== ".")).toBe(true);

    // And it reads back where it was written.
    const target = await fresh();
    const result = await importMirror(target, folder);
    expect(result.folder).toMatchObject({ applied: 1, problems: [] });
  });

  it("an import reads nothing outside the folder it is given: no symlink, no front matter path", async () => {
    const { host } = await library();
    const folder = mirrorDir();
    await exportMirror(host, folder);
    const elsewhere = mkdtempSync(join(tmpdir(), "reverie-m7-elsewhere-"));
    writeFileSync(join(elsewhere, "outside.md"), "Jane Doe's private note about the harbour, outside the mirror.\n");
    mkdirSync(join(elsewhere, "Shelf"));
    writeFileSync(join(elsewhere, "Shelf", "inner.md"), "Another note outside the mirror.\n");
    symlinkSync(join(elsewhere, "outside.md"), join(folder, "linked.md"));
    symlinkSync(join(elsewhere, "Shelf"), join(folder, "Linked shelf"));
    writeFileSync(join(folder, "pointer.md"), `---\ntitle: Pointer\nsource: ${join(elsewhere, "outside.md")}\nfile: ../../outside.md\n---\nA note that names a file elsewhere.\n`);

    const result = await importMirror(host, folder);
    expect(result.folder.notes.map((note) => note.path)).toEqual(["pointer.md"]);
    expect(await host.silo.memory.count({ where: { body: { contains: "outside the mirror" } } })).toBe(0);
    expect(await host.silo.source.count({ where: { uri: { contains: elsewhere } } })).toBe(0);
  });

  it("refuses a relative folder and a folder that is not there, writing nothing", async () => {
    const { host } = await library();
    const count = await host.silo.memory.count();
    await expect(importMirror(host, "relative/mirror")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(importMirror(host, join(throwawayDir(), "missing"))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(exportMirror(host, "relative/mirror")).rejects.toMatchObject({ code: "invalid_input" });
    expect(await host.silo.memory.count()).toBe(count);
  });
});

describe("M7: a Claude Code memory directory", () => {
  async function fixture(): Promise<string> {
    const { writeClaudeCodeFixture } = await import("../../adapter-markdown/tests/fixtures/claude-code.js");
    return writeClaudeCodeFixture(join(mkdtempSync(join(tmpdir(), "reverie-cc-")), "memory"));
  }

  async function importDir(host: MiniHost, folder: string, extra: Record<string, unknown> = {}) {
    return call<FolderResult>(host, "memory.import", { from: "claude_code", folder, confirmedByUser: true, ...extra });
  }

  function state(dir: string): string[][] {
    return readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8")]);
  }

  it("imports both front matter shapes into the project, once, never writing to the directory", async () => {
    const host = await fresh();
    await call(host, "memory.set_projects", { action: "create", slug: "harbour", name: "Harbour", repoUrl: "https://github.com/jane-doe/harbour" });
    const dir = await fixture();
    const before = state(dir);

    const plan = await importDir(host, dir, { project: "harbour", dryRun: true });
    expect(plan.written).toBe(false);
    expect(plan.folder.notes.map((note) => [note.path, note.action, note.kind, note.scope])).toEqual([
      ["feedback-commits.md", "create", "procedure", "project"],
      ["feedback-indent.md", "create", "preference", "project"],
      ["project-launch.md", "create", "fact", "project"],
      ["reference-board.md", "create", "reference", "project"],
      ["user-role.md", "create", "fact", "global"],
    ]);
    expect(await host.silo.memory.count()).toBe(0);

    const result = await importDir(host, dir, { project: "harbour" });
    expect(result.folder.notes.every((note) => note.action === "create")).toBe(true);
    expect(result.links).toBe(1);
    expect(result.backup).toMatch(/^reverie-before-import-/);
    expect(state(dir)).toEqual(before);

    const rows = await host.silo.memory.findMany({
      include: { shelf: { include: { section: true } }, sources: { include: { source: true } } },
      orderBy: { callNumber: "asc" },
    });
    expect(rows).toHaveLength(5);
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    const commits = byTitle.get("Commit subjects are imperative and short");
    expect(commits).toMatchObject({
      kind: "procedure",
      scope: "project",
      scopeRef: "harbour",
      trust: "confirmed",
      why: "Jane reads the log as a list of changes, see [[project-launch]].",
      howToApply: "Every commit in the Harbour repository.",
      body: "Write commit subjects in the imperative mood, under seventy two characters.",
    });
    expect(`${commits?.shelf.section.code}/${commits?.shelf.code}`).toBe("WRK/HAR");
    expect(commits?.sources[0]?.source).toMatchObject({ kind: "import", uri: "claude-code-memory:harbour/feedback-commits", trust: "confirmed" });
    expect(byTitle.get("Two spaces, never tabs")).toMatchObject({ kind: "preference", scope: "project" });
    expect(byTitle.get("The Harbour launch is set for 2027-03-15")).toMatchObject({ kind: "fact", why: "The marketing week at Port Aster starts then." });
    expect(byTitle.get("Build board: builds.example.test")).toMatchObject({ kind: "reference" });
    const user = byTitle.get("Jane Doe is the lead engineer on the Harbour app");
    expect(user).toMatchObject({ kind: "fact", scope: "global", scopeRef: null });
    expect(`${user?.shelf.section.code}/${user?.shelf.code}`).toBe("DSK/RET");
    for (const row of rows) expect(row.body).not.toMatch(/Memory index/);
    expect(await host.silo.memoryLink.count({ where: { relation: "elaborates" } })).toBe(1);

    // Again: nothing new, and the directory still untouched.
    const again = await importDir(host, dir, { project: "harbour" });
    expect(again.folder.notes.every((note) => note.action === "unchanged")).toBe(true);
    expect(await host.silo.memory.count()).toBe(5);
    expect(state(dir)).toEqual(before);

    // A memory forgotten here is never brought back by importing the directory again.
    await call(host, "memory.forget", { call: user?.callNumber, confirmedByUser: true });
    const third = await importDir(host, dir, { project: "harbour" });
    expect(third.folder.notes.find((note) => note.path === "user-role.md")).toMatchObject({ action: "forgotten" });
    expect(await host.silo.memory.count()).toBe(4);

    // A file changed in the directory since is reported and left alone.
    writeFileSync(join(dir, "feedback-indent.md"), readFileSync(join(dir, "feedback-indent.md"), "utf8").replace("two spaces", "four spaces"));
    const fourth = await importDir(host, dir, { project: "harbour" });
    expect(fourth.folder.notes.find((note) => note.path === "feedback-indent.md")).toMatchObject({ action: "unchanged", message: expect.stringMatching(/imported once/) });
  });

  it("with no project named, everything lands global on Returns; a replace is refused", async () => {
    const host = await fresh();
    const dir = await fixture();
    await importDir(host, dir);
    const rows = await host.silo.memory.findMany({ include: { shelf: { include: { section: true } } } });
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.scope).toBe("global");
      expect(`${row.shelf.section.code}/${row.shelf.code}`).toBe("DSK/RET");
    }
    await expect(importDir(host, dir, { mode: "replace" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(importDir(host, dir, { project: "nowhere" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reports a broken or unknown file on its own and imports the rest", async () => {
    const host = await fresh();
    const dir = await fixture();
    writeFileSync(join(dir, "odd-type.md"), "---\nname: odd\ntype: diary\n---\nA diary entry.\n");
    writeFileSync(join(dir, "broken.md"), "---\nname: [broken\n---\nbody\n");
    const result = await importDir(host, dir);
    expect(result.folder.problems.map((problem) => problem.path).sort()).toEqual(["broken.md", "odd-type.md"]);
    expect(await host.silo.memory.count()).toBe(5);
    rmSync(dir, { recursive: true, force: true });
  });
});
