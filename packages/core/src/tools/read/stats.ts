// memory.stats. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.stats` (a starting reading).
//
// Every entry in the silo, whatever its state, counted by section, shelf,
// kind, trust, state and scope. Every key is present, zeros included, so the
// shape never depends on what happens to be shelved.

import { z } from "zod";

import { MemoryKind, MemoryScope, MemoryState, TrustTier } from "../../schemas/enums.js";
import { defineTool } from "../registry.js";

export interface StatsResult {
  total: number;
  byState: Record<MemoryState, number>;
  byKind: Record<MemoryKind, number>;
  byTrust: Record<TrustTier, number>;
  byScope: Record<MemoryScope, number>;
  /** By section code: "WRK". */
  bySection: Record<string, number>;
  /** By shelf path: "WRK/NST". */
  byShelf: Record<string, number>;
}

function zeros<T extends string>(values: readonly T[]): Record<T, number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

export const tool = defineTool({
  name: "memory.stats",
  title: "Stats",
  kind: "read",
  summary: "Counts of every entry by section, shelf, kind, trust, state and scope, with a total. Every key present, zeros included.",
  input: z.object({}),
  async handler(ctx): Promise<StatsResult> {
    const [rows, sections] = await Promise.all([
      ctx.db.memory.groupBy({ by: ["shelfId", "kind", "trust", "state", "scope"], _count: { _all: true } }),
      ctx.db.section.findMany({
        orderBy: [{ order: "asc" }, { code: "asc" }],
        include: { shelves: { orderBy: [{ order: "asc" }, { code: "asc" }] } },
      }),
    ]);

    const result: StatsResult = {
      total: 0,
      byState: zeros(MemoryState.options),
      byKind: zeros(MemoryKind.options),
      byTrust: zeros(TrustTier.options),
      byScope: zeros(MemoryScope.options),
      bySection: {},
      byShelf: {},
    };
    const shelfPath = new Map<string, { section: string; path: string }>();
    for (const section of sections) {
      result.bySection[section.code] = 0;
      for (const shelf of section.shelves) {
        const path = `${section.code}/${shelf.code}`;
        result.byShelf[path] = 0;
        shelfPath.set(shelf.id, { section: section.code, path });
      }
    }

    for (const row of rows) {
      const n = row._count._all;
      result.total += n;
      result.byState[row.state as MemoryState] = (result.byState[row.state as MemoryState] ?? 0) + n;
      result.byKind[row.kind as MemoryKind] = (result.byKind[row.kind as MemoryKind] ?? 0) + n;
      result.byTrust[row.trust as TrustTier] = (result.byTrust[row.trust as TrustTier] ?? 0) + n;
      result.byScope[row.scope as MemoryScope] = (result.byScope[row.scope as MemoryScope] ?? 0) + n;
      const where = shelfPath.get(row.shelfId);
      if (where) {
        result.bySection[where.section] = (result.bySection[where.section] ?? 0) + n;
        result.byShelf[where.path] = (result.byShelf[where.path] ?? 0) + n;
      }
    }
    return result;
  },
});
