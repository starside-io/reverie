// memory.browse. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.browse`; section 5, "Finding things" and "The call number" (prefix
// and wildcard queries); section 14, "browse versus recall" (never ranked, no
// floor, paged, retired only on request, an empty shelf is an empty page).

import { z } from "zod";

import type { Prisma } from "../../../generated/prisma/index.js";
import { resolveShelf } from "../../domain/catalogue/shelving.js";
import { RECALL_NOTICE } from "../../domain/recall/frame.js";
import { dateOnlySchema } from "../../schemas/common.js";
import type { MemoryState } from "../../schemas/enums.js";
import { shelfPathSchema } from "../../schemas/shelf.js";
import { defineTool } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import {
  callPrefixWhere,
  callQuerySchema,
  ENTRY_INCLUDE,
  limitSchema,
  tagFilterSchema,
  tagWhere,
  toEntry,
  type EntryView,
} from "../shared/read-entries.js";
import { findByCall } from "../shared/views.js";

/** Page size. Starting values. */
export const BROWSE_PAGE = 20;
export const BROWSE_PAGE_MAX = 100;
/** Entries either side of `around`. Starting values. */
export const BROWSE_SPAN = 5;
export const BROWSE_SPAN_MAX = 50;

export const browseInputSchema = z
  .object({
    /** One shelf, in order: "WRK/NST". */
    shelf: shelfPathSchema.optional(),
    /** A call number prefix or wildcard query: "LIF/GTH/2026-12", "*\/*\/2026-12-24". */
    prefix: callQuerySchema.optional(),
    /** When it happened, from this day, inclusive. */
    from: dateOnlySchema.optional(),
    /** When it happened, to this day, inclusive. */
    to: dateOnlySchema.optional(),
    /** Only entries carrying at least one of these tags. */
    tags: tagFilterSchema,
    /** No entry carrying any of these tags. */
    excludeTags: tagFilterSchema,
    /** What came just before and after this entry, on its shelf. */
    around: callSchema.optional(),
    span: z.number().int().min(1).max(BROWSE_SPAN_MAX).default(BROWSE_SPAN),
    order: z.enum(["asc", "desc"]).default("asc"),
    /** Retired entries are in the stacks: shown only when asked. */
    includeRetired: z.boolean().default(false),
    limit: limitSchema(BROWSE_PAGE, BROWSE_PAGE_MAX),
    /** The nextCursor of the previous page. */
    cursor: callSchema.optional(),
  })
  .refine((value) => !(value.around && value.cursor), {
    message: "around returns one window and takes no cursor",
    path: ["cursor"],
  });

export type BrowseInput = z.input<typeof browseInputSchema>;

export interface BrowseResult {
  notice: typeof RECALL_NOTICE;
  order: "asc" | "desc";
  items: EntryView[];
  /** Pass as cursor for the next page. Null on the last page, and always with around. */
  nextCursor: string | null;
  /** The call number around was asked for, as it is now. */
  anchor: string | null;
}

export const tool = defineTool({
  name: "memory.browse",
  title: "Browse the library",
  kind: "read",
  summary:
    "The library walk: by shelf, by call number prefix or wildcard, by date range, by tag, or around a call number, ascending or descending. Paged with a cursor. Never ranked, no floor: an empty shelf is an empty page. Retired entries only when asked.",
  input: browseInputSchema,
  async handler(ctx, input): Promise<BrowseResult> {
    const states: MemoryState[] = input.includeRetired ? ["active", "superseded", "retired"] : ["active", "superseded"];
    const and: Prisma.MemoryWhereInput[] = [{ state: { in: states } }, ...tagWhere(input.tags, input.excludeTags)];
    if (input.shelf) {
      // An unknown shelf is not_found; a known empty one is an empty page.
      const shelf = await resolveShelf(ctx.db, input.shelf);
      and.push({ shelfId: shelf.id });
    }
    if (input.prefix) and.push(callPrefixWhere(input.prefix));
    if (input.from) and.push({ occurredOn: { gte: input.from } });
    if (input.to) and.push({ occurredOn: { lte: input.to } });

    if (input.around) {
      const found = await findByCall(ctx, input.around);
      const anchor = await ctx.db.memory.findUniqueOrThrow({ where: { id: found.memoryId }, include: ENTRY_INCLUDE });
      const sameShelf: Prisma.MemoryWhereInput = { AND: [...and, { shelfId: anchor.shelfId }] };
      const [before, after] = await Promise.all([
        ctx.db.memory.findMany({
          where: { AND: [sameShelf, { callNumber: { lt: anchor.callNumber } }] },
          orderBy: { callNumber: "desc" },
          take: input.span,
          include: ENTRY_INCLUDE,
        }),
        ctx.db.memory.findMany({
          where: { AND: [sameShelf, { callNumber: { gt: anchor.callNumber } }] },
          orderBy: { callNumber: "asc" },
          take: input.span,
          include: ENTRY_INCLUDE,
        }),
      ]);
      const window = [...before.reverse(), anchor, ...after].map(toEntry);
      if (input.order === "desc") window.reverse();
      return { notice: RECALL_NOTICE, order: input.order, items: window, nextCursor: null, anchor: anchor.callNumber };
    }

    if (input.cursor) and.push({ callNumber: input.order === "asc" ? { gt: input.cursor } : { lt: input.cursor } });
    const rows = await ctx.db.memory.findMany({
      where: { AND: and },
      orderBy: { callNumber: input.order },
      take: input.limit + 1,
      include: ENTRY_INCLUDE,
    });
    const page = rows.slice(0, input.limit).map(toEntry);
    const nextCursor = rows.length > input.limit ? (page[page.length - 1]?.call ?? null) : null;
    return { notice: RECALL_NOTICE, order: input.order, items: page, nextCursor, anchor: null };
  },
  auditIds: (input, result) => ({
    ...(result ? { memoryIds: result.items.map((item) => item.id), calls: result.items.map((item) => item.call) } : {}),
    ...(!result && input.around ? { calls: [input.around] } : {}),
  }),
});
