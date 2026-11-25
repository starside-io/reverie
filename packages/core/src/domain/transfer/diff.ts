import type { ExportSnapshot, SnapshotCollection } from "./snapshot.js";

/**
 * Comparing two snapshots row by row, as Fellowship's transfer/diff.ts does.
 *
 * Two jobs. The round trip check: export, import, export again, and nothing
 * may be missing, extra or changed. And the import preview: the silo as it
 * stands beside the file, which is what an import would add, change and
 * remove (import.ts, planImport).
 *
 * Rows are matched by identity rather than by position, because two exporters
 * are allowed to order a collection differently. Sections, shelves and tags
 * are matched by their natural keys (code, SECTION/SHELF, slug), because that
 * is how a merge matches them, and every id pointing at one of them is read
 * as that key, so the same library in two silos with different row ids
 * compares equal. Arrays of ids are compared as sets.
 */

export interface FieldDifference {
  /** Dotted path from the row, for example "refs.<id>.label". */
  path: string;
  before: unknown;
  after: unknown;
}

export interface RowDifference {
  key: string;
  fields: FieldDifference[];
}

export interface CollectionDiff {
  collection: SnapshotCollection;
  before: number;
  after: number;
  /** Present before, gone after. */
  missing: string[];
  /** Absent before, present after. */
  extra: string[];
  changed: RowDifference[];
}

export interface SnapshotDiff {
  /** True when nothing at all moved. */
  identical: boolean;
  collections: CollectionDiff[];
  /** The collections with something to report, for a short summary. */
  problems: CollectionDiff[];
}

type Row = Record<string, unknown>;

interface CollectionSpec {
  name: SnapshotCollection;
  key: (row: Row) => string;
  nested?: Array<{ field: string; key: (row: Row) => string }>;
  sets?: string[];
}

const COLLECTIONS: CollectionSpec[] = [
  { name: "sections", key: (row) => String(row["code"]) },
  { name: "shelves", key: (row) => String(row["path"]) },
  { name: "projects", key: (row) => String(row["slug"]) },
  { name: "tags", key: (row) => String(row["slug"]) },
  { name: "sources", key: (row) => String(row["id"]) },
  {
    name: "memories",
    key: (row) => String(row["id"]),
    nested: [
      { field: "refs", key: (row) => String(row["id"]) },
      { field: "sources", key: (row) => String(row["sourceId"]) },
    ],
    sets: ["tags"],
  },
  { name: "versions", key: (row) => String(row["id"]) },
  { name: "aliases", key: (row) => String(row["oldCallNumber"]) },
  { name: "links", key: (row) => `${String(row["fromId"])}|${String(row["toId"])}|${String(row["relation"])}` },
];

/**
 * The snapshot with section, shelf and tag ids read as their natural keys:
 * a shelf is "LIF/GTH", a memory sits on "LIF/GTH" and carries tags by slug.
 * The ids of those three collections drop out of the comparison.
 */
export function keyedView(snapshot: ExportSnapshot): Record<SnapshotCollection, Row[]> {
  const sectionCode = new Map(snapshot.sections.map((row) => [row.id, row.code]));
  const shelfPath = new Map(
    snapshot.shelves.map((row) => [row.id, `${sectionCode.get(row.sectionId) ?? row.sectionId}/${row.code}`]),
  );
  const tagSlug = new Map(snapshot.tags.map((row) => [row.id, row.slug]));
  const shelfOf = (id: string | null) => (id === null ? null : (shelfPath.get(id) ?? id));
  const tagOf = (id: string | null) => (id === null ? null : (tagSlug.get(id) ?? id));

  return {
    sections: snapshot.sections.map(({ id: _id, ...rest }) => rest),
    shelves: snapshot.shelves.map(({ id, sectionId, ...rest }) => ({
      path: shelfPath.get(id),
      section: sectionCode.get(sectionId) ?? sectionId,
      ...rest,
    })),
    projects: snapshot.projects.map(({ shelfId, tagId, ...rest }) => ({
      ...rest,
      shelf: shelfOf(shelfId),
      tag: tagOf(tagId),
    })),
    tags: snapshot.tags.map(({ id: _id, ...rest }) => rest),
    sources: snapshot.sources.map((row) => ({ ...row })),
    memories: snapshot.memories.map(({ shelfId, tagIds, ...rest }) => ({
      ...rest,
      shelf: shelfOf(shelfId),
      tags: tagIds.map((id) => tagOf(id)),
    })),
    versions: snapshot.versions.map((row) => ({ ...row })),
    aliases: snapshot.aliases.map((row) => ({ ...row })),
    links: snapshot.links.map((row) => ({ ...row })),
  };
}

