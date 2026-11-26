import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { existingRoot, inside, MarkdownUnavailable, resolveRoot, safeSegments, symlinkOnTheWay } from "./paths.js";
import { FrontMatterError, parseMarkdown, renderMarkdown } from "./yaml.js";

/**
 * The mirror on disk. docs/SPEC.md section 19, "The markdown mirror".
 *
 * The mirror owns exactly the files it wrote, and remembers them in
 * `.reverie/owned.json` with a hash of the bytes it wrote. That is how it
 * shares a folder with the owner's own notes:
 *
 * - A path the mirror does not own is never written over and never deleted.
 * - A file it owns that was edited since it wrote it is not written over
 *   until the edit has been imported (the import hands the new hash back
 *   with `adoptFiles`), so an edit is never lost to the next export.
 * - A file it owns for a memory that has left the mirror (moved, renamed,
 *   forgotten) is deleted when it is as the mirror wrote it. A forgotten
 *   memory's file is deleted even when edited: forget is real.
 * - A symlink below the folder is never followed, written through or
 *   deleted.
 *
 * owned.json holds paths relative to the folder and hashes, never the
 * folder's own path.
 */

export const MIRROR_DIR = ".reverie";
export const OWNED_PATH = `${MIRROR_DIR}/owned.json`;
export const MANIFEST_PATH = `${MIRROR_DIR}/library.json`;
const OWNED_FORMAT = "reverie-mirror-owned";

/** The most files one read hands over. Starting value. */
export const MAX_FILES = 20_000;
/** The largest file read. A memory body is far smaller. Starting value. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type MirrorDocument =
  | { path: string; format: "markdown"; data: Record<string, unknown>; body: string }
  | { path: string; format: "json"; data: Record<string, unknown> };

export interface ReadFile {
  path: string;
  format: "markdown" | "json";
  data: Record<string, unknown> | null;
  body: string;
  owned: boolean;
  unchanged: boolean;
  sha256: string | null;
  modifiedAt: string | null;
  error: string | null;
}

export interface WriteReport {
  written: number;
  unchanged: number;
  removed: number;
  kept: Array<{ path: string; reason: string }>;
}

interface OwnedEntry {
  sha256: string;
  memoryId: string | null;
}

type Owned = Record<string, OwnedEntry>;

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A document as the bytes the mirror writes. */
export function renderDocument(document: MirrorDocument): string {
  if (document.format === "json") return `${JSON.stringify(document.data, null, 2)}\n`;
  return renderMarkdown(document.data, document.body);
}

function readOwned(root: string, strict: boolean): Owned {
  const path = join(root, MIRROR_DIR, "owned.json");
  if (!existsSync(path)) return {};
  try {
    if (lstatSync(path).isSymbolicLink() || lstatSync(join(root, MIRROR_DIR)).isSymbolicLink()) throw new Error("symlink");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { format?: unknown; files?: unknown };
    if (parsed.format !== OWNED_FORMAT || !parsed.files || typeof parsed.files !== "object") throw new Error("shape");
    const owned: Owned = {};
    for (const [file, entry] of Object.entries(parsed.files as Record<string, unknown>)) {
      const value = entry as { sha256?: unknown; memoryId?: unknown } | null;
      if (!value || typeof value.sha256 !== "string") continue;
      try {
        safeSegments(file);
      } catch {
        continue;
      }
      owned[file] = { sha256: value.sha256, memoryId: typeof value.memoryId === "string" ? value.memoryId : null };
    }
    return owned;
  } catch {
    if (strict) {
      throw new MarkdownUnavailable(
        "owned_unreadable",
        `${OWNED_PATH} does not read, so the mirror cannot tell its files from yours. Nothing was written. Move that file aside to start the mirror afresh.`,
      );
    }
    return {};
  }
}

