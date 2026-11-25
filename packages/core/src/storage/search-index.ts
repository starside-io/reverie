import { existsSync } from "node:fs";

import { openSilo } from "./client.js";

/**
 * Keeping memory_fts honest.
 *
 * memory_fts is an external content table keyed on Memory's implicit rowid,
 * and Memory has a TEXT primary key. SQLite documents that VACUUM may renumber
 * the rowids of a table without an INTEGER PRIMARY KEY. If that ever happens
 * the index still holds the old numbers and a hit joins to the wrong memory,
 * or to none, with no error anywhere. The primary key stays as it is; these
 * three functions make sure drift cannot survive a backup unnoticed:
 *
 *   reindexSearch    rebuilds the index from the Memory rows (FTS5 'rebuild')
 *   searchIntegrity  compares the index with the Memory rows (FTS5
 *                    'integrity-check' in its external content form)
 *   backupSilo       VACUUM INTO a new file, then reindexes and checks the copy
 */

/** What these functions need of a client: two raw statements. */
export interface SearchMaintainable {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}

export type SearchIntegrity = { status: "ok" } | { status: "drifted"; detail: string };

/** Rebuilds memory_fts from the Memory rows as they are now. */
export async function reindexSearch(db: SearchMaintainable): Promise<void> {
  await db.$executeRawUnsafe(`INSERT INTO "memory_fts"("memory_fts") VALUES ('rebuild')`);
}

/**
 * Checks memory_fts against the Memory rows. The rank value 1 is what makes
 * FTS5 compare the index with the content table, not only with itself: an
 * index whose rowids no longer match the rows is reported as drifted.
 */
export async function searchIntegrity(db: SearchMaintainable): Promise<SearchIntegrity> {
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "memory_fts"("memory_fts", "rank") VALUES ('integrity-check', 1)`,
    );
    return { status: "ok" };
  } catch (error) {
    return { status: "drifted", detail: error instanceof Error ? error.message : String(error) };
  }
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export interface BackupResult {
  path: string;
  /** The copy's search check, after the reindex. Always ok: anything else throws. */
  searchIntegrity: SearchIntegrity;
}

/**
 * A consistent copy of a live silo with no downtime (docs/SPEC.md section 25),
 * whose search index is known to match its rows. The copy is opened, its index
 * rebuilt from its own rows and checked before this returns, so a renumbered
 * rowid in the copy can never ship. Refuses a path that already exists, the
 * way VACUUM INTO does, before doing anything.
 */
export async function backupSilo(db: SearchMaintainable, path: string): Promise<BackupResult> {
  if (existsSync(path)) {
    throw new BackupError(`Refusing to back up over ${path}: the file already exists.`);
  }
  await db.$executeRawUnsafe(`VACUUM INTO ?`, path);

  const copy = await openSilo({ path, createDir: false });
  try {
    await reindexSearch(copy);
    const integrity = await searchIntegrity(copy);
    if (integrity.status !== "ok") {
      throw new BackupError(`The backup at ${path} failed its search check: ${integrity.detail}`);
    }
    return { path, searchIntegrity: integrity };
  } finally {
    await copy.$disconnect();
  }
}
