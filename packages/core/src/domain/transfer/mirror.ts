import { createHash } from "node:crypto";

import { z } from "zod";

import { normaliseTagSlug } from "../../schemas/tag.js";
import { parseCallNumber } from "../catalogue/call-number.js";
import { tagColourFor } from "../catalogue/tags.js";
import {
  snapshotLinkSchema,
  snapshotMemorySchema,
  snapshotProjectSchema,
  snapshotSectionSchema,
  snapshotShelfSchema,
  snapshotSourceSchema,
  snapshotTagSchema,
  snapshotVersionSchema,
  SNAPSHOT_VERSION,
  type ExportSnapshot,
  type SnapshotAlias,
  type SnapshotMemory,
  type SnapshotRef,
  type SnapshotSource,
  type SnapshotVersion,
} from "./snapshot.js";

/**
 * The markdown mirror, as documents. docs/SPEC.md section 19, "The markdown
 * mirror": one folder per section, one per shelf, one file per memory, the
 * file name starting with the rest of the call number so a listing is in
 * order.
 *
 * Core touches no disk here. buildMirror turns a snapshot into documents
 * (a relative path, a front matter object and a body); the markdown adapter
 * renders and writes them, and on the way back hands over what it read, which
 * readMirror turns into a snapshot again. Everything a memory needs to be
 * rebuilt sits in its own file's front matter; what is shared by the library
 * sits in one manifest beside the shelves:
 *
 *   .reverie/library.json   sections and shelves (with their folder names),
 *                           the tag vocabulary, projects, sources no memory
 *                           cites, call numbers retired by a forget, links
 *                           between memories, and the version history of
 *                           every memory in the mirror
 *   Life/Gatherings/2026-12-24-001 christmas-at-home.md
 *
 * What the mirror leaves out, on purpose: everything the snapshot leaves out
 * (snapshot.ts), and the version rows of forgotten memories. A forgotten
 * memory is absent from the mirror, history included ("Forget is real"); its
 * call number stays in `retiredNumbers`, a number and a time with no memory
 * behind it, so it is never reissued after a round trip.
 *
 * Nothing in a document is a local folder path: paths are relative to the
 * mirror root, projects travel by slug and repository ("Paths stay home").
 */

export const MIRROR_FORMAT = "reverie-mirror";
export const MIRROR_VERSION = 1;
/** The mirror's own folder. Hidden in Obsidian, as every dot folder is. */
export const MIRROR_DIR = ".reverie";
export const MIRROR_MANIFEST_PATH = `${MIRROR_DIR}/library.json`;

/** How long the slug after the call number may run. Starting value. */
export const FILE_SLUG_MAX = 60;

export type MirrorDocument =
  | { path: string; format: "markdown"; data: Record<string, unknown>; body: string }
  | { path: string; format: "json"; data: Record<string, unknown> };

/* ------------------------------------------------------------------ */
/* Names on disk                                                       */
/* ------------------------------------------------------------------ */

const UNSAFE_IN_NAME = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/**
 * A section or shelf name as a folder name: separators and characters no
 * file system takes become hyphens, leading dots and trailing dots or spaces
 * go (a leading dot would hide the folder). Empty falls back to the code.
 */
export function folderName(name: string, code: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(UNSAFE_IN_NAME, "-")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : code;
}

/** A title as the slug after the call number: lowercase ascii words joined by hyphens. */
export function fileSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = slug.slice(0, FILE_SLUG_MAX).replace(/-+$/, "");
  return cut.length > 0 ? cut : "memory";
}

