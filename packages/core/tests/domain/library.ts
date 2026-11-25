import { seedLibrary } from "../../src/domain/catalogue/shelving.js";
import type { MemoryCreateInput } from "../../src/schemas/memory.js";
import { openSilo, type Silo } from "../../src/storage/client.js";
import { freshSiloPath } from "../storage/throwaway.js";

/**
 * A throwaway silo in the OS temp directory, migrated and seeded with the
 * starting library. Every name in these tests is invented.
 */
export async function openLibrary(options: { seed?: boolean } = {}): Promise<Silo> {
  const db = await openSilo({ path: freshSiloPath() });
  if (options.seed !== false) await seedLibrary(db);
  return db;
}

export const USER = { actor: "user" } as const;

/** A valid create input: an episode at Christmas, one stated source. */
export function episode(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    shelf: "LIF/GTH",
    occurredOn: "2026-12-24",
    kind: "episode",
    title: "Christmas at home",
    body: "Hosted Christmas with Jane Doe, John Doe and Sam Rivera.",
    trust: "stated",
    sources: [
      {
        source: { kind: "conversation", label: "session of 2026-12-27", trust: "stated" },
        quote: "we had everyone over for Christmas",
      },
    ],
    ...overrides,
  };
}

/** The rowids memory_fts matches for one query. */
export async function ftsHits(db: Silo, query: string): Promise<number[]> {
  const rows = await db.$queryRawUnsafe<Array<{ rowid: bigint | number }>>(
    `SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?`,
    query,
  );
  return rows.map((row) => Number(row.rowid));
}
