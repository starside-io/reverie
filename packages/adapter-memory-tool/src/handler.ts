import type { InvokeOptions } from "@reverie/core";

import {
  byteLength,
  deriveTitle,
  humanSize,
  linesOf,
  normaliseNewlines,
  numberLines,
  occurrenceLines,
  parseMemoryFile,
  patchFor,
  type EditPatch,
} from "./file.js";
import { leadingDate, parseFileName, PathRefused, resolvePath, VIRTUAL_ROOT, type VirtualPath } from "./paths.js";

/**
 * The memory tool adapter. docs/SPEC.md section 19, "The memory tool
 * adapter": Anthropic's client-side memory tool (`memory_20250818`) thinks
 * in files under /memories, and the library already is one. Every command
 * becomes one registry tool:
 *
 *   view                 memory.fs_view: sections, a shelf in order, or one memory as a file
 *   create               memory.propose_draft (queued for the owner's review), or
 *                        memory.remember when the embedding app marks the turn as the owner's
 *   str_replace, insert  memory.update: a new version, never an in-place edit
 *   rename               memory.shelve: a new call number, the old one kept as an alias
 *   delete               memory.retire: to the stacks with its history. A model
 *                        can never forget through this adapter.
 *
 * Plain data in, data out: the embedding app hands over one tool_use input
 * and gets back the tool_result content and whether it is an error. The
 * adapter holds no SDK, opens no file and makes no network call. It reaches
 * the library only through `invoke`, the module's registry.
 */

/** The `tools` entry for a Messages API request. The name must be `memory`. */
export const MEMORY_TOOL = { type: "memory_20250818", name: "memory" } as const;

/** What the adapter needs from the module: the registry's invoke, as ModuleApi has it. */
export interface MemoryToolApi {
  invoke(name: string, input: unknown, options?: InvokeOptions): Promise<unknown>;
}

export interface MemoryToolCallOptions {
  /**
   * True only when the embedding app knows this turn is the owner's own
   * request, for example the owner typed "remember this" in its UI. Then
   * `create` writes at once through memory.remember. Otherwise, the default,
   * a `create` is queued for review and nothing is written until the owner
   * confirms it. Never set it from anything the model said.
   */
  owner?: boolean;
  /** Where the caller is working, for project scoped reads and writes. */
  session?: InvokeOptions["session"];
  /** Pinned by tests. */
  now?: Date;
  /** Who the version history names for an edit. Defaults to "memory_tool", or "user" on an owner turn. */
  actor?: string;
}

export interface MemoryToolResult {
  /** The tool_result content: the text the model reads. */
  content: string;
  /** Set the tool_result's is_error to this. */
  isError: boolean;
  /** An unexpected failure, for the embedding app's own log. Its text is never shown to the model. */
  error?: unknown;
}

export type MemoryToolHandler = (input: unknown, options?: MemoryToolCallOptions) => Promise<MemoryToolResult>;

/** The tool_result block for one result, as the Messages API takes it. */
export function toolResultBlock(toolUseId: string, result: MemoryToolResult): {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
} {
  return { type: "tool_result", tool_use_id: toolUseId, content: result.content, is_error: result.isError };
}

/* ------------------------------------------------------------ registry I/O */

interface FsDirectory {
  type: "directory";
  path: string;
  entries: Array<{ name: string; path: string; type: "directory" | "file" }>;
}

interface FsFile {
  type: "file";
  path: string;
  notice: string;
  memoryId: string;
  call: string;
  content: string;
}

type FsView = FsDirectory | FsFile;

interface ShelfRow {
  code: string;
  path: string;
  name: string;
}

interface SectionRow {
  code: string;
  name: string;
  shelves: ShelfRow[];
}

interface MemoryRef {
  call: string;
}

/** A refusal the registry raised. Recognised by shape, so nothing below the registry is imported. */
interface ToolFailure {
  code: string;
  message: string;
}

function toolFailure(error: unknown): ToolFailure | null {
  if (error && typeof error === "object" && (error as { name?: unknown }).name === "ToolError") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code === "string" && typeof message === "string") return { code, message };
  }
  return null;
}

