import { z } from "zod";

import { codeSchema, dateOnlySchema, dateTimeSchema, dayKey, hexColourSchema, idSchema } from "../../schemas/common.js";
// The zod enums are the single source of truth for the allowed values, and the
// snapshot validates against the same ones the database is constrained to.
import {
  LinkRelation,
  MemoryKind,
  MemoryScope,
  MemoryState,
  RefRole,
  SourceKind,
  TrustTier,
  VersionOperation,
} from "../../schemas/enums.js";
import { BODY_MAX_LENGTH, SEQ_MAX, SEQ_MIN, TITLE_MAX_LENGTH } from "../../schemas/memory.js";
import { QUOTE_MAX_LENGTH } from "../../schemas/source.js";
import { TAG_SLUG_MAX_LENGTH, TAG_SLUG_PATTERN } from "../../schemas/tag.js";
import { CALL_NUMBER_PATTERN } from "../catalogue/call-number.js";

/**
 * The silo as one JSON document: the owner's own backup (memory.export) and
 * what memory.import reads back. docs/SPEC.md sections 15 and 16.
 *
 * What it holds: sections, shelves, projects, tags, sources, memories (each
 * with its tag ids, its refs and its citations of sources with their quotes),
 * every version row, every call number alias (the null-pointing numbers of
 * forgotten memories included, so none is reissued after an import), and the
 * links between memories. Ids, call numbers, aliases and version rows travel
 * verbatim.
 *
 * What it leaves out, on purpose:
 *
 * - Embedding. A cache of body and model, recomputed by the host's re-embed
 *   hook; carrying vectors would tie the file to one model and add binary
 *   bulk. The importer reports which memories need one.
 * - SessionNote. Scratch for one working session, expiring within days, never
 *   recalled outside it: not library content.
 * - RecallLog. A log of use, like the audit log the host keeps: ids and
 *   scores, never content. An import never wipes either of these two tables.
 * - Memory.tagText. Derived from the tags, rebuilt on the way in.
 * - Local folder paths. There is no such column in the silo (they live in
 *   host.db), and the project shape below has no field for one: a project
 *   round trips by slug and repository alone ("Paths stay home").
 *
 * The shape follows Fellowship's snapshot: an export side of plain JSON types
 * with dates as strings, an import side that validates the same shape back
 * into Dates, and a cheap summary for a form that describes a file before it
 * is sent.
 */

/** Bumped whenever the snapshot shape stops being readable by the importer. */
export const SNAPSHOT_VERSION = 1;

export const SUPPORTED_SNAPSHOT_VERSIONS = [1] as const;

/* ------------------------------------------------------------------ */
/* Export side: what buildExportSnapshot produces. Dates are strings so */
/* the object survives JSON.stringify without surprises.                */
/* ------------------------------------------------------------------ */

export type SnapshotSection = {
  id: string;
  code: string;
  name: string;
  order: number;
};

export type SnapshotShelf = {
  id: string;
  sectionId: string;
  code: string;
  name: string;
  description: string;
  order: number;
};

