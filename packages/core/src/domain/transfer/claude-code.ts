import type { MemoryKind } from "../../schemas/enums.js";
import { BODY_MAX_LENGTH, TITLE_MAX_LENGTH } from "../../schemas/memory.js";
import type { MirrorReadFile } from "./mirror.js";

/**
 * Reading a Claude Code memory directory. docs/SPEC.md section 19 ("A
 * folder of markdown ... importable from a Claude Code memory directory")
 * and section 24 ("Claude Code's own memory": import once, read only).
 *
 * The directory holds `MEMORY.md`, an index of one-line pointers such as
 * `- [Title](file.md)` and a hook, and one markdown file per memory with
 * front matter, then the fact as body. Two front matter shapes exist:
 *
 *   name, description, metadata: { type }     the current form
 *   name, description, type                    the older flat form
 *
 * `type` is one of user, feedback, project, reference. Bodies may carry
 * `**Why:**` and `**How to apply:**` lines and `[[other-name]]` links.
 *
 * The mapping, a defensible starting value rather than a rule of the design:
 *
 * | type      | kind                                              | scope                                  |
 * | --------- | ------------------------------------------------- | -------------------------------------- |
 * | user      | fact                                              | global: it is about the owner          |
 * | feedback  | procedure with both Why and How to apply,         | the project, when one is named         |
 * |           | else preference                                   |                                        |
 * | project   | fact                                              | the project, when one is named         |
 * | reference | reference                                         | the project, when one is named         |
 *
 * A memory directory belongs to one folder, which is a project (section 4),
 * and Claude Code only loads it in that folder, so everything but `user` is
 * scoped to the project the owner names. A project is never guessed: with
 * none named, everything lands global. The shelf follows section 5: a
 * project scoped entry goes to its project's shelf, everything else waits on
 * Returns. A procedure needs why and how to apply (section 4), so feedback
 * without both is a preference, which is what it holds: how the owner likes
 * to be worked with.
 */

export type ClaudeCodeType = "user" | "feedback" | "project" | "reference";

export interface ClaudeCodeMemory {
  /** The file, relative to the directory. */
  file: string;
  /** The `name` slug, else the file name without .md. Its identity across re-imports. */
  name: string;
  type: ClaudeCodeType | null;
  kind: MemoryKind;
  /** Whether it is scoped to the project when one is named. False for `user`. */
  projectScoped: boolean;
  title: string;
  body: string;
  why: string | null;
  howToApply: string | null;
  /** The `[[other-name]]` names the body points at, each once. */
  links: string[];
  /** Taken from the file as written, for the source's quote. */
  quote: string;
  /** The file's modification day, when the connector knew it. */
  modifiedAt: string | null;
}

export interface ClaudeCodeProblem {
  file: string;
  message: string;
}

/** The file name the index lives in. Never imported as a memory. */
export const CLAUDE_CODE_INDEX = "MEMORY.md";

const TYPES: readonly ClaudeCodeType[] = ["user", "feedback", "project", "reference"];

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function humanise(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words.length > 0 ? words[0]!.toUpperCase() + words.slice(1) : name;
}

function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  const slice = value.slice(0, max);
  const space = slice.lastIndexOf(" ");
  return (space > max / 2 ? slice.slice(0, space) : slice).trimEnd();
}

/** `- [Title](file.md)` lines of the index: file to title. */
export function readClaudeCodeIndex(body: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = /^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)/.exec(line);
    if (!match) continue;
    const [, title, target] = match as unknown as [string, string, string];
    const file = target.replace(/^\.\//, "");
    if (!titles.has(file)) titles.set(file, title.trim());
  }
  return titles;
}

const MARKER = /^\s*(?:[-*]\s*)?\*\*\s*(why|how to apply)\s*:?\s*\*\*\s*:?\s*(.*)$/i;

/**
 * The body split into the fact and its `**Why:**` and `**How to apply:**`
 * parts. A part runs from its marker to the next marker or the next blank
 * line.
 */
export function splitWhyAndHow(body: string): { body: string; why: string | null; howToApply: string | null } {
  const kept: string[] = [];
  const parts: Record<"why" | "how", string[]> = { why: [], how: [] };
  let current: "why" | "how" | null = null;
  for (const line of body.split("\n")) {
    const marker = MARKER.exec(line);
    if (marker) {
      current = (marker[1] as string).toLowerCase() === "why" ? "why" : "how";
      const rest = (marker[2] as string).trim();
      if (rest.length > 0) parts[current].push(rest);
      continue;
    }
    if (current !== null) {
      if (line.trim().length === 0) {
        current = null;
        kept.push(line);
        continue;
      }
      parts[current].push(line.trim());
      continue;
    }
    kept.push(line);
  }
  const join = (lines: string[]) => (lines.length > 0 ? lines.join(" ").trim() : null);
  return {
    body: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    why: join(parts.why),
    howToApply: join(parts.how),
  };
}

/** `[[other-name]]` and `[[other-name|label]]` targets, each once, in order. */
export function wikiLinks(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const name = (match[1] as string).trim().replace(/\.md$/i, "");
    if (name.length > 0 && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * One memory file as Reverie reads it, or the reason it cannot be read. The
 * index is not a memory and is refused here too, whatever the connector did.
 */
export function readClaudeCodeMemory(
  file: MirrorReadFile,
  index: ReadonlyMap<string, string> = new Map(),
): { memory: ClaudeCodeMemory } | { problem: ClaudeCodeProblem } {
  const fail = (message: string) => ({ problem: { file: file.path, message } });
  if (file.path.toLowerCase() === CLAUDE_CODE_INDEX.toLowerCase()) return fail("The index is not a memory.");
  if (file.error) return fail(file.error);
  const data = file.data ?? {};
  const metadata = data["metadata"] && typeof data["metadata"] === "object" ? (data["metadata"] as Record<string, unknown>) : {};

  const rawType = text(metadata["type"]) ?? text(data["type"]);
  const type = rawType && (TYPES as readonly string[]).includes(rawType.toLowerCase()) ? (rawType.toLowerCase() as ClaudeCodeType) : null;
  if (rawType && !type) return fail(`type "${rawType}" is not one of ${TYPES.join(", ")}.`);

  const fileBase = file.path.replace(/\.md$/i, "");
  const name = text(data["name"]) ?? fileBase;
  const description = text(data["description"]) ?? text(metadata["description"]);

  const split = splitWhyAndHow(file.body.replace(/\r\n/g, "\n"));
  const body = split.body.length > 0 ? split.body : (description ?? "");
  if (body.length === 0) return fail("The file holds no fact: no body and no description.");
  if (body.length > BODY_MAX_LENGTH) return fail(`The body runs past ${BODY_MAX_LENGTH} characters.`);

  const kind: MemoryKind =
    type === "user" || type === "project" || type === null
      ? "fact"
      : type === "reference"
        ? "reference"
        : split.why && split.howToApply
          ? "procedure"
          : "preference";

  const title = cut(description ?? index.get(file.path) ?? humanise(name), TITLE_MAX_LENGTH);
  return {
    memory: {
      file: file.path,
      name,
      type,
      kind,
      projectScoped: type !== "user",
      title,
      body,
      why: split.why,
      howToApply: split.howToApply,
      links: wikiLinks(file.body),
      quote: description ?? body,
      modifiedAt: file.modifiedAt,
    },
  };
}
