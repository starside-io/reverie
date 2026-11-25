import { ToolError } from "../registry.js";

/**
 * Paths for memory.fs_view, the memory tool adapter's `view`. docs/SPEC.md
 * section 19, "The memory tool adapter": paths resolve against the virtual
 * root, and anything that escapes it is refused, traversal and encoded forms
 * included. The tool ships with no path protection, so this is all of it.
 *
 * The rules, strict on purpose:
 *
 * - The virtual root is `/memories`. A relative path is read from it.
 * - Percent-encoding is decoded before anything is checked, repeatedly, so a
 *   double encoded `%252e%252e` is seen as `..`. An encoded separator (`/` or
 *   `\`) is refused outright: no legitimate name needs one.
 * - Unicode is NFKC normalised first, so a full width dot is a dot.
 * - A backslash, a NUL or any control character is refused.
 * - Any `.` or `..` segment is refused, even one that would land back inside
 *   the root. Nothing here needs to walk up, so nothing may.
 * - Anything not under `/memories` is refused.
 */

export const VIRTUAL_ROOT = "/memories";
const ROOT_SEGMENT = "memories";
/** How many rounds of percent-decoding are tried before the path is refused as obfuscated. */
const MAX_DECODE_ROUNDS = 4;
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;
const ENCODED_SEPARATOR = /%(2f|5c)/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

export type PathRefusal = "encoded_separator" | "malformed_encoding" | "control_character" | "backslash" | "traversal" | "outside_root";

function refuse(reason: PathRefusal, message: string): never {
  throw new ToolError("refused", message, { reason });
}

/**
 * The segments under `/memories`, root excluded: `[]` for the root,
 * `["Life", "Gatherings", "2026-12-24-001.md"]` for one file.
 */
export function resolveVirtualPath(raw: string): string[] {
  let path = raw;
  for (let round = 0; PERCENT_ESCAPE.test(path); round += 1) {
    if (round >= MAX_DECODE_ROUNDS) refuse("malformed_encoding", "The path is encoded too many times over.");
    if (ENCODED_SEPARATOR.test(path)) refuse("encoded_separator", "An encoded path separator is refused.");
    try {
      path = decodeURIComponent(path);
    } catch {
      refuse("malformed_encoding", "The path has a malformed percent-encoding.");
    }
  }
  path = path.normalize("NFKC");
  if (CONTROL.test(path)) refuse("control_character", "The path holds a control character.");
  if (path.includes("\\")) refuse("backslash", "A backslash is not a path separator here.");

  const absolute = path.startsWith("/") ? path : `${VIRTUAL_ROOT}/${path}`;
  const segments = absolute.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    refuse("traversal", `Paths are resolved inside ${VIRTUAL_ROOT} and may not step through . or ..`);
  }
  if (segments[0] !== ROOT_SEGMENT) refuse("outside_root", `Only paths under ${VIRTUAL_ROOT} exist.`);
  return segments.slice(1);
}

/** A section or shelf name as a directory name: separators become hyphens. Falls back to the code. */
export function dirName(name: string, code: string): string {
  const cleaned = name.replace(/[/\\]/g, "-").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : code;
}

/** `2026-12-24-001.md` for a day and a sequence. */
export function fileName(day: string, seq: number): string {
  return `${day}-${String(seq).padStart(3, "0")}.md`;
}

const FILE_NAME = /^(\d{4}-\d{2}-\d{2})-(\d{3})\.md$/;

/** The day and sequence a file name stands for, or null. */
export function parseFileName(name: string): { day: string; seq: string } | null {
  const match = FILE_NAME.exec(name);
  return match ? { day: match[1] as string, seq: match[2] as string } : null;
}