function sortedOwned(owned: Owned): Owned {
  return Object.fromEntries(Object.entries(owned).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Write then rename, so a reader never sees half a file. */
function writeAtomic(path: string, content: string): void {
  const temp = join(dirname(path), `.${process.pid}.${Date.now()}.reverie-tmp`);
  writeFileSync(temp, content, { encoding: "utf8", flag: "wx" });
  renameSync(temp, path);
}

function writeOwned(root: string, owned: Owned): void {
  const dir = join(root, MIRROR_DIR);
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
    throw new MarkdownUnavailable("unsafe_path", `${MIRROR_DIR} is a symlink. Nothing more was written.`);
  }
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, "owned.json"), `${JSON.stringify({ format: OWNED_FORMAT, version: 1, files: sortedOwned(owned) }, null, 2)}\n`);
}

/** Folders the removal left empty, up to (never including) the root and the mirror's own folder. */
function pruneEmpty(root: string, start: string): void {
  let current = start;
  while (current !== root && current.startsWith(root) && current !== join(root, MIRROR_DIR)) {
    try {
      if (lstatSync(current).isSymbolicLink() || readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function memoryIdOf(document: MirrorDocument): string | null {
  const id = document.data["id"];
  return typeof id === "string" ? id : null;
}

/**
 * Writes the mirror. `forgotten` names memories forgotten in the library:
 * a file the mirror wrote for one goes, edited or not.
 */
export function writeMirror(
  folder: unknown,
  documents: readonly MirrorDocument[],
  options: { forgotten?: readonly string[] } = {},
): WriteReport {
  const given = resolveRoot(folder);
  if (existsSync(given) && !statSync(given).isDirectory()) {
    throw new MarkdownUnavailable("not_a_directory", "The mirror folder's path names a file, not a folder.");
  }
  mkdirSync(given, { recursive: true });
  const root = realpathSync(given);
  const owned = readOwned(root, true);
  const next: Owned = {};
  const report: WriteReport = { written: 0, unchanged: 0, removed: 0, kept: [] };
  const wanted = new Set<string>();
  const forgotten = new Set(options.forgotten ?? []);

  for (const document of documents) {
    const segments = safeSegments(document.path);
    if (document.path === OWNED_PATH || segments[0] === MIRROR_DIR && document.path !== MANIFEST_PATH) {
      throw new MarkdownUnavailable("unsafe_path", `The mirror writes nothing at ${document.path}.`);
    }
    if (wanted.has(document.path)) throw new MarkdownUnavailable("bad_payload", `Two documents share the path ${document.path}.`);
    wanted.add(document.path);
    const target = inside(root, document.path);
    const content = renderDocument(document);
    const hash = sha256(content);
    const entry: OwnedEntry = { sha256: hash, memoryId: memoryIdOf(document) };

    if (symlinkOnTheWay(root, document.path)) {
      report.kept.push({ path: document.path, reason: "A symlink is on this path. The mirror does not follow it." });
      continue;
    }
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (!stat.isFile()) {
        report.kept.push({ path: document.path, reason: "Something that is not a file is at this path. Left alone." });
        continue;
      }
      const mine = owned[document.path];
      if (!mine) {
        report.kept.push({ path: document.path, reason: "A file the mirror did not write is at this path. Left alone." });
        continue;
      }
      const current = sha256(readFileSync(target));
      if (current === hash) {
        next[document.path] = entry;
        report.unchanged += 1;
        continue;
      }
      if (current !== mine.sha256) {
        next[document.path] = mine;
        report.kept.push({ path: document.path, reason: "Edited in the folder and not imported yet. Left alone: import it, then export again." });
        continue;
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    writeAtomic(target, content);
    next[document.path] = entry;
    report.written += 1;
  }

  for (const [path, entry] of Object.entries(owned)) {
    if (wanted.has(path)) continue;
    let target: string;
    try {
      target = inside(root, path);
    } catch {
      continue;
    }
    if (symlinkOnTheWay(root, path) || !existsSync(target)) continue;
    if (!lstatSync(target).isFile()) continue;
    const current = sha256(readFileSync(target));
    const gone = entry.memoryId !== null && forgotten.has(entry.memoryId);
    if (current !== entry.sha256 && !gone) {
      next[path] = entry;
      report.kept.push({ path, reason: "Its memory moved or left the mirror, but the file was edited here. Left for you." });
      continue;
    }
    unlinkSync(target);
    report.removed += 1;
    pruneEmpty(root, dirname(target));
  }

  writeOwned(root, next);
  return report;
}

/**
 * After an import took an edited file in, the mirror owns it again at its
 * new bytes, so the next export may write over it. Only a file the mirror
 * already owns, and only at the hash the import read.
 */
export function adoptFiles(folder: unknown, files: Record<string, unknown>): { adopted: number } {
  const root = existingRoot(folder);
  const owned = readOwned(root, true);
  let adopted = 0;
  for (const [path, hash] of Object.entries(files)) {
    if (typeof hash !== "string" || !owned[path]) continue;
    let target: string;
    try {
      target = inside(root, path);
    } catch {
      continue;
    }
    if (symlinkOnTheWay(root, path) || !existsSync(target) || !lstatSync(target).isFile()) continue;
    if (sha256(readFileSync(target)) !== hash) continue;
    owned[path] = { ...(owned[path] as OwnedEntry), sha256: hash };
    adopted += 1;
  }
  if (adopted > 0) writeOwned(root, owned);
  return { adopted };
}

/** Every markdown file under the root, relative, skipping dot folders, dot files and symlinks. */
function markdownFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 10 || found.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel, depth + 1);
      else if (entry.isFile() && /\.md$/i.test(entry.name) && found.length < MAX_FILES) found.push(rel);
    }
  };
  walk(root, "", 0);
  return found;
}

function readOne(root: string, path: string, owned: Owned, format: "markdown" | "json"): ReadFile {
  const base: ReadFile = {
    path,
    format,
    data: null,
    body: "",
    owned: owned[path] !== undefined,
    unchanged: false,
    sha256: null,
    modifiedAt: null,
    error: null,
  };
  try {
    const target = inside(root, path);
    if (symlinkOnTheWay(root, path)) return { ...base, error: "A symlink. Not followed." };
    const stat = lstatSync(target);
    if (!stat.isFile()) return { ...base, error: "Not a regular file." };
    if (stat.size > MAX_FILE_BYTES) return { ...base, error: `Larger than ${MAX_FILE_BYTES} bytes. Not read.` };
    const bytes = readFileSync(target);
    const hash = sha256(bytes);
    const text = bytes.toString("utf8");
    const read: ReadFile = {
      ...base,
      sha256: hash,
      unchanged: owned[path]?.sha256 === hash,
      modifiedAt: stat.mtime.toISOString(),
    };
    if (format === "json") {
      const data = JSON.parse(text) as unknown;
      if (!data || typeof data !== "object" || Array.isArray(data)) return { ...read, error: "Not a JSON object." };
      return { ...read, data: data as Record<string, unknown> };
    }
    const parsed = parseMarkdown(text);
    return { ...read, data: parsed.data, body: parsed.body };
  } catch (error) {
    if (error instanceof MarkdownUnavailable) return { ...base, error: error.message };
    if (error instanceof FrontMatterError) return { ...base, error: `The front matter does not read: ${error.message}` };
    if (error instanceof SyntaxError) return { ...base, error: `Not JSON: ${error.message}` };
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

/** What a mirror folder holds: every markdown file under it, and the manifest. Reads only. */
export function readMirror(folder: unknown): ReadFile[] {
  const root = existingRoot(folder);
  const owned = readOwned(root, false);
  const files: ReadFile[] = [];
  const manifest = join(root, MIRROR_DIR, "library.json");
  if (existsSync(manifest)) files.push(readOne(root, MANIFEST_PATH, owned, "json"));
  for (const path of markdownFiles(root)) files.push(readOne(root, path, owned, "markdown"));
  return files;
}
