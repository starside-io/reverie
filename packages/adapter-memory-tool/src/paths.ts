/**
 * Every path the memory tool sends, resolved against the virtual root.
 * docs/SPEC.md section 19, "The memory tool adapter": anything that escapes
 * the root is refused, traversal and encoded forms included. The tool ships
 * with no path protection, so the handler owns it. memory.fs_view checks the
 * same rules again on its side; this is the adapter's own copy, because an
 * adapter imports the registry and nothing below it.
 *
 * There is no real directory behind /memories. The adapter never touches the
 * filesystem: a path is only ever a name for a section, a shelf or a call
 * number. The checks still matter, because a path that slipped through here
 * would reach a tool, a log line or the text handed back to the model.
 *
 * The rules, strict on purpose:
 *
 * - The virtual root is `/memories`. A relative path is read from it.
 * - Percent-encoding is decoded before anything is checked, repeatedly, so a
 *   double encoded `%252e%252e` is seen as `..`. An encoded separator (`/` or
 *   `\`) is refused outright: no name in the library needs one.
 * - Unicode is NFKC normalised, so a full width dot or a two dot leader is
 *   seen for the dots it stands for. Characters that only look like a
 *   separator (full width and small slashes, division slash, fraction slash,
 *   big solidus and the like) are refused, and so are invisible format
 *   characters such as a zero width space or a direction override.
 * - A backslash, a NUL or any other control character is refused.
 * - Any `.` or `..` segment is refused, even one that would land back inside
 *   the root. Nothing here needs to walk up, so nothing may.
 * - Anything not under `/memories` is refused.
 */

export const VIRTUAL_ROOT = "/memories";
const ROOT_SEGMENT = "memories";
const MAX_PATH_LENGTH = 1024;
const MAX_DECODE_ROUNDS = 4;
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;
const ENCODED_SEPARATOR = /%(2f|5c)/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Invisible format characters: zero width joiners and spaces, direction marks and overrides, the BOM. */
const FORMAT = /\p{Cf}/u;
/**
 * Characters that read as a slash or a backslash without being one, as they
 * stand after NFKC (which already folds the full width and small forms).
 */
const LOOKALIKE_SEPARATORS = /[⁄∕∖╱╲⧵⧸⧹〳〵・㇓㇔丶丿／＼﹨]/;

export type PathRefusal =
  | "empty"
  | "too_long"
  | "encoded_separator"
  | "malformed_encoding"
  | "control_character"
  | "format_character"
  | "lookalike_separator"
  | "backslash"
  | "traversal"
  | "outside_root";

export class PathRefused extends Error {
  readonly reason: PathRefusal;

  constructor(reason: PathRefusal, message: string) {
    super(message);
    this.name = "PathRefused";
    this.reason = reason;
  }
}

function refuse(reason: PathRefusal, message: string): never {
  throw new PathRefused(reason, message);
}

/** A resolved path: the segments under the root, and the path written out. */
export interface VirtualPath {
  /** `[]` for the root, `["Life", "Gatherings", "2026-12-24-001.md"]` for one file. */
  segments: string[];
  /** `/memories/Life/Gatherings/2026-12-24-001.md`. */
  path: string;
}

/** Resolves one path from the model, or throws PathRefused. */
export function resolvePath(raw: unknown): VirtualPath {
  if (typeof raw !== "string" || raw.trim().length === 0) refuse("empty", "A path is required.");
  if (raw.length > MAX_PATH_LENGTH) refuse("too_long", `A path is at most ${MAX_PATH_LENGTH} characters.`);

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

  // Checked before and after normalising: NFKC can produce a control
  // character or a backslash from something that was neither.
  for (const form of [path, path.normalize("NFKC")]) {
    if (CONTROL.test(form)) refuse("control_character", "The path holds a control character.");
    if (FORMAT.test(form)) refuse("format_character", "The path holds an invisible format character.");
    if (LOOKALIKE_SEPARATORS.test(form)) refuse("lookalike_separator", "The path holds a character that only looks like a separator.");
    if (form.includes("\\")) refuse("backslash", "A backslash is not a path separator here.");
  }
  path = path.normalize("NFKC");

  const absolute = path.startsWith("/") ? path : `${VIRTUAL_ROOT}/${path}`;
  const segments = absolute.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment.trim() === "." || segment.trim() === "..")) {
    refuse("traversal", `Paths are resolved inside ${VIRTUAL_ROOT} and may not step through . or ..`);
  }
  if (segments[0] !== ROOT_SEGMENT) refuse("outside_root", `Only paths under ${VIRTUAL_ROOT} exist.`);
  const under = segments.slice(1);
  return { segments: under, path: [VIRTUAL_ROOT, ...under].join("/") };
}

const FILE_NAME = /^(\d{4}-\d{2}-\d{2})-(\d{3})\.md$/;
const LEADING_DATE = /^(\d{4}-\d{2}-\d{2})(?:$|[^\d])/;

/** `2026-12-24-001.md` for a day and a sequence. */
export function fileName(day: string, seq: number | string): string {
  return `${day}-${String(seq).padStart(3, "0")}.md`;
}

/** The day and sequence a canonical file name stands for, or null. */
export function parseFileName(name: string): { day: string; seq: string } | null {
  const match = FILE_NAME.exec(name);
  return match ? { day: match[1] as string, seq: match[2] as string } : null;
}

/** The date a file name starts with, `2026-12-24` from `2026-12-24-dinner.md`, when it is a real day. */
export function leadingDate(name: string): string | null {
  const match = LEADING_DATE.exec(name);
  if (!match) return null;
  const day = match[1] as string;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

/** The file path of a call number, given the directory names of its section and shelf. */
export function callPath(sectionDir: string, shelfDir: string, call: string): string {
  const [, , day, seq] = call.split("/");
  return `${VIRTUAL_ROOT}/${sectionDir}/${shelfDir}/${fileName(day as string, seq as string)}`;
}