/** A project as the silo holds it. No local folder path, by design. */
export type SnapshotProject = {
  id: string;
  slug: string;
  name: string;
  repoUrl: string | null;
  shelfId: string | null;
  tagId: string | null;
  description: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SnapshotTag = {
  id: string;
  slug: string;
  colour: string;
};

export type SnapshotSource = {
  id: string;
  kind: SourceKind;
  uri: string | null;
  label: string;
  occurredAt: string | null;
  trust: TrustTier;
  createdAt: string;
};

export type SnapshotRef = {
  id: string;
  role: RefRole;
  uri: string | null;
  label: string;
  resolved: boolean;
};

/** One citation: a source the memory cites, and the quote. */
export type SnapshotCitation = {
  sourceId: string;
  quote: string;
};

export type SnapshotMemory = {
  id: string;
  callNumber: string;
  shelfId: string;
  /** Date only, YYYY-MM-DD. */
  occurredOn: string;
  seq: number;
  kind: MemoryKind;
  scope: MemoryScope;
  scopeRef: string | null;
  title: string;
  body: string;
  why: string | null;
  howToApply: string | null;
  importance: number;
  trust: TrustTier;
  state: MemoryState;
  validFrom: string;
  validTo: string | null;
  supersededById: string | null;
  pinned: boolean;
  lastConfirmedAt: string;
  lastRecalledAt: string | null;
  recallCount: number;
  createdAt: string;
  updatedAt: string;
  tagIds: string[];
  refs: SnapshotRef[];
  sources: SnapshotCitation[];
};

/**
 * Versions are a flat top level collection rather than nesting under their
 * memory: they outlive a forgotten memory (redacted, content null), and a
 * forgotten memory has no row to nest them under.
 */
export type SnapshotVersion = {
  id: string;
  memoryId: string;
  operation: VersionOperation;
  actor: string;
  contentSha256: string | null;
  /** The JSON text the silo stores, verbatim, so the hash still verifies. */
  body: string | null;
  at: string;
};

export type SnapshotAlias = {
  oldCallNumber: string;
  /** Null for a forgotten memory: the number points at nothing, and stays retired. */
  memoryId: string | null;
  createdAt: string;
};

export type SnapshotLink = {
  id: string;
  fromId: string;
  toId: string;
  relation: LinkRelation;
  createdAt: string;
};

export type ExportSnapshot = {
  version: number;
  exportedAt: string;
  sections: SnapshotSection[];
  shelves: SnapshotShelf[];
  projects: SnapshotProject[];
  tags: SnapshotTag[];
  sources: SnapshotSource[];
  memories: SnapshotMemory[];
  versions: SnapshotVersion[];
  aliases: SnapshotAlias[];
  links: SnapshotLink[];
};

/** The collections of a snapshot, in the order they are written. */
export const SNAPSHOT_COLLECTIONS = [
  "sections",
  "shelves",
  "projects",
  "tags",
  "sources",
  "memories",
  "versions",
  "aliases",
  "links",
] as const;
export type SnapshotCollection = (typeof SNAPSHOT_COLLECTIONS)[number];

/* ------------------------------------------------------------------ */
/* Import side: the same shape, validated, with dates back as Dates.    */
/* Text travels verbatim: nothing is trimmed on the way in.             */
/* ------------------------------------------------------------------ */

const nullableText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value ?? null);

const nullableDate = dateTimeSchema.nullish().transform((value) => value ?? null);

const slugSchema = z
  .string()
  .max(TAG_SLUG_MAX_LENGTH)
  .regex(TAG_SLUG_PATTERN, "Expected a lowercase tag slug");

const sectionSchema = z.object({
  id: idSchema,
  code: codeSchema,
  name: z.string().min(1).max(80),
  order: z.number().int(),
});

const shelfSchema = z.object({
  id: idSchema,
  sectionId: idSchema,
  code: codeSchema,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  order: z.number().int(),
});

/**
 * Unknown keys are stripped, as everywhere in this schema, so a file that
 * carries a folder path on a project (a hand edit, another tool's export)
 * never writes it anywhere.
 */
const projectSchema = z.object({
  id: idSchema,
  slug: slugSchema,
  name: z.string().min(1).max(120),
  repoUrl: nullableText(300),
  shelfId: idSchema.nullish().transform((value) => value ?? null),
  tagId: idSchema.nullish().transform((value) => value ?? null),
  description: nullableText(300),
  archived: z.boolean().default(false),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});

const tagSchema = z.object({
  id: idSchema,
  slug: slugSchema,
  colour: hexColourSchema,
});

const sourceSchema = z.object({
  id: idSchema,
  kind: SourceKind,
  uri: nullableText(2000),
  label: z.string().min(1).max(200),
  occurredAt: nullableDate,
  trust: TrustTier,
  createdAt: dateTimeSchema,
});

const refSchema = z.object({
  id: idSchema,
  role: RefRole,
  uri: nullableText(2000),
  label: z.string().min(1).max(200),
  resolved: z.boolean().default(false),
});

const citationSchema = z.object({
  sourceId: idSchema,
  quote: z.string().min(1).max(QUOTE_MAX_LENGTH, `A quote holds at most ${QUOTE_MAX_LENGTH} characters`),
});

