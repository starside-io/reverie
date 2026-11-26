/**
 * Prisma does not expose pragmas, so they run as raw statements on every
 * connection at boot. foreign_keys is the one that matters: SQLite ships with
 * it off, and the whole cascade behaviour of this schema depends on it, so it
 * is read back and the process refuses to start on 0.
 */

export const PRAGMAS = [
  // Wait rather than throw SQLITE_BUSY. First, so the statements after it
  // wait too when another process holds the file.
  "PRAGMA busy_timeout = 5000",
  // Readers do not block the writer.
  "PRAGMA journal_mode = WAL",
  // WAL makes this safe enough for a local app.
  "PRAGMA synchronous = NORMAL",
  // Assert it, do not assume the driver set it.
  "PRAGMA foreign_keys = ON",
] as const;

/** The minimum of a Prisma client this module needs. Keeps tests cheap. */
export interface RawSql {
  $executeRawUnsafe(sql: string): Promise<number>;
  $queryRawUnsafe<T = unknown>(sql: string): Promise<T>;
}

export class PragmaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PragmaError";
  }
}

/** Run every pragma, then prove the ones that can be read back took. */
export async function applyPragmas(db: RawSql): Promise<void> {
  for (const statement of PRAGMAS) {
    // journal_mode returns a row rather than nothing, so query all of them.
    await db.$queryRawUnsafe(statement);
  }
  await assertPragmas(db);
}

export async function assertPragmas(db: RawSql): Promise<void> {
  // SQLite integers come back from Prisma as BigInt, so compare on Number.
  const foreignKeys = await readPragma(db, "foreign_keys");
  if (Number(foreignKeys) !== 1) {
    throw new PragmaError(
      `PRAGMA foreign_keys reads ${String(foreignKeys)}, expected 1. ` +
        "Refusing to open the silo: without foreign keys SQLite orphans rows silently.",
    );
  }

  const journalMode = await readPragma(db, "journal_mode");
  if (String(journalMode).toLowerCase() !== "wal") {
    throw new PragmaError(
      `PRAGMA journal_mode reads ${String(journalMode)}, expected wal. ` +
        "Another process may hold the file in a different mode.",
    );
  }
}

/** Read one pragma back as its scalar value. */
export async function readPragma(db: RawSql, name: string): Promise<unknown> {
  const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(`PRAGMA ${name}`);
  const first = rows[0];
  if (!first) return undefined;
  const values = Object.values(first);
  return values[0];
}
