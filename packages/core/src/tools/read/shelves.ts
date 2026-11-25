// memory.shelves. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.shelves` (a starting reading); section 5, "Sections and shelves".

import { z } from "zod";

import { shelfCounts } from "../../domain/queries/counts.js";
import { defineTool } from "../registry.js";

export interface ShelfEntry {
  code: string;
  /** "WRK/NST" */
  path: string;
  name: string;
  /** Written for the drafter: what belongs here. */
  description: string;
  order: number;
  /** Active entries. */
  count: number;
  /** Every entry on the shelf, active, superseded and retired. */
  total: number;
}

export interface SectionEntry {
  code: string;
  name: string;
  order: number;
  count: number;
  total: number;
  shelves: ShelfEntry[];
}

export interface ShelvesResult {
  sections: SectionEntry[];
}

export const tool = defineTool({
  name: "memory.shelves",
  title: "Sections and shelves",
  kind: "read",
  summary:
    "Sections and shelves in library order, with codes, names, descriptions and counts: active entries, and every entry on the shelf.",
  input: z.object({}),
  async handler(ctx): Promise<ShelvesResult> {
    const [sections, counts] = await Promise.all([
      ctx.db.section.findMany({
        orderBy: [{ order: "asc" }, { code: "asc" }],
        include: { shelves: { orderBy: [{ order: "asc" }, { code: "asc" }] } },
      }),
      shelfCounts(ctx.db),
    ]);
    return {
      sections: sections.map((section) => {
        const shelves = section.shelves.map((shelf) => {
          const tally = counts.get(shelf.id) ?? { count: 0, total: 0 };
          return {
            code: shelf.code,
            path: `${section.code}/${shelf.code}`,
            name: shelf.name,
            description: shelf.description,
            order: shelf.order,
            count: tally.count,
            total: tally.total,
          };
        });
        return {
          code: section.code,
          name: section.name,
          order: section.order,
          count: shelves.reduce((sum, shelf) => sum + shelf.count, 0),
          total: shelves.reduce((sum, shelf) => sum + shelf.total, 0),
          shelves,
        };
      }),
    };
  },
});