const memorySchema = z.object({
  id: idSchema,
  callNumber: z.string().regex(CALL_NUMBER_PATTERN, "Expected a call number such as LIF/GTH/2026-12-24/001"),
  shelfId: idSchema,
  occurredOn: dateOnlySchema,
  seq: z.number().int().min(SEQ_MIN).max(SEQ_MAX),
  kind: MemoryKind,
  scope: MemoryScope,
  scopeRef: nullableText(200),
  title: z.string().min(1).max(TITLE_MAX_LENGTH),
  body: z.string().min(1).max(BODY_MAX_LENGTH),
  why: nullableText(BODY_MAX_LENGTH),
  howToApply: nullableText(BODY_MAX_LENGTH),
  importance: z.number().int().min(1).max(5),
  trust: TrustTier,
  state: MemoryState,
  validFrom: dateTimeSchema,
  validTo: nullableDate,
  supersededById: idSchema.nullish().transform((value) => value ?? null),
  pinned: z.boolean().default(false),
  lastConfirmedAt: dateTimeSchema,
  lastRecalledAt: nullableDate,
  recallCount: z.number().int().min(0).default(0),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  tagIds: z.array(idSchema).default([]),
  refs: z.array(refSchema).default([]),
  sources: z.array(citationSchema).min(1, "No source, no memory: every memory cites at least one source"),
});

const versionSchema = z.object({
  id: idSchema,
  memoryId: idSchema,
  operation: VersionOperation,
  actor: z.string().min(1).max(120),
  contentSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "Expected a sha256 in hex")
    .nullish()
    .transform((value) => value ?? null),
  body: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  at: dateTimeSchema,
});

const aliasSchema = z.object({
  oldCallNumber: z.string().regex(CALL_NUMBER_PATTERN, "Expected a call number"),
  memoryId: idSchema.nullish().transform((value) => value ?? null),
  createdAt: dateTimeSchema,
});

const linkSchema = z.object({
  id: idSchema,
  fromId: idSchema,
  toId: idSchema,
  relation: LinkRelation,
  createdAt: dateTimeSchema,
});

type Issue = { path: Array<string | number>; message: string };

function duplicates<T>(rows: readonly T[], key: (row: T) => string, collection: string, field: string): Issue[] {
  const seen = new Set<string>();
  const issues: Issue[] = [];
  rows.forEach((row, index) => {
    const value = key(row);
    if (seen.has(value)) issues.push({ path: [collection, index, field], message: `Two ${collection} share ${field} "${value}"` });
    seen.add(value);
  });
  return issues;
}

