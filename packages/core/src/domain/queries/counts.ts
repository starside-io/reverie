import type { MemoryState } from "../../schemas/enums.js";
import type { Db } from "../db.js";

/**
 * Counts the read tools share (shelves, core, stats). Plain reads of the
 * silo, no writes.
 */

export interface ShelfTally {
  /** Active entries. */
  count: number;
  /** Every entry, whatever its state. */
  total: number;
}

/** Active and all-state counts per shelf id. A shelf with no entry is absent. */
export async function shelfCounts(db: Db): Promise<Map<string, ShelfTally>> {
  const rows = await db.memory.groupBy({ by: ["shelfId", "state"], _count: { _all: true } });
  const out = new Map<string, ShelfTally>();
  for (const row of rows) {
    const entry = out.get(row.shelfId) ?? { count: 0, total: 0 };
    entry.total += row._count._all;
    if ((row.state as MemoryState) === "active") entry.count += row._count._all;
    out.set(row.shelfId, entry);
  }
  return out;
}
