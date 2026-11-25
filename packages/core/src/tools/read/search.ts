// memory.search. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.search` (a starting reading); sections 10 and 11 (memory_fts).
//
// Plain text search: every word required, the last one as a prefix, BM25
// order. None of recall's weighting, floor, budget or framing, and no
// RecallLog row: it is a search box, not a recall.

import { z } from "zod";

import type { MemoryState } from "../../schemas/enums.js";
import { searchMemoryFts, toMatchQuery } from "../../storage/search.js";
import { defineTool } from "../registry.js";
import { ENTRY_INCLUDE, limitSchema, toEntry, type EntryView } from "../shared/read-entries.js";

export const SEARCH_LIMIT = 20;
export const SEARCH_LIMIT_MAX = 100;

export const searchInputSchema = z.object({
  query: z.string().trim().min(1, "A query is required").max(500),
  /** Retired entries are in the stacks: searched only when asked. */
  includeRetired: z.boolean().default(false),
  limit: limitSchema(SEARCH_LIMIT, SEARCH_LIMIT_MAX),
});

export type SearchInput = z.input<typeof searchInputSchema>;

export interface SearchResult {
  /** Best match first. */
  items: Array<EntryView & { bm25: number }>;
}

export const tool = defineTool({
  name: "memory.search",
  title: "Search",
  kind: "read",
  summary:
    "Plain text search over the library: every word required, the last as a prefix, best match first. None of recall's weighting, floor or framing. Active and superseded entries; retired ones when asked.",
  input: searchInputSchema,
  async handler(ctx, input): Promise<SearchResult> {
    const match = toMatchQuery(input.query);
    if (!match) return { items: [] };
    const states: MemoryState[] = input.includeRetired ? ["active", "superseded", "retired"] : ["active", "superseded"];
    const hits = await searchMemoryFts(ctx.db, match.expression, { states, limit: input.limit });
    if (hits.length === 0) return { items: [] };
    const rows = await ctx.db.memory.findMany({ where: { id: { in: hits.map((hit) => hit.id) } }, include: ENTRY_INCLUDE });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      items: hits.flatMap((hit) => {
        const row = byId.get(hit.id);
        return row ? [{ ...toEntry(row), bm25: hit.bm25 }] : [];
      }),
    };
  },
  auditIds: (_input, result) =>
    result ? { memoryIds: result.items.map((item) => item.id), calls: result.items.map((item) => item.call) } : undefined,
});