export const snapshotSchema = z
  .object({
    version: z.literal(1),
    exportedAt: z.string().optional(),
    sections: z.array(sectionSchema).default([]),
    shelves: z.array(shelfSchema).default([]),
    projects: z.array(projectSchema).default([]),
    tags: z.array(tagSchema).default([]),
    sources: z.array(sourceSchema).default([]),
    memories: z.array(memorySchema).default([]),
    versions: z.array(versionSchema).default([]),
    aliases: z.array(aliasSchema).default([]),
    links: z.array(linkSchema).default([]),
  })
  .superRefine((value, ctx) => {
    const issues: Issue[] = [
      ...duplicates(value.sections, (row) => row.id, "sections", "id"),
      ...duplicates(value.sections, (row) => row.code, "sections", "code"),
      ...duplicates(value.shelves, (row) => row.id, "shelves", "id"),
      ...duplicates(value.shelves, (row) => `${row.sectionId}/${row.code}`, "shelves", "code"),
      ...duplicates(value.projects, (row) => row.id, "projects", "id"),
      ...duplicates(value.projects, (row) => row.slug, "projects", "slug"),
      ...duplicates(
        value.projects.filter((row) => row.repoUrl !== null),
        (row) => row.repoUrl as string,
        "projects",
        "repoUrl",
      ),
      ...duplicates(value.tags, (row) => row.id, "tags", "id"),
      ...duplicates(value.tags, (row) => row.slug, "tags", "slug"),
      ...duplicates(value.sources, (row) => row.id, "sources", "id"),
      ...duplicates(value.memories, (row) => row.id, "memories", "id"),
      ...duplicates(value.memories, (row) => row.callNumber, "memories", "callNumber"),
      ...duplicates(value.versions, (row) => row.id, "versions", "id"),
      ...duplicates(value.aliases, (row) => row.oldCallNumber, "aliases", "oldCallNumber"),
      ...duplicates(value.links, (row) => row.id, "links", "id"),
      ...duplicates(value.links, (row) => `${row.fromId}|${row.toId}|${row.relation}`, "links", "relation"),
    ];

    const sections = new Map(value.sections.map((row) => [row.id, row]));
    const shelves = new Map(value.shelves.map((row) => [row.id, row]));
    const tags = new Set(value.tags.map((row) => row.id));
    const sources = new Set(value.sources.map((row) => row.id));
    const memories = new Set(value.memories.map((row) => row.id));
    const refIds = new Set<string>();

    value.shelves.forEach((shelf, index) => {
      if (!sections.has(shelf.sectionId)) {
        issues.push({ path: ["shelves", index, "sectionId"], message: "A shelf points at a section the file does not carry" });
      }
    });
    value.projects.forEach((project, index) => {
      if (project.shelfId !== null && !shelves.has(project.shelfId)) {
        issues.push({ path: ["projects", index, "shelfId"], message: "A project points at a shelf the file does not carry" });
      }
      if (project.tagId !== null && !tags.has(project.tagId)) {
        issues.push({ path: ["projects", index, "tagId"], message: "A project points at a tag the file does not carry" });
      }
    });

    value.memories.forEach((memory, index) => {
      const shelf = shelves.get(memory.shelfId);
      if (!shelf) {
        issues.push({ path: ["memories", index, "shelfId"], message: "A memory points at a shelf the file does not carry" });
      } else {
        const section = sections.get(shelf.sectionId);
        const expected = section
          ? `${section.code}/${shelf.code}/${dayKey(memory.occurredOn)}/${String(memory.seq).padStart(3, "0")}`
          : null;
        if (expected !== null && expected !== memory.callNumber) {
          issues.push({
            path: ["memories", index, "callNumber"],
            message: `${memory.callNumber} does not match its shelf, day and sequence (${expected})`,
          });
        }
      }
      const globalScope = memory.scope === "global";
      if (globalScope !== (memory.scopeRef === null)) {
        issues.push({
          path: ["memories", index, "scopeRef"],
          message: "A global memory takes no scopeRef; a project, agent or session memory names one",
        });
      }
      if (memory.supersededById !== null && !memories.has(memory.supersededById)) {
        issues.push({ path: ["memories", index, "supersededById"], message: "A memory points at a replacement the file does not carry" });
      }
      memory.tagIds.forEach((tagId, at) => {
        if (!tags.has(tagId)) issues.push({ path: ["memories", index, "tagIds", at], message: "A memory carries a tag the file does not" });
      });
      issues.push(...duplicates(memory.tagIds, (id) => id, `memories.${index}.tagIds`, "id"));
      memory.refs.forEach((ref, at) => {
        if (refIds.has(ref.id)) issues.push({ path: ["memories", index, "refs", at, "id"], message: "Two refs share an id" });
        refIds.add(ref.id);
      });
      memory.sources.forEach((citation, at) => {
        if (!sources.has(citation.sourceId)) {
          issues.push({ path: ["memories", index, "sources", at, "sourceId"], message: "A memory cites a source the file does not carry" });
        }
      });
      issues.push(...duplicates(memory.sources, (row) => row.sourceId, `memories.${index}.sources`, "sourceId"));
    });

    value.aliases.forEach((alias, index) => {
      if (alias.memoryId !== null && !memories.has(alias.memoryId)) {
        issues.push({ path: ["aliases", index, "memoryId"], message: "An alias points at a memory the file does not carry" });
      }
    });
    value.links.forEach((link, index) => {
      if (!memories.has(link.fromId) || !memories.has(link.toId)) {
        issues.push({ path: ["links", index], message: "A link joins a memory the file does not carry" });
      }
    });
    value.versions.forEach((version, index) => {
      if ((version.body === null) !== (version.contentSha256 === null)) {
        issues.push({
          path: ["versions", index, "body"],
          message: "A version holds both its content and its hash, or neither once redacted",
        });
      }
    });

    for (const issue of issues) ctx.addIssue({ code: z.ZodIssueCode.custom, ...issue });
  });

