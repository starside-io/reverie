import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Where the mirror may read and write. A folder is named by the owner, as
 * an absolute path on this machine; every file under it is named by a path
 * relative to it, and nothing a document or a file says can reach outside
 * it.
 *
 * The rules, strict on purpose:
 *
 * - The folder is absolute and is resolved through any symlink once, up
 *   front. Below it, a symlink is never followed: not read, not written
 *   through, not deleted.
 * - A relative path uses forward slashes. A backslash, a NUL or any control
 *   character is refused, and so is an absolute path or a drive letter.
 * - No segment may be empty, `.` or `..`, before or after Unicode NFKC
 *   normalisation (a full width dot is a dot, a full width solidus a slash).
 * - The resolved path must still sit inside the folder.
 */

export type MarkdownErrorCode =
  | "bad_cursor"
  | "bad_payload"
  | "not_absolute"
  | "not_a_directory"
  | "owned_unreadable"
  | "unsafe_path";

/** A refusal the connector hands back through the port, with a code core can read. */
export class MarkdownUnavailable extends Error {
  readonly code: MarkdownErrorCode;
  constructor(code: MarkdownErrorCode, message: string) {
    super(message);
    this.name = "MarkdownUnavailable";
    this.code = code;
  }
}

/** The deepest a mirror path may go: section, shelf, file, and some room for a person's own folders. */
export const MAX_DEPTH = 12;
const MAX_SEGMENT_BYTES = 255;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The folder as given, made absolute and resolved, or a refusal. Does not create it. */
export function resolveRoot(folder: unknown): string {
  if (typeof folder !== "string" || folder.trim().length === 0) {
    throw new MarkdownUnavailable("not_absolute", "Name the folder as an absolute path.");
  }
  if (CONTROL.test(folder)) throw new MarkdownUnavailable("not_absolute", "The folder's path holds a control character.");
  if (!isAbsolute(folder)) throw new MarkdownUnavailable("not_absolute", "Name the folder as an absolute path.");
  return resolve(folder);
}

/** An existing folder, through any symlink in its own path. */
export function existingRoot(folder: unknown): string {
  const root = resolveRoot(folder);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new MarkdownUnavailable("not_a_directory", "The folder does not exist or is not a folder.");
  }
  return realpathSync(root);
}

/** The segments of a relative path, or a refusal naming why it may not be used. */
export function safeSegments(path: unknown): string[] {
  if (typeof path !== "string" || path.length === 0) throw new MarkdownUnavailable("unsafe_path", "A path is required.");
  if (path.length > 4096) throw new MarkdownUnavailable("unsafe_path", "The path is too long.");
  if (CONTROL.test(path)) throw new MarkdownUnavailable("unsafe_path", "The path holds a control character.");
  if (path.includes("\\")) throw new MarkdownUnavailable("unsafe_path", "A backslash is not a path separator here.");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw new MarkdownUnavailable("unsafe_path", "The path must be relative to the folder.");
  const segments = path.split("/");
  if (segments.length > MAX_DEPTH) throw new MarkdownUnavailable("unsafe_path", "The path is too deep.");
  for (const segment of segments) {
    const normal = segment.normalize("NFKC");
    if (segment.length === 0 || segment === "." || segment === ".." || normal === "." || normal === ".." || normal.includes("/") || normal.includes("\\")) {
      throw new MarkdownUnavailable("unsafe_path", "The path may not step through an empty, . or .. segment.");
    }
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) throw new MarkdownUnavailable("unsafe_path", "A name in the path is too long.");
  }
  return segments;
}

/** Where a relative path lands under the root, checked to stay inside it. */
export function inside(root: string, path: string): string {
  const segments = safeSegments(path);
  const target = join(root, ...segments);
  const back = relative(root, target);
  if (back.length === 0 || back.startsWith(`..${sep}`) || back === ".." || isAbsolute(back)) {
    throw new MarkdownUnavailable("unsafe_path", "The path leaves the folder.");
  }
  return target;
}

/** True when the path, or any folder between it and the root, is a symlink. */
export function symlinkOnTheWay(root: string, path: string): boolean {
  const segments = safeSegments(path);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}
