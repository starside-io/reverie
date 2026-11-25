import { z } from "zod";

/**
 * SQLite has no enum type and Prisma does not model one for it, so every
 * enumerated column is a String. These zod enums are the single source of truth
 * for the allowed values: they validate every tool input, they generate the
 * TypeScript unions below, and `ENUM_COLUMNS` drives the CHECK constraints in
 * the migration so the database refuses a bad value even when a write bypasses
 * zod.
 */

/** What a memory holds. docs/SPEC.md section 4. */
export const MemoryKind = z.enum(["fact", "preference", "procedure", "episode", "reference"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

/** Where a memory can be recalled. `scopeRef` names what it is scoped to. */
export const MemoryScope = z.enum(["global", "project", "agent", "session"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

/** How far a memory or a source is trusted, highest first. */
export const TrustTier = z.enum(["stated", "confirmed", "inferred", "external"]);
export type TrustTier = z.infer<typeof TrustTier>;

/**
 * The lifecycle states a Memory row can be in. `proposed` lives in the host's
 * review queue and `forgotten` has no row, so neither is a column value.
 */
export const MemoryState = z.enum(["active", "superseded", "retired"]);
export type MemoryState = z.infer<typeof MemoryState>;

/** How a memory points into the people module. */
export const RefRole = z.enum(["attendee", "occasion", "mentions"]);
export type RefRole = z.infer<typeof RefRole>;

/** What one immutable version row records. Starting value. */
export const VersionOperation = z.enum([
  "create",
  "update",
  "refine",
  "supersede",
  "shelve",
  "retire",
  "redact",
  "forget",
]);
export type VersionOperation = z.infer<typeof VersionOperation>;

/** Where a source came from. Starting value. */
export const SourceKind = z.enum(["conversation", "file", "page", "tool_result", "import"]);
export type SourceKind = z.infer<typeof SourceKind>;

/** How one memory relates to another. `contradicts` feeds the conflicts screen. */
export const LinkRelation = z.enum(["elaborates", "contradicts", "derived-from"]);
export type LinkRelation = z.infer<typeof LinkRelation>;

/** Every string column that carries an enumerated value, by table and column. */
export const ENUM_COLUMNS = [
  { table: "Memory", column: "kind", values: MemoryKind.options, nullable: false },
  { table: "Memory", column: "scope", values: MemoryScope.options, nullable: false },
  { table: "Memory", column: "trust", values: TrustTier.options, nullable: false },
  { table: "Memory", column: "state", values: MemoryState.options, nullable: false },
  { table: "MemoryRef", column: "role", values: RefRole.options, nullable: false },
  {
    table: "MemoryVersion",
    column: "operation",
    values: VersionOperation.options,
    nullable: false,
  },
  { table: "Source", column: "kind", values: SourceKind.options, nullable: false },
  { table: "Source", column: "trust", values: TrustTier.options, nullable: false },
  { table: "MemoryLink", column: "relation", values: LinkRelation.options, nullable: false },
  { table: "RecallLog", column: "scope", values: MemoryScope.options, nullable: false },
] as const satisfies ReadonlyArray<{
  table: string;
  column: string;
  values: readonly string[];
  nullable: boolean;
}>;

/** The SQL fragment a CHECK constraint on one enum column needs. */
export function enumCheckSql(entry: (typeof ENUM_COLUMNS)[number]): string {
  const list = entry.values.map((value) => `'${value}'`).join(", ");
  const inList = `"${entry.column}" IN (${list})`;
  return entry.nullable ? `"${entry.column}" IS NULL OR ${inList}` : inList;
}
