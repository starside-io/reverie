// memory.fs_view. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.fs_view`; section 19, "The memory tool adapter" (the library as
// files under /memories, `view`, and path traversal) and "The markdown
// mirror" (one folder per section, one per shelf, one file per memory, so a
// listing is already in order).
//
// Layout:
//
//   /memories                              the sections, by name, in library order
//   /memories/Life                         its shelves, by name, in order
//   /memories/Life/Gatherings              its entries, 2026-12-24-001.md, by call number
//   /memories/Life/Gatherings/2026-12-24-001.md   one memory as markdown with front matter
//
// A directory may also be named by its code (/memories/LIF/GTH). A shelf
// lists its active and superseded entries; retired ones are in the stacks and
// are not files, which is what the adapter's `delete` (retire) relies on.

import { z } from "zod";

import type { Section, Shelf } from "../../../generated/prisma/index.js";
import { RECALL_NOTICE } from "../../domain/recall/frame.js";
import { dayKey } from "../../schemas/common.js";
import { defineTool, ToolError, type ToolContext } from "../registry.js";
import { dirName, fileName, parseFileName, resolveVirtualPath, VIRTUAL_ROOT } from "../shared/read-fs-path.js";
import { memoryView, type MemoryView } from "../shared/views.js";

export interface FsEntry {
  name: string;
  path: string;
  type: "directory" | "file";
}

export type FsViewResult =
  | {
      type: "directory";
      path: string;
      entries: FsEntry[];
      /** The listing as the memory tool shows it: one entry per line, directories ending in "/". */
      text: string;
    }
  | {
      type: "file";
      path: string;
      notice: typeof RECALL_NOTICE;
      memoryId: string;
      call: string;
      /** The memory as markdown with front matter. */
      content: string;
    };

const LISTED_STATES = ["active", "superseded"];

function yamlValue(value: string | number | boolean | null | readonly string[]): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => JSON.stringify(entry)).join(", ")}]`;
  return JSON.stringify(value);
}

/** One memory as a file: front matter, then the title, the body, and why and how to apply when present. */
export function renderMemoryFile(memory: MemoryView): string {
  const front: Array<[string, string | number | boolean | null | readonly string[]]> = [
    ["call", memory.call],
    ["title", memory.title],
    ["kind", memory.kind],
    ["state", memory.state],
    ["trust", memory.trust],
    ["scope", memory.scope],
    ["scopeRef", memory.scopeRef],
    ["occurredOn", memory.occurredOn],
    ["importance", memory.importance],
    ["pinned", memory.pinned],
    ["tags", memory.tags],
    ["attendees", memory.attendees.map((ref) => ref.label)],
    ["occasion", memory.occasion?.label ?? null],
    ["supersededBy", memory.supersededBy],
  ];
  const lines = ["---", ...front.map(([key, value]) => `${key}: ${yamlValue(value)}`), "---", "", `# ${memory.title}`, "", memory.body];
  if (memory.why) lines.push("", "## Why", "", memory.why);
  if (memory.howToApply) lines.push("", "## How to apply", "", memory.howToApply);
  return `${lines.join("\n")}\n`;
}

function listing(path: string, entries: FsEntry[]): FsViewResult {
  return {
    type: "directory",
    path,
    entries,
    text: entries.map((entry) => (entry.type === "directory" ? `${entry.name}/` : entry.name)).join("\n"),
  };
}

function notFound(path: string): never {
  throw new ToolError("not_found", `Nothing at ${path}.`);
}

/** A directory name to the section or shelf it names: by name first, then by code. */
function pick<T extends { name: string; code: string }>(rows: readonly T[], segment: string): T | undefined {
  return rows.find((row) => dirName(row.name, row.code) === segment) ?? rows.find((row) => row.code === segment);
}

async function sectionsInOrder(ctx: ToolContext): Promise<Array<Section & { shelves: Shelf[] }>> {
  return ctx.db.section.findMany({
    orderBy: [{ order: "asc" }, { code: "asc" }],
    include: { shelves: { orderBy: [{ order: "asc" }, { code: "asc" }] } },
  });
}

export const tool = defineTool({
  name: "memory.fs_view",
  title: "Library as files",
  kind: "read",
  summary:
    "The library as files under /memories, for the memory tool adapter: sections by name, a section's shelves, a shelf's entries as YYYY-MM-DD-NNN.md in order, or one memory as markdown with front matter. Paths outside /memories, traversal and encoded forms are refused.",
  input: z.object({ path: z.string().max(1024).default(VIRTUAL_ROOT) }),
  async handler(ctx, input): Promise<FsViewResult> {
    const segments = resolveVirtualPath(input.path);
    const sections = await sectionsInOrder(ctx);
    const here = [VIRTUAL_ROOT, ...segments].join("/");

    if (segments.length === 0) {
      return listing(
        VIRTUAL_ROOT,
        sections.map((section) => {
          const name = dirName(section.name, section.code);
          return { name, path: `${VIRTUAL_ROOT}/${name}`, type: "directory" as const };
        }),
      );
    }

    const section = pick(sections, segments[0] as string);
    if (!section) notFound(here);
    const sectionDir = `${VIRTUAL_ROOT}/${dirName(section.name, section.code)}`;
    if (segments.length === 1) {
      return listing(
        sectionDir,
        section.shelves.map((shelf) => {
          const name = dirName(shelf.name, shelf.code);
          return { name, path: `${sectionDir}/${name}`, type: "directory" as const };
        }),
      );
    }

    const shelf = pick(section.shelves, segments[1] as string);
    if (!shelf) notFound(here);
    const shelfDir = `${sectionDir}/${dirName(shelf.name, shelf.code)}`;
    if (segments.length === 2) {
      const rows = await ctx.db.memory.findMany({
        where: { shelfId: shelf.id, state: { in: LISTED_STATES } },
        orderBy: { callNumber: "asc" },
        select: { occurredOn: true, seq: true },
      });
      return listing(
        shelfDir,
        rows.map((row) => {
          const name = fileName(dayKey(row.occurredOn), row.seq);
          return { name, path: `${shelfDir}/${name}`, type: "file" as const };
        }),
      );
    }

    const parts = segments.length === 3 ? parseFileName(segments[2] as string) : null;
    if (!parts) notFound(here);
    const call = `${section.code}/${shelf.code}/${parts.day}/${parts.seq}`;
    const row = await ctx.db.memory.findUnique({ where: { callNumber: call }, select: { id: true, shelfId: true, state: true } });
    if (!row || row.shelfId !== shelf.id || !LISTED_STATES.includes(row.state)) notFound(here);
    const memory = await memoryView(ctx, row.id);
    return {
      type: "file",
      path: `${shelfDir}/${segments[2]}`,
      notice: RECALL_NOTICE,
      memoryId: memory.id,
      call: memory.call,
      content: renderMemoryFile(memory),
    };
  },
  auditIds: (_input, result) =>
    result && result.type === "file" ? { memoryIds: [result.memoryId], calls: [result.call] } : undefined,
});
