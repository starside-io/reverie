/**
 * The search layer is raw SQL, and Prisma cannot see it.
 *
 * `migrate diff` builds a shadow database from the migrations, finds the
 * virtual table and its shadow tables in it, finds none of it in
 * schema.prisma, and helpfully writes DROP TABLE for every piece. Applied, that
 * would take the search index out at the first unrelated schema change, and it
 * would look like a routine migration while it did it.
 *
 * So the generated SQL is filtered. This is the one place that knows which
 * tables belong to the search layer, and it is deliberately a list rather than
 * a pattern over everything that ends in _fts.
 */

/** The virtual tables, and the shadow tables SQLite builds beside each one. */
export const SEARCH_TABLES = ["memory_fts"] as const;

const SHADOW_SUFFIXES = ["", "_config", "_content", "_data", "_docsize", "_idx"];

export function searchTableNames(): string[] {
  return SEARCH_TABLES.flatMap((table) =>
    SHADOW_SUFFIXES.map((suffix) => `${table}${suffix}`),
  );
}

export interface StripResult {
  sql: string;
  /** The tables whose DROP was removed, for the caller to report. */
  removed: string[];
}

/** Removes the DROP TABLE statements that would take the search layer out. */
export function stripSearchDrops(sql: string): StripResult {
  const names = new Set(searchTableNames());
  const removed: string[] = [];

  // Prisma writes each drop as a comment, then a pragma, a drop and a pragma.
  const block =
    /-- DropTable\nPRAGMA foreign_keys=off;\nDROP TABLE "([^"]+)";\nPRAGMA foreign_keys=on;\n*/g;

  const out = sql.replace(block, (match, table: string) => {
    if (!names.has(table)) return match;
    removed.push(table);
    return "";
  });

  return { sql: out.replace(/\n{3,}/g, "\n\n").trimStart(), removed };
}
