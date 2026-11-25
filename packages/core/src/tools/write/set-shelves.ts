// memory.set_shelves. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.set_shelves`; section 5, "Sections and shelves" (yours to make,
// rename, reorder and merge; renaming changes the name, never the code) and
// "The call number" (it survives a move); section 18
// (`memory.memory.shelved`); gates "Call numbers are stable" and "No orphan
// on a shelf"; guardrail 9.

import { z } from "zod";

import {
  createSection,
  createShelf,
  deleteShelf,
  mergeSections,
  mergeShelves,
  renameSection,
  renameShelf,
  reorderSections,
  reorderShelves,
  resolveShelf,
} from "../../domain/catalogue/shelving.js";
import { atomic, type Tx } from "../../domain/db.js";
import { codeSchema } from "../../schemas/common.js";
import { shelfPathSchema } from "../../schemas/shelf.js";
import { defineTool } from "../registry.js";
import { mutation } from "../shared/write-common.js";

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const name = z.string().trim().min(1, "A name is required").max(NAME_MAX);
const description = z.string().trim().min(1, "A description is required").max(DESCRIPTION_MAX);
const order = z.number().int().min(0).optional();

export const setShelvesInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_section"), code: codeSchema, name, order }),
  z.object({ action: z.literal("rename_section"), code: codeSchema, name }),
  /** Every section code once, first to last. */
  z.object({ action: z.literal("reorder_sections"), codes: z.array(codeSchema).min(1).max(200) }),
  z.object({ action: z.literal("merge_sections"), from: codeSchema, into: codeSchema }),
  z.object({
    action: z.literal("create_shelf"),
    section: codeSchema,
    code: codeSchema,
    name,
    /** Written for the drafter: it decides where a new memory goes. */
    description,
    order,
  }),
  z.object({ action: z.literal("rename_shelf"), shelf: shelfPathSchema, name, description: description.optional() }),
  /** Every shelf code in the section once, first to last. */
  z.object({ action: z.literal("reorder_shelves"), section: codeSchema, codes: z.array(codeSchema).min(1).max(200) }),
  z.object({ action: z.literal("merge_shelves"), from: shelfPathSchema, into: shelfPathSchema }),
  z.object({ action: z.literal("delete_shelf"), shelf: shelfPathSchema }),
]);

export type SetShelvesInput = z.input<typeof setShelvesInputSchema>;

export interface ShelfSummary {
  /** "WRK/NST" */
  path: string;
  name: string;
  description: string;
  order: number;
}

export interface SectionSummary {
  code: string;
  name: string;
  order: number;
}

export interface Renumbered {
  memoryId: string;
  from: string;
  to: string;
}

export interface SetShelvesResult {
  action: SetShelvesInput["action"];
  section: SectionSummary | null;
  shelf: ShelfSummary | null;
  /** For a reorder: the new order. */
  sections: SectionSummary[];
  shelves: ShelfSummary[];
  /** For a merge: every entry whose number changed. Each old number is an alias now. */
  renumbered: Renumbered[];
  /** For a delete: the path that is gone. */
  deleted: string | null;
}

function emptyResult(action: SetShelvesInput["action"]): SetShelvesResult {
  return { action, section: null, shelf: null, sections: [], shelves: [], renumbered: [], deleted: null };
}

/** Numbers of the entries under a set of shelves, before a merge. */
async function numbersOn(tx: Tx, shelfIds: string[]): Promise<Map<string, string>> {
  const rows = await tx.memory.findMany({
    where: { shelfId: { in: shelfIds } },
    select: { id: true, callNumber: true },
  });
  return new Map(rows.map((row) => [row.id, row.callNumber]));
}