/** Object keys in a stable order, so a key order difference is not a change. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Row)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, entry]) => [key, sorted(entry)]));
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== typeof right || typeof left !== "object") return false;
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function asSet(value: unknown): string {
  return Array.isArray(value)
    ? [...value]
        .map((entry) => JSON.stringify(entry))
        .sort()
        .join("\u0000")
    : "";
}

function compareRow(before: Row, after: Row, spec: Pick<CollectionSpec, "nested" | "sets">, prefix = ""): FieldDifference[] {
  const differences: FieldDifference[] = [];
  const nestedFields = new Set((spec.nested ?? []).map((entry) => entry.field));
  const setFields = new Set(spec.sets ?? []);

  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (nestedFields.has(field)) continue;
    const same = setFields.has(field)
      ? asSet(before[field]) === asSet(after[field])
      : sameValue(before[field], after[field]);
    if (!same) differences.push({ path: `${prefix}${field}`, before: before[field], after: after[field] });
  }

  for (const nested of spec.nested ?? []) {
    const rows = (value: unknown) => (Array.isArray(value) ? (value as Row[]) : []);
    const left = new Map(rows(before[nested.field]).map((row) => [nested.key(row), row]));
    const right = new Map(rows(after[nested.field]).map((row) => [nested.key(row), row]));
    for (const [key, row] of left) {
      const other = right.get(key);
      if (!other) {
        differences.push({ path: `${prefix}${nested.field}.${key}`, before: row, after: undefined });
        continue;
      }
      differences.push(...compareRow(row, other, {}, `${prefix}${nested.field}.${key}.`));
    }
    for (const [key, row] of right) {
      if (!left.has(key)) differences.push({ path: `${prefix}${nested.field}.${key}`, before: undefined, after: row });
    }
  }

  return differences;
}

export interface DiffOptions {
  /** Collections whose contents are not compared. */
  ignore?: SnapshotCollection[];
  /** Cap on reported rows per list, so a report stays readable. Infinity for all. */
  maxRowsReported?: number;
}

export function diffSnapshots(before: ExportSnapshot, after: ExportSnapshot, options: DiffOptions = {}): SnapshotDiff {
  const ignore = new Set(options.ignore ?? []);
  const cap = options.maxRowsReported ?? 20;
  const left = keyedView(before);
  const right = keyedView(after);
  const collections: CollectionDiff[] = [];

  for (const spec of COLLECTIONS) {
    const beforeRows = left[spec.name];
    const afterRows = right[spec.name];
    const diff: CollectionDiff = {
      collection: spec.name,
      before: beforeRows.length,
      after: afterRows.length,
      missing: [],
      extra: [],
      changed: [],
    };
    if (ignore.has(spec.name)) {
      collections.push(diff);
      continue;
    }

    const beforeByKey = new Map(beforeRows.map((row) => [spec.key(row), row]));
    const afterByKey = new Map(afterRows.map((row) => [spec.key(row), row]));
    for (const [key, row] of beforeByKey) {
      const other = afterByKey.get(key);
      if (!other) {
        if (diff.missing.length < cap) diff.missing.push(key);
        continue;
      }
      const fields = compareRow(row, other, spec);
      if (fields.length > 0 && diff.changed.length < cap) diff.changed.push({ key, fields });
    }
    for (const key of afterByKey.keys()) {
      if (!beforeByKey.has(key) && diff.extra.length < cap) diff.extra.push(key);
    }
    collections.push(diff);
  }

  // An ignored collection keeps its counts in the report but is never a problem.
  const problems = collections.filter(
    (diff) =>
      !ignore.has(diff.collection) &&
      (diff.before !== diff.after || diff.missing.length > 0 || diff.extra.length > 0 || diff.changed.length > 0),
  );
  return { identical: problems.length === 0, collections, problems };
}

/** A report a human reads, one line per collection. */
export function formatDiff(diff: SnapshotDiff): string {
  const lines = ["collection    before    after  verdict", "------------------------------------------"];
  for (const collection of diff.collections) {
    const clean =
      collection.before === collection.after &&
      collection.missing.length === 0 &&
      collection.extra.length === 0 &&
      collection.changed.length === 0;
    const verdict = clean
      ? "same"
      : [
          collection.missing.length > 0 ? `${collection.missing.length} missing` : "",
          collection.extra.length > 0 ? `${collection.extra.length} extra` : "",
          collection.changed.length > 0 ? `${collection.changed.length} changed` : "",
          collection.before !== collection.after ? "count moved" : "",
        ]
          .filter(Boolean)
          .join(", ");
    lines.push(
      `${collection.collection.padEnd(12)} ${String(collection.before).padStart(6)} ${String(collection.after).padStart(8)}  ${verdict}`,
    );
  }
  for (const collection of diff.problems) {
    for (const row of collection.changed.slice(0, 5)) {
      for (const field of row.fields.slice(0, 5)) {
        lines.push(
          `  ${collection.collection} ${row.key} ${field.path}: ${JSON.stringify(field.before)} -> ${JSON.stringify(field.after)}`,
        );
      }
    }
    for (const key of collection.missing.slice(0, 5)) lines.push(`  ${collection.collection} ${key} is gone`);
    for (const key of collection.extra.slice(0, 5)) lines.push(`  ${collection.collection} ${key} appeared`);
  }
  return lines.join("\n");
}