/** A failure that ends the command with this text for the model. */
class Answer extends Error {
  constructor(readonly content: string) {
    super(content);
    this.name = "Answer";
  }
}

function fail(content: string): never {
  throw new Answer(content);
}

/** As memory.fs_view names a directory: separators become hyphens, an empty name falls back to the code. */
function dirName(name: string, code: string): string {
  const cleaned = name.replace(/[/\\]/g, "-").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : code;
}

const KINDS = ["fact", "preference", "procedure", "episode", "reference"] as const;
type Kind = (typeof KINDS)[number];

const SIZE_OF_DIRECTORY = "4.0K";

const LIBRARY_NOTE = [
  "",
  "This is a library. Each folder under /memories is a section, each folder in it a shelf, and each file one memory, named for the day it happened and its order that day (2026-12-24-001.md). The library picks that name: a file you create is filed under the next free number on the shelf its folder names, and anywhere else it waits on the Returns shelf.",
].join("\n");

const REVIEW_NOTE =
  "Reverie keeps what an assistant writes in a review queue until its owner confirms it, so this file does not exist yet and a view will not show it. Do not create it again.";

/* ----------------------------------------------------------------- handler */

export function createMemoryToolHandler(api: MemoryToolApi, defaults: MemoryToolCallOptions = {}): MemoryToolHandler {
  return async (input, callOptions = {}) => {
    const options = { ...defaults, ...callOptions };
    const run = new Command(api, options);
    try {
      return { content: await run.dispatch(input), isError: false };
    } catch (error) {
      if (error instanceof Answer) return { content: error.content, isError: true };
      if (error instanceof PathRefused) return { content: `Error: The path is refused. ${error.message}`, isError: true };
      const failure = toolFailure(error);
      if (failure) return { content: `Error: ${failure.message}`, isError: true };
      return { content: "Error: Reverie could not run that command.", isError: true, error };
    }
  };
}

class Command {
  private library: SectionRow[] | null = null;

  constructor(
    private readonly api: MemoryToolApi,
    private readonly options: MemoryToolCallOptions,
  ) {}

