import { ENUM_COLUMNS, enumCheckSql } from "../schemas/enums.js";

/**
 * Prisma cannot model a CHECK constraint, so the guards are added to the
 * migration SQL after Prisma writes it. The enum values come from the zod
 * enums, so the database and the validation layer cannot disagree: the test in
 * tests/storage/migrations.test.ts re-derives these from the same source and
 * compares them against what the migrations actually built.
 *
 * Beside the enums there is one length guard, on MemorySource.quote: a source
 * keeps a short quote and a pointer, never the transcript.
 */

/** The most characters one quote may hold. docs/SPEC.md section 11. */
export const QUOTE_MAX_LENGTH = 500;

export interface CheckConstraint {
  table: string;
  column: string;
  name: string;
  sql: string;
}

/** Columns capped at a number of characters. SQLite length() counts characters on TEXT. */
const LENGTH_COLUMNS = [{ table: "MemorySource", column: "quote", max: QUOTE_MAX_LENGTH }] as const;

export function enumCheckConstraints(): CheckConstraint[] {
  return ENUM_COLUMNS.map((entry) => ({
    table: entry.table,
    column: entry.column,
    name: `${entry.table}_${entry.column}_check`,
    sql: enumCheckSql(entry),
  }));
}

export function lengthCheckConstraints(): CheckConstraint[] {
  return LENGTH_COLUMNS.map((entry) => ({
    table: entry.table,
    column: entry.column,
    name: `${entry.table}_${entry.column}_length_check`,
    sql: `length("${entry.column}") <= ${entry.max}`,
  }));
}

/** Every CHECK the migrations add by hand. */
export function checkConstraints(): CheckConstraint[] {
  return [...enumCheckConstraints(), ...lengthCheckConstraints()];
}

/** The line as it appears inside a CREATE TABLE statement. */
export function constraintLine(constraint: CheckConstraint): string {
  return `    CONSTRAINT "${constraint.name}" CHECK (${constraint.sql})`;
}

/**
 * Add every CHECK to the CREATE TABLE statements of a migration script. A
 * table the script does not create is skipped, so this is safe to run over a
 * later migration that only touches one table.
 */
export function injectEnumChecks(sql: string): string {
  let out = sql;
  for (const constraint of checkConstraints()) {
    const line = constraintLine(constraint);
    if (out.includes(`"${constraint.name}"`)) continue;

    const opening = `CREATE TABLE "${constraint.table}" (`;
    const start = out.indexOf(opening);
    if (start === -1) continue;

    const end = out.indexOf("\n);", start);
    if (end === -1) continue;

    out = `${out.slice(0, end)},\n${line}${out.slice(end)}`;
  }
  return out;
}