export type ParsedSnapshot = z.infer<typeof snapshotSchema>;
export type ParsedSnapshotMemory = ParsedSnapshot["memories"][number];

/* ------------------------------------------------------------------ */
/* Back to the export shape: a parsed file as the exporter would write  */
/* it, so a file and a silo compare field for field.                    */
/* ------------------------------------------------------------------ */

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toExportShape(snapshot: ParsedSnapshot): ExportSnapshot {
  return {
    version: snapshot.version,
    exportedAt: snapshot.exportedAt ?? "",
    sections: snapshot.sections.map((row) => ({ ...row })),
    shelves: snapshot.shelves.map((row) => ({ ...row })),
    projects: snapshot.projects.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      repoUrl: row.repoUrl,
      shelfId: row.shelfId,
      tagId: row.tagId,
      description: row.description,
      archived: row.archived,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    tags: snapshot.tags.map((row) => ({ ...row })),
    sources: snapshot.sources.map((row) => ({
      id: row.id,
      kind: row.kind,
      uri: row.uri,
      label: row.label,
      occurredAt: iso(row.occurredAt),
      trust: row.trust,
      createdAt: row.createdAt.toISOString(),
    })),
    memories: snapshot.memories.map((row) => ({
      id: row.id,
      callNumber: row.callNumber,
      shelfId: row.shelfId,
      occurredOn: dayKey(row.occurredOn),
      seq: row.seq,
      kind: row.kind,
      scope: row.scope,
      scopeRef: row.scopeRef,
      title: row.title,
      body: row.body,
      why: row.why,
      howToApply: row.howToApply,
      importance: row.importance,
      trust: row.trust,
      state: row.state,
      validFrom: row.validFrom.toISOString(),
      validTo: iso(row.validTo),
      supersededById: row.supersededById,
      pinned: row.pinned,
      lastConfirmedAt: row.lastConfirmedAt.toISOString(),
      lastRecalledAt: iso(row.lastRecalledAt),
      recallCount: row.recallCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      tagIds: [...row.tagIds],
      refs: row.refs.map((ref) => ({ ...ref })),
      sources: row.sources.map((citation) => ({ ...citation })),
    })),
    versions: snapshot.versions.map((row) => ({
      id: row.id,
      memoryId: row.memoryId,
      operation: row.operation,
      actor: row.actor,
      contentSha256: row.contentSha256,
      body: row.body,
      at: row.at.toISOString(),
    })),
    aliases: snapshot.aliases.map((row) => ({
      oldCallNumber: row.oldCallNumber,
      memoryId: row.memoryId,
      createdAt: row.createdAt.toISOString(),
    })),
    links: snapshot.links.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
  };
}

/* ------------------------------------------------------------------ */
/* Client side dry read: counts without validating every field.         */
/* ------------------------------------------------------------------ */

export type SnapshotSummary = { version: number; exportedAt: string | null } & Record<SnapshotCollection, number>;

function isSupportedVersion(value: unknown): value is (typeof SUPPORTED_SNAPSHOT_VERSIONS)[number] {
  return SUPPORTED_SNAPSHOT_VERSIONS.some((version) => version === value);
}

/**
 * Cheap read of a parsed JSON file, to describe a file before anything is
 * sent. Null when it is not a snapshot this build knows how to read.
 */
export function summariseSnapshot(value: unknown): SnapshotSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isSupportedVersion(record.version)) return null;
  const counts = Object.fromEntries(
    SNAPSHOT_COLLECTIONS.map((name) => {
      const list = record[name];
      return [name, Array.isArray(list) ? list.length : 0];
    }),
  ) as Record<SnapshotCollection, number>;
  return {
    version: record.version,
    exportedAt: typeof record.exportedAt === "string" ? record.exportedAt : null,
    ...counts,
  };
}