  private invokeOptions(): InvokeOptions {
    return {
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.session ? { session: this.options.session } : {}),
      actor: this.options.actor ?? (this.options.owner ? "user" : "memory_tool"),
    };
  }

  private invoke(name: string, input: unknown): Promise<unknown> {
    return this.api.invoke(name, input, this.invokeOptions());
  }

  private today(): string {
    return (this.options.now ?? new Date()).toISOString().slice(0, 10);
  }

  async dispatch(input: unknown): Promise<string> {
    const command = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    switch (command["command"]) {
      case "view":
        return this.view(command["path"], command["view_range"]);
      case "create":
        return this.create(command["path"], command["file_text"]);
      case "str_replace":
        return this.strReplace(command["path"], command["old_str"], command["new_str"]);
      case "insert":
        return this.insert(command["path"], command["insert_line"], command["insert_text"]);
      case "delete":
        return this.remove(command["path"]);
      case "rename":
        return this.rename(command["old_path"], command["new_path"]);
      default:
        return fail(`Error: unknown command ${typeof command["command"] === "string" ? command["command"] : String(command["command"])}`);
    }
  }

  /* ------------------------------------------------------------- lookups */

  private async sections(): Promise<SectionRow[]> {
    this.library ??= ((await this.invoke("memory.shelves", {})) as { sections: SectionRow[] }).sections;
    return this.library;
  }

  /** The shelf a section and shelf directory name, by name first, then by code. */
  private async shelfAt(sectionSegment: string, shelfSegment: string): Promise<{ section: SectionRow; shelf: ShelfRow } | null> {
    const sections = await this.sections();
    const pick = <T extends { name: string; code: string }>(rows: readonly T[], segment: string) =>
      rows.find((row) => dirName(row.name, row.code) === segment) ?? rows.find((row) => row.code === segment);
    const section = pick(sections, sectionSegment);
    const shelf = section ? pick(section.shelves, shelfSegment) : undefined;
    return section && shelf ? { section, shelf } : null;
  }

  /** The file a call number is, under the names the library has now. */
  private async pathOfCall(call: string): Promise<string> {
    const [sectionCode, shelfCode, day, seq] = call.split("/");
    const sections = await this.sections();
    const section = sections.find((row) => row.code === sectionCode);
    const shelf = section?.shelves.find((row) => row.code === shelfCode);
    const sectionDir = section ? dirName(section.name, section.code) : (sectionCode as string);
    const shelfDir = shelf ? dirName(shelf.name, shelf.code) : (shelfCode as string);
    return `${VIRTUAL_ROOT}/${sectionDir}/${shelfDir}/${day}-${seq}.md`;
  }

  /** fs_view, with "nothing there" as null. */
  private async fsView(path: string): Promise<FsView | null> {
    try {
      return (await this.invoke("memory.fs_view", { path })) as FsView;
    } catch (error) {
      if (toolFailure(error)?.code === "not_found") return null;
      throw error;
    }
  }

  /** One memory as a file, or the answer the command gives when the path is not one. */
  private async fileAt(resolved: VirtualPath, missing: string): Promise<FsFile> {
    const found = resolved.segments.length === 3 ? await this.fsView(resolved.path) : null;
    if (!found || found.type !== "file") fail(missing);
    return found;
  }

  /* ---------------------------------------------------------------- view */

  private async view(rawPath: unknown, rawRange: unknown): Promise<string> {
    const resolved = resolvePath(rawPath ?? VIRTUAL_ROOT);
    const missing = `The path ${resolved.path} does not exist. Please provide a valid path.`;

    if (resolved.segments.length === 0) {
      const lines = [`${SIZE_OF_DIRECTORY}\t${VIRTUAL_ROOT}`];
      for (const section of await this.sections()) {
        const sectionDir = `${VIRTUAL_ROOT}/${dirName(section.name, section.code)}`;
        lines.push(`${SIZE_OF_DIRECTORY}\t${sectionDir}`);
        for (const shelf of section.shelves) lines.push(`${SIZE_OF_DIRECTORY}\t${sectionDir}/${dirName(shelf.name, shelf.code)}`);
      }
      return `${listingHeader(VIRTUAL_ROOT)}\n${lines.join("\n")}\n${LIBRARY_NOTE}`;
    }

    const found = await this.fsView(resolved.path);
    if (!found) fail(missing);

    if (found.type === "file") {
      const lines = linesOf(found.content);
      let first = 1;
      let shown = lines;
      if (rawRange !== undefined && rawRange !== null) {
        const range = Array.isArray(rawRange) ? rawRange : [];
        const [start, end] = range as unknown[];
        const valid =
          range.length === 2 &&
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          (start as number) >= 1 &&
          (start as number) <= lines.length &&
          ((end as number) === -1 || ((end as number) >= (start as number) && (end as number) <= lines.length));
        if (!valid) {
          fail(
            `Error: Invalid \`view_range\` parameter: ${JSON.stringify(rawRange)}. It should be [start_line, end_line] within the range of lines of the file: [1, ${lines.length}], or [start_line, -1].`,
          );
        }
        first = start as number;
        shown = lines.slice(first - 1, (end as number) === -1 ? undefined : (end as number));
      }
      return `${found.notice}\n\nHere's the content of ${found.path} with line numbers:\n${numberLines(shown, first)}`;
    }

    // A directory: itself, and two levels under it. A section lists its
    // shelves and their files; a shelf lists its files, in call number order.
    const lines = [`${SIZE_OF_DIRECTORY}\t${found.path}`];
    for (const entry of found.entries) {
      if (entry.type === "file") {
        lines.push(`${await this.sizeOf(entry.path)}\t${entry.path}`);
        continue;
      }
      lines.push(`${SIZE_OF_DIRECTORY}\t${entry.path}`);
      const inner = await this.fsView(entry.path);
      if (inner?.type !== "directory") continue;
      for (const child of inner.entries) {
        lines.push(`${child.type === "file" ? await this.sizeOf(child.path) : SIZE_OF_DIRECTORY}\t${child.path}`);
      }
    }
    return `${listingHeader(found.path)}\n${lines.join("\n")}`;
  }

  private async sizeOf(path: string): Promise<string> {
    const file = await this.fsView(path);
    return file?.type === "file" ? humanSize(byteLength(file.content)) : SIZE_OF_DIRECTORY;
  }

  /* -------------------------------------------------------------- create */

  private async create(rawPath: unknown, rawText: unknown): Promise<string> {
    const resolved = resolvePath(rawPath);
    if (typeof rawText !== "string") fail("Error: create needs file_text.");
    if (resolved.segments.length === 0) fail(`Error: File ${VIRTUAL_ROOT} already exists`);

    // The folder names the shelf only as section/shelf/file. Anything else,
    // a file at the root or in a folder that is not a shelf, waits on Returns.
    const name = resolved.segments[resolved.segments.length - 1] as string;
    const target =
      resolved.segments.length === 3
        ? await this.shelfAt(resolved.segments[0] as string, resolved.segments[1] as string)
        : null;
    if (target && parseFileName(name) && (await this.fsView(resolved.path))?.type === "file") {
      fail(`Error: File ${resolved.path} already exists`);
    }
    if (resolved.segments.length <= 2 && (await this.fsView(resolved.path))?.type === "directory") {
      fail(`Error: File ${resolved.path} already exists`);
    }

    const text = normaliseNewlines(rawText);
    const parsed = parseMemoryFile(text);
    if (parsed.body.length === 0) fail("Error: The file has no text to keep.");

    const kindValue = parsed.front["kind"] ?? "fact";
    if (typeof kindValue !== "string" || !(KINDS as readonly string[]).includes(kindValue)) {
      fail(`Error: kind is one of ${KINDS.join(", ")}.`);
    }
    const kind = kindValue as Kind;
    const frontTitle = typeof parsed.front["title"] === "string" ? (parsed.front["title"] as string).trim() : "";
    const title = parsed.heading ?? (frontTitle.length > 0 ? frontTitle : deriveTitle(parsed.body));
    const frontDate = typeof parsed.front["occurredOn"] === "string" ? leadingDate(parsed.front["occurredOn"] as string) : null;
    const occurredOn = frontDate ?? leadingDate(name) ?? this.today();
    const tagsValue = parsed.front["tags"];
    const tags = Array.isArray(tagsValue) ? tagsValue : [];
    const importanceValue = Number(parsed.front["importance"] ?? 3);
    const importance = Number.isInteger(importanceValue) && importanceValue >= 1 && importanceValue <= 5 ? importanceValue : 3;
    const shelf = target ? target.shelf.path : null;

    if (this.options.owner) {
      const result = (await this.invoke("memory.remember", {
        body: parsed.body,
        title,
        kind,
        ...(shelf ? { shelf } : {}),
        occurredOn,
        tags,
        importance,
        ...(parsed.why ? { why: parsed.why } : {}),
        ...(parsed.howToApply ? { howToApply: parsed.howToApply } : {}),
      })) as { memory: MemoryRef; notice: string | null };
      const actual = await this.pathOfCall(result.memory.call);
      const lines = [`File created successfully at: ${actual}`];
      if (actual !== resolved.path) {
        lines.push(`The library filed it as ${result.memory.call}, so the file is ${actual}, not ${resolved.path}.`);
      }
      if (result.notice) lines.push(result.notice);
      return lines.join("\n");
    }

    // An assistant's turn: a draft for the owner. The file's own text is the
    // material, an assistant turn, so the draft carries inferred trust and
    // every gate propose_draft runs applies to it.
    const quote = parsed.body.slice(0, 500).trim();
    const result = (await this.invoke("memory.propose_draft", {
      target: {
        job: "extract",
        material: { kind: "turns", turns: [{ role: "assistant", text }] },
        sessionDate: this.today(),
      },
      draft: {
        candidates: [
          {
            kind,
            title,
            body: parsed.body,
            shelf,
            occurredOn,
            tags,
            why: parsed.why,
            howToApply: parsed.howToApply,
            importance,
            quote,
          },
        ],
      },
    })) as {
      queued: Array<{ id: string; tool: string }>;
      rejected: Array<{ reason: string }>;
    };

    const queued = result.queued[0];
    if (!queued) {
      fail(`Error: Not created. ${result.rejected.map((entry) => entry.reason).join(" ") || "The draft was refused."}`);
    }
    const lines = [`Queued for review, not written: ${resolved.path}. ${REVIEW_NOTE}`];
    if (queued.tool === "memory.promote_procedure") {
      lines.push("It is a procedure, which changes how every later session behaves, so it waits for the owner's yes like everything else.");
    }
    lines.push(`Where it lands: ${shelf ? `the shelf ${shelf}` : "the Returns shelf, to be shelved by the owner"}. Proposal ${queued.id}.`);
    return lines.join("\n");
  }

  /* --------------------------------------------------- str_replace, insert */

  private async strReplace(rawPath: unknown, rawOld: unknown, rawNew: unknown): Promise<string> {
    const resolved = resolvePath(rawPath);
    const file = await this.fileAt(resolved, `Error: The path ${resolved.path} does not exist. Please provide a valid path.`);
    if (typeof rawOld !== "string" || rawOld.length === 0) fail("Error: str_replace needs old_str.");
    const newStr = typeof rawNew === "string" ? rawNew : "";
    const content = file.content;
    const at = occurrenceLines(content, rawOld);
    if (at.length === 0) {
      fail(`No replacement was performed, old_str \`${rawOld}\` did not appear verbatim in ${resolved.path}.`);
    }
    if (at.length > 1) {
      fail(
        `No replacement was performed. Multiple occurrences of old_str \`${rawOld}\` in lines: ${at.join(", ")}. Please ensure it is unique`,
      );
    }
    const edited = content.replace(rawOld, () => newStr);
    const outcome = await this.applyEdit(file, edited);
    return [
      "The memory file has been edited.",
      await this.snippet(outcome.path, at[0] as number, newStr),
      outcome.note,
    ].join("\n");
  }

  private async insert(rawPath: unknown, rawLine: unknown, rawText: unknown): Promise<string> {
    const resolved = resolvePath(rawPath);
    const file = await this.fileAt(resolved, `Error: The path ${resolved.path} does not exist`);
    if (typeof rawText !== "string") fail("Error: insert needs insert_text.");
    const lines = linesOf(file.content);
    if (!Number.isInteger(rawLine) || (rawLine as number) < 0 || (rawLine as number) > lines.length) {
      fail(
        `Error: Invalid \`insert_line\` parameter: ${String(rawLine)}. It should be within the range of lines of the file: [0, ${lines.length}]`,
      );
    }
    const next = [...lines];
    next.splice(rawLine as number, 0, normaliseNewlines(rawText).replace(/\n$/, ""));
    const outcome = await this.applyEdit(file, `${next.join("\n")}\n`);
    return [`The file ${outcome.path} has been edited.`, outcome.note].join("\n");
  }

  /** The edit as a new version through memory.update. Nothing is ever edited in place. */
  private async applyEdit(file: FsFile, edited: string): Promise<{ path: string; note: string }> {
    const outcome = patchFor(file.content, edited);
    if (!outcome.ok) fail(`Error: Not edited. ${outcome.message}`);
    const patch: EditPatch = outcome.patch;
    if (Object.keys(patch).length === 0) {
      return { path: file.path, note: `Nothing in ${file.call} changed, so no version was written.` };
    }
    const result = (await this.invoke("memory.update", { call: file.call, ...patch })) as {
      memory: MemoryRef;
      changed: boolean;
    };
    return {
      path: file.path,
      note: result.changed
        ? `Saved as a new version of ${result.memory.call}. The earlier wording stays readable in its history.`
        : `Nothing in ${result.memory.call} changed, so no version was written.`,
    };
  }

  /** A few lines around an edit, numbered, from the file as it stands now. */
  private async snippet(path: string, line: number, inserted: string): Promise<string> {
    const now = await this.fsView(path);
    if (now?.type !== "file") return "";
    const lines = linesOf(now.content);
    const span = 4;
    const from = Math.max(1, line - span);
    const to = Math.min(lines.length, line + inserted.split("\n").length - 1 + span);
    return `Here's a snippet of ${path} with line numbers:\n${numberLines(lines.slice(from - 1, to), from)}`;
  }

  /* -------------------------------------------------------------- delete */

  private async remove(rawPath: unknown): Promise<string> {
    const resolved = resolvePath(rawPath);
    if (resolved.segments.length === 0) fail(`Error: The ${VIRTUAL_ROOT} directory itself cannot be deleted`);
    const found = await this.fsView(resolved.path);
    if (!found) fail(`Error: The path ${resolved.path} does not exist`);
    if (found.type === "directory") {
      fail(
        `Error: ${resolved.path} is a ${resolved.segments.length === 1 ? "section" : "shelf"} of the library. Delete removes one memory at a time; sections and shelves are the owner's to change.`,
      );
    }
    await this.invoke("memory.retire", { call: found.call });
    return [
      `Successfully deleted ${resolved.path}`,
      `${found.call} is retired to the stacks, not forgotten: it is out of recall and out of /memories, and its history is kept. Only the owner can forget a memory.`,
    ].join("\n");
  }

  /* -------------------------------------------------------------- rename */

  private async rename(rawOld: unknown, rawNew: unknown): Promise<string> {
    const from = resolvePath(rawOld);
    const to = resolvePath(rawNew);
    if (from.segments.length === 0) fail(`Error: The ${VIRTUAL_ROOT} directory itself cannot be renamed`);
    const found = await this.fsView(from.path);
    if (!found) fail(`Error: The path ${from.path} does not exist`);
    if (found.type === "directory") {
      fail(`Error: ${from.path} is a ${from.segments.length === 1 ? "section" : "shelf"} of the library. Rename moves one memory at a time; the owner renames sections and shelves.`);
    }
    if (to.segments.length !== 3) {
      fail(`Error: A memory moves onto a shelf: give the new path as ${VIRTUAL_ROOT}/<section>/<shelf>/<file>.`);
    }
    const target = await this.shelfAt(to.segments[0] as string, to.segments[1] as string);
    if (!target) {
      fail(`Error: There is no shelf at ${VIRTUAL_ROOT}/${to.segments[0]}/${to.segments[1]}. A memory moves only onto a shelf that exists; the owner makes new ones.`);
    }
    const name = to.segments[2] as string;
    if (parseFileName(name) && (await this.fsView(to.path))?.type === "file") {
      fail(`Error: The destination ${to.path} already exists`);
    }

    const [sectionCode, shelfCode, day] = found.call.split("/");
    const sameShelf = target.shelf.path === `${sectionCode}/${shelfCode}`;
    const newDay = leadingDate(name);
    const dayChanges = newDay !== null && newDay !== day;
    if (sameShelf && !dayChanges) {
      fail(
        `Error: ${to.path} is on the same shelf and day as ${from.path}. The library numbers the entries of a day itself; the owner reorders them.`,
      );
    }

    const moved = (await this.invoke("memory.shelve", {
      action: "move",
      call: found.call,
      ...(sameShelf ? {} : { shelf: target.shelf.path }),
      ...(dayChanges ? { occurredOn: newDay } : {}),
    })) as { from: string; to: string };
    const actual = await this.pathOfCall(moved.to);
    const lines = [`Successfully renamed ${from.path} to ${actual}`];
    if (actual !== to.path) lines.push(`The library numbered it ${moved.to}, so the file is ${actual}, not ${to.path}.`);
    lines.push(`Its old number, ${moved.from}, still resolves to it.`);
    return lines.join("\n");
  }
}

function listingHeader(path: string): string {
  return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:`;
}
