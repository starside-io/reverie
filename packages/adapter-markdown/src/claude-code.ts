import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MAX_FILE_BYTES, MAX_FILES, sha256, type ReadFile } from "./mirror-fs.js";
import { existingRoot } from "./paths.js";
import { FrontMatterError, parseMarkdown } from "./yaml.js";

/**
 * A Claude Code memory directory, read once and never written to
 * (docs/SPEC.md section 24, "Claude Code's own memory"). The directory holds
 * `MEMORY.md`, an index of one-line pointers, and one markdown file per
 * memory with front matter. Only the files directly in it are read, never a
 * subfolder, never through a symlink. Nothing here opens a file for writing.
 *
 * What each file means to the library (kind, scope, shelf) is core's to
 * decide; this hands over the front matter and the body as they are.
 */
export function readClaudeCodeDirectory(folder: unknown): ReadFile[] {
  const root = existingRoot(folder);
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /\.md$/i.test(entry.name) && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_FILES);

  return entries.map((name): ReadFile => {
    const base: ReadFile = {
      path: name,
      format: "markdown",
      data: null,
      body: "",
      owned: false,
      unchanged: false,
      sha256: null,
      modifiedAt: null,
      error: null,
    };
    try {
      const target = join(root, name);
      const stat = lstatSync(target);
      if (!stat.isFile()) return { ...base, error: "Not a regular file." };
      if (stat.size > MAX_FILE_BYTES) return { ...base, error: `Larger than ${MAX_FILE_BYTES} bytes. Not read.` };
      const bytes = readFileSync(target);
      const parsed = parseMarkdown(bytes.toString("utf8"));
      return { ...base, data: parsed.data, body: parsed.body, sha256: sha256(bytes), modifiedAt: stat.mtime.toISOString() };
    } catch (error) {
      if (error instanceof FrontMatterError) return { ...base, error: `The front matter does not read: ${error.message}` };
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