/** `2026-12-24-001 christmas-at-home.md`: the rest of the call number, then the slug. */
export function memoryFileName(callNumber: string, title: string): string {
  const parts = parseCallNumber(callNumber);
  const rest = parts ? `${parts.day}-${String(parts.seq).padStart(3, "0")}` : callNumber.replace(/\//g, "-");
  return `${rest} ${fileSlug(title)}.md`;
}

/** Folder names for every section and shelf, unique within their parent, in library order. */
export function libraryFolders(snapshot: Pick<ExportSnapshot, "sections" | "shelves">): {
  sections: Map<string, string>;
  shelves: Map<string, string>;
} {
  const sections = new Map<string, string>();
  const takenSections = new Set<string>();
  for (const section of snapshot.sections) {
    let name = folderName(section.name, section.code);
    if (takenSections.has(name.toLowerCase())) name = `${name} (${section.code})`;
    takenSections.add(name.toLowerCase());
    sections.set(section.id, name);
  }
  const shelves = new Map<string, string>();
  const takenShelves = new Map<string, Set<string>>();
  for (const shelf of snapshot.shelves) {
    const section = sections.get(shelf.sectionId) ?? shelf.sectionId;
    const taken = takenShelves.get(shelf.sectionId) ?? new Set<string>();
    let name = folderName(shelf.name, shelf.code);
    if (taken.has(name.toLowerCase()) || name.toLowerCase() === MIRROR_DIR) name = `${name} (${shelf.code})`;
    taken.add(name.toLowerCase());
    takenShelves.set(shelf.sectionId, taken);
    shelves.set(shelf.id, `${section}/${name}`);
  }
  return { sections, shelves };
}

/* ------------------------------------------------------------------ */
/* Revision: what the silo held for a memory when its file was written  */
/* ------------------------------------------------------------------ */

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** How a revision names shelves and tags: by their natural keys, so two silos' ids compare. */
export interface RevisionKeys {
  shelf: ReadonlyMap<string, string>;
  tag: ReadonlyMap<string, string>;
}

/** Shelf paths and tag slugs by id, for memoryRevision. */
export function revisionKeys(snapshot: Pick<ExportSnapshot, "sections" | "shelves" | "tags">): RevisionKeys {
  const section = new Map(snapshot.sections.map((row) => [row.id, row.code]));
  return {
    shelf: new Map(snapshot.shelves.map((row) => [row.id, `${section.get(row.sectionId) ?? "?"}/${row.code}`])),
    tag: new Map(snapshot.tags.map((row) => [row.id, row.slug])),
  };
}

/**
 * A short hash of a memory as the silo holds it, bar the counters recall
 * moves on its own (lastRecalledAt, recallCount, updatedAt). Written into
 * each file; on import, a file that was edited while the silo's memory also
 * changed is a conflict, never a silent overwrite of the newer side. Shelves
 * and tags are hashed by their keys, not their row ids.
 */
export function memoryRevision(memory: SnapshotMemory, aliases: readonly SnapshotAlias[], keys: RevisionKeys): string {
  const { lastRecalledAt: _a, recallCount: _b, updatedAt: _c, shelfId, tagIds, ...rest } = memory;
  const stable = {
    ...rest,
    shelf: keys.shelf.get(shelfId) ?? shelfId,
    tags: tagIds.map((id) => keys.tag.get(id) ?? id).sort(compareText),
    refs: [...rest.refs].sort((a, b) => compareText(a.id, b.id)),
    sources: [...rest.sources].sort((a, b) => compareText(a.sourceId, b.sourceId)),
    aliases: aliases
      .filter((alias) => alias.memoryId === memory.id)
      .map((alias) => alias.oldCallNumber)
      .sort(compareText),
  };
  return createHash("sha256").update(JSON.stringify(stable), "utf8").digest("hex").slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* Snapshot to documents                                               */
/* ------------------------------------------------------------------ */

function refEntries(refs: readonly SnapshotRef[], role: SnapshotRef["role"]) {
  return refs
    .filter((ref) => ref.role === role)
    .map((ref) => ({ id: ref.id, label: ref.label, uri: ref.uri, resolved: ref.resolved }));
}

/**
 * The mirror of a snapshot: one markdown document per memory, at
 * `<section folder>/<shelf folder>/<rest of call number> <slug>.md`, and the
 * manifest. Deterministic: the same library gives the same documents, so
 * writing the mirror again over an unchanged library writes nothing.
 */
export function buildMirror(snapshot: ExportSnapshot): MirrorDocument[] {
  const folders = libraryFolders(snapshot);
  const sections = new Map(snapshot.sections.map((row) => [row.id, row]));
  const sources = new Map(snapshot.sources.map((row) => [row.id, row]));
  const tagSlug = new Map(snapshot.tags.map((row) => [row.id, row.slug]));
  const live = new Set(snapshot.memories.map((row) => row.id));
  const cited = new Set(snapshot.memories.flatMap((row) => row.sources.map((citation) => citation.sourceId)));
  const keys = revisionKeys(snapshot);

  const documents: MirrorDocument[] = [];
  for (const memory of snapshot.memories) {
    const folder = folders.shelves.get(memory.shelfId) ?? memory.shelfId;
    const previousCalls = snapshot.aliases
      .filter((alias) => alias.memoryId === memory.id)
      .map((alias) => ({ call: alias.oldCallNumber, at: alias.createdAt }));
    const data: Record<string, unknown> = {
      id: memory.id,
      call: memory.callNumber,
      title: memory.title,
      kind: memory.kind,
      state: memory.state,
      trust: memory.trust,
      importance: memory.importance,
      pinned: memory.pinned,
      scope: memory.scope,
      scopeRef: memory.scopeRef,
      tags: memory.tagIds.map((id) => tagSlug.get(id) ?? id).sort(compareText),
      attendees: refEntries(memory.refs, "attendee"),
      occasions: refEntries(memory.refs, "occasion"),
      mentions: refEntries(memory.refs, "mentions"),
      why: memory.why,
      howToApply: memory.howToApply,
      supersededBy: memory.supersededById,
      validFrom: memory.validFrom,
      validTo: memory.validTo,
      lastConfirmedAt: memory.lastConfirmedAt,
      lastRecalledAt: memory.lastRecalledAt,
      recallCount: memory.recallCount,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      previousCalls,
      sources: memory.sources.map((citation) => {
        const source = sources.get(citation.sourceId);
        return {
          id: citation.sourceId,
          kind: source?.kind ?? "import",
          uri: source?.uri ?? null,
          label: source?.label ?? citation.sourceId,
          occurredAt: source?.occurredAt ?? null,
          trust: source?.trust ?? memory.trust,
          createdAt: source?.createdAt ?? memory.createdAt,
          quote: citation.quote,
        };
      }),
      revision: memoryRevision(memory, snapshot.aliases, keys),
    };
    documents.push({
      path: `${folder}/${memoryFileName(memory.callNumber, memory.title)}`,
      format: "markdown",
      data,
      body: memory.body,
    });
  }

  documents.push({
    path: MIRROR_MANIFEST_PATH,
    format: "json",
    data: {
      format: MIRROR_FORMAT,
      version: MIRROR_VERSION,
      snapshotVersion: SNAPSHOT_VERSION,
      sections: snapshot.sections.map((row) => ({ ...row, folder: folders.sections.get(row.id) })),
      shelves: snapshot.shelves.map((row) => ({
        ...row,
        section: sections.get(row.sectionId)?.code ?? null,
        folder: folders.shelves.get(row.id),
      })),
      tags: snapshot.tags.map((row) => ({ ...row })),
      projects: snapshot.projects.map((row) => ({ ...row })),
      sources: snapshot.sources.filter((row) => !cited.has(row.id)).map((row) => ({ ...row })),
      retiredNumbers: snapshot.aliases
        .filter((alias) => alias.memoryId === null)
        .map((alias) => ({ call: alias.oldCallNumber, at: alias.createdAt })),
      links: snapshot.links.map((row) => ({ ...row })),
      // A forgotten memory's versions stay in the silo, redacted; they stay out of the mirror.
      versions: snapshot.versions.filter((row) => live.has(row.memoryId)).map((row) => ({ ...row })),
      // Every number issued to a memory in the mirror, so a replace with a
      // file missing still retires that file's numbers.
      issued: [
        ...snapshot.memories.map((row) => ({ call: row.callNumber, memoryId: row.id })),
        ...snapshot.aliases
          .filter((alias) => alias.memoryId !== null)
          .map((alias) => ({ call: alias.oldCallNumber, memoryId: alias.memoryId })),
      ].sort((a, b) => compareText(a.call, b.call)),
    },
  });
  return documents;
}

/* ------------------------------------------------------------------ */
/* What the adapter hands back                                         */
/* ------------------------------------------------------------------ */

/** One file the markdown connector read, as it hands it over. */
export const mirrorReadFileSchema = z.object({
  /** Relative to the folder, forward slashes. */
  path: z.string().min(1).max(4096),
  format: z.enum(["markdown", "json"]),
  /** The front matter (or the JSON object). Null when the file has none. */
  data: z.record(z.unknown()).nullable(),
  body: z.string(),
  /** The mirror wrote this path. */
  owned: z.boolean().default(false),
  /** Its bytes are exactly what the mirror last wrote. */
  unchanged: z.boolean().default(false),
  /** A hash of its bytes as read, handed back to adopt an edit once imported. */
  sha256: z.string().nullable().default(null),
  modifiedAt: z.string().nullable().default(null),
  /** Why it could not be read or parsed. Reported for this file alone. */
  error: z.string().nullable().default(null),
});
export type MirrorReadFile = z.output<typeof mirrorReadFileSchema>;

const manifestSchema = z.object({
  format: z.literal(MIRROR_FORMAT),
  version: z.literal(MIRROR_VERSION),
  sections: z.array(snapshotSectionSchema.extend({ folder: z.string().optional() })).default([]),
  shelves: z.array(snapshotShelfSchema.extend({ folder: z.string().optional() })).default([]),
  tags: z.array(snapshotTagSchema).default([]),
  projects: z.array(snapshotProjectSchema).default([]),
  sources: z.array(snapshotSourceSchema).default([]),
  retiredNumbers: z.array(z.object({ call: z.string(), at: z.string() })).default([]),
  links: z.array(snapshotLinkSchema).default([]),
  versions: z.array(snapshotVersionSchema).default([]),
  issued: z.array(z.object({ call: z.string(), memoryId: z.string() })).default([]),
});

/* ------------------------------------------------------------------ */
/* Documents back to a snapshot                                        */
/* ------------------------------------------------------------------ */

export interface MirrorFileProblem {
  path: string;
  message: string;
}

/** A file read as a memory the mirror wrote: it has an id. */
export interface MirrorRecord {
  path: string;
  memory: SnapshotMemory;
  /** Aliases this memory's file names: its previous call numbers. */
  aliases: SnapshotAlias[];
  /** Sources the file carries in full. */
  sources: SnapshotSource[];
  /** The revision written into the file, or null when it carries none. */
  revision: string | null;
  owned: boolean;
  unchanged: boolean;
  sha256: string | null;
}

/** A markdown file with no id: a note written by hand in the folder. */
export interface FreshNote {
  path: string;
  data: Record<string, unknown>;
  body: string;
  modifiedAt: string | null;
  /** The shelf its folder stands for, "LIF/GTH", when it sits in one the manifest knows. */
  folderShelf: string | null;
}

export interface MirrorRead {
  /** False when the folder has no manifest: only hand written notes can be read from it. */
  hasManifest: boolean;
  manifestUnchanged: boolean;
  sections: ExportSnapshot["sections"];
  shelves: ExportSnapshot["shelves"];
  tags: ExportSnapshot["tags"];
  /** Tags a file names that the manifest's vocabulary does not hold. */
  addedTags: Set<string>;
  projects: ExportSnapshot["projects"];
  /** Sources no memory cites, from the manifest. */
  uncitedSources: SnapshotSource[];
  retired: SnapshotAlias[];
  links: ExportSnapshot["links"];
  versions: SnapshotVersion[];
  /** Every number the manifest says was issued, with its memory. */
  issued: Array<{ call: string; memoryId: string }>;
  records: MirrorRecord[];
  fresh: FreshNote[];
  problems: MirrorFileProblem[];
}

/** A uuid shaped id derived from a seed, so reading the same folder twice gives the same ids. */
export function stableId(seed: string): string {
  const hash = createHash("sha256").update(seed, "utf8").digest("hex");
  const variant = ["8", "9", "a", "b"][parseInt(hash[16] as string, 16) & 3] as string;
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** One ref entry from front matter: an object as the mirror writes it, or a bare name written by hand. */
function refFrom(entry: unknown, role: SnapshotRef["role"], memoryId: string): unknown {
  if (typeof entry === "string") {
    return { id: stableId(`ref:${memoryId}:${role}:${entry}`), role, uri: null, label: entry, resolved: false };
  }
  const record = asRecord(entry);
  if (!record) return entry;
  const label = typeof record["label"] === "string" ? record["label"] : "";
  return {
    id: typeof record["id"] === "string" ? record["id"] : stableId(`ref:${memoryId}:${role}:${label}`),
    role,
    uri: record["uri"] ?? null,
    label,
    resolved: record["resolved"] ?? false,
  };
}

/** The shelf a hand written note's folder stands for, by folder name or by code. */
function shelfForFolder(
  path: string,
  sections: MirrorRead["sections"],
  shelves: Array<MirrorRead["shelves"][number] & { folder?: string | undefined }>,
): string | null {
  const segments = path.split("/");
  if (segments.length < 3) return null;
  const [sectionSegment, shelfSegment] = segments;
  const folders = libraryFolders({ sections, shelves });
  for (const shelf of shelves) {
    const section = sections.find((row) => row.id === shelf.sectionId);
    if (!section) continue;
    const byFolder = (shelf.folder ?? folders.shelves.get(shelf.id)) === `${sectionSegment}/${shelfSegment}`;
    const byCode = section.code === sectionSegment && shelf.code === shelfSegment;
    if (byFolder || byCode) return `${section.code}/${shelf.code}`;
  }
  return null;
}

/**
 * Read back what the adapter handed over. Each memory file is checked on its
 * own: one that does not parse, or names a shelf the manifest does not hold,
 * is reported for that file and left out, and the rest go on. The manifest is
 * the mirror's own; one that does not parse refuses the folder.
 *
 * Tags written in a file but missing from the vocabulary are added with a
 * colour picked by slug, and a source or ref written by hand without an id
 * gets one derived from the file, so reading the same folder twice gives the
 * same rows.
 */
export function readMirror(files: readonly MirrorReadFile[]): MirrorRead {
  const problems: MirrorFileProblem[] = [];
  const manifestFile = files.find((file) => file.path === MIRROR_MANIFEST_PATH);
  let manifest: z.output<typeof manifestSchema> | null = null;
  if (manifestFile) {
    if (manifestFile.error) throw new MirrorManifestError(`${MIRROR_MANIFEST_PATH}: ${manifestFile.error}`);
    const parsed = manifestSchema.safeParse(manifestFile.data);
    if (!parsed.success) throw new MirrorManifestError(`${MIRROR_MANIFEST_PATH}: ${issuesText(parsed.error)}`);
    manifest = parsed.data;
  }

  const toIso = (value: Date | null) => (value === null ? null : value.toISOString());
  const sections = (manifest?.sections ?? []).map(({ folder: _folder, ...row }) => row);
  const shelvesWithFolder = manifest?.shelves ?? [];
  const shelves = shelvesWithFolder.map(({ folder: _folder, ...row }) => row);
  const tags: MirrorRead["tags"] = (manifest?.tags ?? []).map((row) => ({ ...row }));
  const projects: MirrorRead["projects"] = (manifest?.projects ?? []).map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
  const sourceOut = (row: z.output<typeof snapshotSourceSchema>): SnapshotSource => ({
    ...row,
    occurredAt: toIso(row.occurredAt),
    createdAt: row.createdAt.toISOString(),
  });

  const sectionByCode = new Map(sections.map((row) => [row.code, row]));
  const shelfByCodes = new Map(
    shelves.map((row) => [`${sections.find((section) => section.id === row.sectionId)?.code ?? "?"}/${row.code}`, row]),
  );
  const tagBySlug = new Map(tags.map((row) => [row.slug, row]));
  const addedTags = new Set<string>();

  const records: MirrorRecord[] = [];
  const fresh: FreshNote[] = [];
  const byId = new Map<string, string>();
  const byCall = new Map<string, string>();

  const markdown = files
    .filter((file) => file.path !== MIRROR_MANIFEST_PATH && file.format === "markdown")
    // A file the mirror wrote wins over a copy of it a person made: it is read first.
    .sort((a, b) => Number(b.owned) - Number(a.owned) || compareText(a.path, b.path));

  for (const file of markdown) {
    if (file.error) {
      problems.push({ path: file.path, message: file.error });
      continue;
    }
    const data = file.data;
    if (!data || data["id"] === undefined || data["id"] === null) {
      fresh.push({
        path: file.path,
        data: data ?? {},
        body: file.body,
        modifiedAt: file.modifiedAt,
        folderShelf: shelfForFolder(file.path, sections, shelvesWithFolder),
      });
      continue;
    }
    const id = String(data["id"]);
    const call = typeof data["call"] === "string" ? data["call"] : "";
    const parts = parseCallNumber(call);
    if (!parts) {
      problems.push({ path: file.path, message: `"call" is not a call number such as LIF/GTH/2026-12-24/001.` });
      continue;
    }
    if (!sectionByCode.has(parts.section)) {
      problems.push({ path: file.path, message: `${call} names section ${parts.section}, which ${MIRROR_MANIFEST_PATH} does not hold.` });
      continue;
    }
    const shelf = shelfByCodes.get(`${parts.section}/${parts.shelf}`);
    if (!shelf) {
      problems.push({ path: file.path, message: `${call} names shelf ${parts.section}/${parts.shelf}, which ${MIRROR_MANIFEST_PATH} does not hold.` });
      continue;
    }

    // Tags by slug, normalised as every write path does; a new one joins the vocabulary.
    const tagIds: string[] = [];
    let badTag: string | null = null;
    for (const raw of asList(data["tags"])) {
      const slug = typeof raw === "string" ? normaliseTagSlug(raw) : null;
      if (slug === null) {
        badTag = String(raw);
        break;
      }
      let tag = tagBySlug.get(slug);
      if (!tag) {
        tag = { id: stableId(`tag:${slug}`), slug, colour: tagColourFor(slug) };
        tagBySlug.set(slug, tag);
        tags.push(tag);
        addedTags.add(tag.id);
      }
      if (!tagIds.includes(tag.id)) tagIds.push(tag.id);
    }
    if (badTag !== null) {
      problems.push({ path: file.path, message: `"${badTag}" is not a tag: lowercase letters, digits and hyphens.` });
      continue;
    }

    const refs = [
      ...asList(data["attendees"]).map((entry) => refFrom(entry, "attendee", id)),
      ...asList(data["occasions"] ?? data["occasion"]).map((entry) => refFrom(entry, "occasion", id)),
      ...asList(data["mentions"]).map((entry) => refFrom(entry, "mentions", id)),
    ];

    const citations: Array<{ sourceId: string; quote: unknown }> = [];
    const fileSources: unknown[] = [];
    for (const entry of asList(data["sources"])) {
      const record = asRecord(entry);
      if (!record) {
        citations.push({ sourceId: "", quote: entry });
        continue;
      }
      const sourceId =
        typeof record["id"] === "string" ? record["id"] : stableId(`source:${file.path}:${String(record["label"] ?? "")}`);
      citations.push({ sourceId, quote: record["quote"] });
      fileSources.push({
        id: sourceId,
        kind: record["kind"] ?? "file",
        uri: record["uri"] ?? null,
        label: record["label"],
        occurredAt: record["occurredAt"] ?? null,
        trust: record["trust"] ?? data["trust"],
        createdAt: record["createdAt"] ?? data["createdAt"],
      });
    }

    const candidate = {
      id,
      callNumber: call,
      shelfId: shelf.id,
      occurredOn: parts.day,
      seq: parts.seq,
      kind: data["kind"],
      scope: data["scope"] ?? "global",
      scopeRef: data["scopeRef"] ?? null,
      title: data["title"],
      body: file.body,
      why: data["why"] ?? null,
      howToApply: data["howToApply"] ?? null,
      importance: data["importance"] ?? 3,
      trust: data["trust"],
      state: data["state"] ?? "active",
      validFrom: data["validFrom"],
      validTo: data["validTo"] ?? null,
      supersededById: data["supersededBy"] ?? null,
      pinned: data["pinned"] ?? false,
      lastConfirmedAt: data["lastConfirmedAt"],
      lastRecalledAt: data["lastRecalledAt"] ?? null,
      recallCount: data["recallCount"] ?? 0,
      createdAt: data["createdAt"],
      updatedAt: data["updatedAt"] ?? data["createdAt"],
      tagIds,
      refs,
      sources: citations,
    };
    const parsed = snapshotMemorySchema.safeParse(candidate);
    if (!parsed.success) {
      problems.push({ path: file.path, message: issuesText(parsed.error) });
      continue;
    }
    const sourceRows: SnapshotSource[] = [];
    let badSource: string | null = null;
    for (const raw of fileSources) {
      const row = snapshotSourceSchema.safeParse(raw);
      if (!row.success) {
        badSource = issuesText(row.error);
        break;
      }
      sourceRows.push(sourceOut(row.data));
    }
    if (badSource !== null) {
      problems.push({ path: file.path, message: `sources: ${badSource}` });
      continue;
    }

    const aliases: SnapshotAlias[] = [];
    let badAlias: string | null = null;
    for (const entry of asList(data["previousCalls"])) {
      const record = asRecord(entry);
      const old = typeof entry === "string" ? entry : typeof record?.["call"] === "string" ? (record["call"] as string) : "";
      if (!parseCallNumber(old)) {
        badAlias = String(old);
        break;
      }
      const at = typeof record?.["at"] === "string" ? (record["at"] as string) : (parsed.data.createdAt.toISOString());
      aliases.push({ oldCallNumber: old, memoryId: id, createdAt: at });
    }
    if (badAlias !== null) {
      problems.push({ path: file.path, message: `previousCalls: "${badAlias}" is not a call number.` });
      continue;
    }

    const seenAt = byId.get(id);
    if (seenAt) {
      problems.push({ path: file.path, message: `Carries the same id as ${seenAt}. Left out; keep one of the two.` });
      continue;
    }
    const callAt = byCall.get(call);
    if (callAt) {
      problems.push({ path: file.path, message: `Carries the same call number as ${callAt}. Left out.` });
      continue;
    }
    byId.set(id, file.path);
    byCall.set(call, file.path);

    const memory = parsed.data;
    records.push({
      path: file.path,
      memory: {
        id: memory.id,
        callNumber: memory.callNumber,
        shelfId: memory.shelfId,
        occurredOn: parts.day,
        seq: memory.seq,
        kind: memory.kind,
        scope: memory.scope,
        scopeRef: memory.scopeRef,
        title: memory.title,
        body: memory.body,
        why: memory.why,
        howToApply: memory.howToApply,
        importance: memory.importance,
        trust: memory.trust,
        state: memory.state,
        validFrom: memory.validFrom.toISOString(),
        validTo: toIso(memory.validTo),
        supersededById: memory.supersededById,
        pinned: memory.pinned,
        lastConfirmedAt: memory.lastConfirmedAt.toISOString(),
        lastRecalledAt: toIso(memory.lastRecalledAt),
        recallCount: memory.recallCount,
        createdAt: memory.createdAt.toISOString(),
        updatedAt: memory.updatedAt.toISOString(),
        tagIds: memory.tagIds,
        refs: memory.refs.map((ref) => ({ ...ref })),
        sources: memory.sources.map((citation) => ({ ...citation })),
      },
      aliases,
      sources: sourceRows,
      revision: typeof data["revision"] === "string" ? data["revision"] : null,
      owned: file.owned,
      unchanged: file.unchanged,
      sha256: file.sha256,
    });
  }

  return {
    hasManifest: manifest !== null,
    manifestUnchanged: manifestFile?.unchanged ?? false,
    sections,
    shelves,
    tags,
    addedTags,
    projects,
    uncitedSources: (manifest?.sources ?? []).map(sourceOut),
    retired: (manifest?.retiredNumbers ?? []).map((row) => ({ oldCallNumber: row.call, memoryId: null, createdAt: row.at })),
    links: (manifest?.links ?? []).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    versions: (manifest?.versions ?? []).map((row) => ({ ...row, at: row.at.toISOString() })),
    issued: manifest?.issued ?? [],
    records,
    fresh,
    problems,
  };
}

/** The manifest is the mirror's own: when it does not parse, nothing is read from the folder. */
export class MirrorManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirrorManifestError";
  }
}

export interface AssembleOptions {
  /** Memory ids to take from the records. Every record when absent. */
  include?: ReadonlySet<string>;
  /**
   * When true, a call number the manifest says was issued to a memory the
   * folder no longer has a file for is written as retired, so a replace never
   * frees it for reissue. `at` is the time those rows record.
   */
  retireMissing?: { at: string } | false;
}

export interface Assembled {
  snapshot: ExportSnapshot;
  /** Memories in the snapshot whose replacement is not: their pointer was cleared here. */
  danglingSupersededBy: Map<string, string>;
}

/**
 * A snapshot from what readMirror found, for importSnapshot. Rows that point
 * at a memory the snapshot does not carry (links, versions, a replacement)
 * are left out or cleared, so the file validates, and `danglingSupersededBy`
 * says which replacement pointers were cleared for the caller to keep.
 */
export function assembleSnapshot(read: MirrorRead, options: AssembleOptions = {}): Assembled {
  const records = options.include ? read.records.filter((record) => options.include?.has(record.memory.id)) : read.records;
  const present = new Set(records.map((record) => record.memory.id));

  const sources = new Map<string, SnapshotSource>();
  for (const record of records) {
    for (const source of record.sources) if (!sources.has(source.id)) sources.set(source.id, source);
  }
  for (const source of read.uncitedSources) if (!sources.has(source.id)) sources.set(source.id, source);

  const danglingSupersededBy = new Map<string, string>();
  const memories = records.map((record) => {
    const target = record.memory.supersededById;
    if (target !== null && !present.has(target)) {
      danglingSupersededBy.set(record.memory.id, target);
      return { ...record.memory, supersededById: null };
    }
    return record.memory;
  });

  const aliases = new Map<string, SnapshotAlias>();
  for (const alias of read.retired) aliases.set(alias.oldCallNumber, alias);
  for (const record of records) for (const alias of record.aliases) aliases.set(alias.oldCallNumber, alias);
  if (options.retireMissing) {
    const held = new Set([...memories.map((memory) => memory.callNumber), ...aliases.keys()]);
    for (const issued of read.issued) {
      if (present.has(issued.memoryId) || held.has(issued.call)) continue;
      aliases.set(issued.call, { oldCallNumber: issued.call, memoryId: null, createdAt: options.retireMissing.at });
      held.add(issued.call);
    }
  }

  const usedTags = new Set(memories.flatMap((memory) => memory.tagIds));

  return {
    snapshot: {
      version: SNAPSHOT_VERSION,
      exportedAt: "",
      sections: read.sections.map((row) => ({ ...row })),
      shelves: read.shelves.map((row) => ({ ...row })),
      projects: read.projects.map((row) => ({ ...row })),
      // The vocabulary as the manifest holds it, plus any tag a file added.
      tags: read.tags.filter((tag) => usedTags.has(tag.id) || !read.addedTags.has(tag.id)).map((row) => ({ ...row })),
      sources: [...sources.values()].sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id)),
      memories,
      versions: read.versions.filter((row) => present.has(row.memoryId)),
      aliases: [...aliases.values()].sort((a, b) => compareText(a.oldCallNumber, b.oldCallNumber)),
      links: read.links.filter((row) => present.has(row.fromId) && present.has(row.toId)),
    },
    danglingSupersededBy,
  };
}