async function renumberedSince(tx: Tx, before: Map<string, string>): Promise<Renumbered[]> {
  const after = await tx.memory.findMany({
    where: { id: { in: [...before.keys()] } },
    select: { id: true, callNumber: true },
  });
  return after
    .filter((row) => before.get(row.id) !== row.callNumber)
    .map((row) => ({ memoryId: row.id, from: before.get(row.id) as string, to: row.callNumber }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

export const tool = defineTool({
  name: "memory.set_shelves",
  title: "Set shelves",
  kind: "write",
  summary:
    "Sections and shelves are the owner's: create, rename, reorder and merge them, and delete an empty shelf. Renaming changes the name and description, never the code. Merging reshelves every entry, keeps every old number as an alias so it still resolves, and repoints projects. Deleting a shelf with entries is refused: merge it or move them first. Returns, DSK/RET, is never merged away or deleted.",
  input: setShelvesInputSchema,
  async handler(ctx, input): Promise<SetShelvesResult> {
    const result = emptyResult(input.action);
    const sectionOf = (row: { code: string; name: string; order: number }): SectionSummary => ({
      code: row.code,
      name: row.name,
      order: row.order,
    });
    const shelfOf = (row: { code: string; name: string; description: string; order: number }, section: string) => ({
      path: `${section}/${row.code}`,
      name: row.name,
      description: row.description,
      order: row.order,
    });

    switch (input.action) {
      case "create_section": {
        const section = await createSection(ctx.db, {
          code: input.code,
          name: input.name,
          ...(input.order !== undefined ? { order: input.order } : {}),
        });
        return { ...result, section: sectionOf(section) };
      }
      case "rename_section":
        return { ...result, section: sectionOf(await renameSection(ctx.db, input.code, input.name)) };
      case "reorder_sections":
        return { ...result, sections: (await reorderSections(ctx.db, input.codes)).map(sectionOf) };
      case "create_shelf": {
        const shelf = await createShelf(ctx.db, {
          section: input.section,
          code: input.code,
          name: input.name,
          description: input.description,
          ...(input.order !== undefined ? { order: input.order } : {}),
        });
        return { ...result, shelf: shelfOf(shelf, shelf.section.code) };
      }
      case "rename_shelf": {
        const shelf = await renameShelf(ctx.db, input.shelf, {
          name: input.name,
          ...(input.description !== undefined ? { description: input.description } : {}),
        });
        return { ...result, shelf: shelfOf(shelf, shelf.section.code) };
      }
      case "reorder_shelves": {
        const shelves = await reorderShelves(ctx.db, input.section, input.codes);
        return { ...result, shelves: shelves.map((shelf) => shelfOf(shelf, input.section)) };
      }
      case "merge_shelves": {
        const renumbered = await atomic(ctx.db, async (tx) => {
          const from = await resolveShelf(tx, input.from);
          const before = await numbersOn(tx, [from.id]);
          await mergeShelves(tx, input.from, input.into, mutation(ctx));
          return renumberedSince(tx, before);
        });
        for (const move of renumbered) ctx.emit("memory.memory.shelved", { ...move, via: "merge" });
        const into = await resolveShelf(ctx.db, input.into);
        return { ...result, shelf: shelfOf(into, into.section.code), renumbered, deleted: input.from };
      }
      case "merge_sections": {
        const renumbered = await atomic(ctx.db, async (tx) => {
          const shelves = await tx.shelf.findMany({ where: { section: { code: input.from } }, select: { id: true } });
          const before = await numbersOn(tx, shelves.map((shelf) => shelf.id));
          await mergeSections(tx, input.from, input.into, mutation(ctx));
          return renumberedSince(tx, before);
        });
        for (const move of renumbered) ctx.emit("memory.memory.shelved", { ...move, via: "merge" });
        const into = await ctx.db.section.findUniqueOrThrow({ where: { code: input.into } });
        return { ...result, section: sectionOf(into), renumbered, deleted: input.from };
      }
      case "delete_shelf":
        await deleteShelf(ctx.db, input.shelf);
        return { ...result, deleted: input.shelf };
    }
  },
  auditIds: (_input, result) =>
    result && result.renumbered.length > 0
      ? {
          memoryIds: result.renumbered.map((move) => move.memoryId),
          calls: result.renumbered.flatMap((move) => [move.from, move.to]),
        }
      : undefined,
});
