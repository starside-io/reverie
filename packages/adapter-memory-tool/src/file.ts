/**
 * A memory as the memory tool sees it: one markdown file, front matter on
 * top, then `# title`, the body, and `## Why` and `## How to apply` when the
 * memory has them. memory.fs_view renders it; this reads it back, for a
 * `create` from scratch and to work out what a `str_replace` or `insert`
 * changed. Plain text in, plain values out: no file is ever opened.
 */

export type FrontValue = string | number | boolean | null | string[];

export interface ParsedFile {
  /** The front matter keys, as written. Empty when there is none. */
  front: Record<string, FrontValue>;
  /** The `# heading` under the front matter, when there is one. */
  heading: string | null;
  body: string;
  why: string | null;
  howToApply: string | null;
}

const WHY = "## Why";
const HOW = "## How to apply";

/** Line endings as LF, so a file from any platform reads the same. */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function frontValue(raw: string): FrontValue {
  const text = raw.trim();
  if (text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") return parsed;
    if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
  } catch {
    // Not JSON: a bare word, as a person would type it.
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    return text
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
      .filter((entry) => entry.length > 0);
  }
  return text.replace(/^["']|["']$/g, "");
}

/** The section after the last line that is exactly `heading`, and what came before it. */
function splitLast(lines: string[], heading: string): { before: string[]; after: string | null } {
  const at = lines.lastIndexOf(heading);
  if (at === -1) return { before: lines, after: null };
  const after = lines.slice(at + 1).join("\n").trim();
  return { before: lines.slice(0, at), after: after.length > 0 ? after : null };
}

export function parseMemoryFile(text: string): ParsedFile {
  let lines = normaliseNewlines(text).split("\n");
  const front: Record<string, FrontValue> = {};

  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (close > 0) {
      for (const line of lines.slice(1, close)) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        front[line.slice(0, colon).trim()] = frontValue(line.slice(colon + 1));
      }
      lines = lines.slice(close + 1);
    }
  }

  while (lines.length > 0 && (lines[0] as string).trim() === "") lines.shift();
  let heading: string | null = null;
  if (lines[0]?.startsWith("# ")) {
    heading = (lines[0] as string).slice(2).trim() || null;
    lines = lines.slice(1);
  }

  const how = splitLast(lines, HOW);
  const why = splitLast(how.before, WHY);
  return {
    front,
    heading,
    body: why.before.join("\n").trim(),
    why: why.after,
    howToApply: how.after,
  };
}

/** Starting value, as core's own: a title cut from the body when none is given. */
const DERIVED_TITLE_MAX = 80;

export function deriveTitle(body: string): string {
  const first = body.trim().split(/\n|(?<=[.!?])\s/)[0]?.trim() ?? "";
  const line = (first.length > 0 ? first : body.trim()).replace(/^#+\s*/, "").replace(/[.!?]+$/, "");
  if (line.length <= DERIVED_TITLE_MAX) return line;
  const cut = line.slice(0, DERIVED_TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > DERIVED_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/** The lines of a file as the tool counts them: a final newline ends the last line, it does not start another. */
export function linesOf(content: string): string[] {
  return normaliseNewlines(content).replace(/\n$/, "").split("\n");
}

/** Lines numbered the way the memory tool shows them: six wide, right aligned, a tab, the line. */
export function numberLines(lines: readonly string[], firstNumber = 1): string {
  return lines.map((line, index) => `${String(index + firstNumber).padStart(6)}\t${line}`).join("\n");
}

/** A size as `du -h` writes it: 512B, 1.5K, 1.2M. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The 1-based line numbers each occurrence of `needle` starts on. */
export function occurrenceLines(content: string, needle: string): number[] {
  const found: number[] = [];
  if (needle.length === 0) return found;
  let from = 0;
  for (;;) {
    const at = content.indexOf(needle, from);
    if (at === -1) return found;
    found.push(content.slice(0, at).split("\n").length);
    from = at + needle.length;
  }
}

/**
 * The fields of a memory an edit may change, and the front matter keys it
 * may not. `title` and `importance` are the only front matter a file edit
 * reaches; the call number, kind, trust, state, scope, tags and people are
 * changed by their own tools or by the owner, never by rewriting the file.
 */
export const EDITABLE_FRONT = ["title", "importance"] as const;

export interface EditPatch {
  title?: string;
  body?: string;
  why?: string | null;
  howToApply?: string | null;
  importance?: number;
}

export type EditOutcome = { ok: true; patch: EditPatch } | { ok: false; message: string };

function same(a: FrontValue | undefined, b: FrontValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** What an edit of a rendered memory changed, as an update patch. Only changed fields are in it. */
export function patchFor(original: string, edited: string): EditOutcome {
  const before = parseMemoryFile(original);
  const after = parseMemoryFile(edited);

  const keys = new Set([...Object.keys(before.front), ...Object.keys(after.front)]);
  const locked = [...keys].filter(
    (key) => !(EDITABLE_FRONT as readonly string[]).includes(key) && !same(before.front[key], after.front[key]),
  );
  if (locked.length > 0) {
    return {
      ok: false,
      message: `Only the title, the importance and the text of a memory change through its file. ${locked.join(", ")} ${locked.length === 1 ? "is" : "are"} kept by the library: the owner changes ${locked.length === 1 ? "it" : "them"} in Reverie.`,
    };
  }

  const patch: EditPatch = {};
  if (after.heading !== before.heading && after.heading) {
    patch.title = after.heading;
  } else if (!same(before.front["title"], after.front["title"])) {
    const title = after.front["title"];
    if (typeof title !== "string" || title.trim().length === 0) return { ok: false, message: "A memory keeps a title." };
    patch.title = title.trim();
  }
  if (!same(before.front["importance"], after.front["importance"])) {
    const importance = Number(after.front["importance"]);
    if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
      return { ok: false, message: "importance is a whole number from 1 to 5." };
    }
    patch.importance = importance;
  }
  if (after.body !== before.body) {
    if (after.body.length === 0) {
      return {
        ok: false,
        message: "A memory keeps a body. To take it out of the library, delete the file: it is retired, with its history kept.",
      };
    }
    patch.body = after.body;
  }
  if (after.why !== before.why) patch.why = after.why;
  if (after.howToApply !== before.howToApply) patch.howToApply = after.howToApply;
  return { ok: true, patch };
}
