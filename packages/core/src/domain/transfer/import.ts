import { z } from "zod";

import { RETURNS } from "../catalogue/shelving.js";
import { writeAlias } from "../catalogue/call-number.js";
import { atomic, type Db, type Tx } from "../db.js";
import { DomainError, parseInput } from "../errors.js";
import { appendVersion, serialiseContent, sha256, snapshotMemory } from "../versions.js";
import { diffSnapshots, type CollectionDiff } from "./diff.js";
import { buildExportSnapshot } from "./export.js";
import {
  snapshotSchema,
  toExportShape,
  type ParsedSnapshot,
  type ParsedSnapshotMemory,
  type SnapshotCollection,
} from "./snapshot.js";

export const importModeSchema = z.enum(["merge", "replace"]);
export type ImportMode = z.infer<typeof importModeSchema>;

/** Rows per table, for what a replace destroys and what an import writes. */
export type TableCounts = {
  sections: number;
  shelves: number;
  projects: number;
  tags: number;
  sources: number;
  memories: number;
  memoryTags: number;
  refs: number;
  /** MemorySource rows: a memory citing a source, with its quote. */
  citations: number;
  versions: number;
  aliases: number;
  links: number;
  embeddings: number;
};

export interface ReplacePlan {
  /** Every row a replace deletes before it writes the file. */
  destroys: TableCounts;
  /** Tables a replace leaves alone: the file carries none of them. */
  kept: { sessionNotes: number; recallLogs: number };
}

export type ImportCounts = Omit<TableCounts, "embeddings"> & {
  /**
   * Memories in the file that this silo has forgotten, left out by a merge:
   * importing an old backup never brings a forgotten memory back.
   */
  forgottenSkipped: number;
  /** Versions a merge appended for a memory whose content it changed. */
  versionsAppended: number;
};

export interface ImportResult {
  mode: ImportMode;
  counts: ImportCounts;
  /** What a replace deleted first, as planReplace reported it. Null for a merge. */
  destroyed: ReplacePlan | null;
  /**
   * Memories with no embedding after the import: every one a replace wrote,
   * and every one a merge created or whose body it changed. The host's
   * re-embed hook computes them; the snapshot carries no vectors.
   */
  needsEmbedding: string[];
}

export interface ImportOptions {
  /** Who a version appended by a merge names. Defaults to "import". */
  actor?: string;
  /** When. Defaults to now. Tests pin it. */
  at?: Date;
}

type IdMap = Map<string, string>;

function remap(map: IdMap, id: string): string {
  return map.get(id) ?? id;
}

function remapNullable(map: IdMap, id: string | null): string | null {
  return id === null ? null : remap(map, id);
}

function emptyCounts(): ImportCounts {
  return {
    sections: 0,
    shelves: 0,
    projects: 0,
    tags: 0,
    sources: 0,
    memories: 0,
    memoryTags: 0,
    refs: 0,
    citations: 0,
    versions: 0,
    aliases: 0,
    links: 0,
    forgottenSkipped: 0,
    versionsAppended: 0,
  };
}

/** Memory.tagText as core fills it: the slugs, sorted, space separated. */
function tagTextOf(tagIds: readonly string[], slugs: ReadonlyMap<string, string>): string {
  return tagIds
    .map((id) => slugs.get(id))
    .filter((slug): slug is string => slug !== undefined)
    .sort()
    .join(" ");
}

/**
 * Every column of a memory but supersededById, which points at another
 * memory and is written in a second pass once every row exists. updatedAt is
 * given explicitly so the file's value stands.
 */
function memoryScalars(memory: ParsedSnapshotMemory, shelfId: string, tagText: string) {
  return {
    callNumber: memory.callNumber,
    shelfId,
    occurredOn: memory.occurredOn,
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
    validFrom: memory.validFrom,
    validTo: memory.validTo,
    pinned: memory.pinned,
    lastConfirmedAt: memory.lastConfirmedAt,
    lastRecalledAt: memory.lastRecalledAt,
    recallCount: memory.recallCount,
    tagText,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

async function tableCounts(db: Db): Promise<TableCounts> {
  const [sections, shelves, projects, tags, sources, memories, memoryTags, refs, citations, versions, aliases, links, embeddings] =
    await Promise.all([
      db.section.count(),
      db.shelf.count(),
      db.project.count(),
      db.tag.count(),
      db.source.count(),
      db.memory.count(),
      db.memoryTag.count(),
      db.memoryRef.count(),
      db.memorySource.count(),
      db.memoryVersion.count(),
      db.callNumberAlias.count(),
      db.memoryLink.count(),
      db.embedding.count(),
    ]);
  return { sections, shelves, projects, tags, sources, memories, memoryTags, refs, citations, versions, aliases, links, embeddings };
}

/**
 * The row counts a replace will destroy, read before it runs, so the import
 * tool can name them and the owner confirms knowing the number (section 15,
 * section 25). Writes nothing.
 */
export async function planReplace(db: Db): Promise<ReplacePlan> {
  const [destroys, sessionNotes, recallLogs] = await Promise.all([
    tableCounts(db),
    db.sessionNote.count(),
    db.recallLog.count(),
  ]);
  return { destroys, kept: { sessionNotes, recallLogs } };
}

/**
 * The memories in a file that this silo has forgotten: the silo holds a
 * `forget` version for the id, or the number the file gives it is retired
 * here (an alias pointing at nothing, with no live holder).
 */
async function forgottenInSilo(db: Db, memories: readonly ParsedSnapshotMemory[]): Promise<Set<string>> {
  if (memories.length === 0) return new Set();
  const ids = memories.map((memory) => memory.id);
  const numbers = memories.map((memory) => memory.callNumber);
  const [forgets, retired, live] = await Promise.all([
    db.memoryVersion.findMany({ where: { operation: "forget", memoryId: { in: ids } }, select: { memoryId: true } }),
    db.callNumberAlias.findMany({ where: { memoryId: null, oldCallNumber: { in: numbers } }, select: { oldCallNumber: true } }),
    db.memory.findMany({ where: { callNumber: { in: numbers } }, select: { callNumber: true } }),
  ]);
  const forgottenIds = new Set(forgets.map((row) => row.memoryId));
  const liveNumbers = new Set(live.map((row) => row.callNumber));
  const retiredNumbers = new Set(retired.map((row) => row.oldCallNumber).filter((number) => !liveNumbers.has(number)));
  return new Set(
    memories
      .filter((memory) => forgottenIds.has(memory.id) || retiredNumbers.has(memory.callNumber))
      .map((memory) => memory.id),
  );
}

export interface ImportPlanCollection {
  collection: SnapshotCollection;
  add: number;
  change: number;
  remove: number;
  /** The first keys of each, capped for a readable preview. */
  keys: { add: string[]; change: string[]; remove: string[] };
}

export interface ImportPlan {
  mode: ImportMode;
  collections: ImportPlanCollection[];
  /** For a replace, what it destroys first. Null for a merge. */
  destroys: ReplacePlan | null;
  /**
   * Call numbers of memories in the file that this silo has forgotten. A
   * merge leaves them out; a replace restores the file as it is, so they
   * would come back, and the owner should see that before confirming.
   */
  forgottenInFile: string[];
}

/** How many keys of each kind a preview lists. Starting value. */
export const PLAN_KEYS_SHOWN = 20;

function planCollection(diff: CollectionDiff, mode: ImportMode): ImportPlanCollection {
  let changed = diff.changed;
  if (mode === "merge") {
    // What a merge actually changes: it never restores the content of a
    // redacted version, and never repoints a number that was retired here.
    if (diff.collection === "versions") {
      changed = changed.filter((row) =>
        row.fields.some((field) => field.path === "body" && field.after === null && field.before !== null),
      );
    }
    if (diff.collection === "aliases") {
      changed = changed.filter((row) =>
        row.fields.some((field) => field.path === "memoryId" && field.before !== null),
      );
    }
  }
  const add = diff.extra;
  const change = changed.map((row) => row.key);
  const remove = mode === "replace" ? diff.missing : [];
  return {
    collection: diff.collection,
    add: add.length,
    change: change.length,
    remove: remove.length,
    keys: {
      add: add.slice(0, PLAN_KEYS_SHOWN),
      change: change.slice(0, PLAN_KEYS_SHOWN),
      remove: remove.slice(0, PLAN_KEYS_SHOWN),
    },
  };
}

/**
 * What an import would add, change and remove, per collection, without
 * writing anything: the silo as it stands beside the file. A merge removes
 * no row (a memory's tags, refs and citations are replaced by the file's,
 * which shows as a change to that memory); a replace removes every row the
 * file does not carry.
 */
export async function planImport(db: Db, input: unknown, mode: ImportMode): Promise<ImportPlan> {
  const snapshot = parseInput(snapshotSchema, input);
  const [before, skipped] = await Promise.all([buildExportSnapshot(db), forgottenInSilo(db, snapshot.memories)]);
  const file = toExportShape(snapshot);
  if (mode === "merge" && skipped.size > 0) {
    file.memories = file.memories.filter((memory) => !skipped.has(memory.id));
    file.links = file.links.filter((link) => !skipped.has(link.fromId) && !skipped.has(link.toId));
  }
  const diff = diffSnapshots(before, file, { maxRowsReported: Number.POSITIVE_INFINITY });
  return {
    mode,
    collections: diff.collections.map((collection) => planCollection(collection, mode)),
    destroys: mode === "replace" ? await planReplace(db) : null,
    forgottenInFile: snapshot.memories
      .filter((memory) => skipped.has(memory.id))
      .map((memory) => memory.callNumber)
      .sort(),
  };
}

/* ------------------------------------------------------------------ */
/* Replace                                                             */
/* ------------------------------------------------------------------ */

/**
 * Everything the snapshot covers, in an order the Restrict relations allow.
 * Cascades would cover some of it; the explicit order keeps it obvious.
 * SessionNote and RecallLog are not in the file and are left alone.
 */
async function deleteEverything(tx: Tx): Promise<void> {
  await tx.memoryLink.deleteMany();
  await tx.memoryTag.deleteMany();
  await tx.memoryRef.deleteMany();
  await tx.memorySource.deleteMany();
  await tx.embedding.deleteMany();
  await tx.callNumberAlias.deleteMany();
  await tx.memoryVersion.deleteMany();
  await tx.memory.updateMany({ where: { supersededById: { not: null } }, data: { supersededById: null } });
  await tx.memory.deleteMany();
  await tx.project.deleteMany();
  await tx.source.deleteMany();
  await tx.tag.deleteMany();
  await tx.shelf.deleteMany();
  await tx.section.deleteMany();
}

async function createMany<T>(rows: T[], write: (data: T[]) => Promise<unknown>): Promise<number> {
  if (rows.length === 0) return 0;
  await write(rows);
  return rows.length;
}

async function insertAll(tx: Tx, snapshot: ParsedSnapshot): Promise<{ counts: ImportCounts; needsEmbedding: string[] }> {
  const counts = emptyCounts();
  const slugs = new Map(snapshot.tags.map((tag) => [tag.id, tag.slug]));

  counts.sections = await createMany(snapshot.sections, (data) => tx.section.createMany({ data }));
  counts.shelves = await createMany(snapshot.shelves, (data) => tx.shelf.createMany({ data }));
  counts.tags = await createMany(snapshot.tags, (data) => tx.tag.createMany({ data }));
  counts.projects = await createMany(snapshot.projects, (data) => tx.project.createMany({ data }));
  counts.sources = await createMany(snapshot.sources, (data) => tx.source.createMany({ data }));

  // The insert trigger indexes each row in memory_fts with its tagText.
  counts.memories = await createMany(
    snapshot.memories.map((memory) => ({
      id: memory.id,
      ...memoryScalars(memory, memory.shelfId, tagTextOf(memory.tagIds, slugs)),
    })),
    (data) => tx.memory.createMany({ data }),
  );
  for (const memory of snapshot.memories) {
    if (memory.supersededById === null) continue;
    await tx.memory.update({
      where: { id: memory.id },
      data: { supersededById: memory.supersededById, updatedAt: memory.updatedAt },
    });
  }

  counts.memoryTags = await createMany(
    snapshot.memories.flatMap((memory) => memory.tagIds.map((tagId) => ({ memoryId: memory.id, tagId }))),
    (data) => tx.memoryTag.createMany({ data }),
  );
  counts.refs = await createMany(
    snapshot.memories.flatMap((memory) => memory.refs.map((ref) => ({ ...ref, memoryId: memory.id }))),
    (data) => tx.memoryRef.createMany({ data }),
  );
  counts.citations = await createMany(
    snapshot.memories.flatMap((memory) => memory.sources.map((citation) => ({ ...citation, memoryId: memory.id }))),
    (data) => tx.memorySource.createMany({ data }),
  );
  counts.versions = await createMany(snapshot.versions, (data) => tx.memoryVersion.createMany({ data }));
  counts.aliases = await createMany(snapshot.aliases, (data) => tx.callNumberAlias.createMany({ data }));
  counts.links = await createMany(snapshot.links, (data) => tx.memoryLink.createMany({ data }));

  return { counts, needsEmbedding: snapshot.memories.map((memory) => memory.id) };
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

function conflict(message: string): DomainError {
  return new DomainError("conflict", message);
}

/**
 * Sections, shelves and tags carry natural keys. A row found by id keeps its
 * key (a code or slug that differs is a conflict: renaming a code moves call
 * numbers, and that is reshelving, not an import). A row whose id is new but
 * whose key is taken is the same row: the existing one wins its id and the
 * file's id is remapped onto it.
 */
async function mergeLibrary(
  tx: Tx,
  snapshot: ParsedSnapshot,
  counts: ImportCounts,
): Promise<{ shelfMap: IdMap; tagMap: IdMap }> {
  const sectionMap: IdMap = new Map();
  const shelfMap: IdMap = new Map();
  const tagMap: IdMap = new Map();

  for (const section of snapshot.sections) {
    const data = { name: section.name, order: section.order };
    const byId = await tx.section.findUnique({ where: { id: section.id } });
    if (byId) {
      if (byId.code !== section.code) {
        throw conflict(`Section ${section.id} is ${byId.code} here and ${section.code} in the file.`);
      }
      await tx.section.update({ where: { id: byId.id }, data });
    } else {
      const byCode = await tx.section.findUnique({ where: { code: section.code } });
      if (byCode) {
        sectionMap.set(section.id, byCode.id);
        await tx.section.update({ where: { id: byCode.id }, data });
      } else {
        await tx.section.create({ data: section });
      }
    }
    counts.sections += 1;
  }

  for (const shelf of snapshot.shelves) {
    const sectionId = remap(sectionMap, shelf.sectionId);
    const data = { name: shelf.name, description: shelf.description, order: shelf.order };
    const byId = await tx.shelf.findUnique({ where: { id: shelf.id } });
    if (byId) {
      if (byId.sectionId !== sectionId || byId.code !== shelf.code) {
        throw conflict(`Shelf ${shelf.id} sits elsewhere here than in the file. Reshelve it first, then import.`);
      }
      await tx.shelf.update({ where: { id: byId.id }, data });
    } else {
      const byKey = await tx.shelf.findUnique({ where: { sectionId_code: { sectionId, code: shelf.code } } });
      if (byKey) {
        shelfMap.set(shelf.id, byKey.id);
        await tx.shelf.update({ where: { id: byKey.id }, data });
      } else {
        await tx.shelf.create({ data: { ...shelf, sectionId } });
      }
    }
    counts.shelves += 1;
  }

  for (const tag of snapshot.tags) {
    const byId = await tx.tag.findUnique({ where: { id: tag.id } });
    if (byId) {
      if (byId.slug !== tag.slug) {
        throw conflict(`Tag ${tag.id} is #${byId.slug} here and #${tag.slug} in the file. Rename it first, then import.`);
      }
      await tx.tag.update({ where: { id: byId.id }, data: { colour: tag.colour } });
    } else {
      const bySlug = await tx.tag.findUnique({ where: { slug: tag.slug } });
      if (bySlug) {
        tagMap.set(tag.id, bySlug.id);
        await tx.tag.update({ where: { id: bySlug.id }, data: { colour: tag.colour } });
      } else {
        await tx.tag.create({ data: tag });
      }
    }
    counts.tags += 1;
  }

  for (const project of snapshot.projects) {
    const data = {
      slug: project.slug,
      name: project.name,
      repoUrl: project.repoUrl,
      shelfId: remapNullable(shelfMap, project.shelfId),
      tagId: remapNullable(tagMap, project.tagId),
      description: project.description,
      archived: project.archived,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    const existing =
      (await tx.project.findUnique({ where: { id: project.id } })) ??
      (await tx.project.findUnique({ where: { slug: project.slug } }));
    if (project.repoUrl !== null) {
      const holder = await tx.project.findUnique({ where: { repoUrl: project.repoUrl } });
      if (holder && holder.id !== (existing?.id ?? project.id)) {
        throw conflict(`${project.repoUrl} is already the repository of project ${holder.slug}.`);
      }
    }
    if (existing) await tx.project.update({ where: { id: existing.id }, data });
    else await tx.project.create({ data: { id: project.id, ...data } });
    counts.projects += 1;
  }

  return { shelfMap, tagMap };
}

async function contentHash(tx: Tx, memoryId: string): Promise<string> {
  return sha256(serialiseContent(await snapshotMemory(tx, memoryId)));
}

/**
 * The file wins row by row; nothing in the silo is deleted but what the file
 * replaces: a memory's tags, refs and citations become the file's. Ids are
 * kept, call numbers are kept verbatim (a number the file gives a memory that
 * another memory holds, or that names another memory here, is a conflict,
 * never a silent renumbering), and forget stays real: a memory this silo has
 * forgotten is left out, its versions arrive without content, and a number
 * retired here stays retired.
 */
async function mergeAll(
  tx: Tx,
  snapshot: ParsedSnapshot,
  options: Required<ImportOptions>,
): Promise<{ counts: ImportCounts; needsEmbedding: string[] }> {
  const counts = emptyCounts();
  const needsEmbedding: string[] = [];
  const { shelfMap, tagMap } = await mergeLibrary(tx, snapshot, counts);

  const skipped = await forgottenInSilo(tx, snapshot.memories);
  counts.forgottenSkipped = skipped.size;
  const live = snapshot.memories.filter((memory) => !skipped.has(memory.id));

  // A source cited only by memories left out is left out with them, as a
  // forget deletes a source nothing else cites.
  const citedByLive = new Set(live.flatMap((memory) => memory.sources.map((citation) => citation.sourceId)));
  const citedAtAll = new Set(snapshot.memories.flatMap((memory) => memory.sources.map((citation) => citation.sourceId)));
  for (const source of snapshot.sources) {
    if (citedAtAll.has(source.id) && !citedByLive.has(source.id)) continue;
    const { id, ...data } = source;
    await tx.source.upsert({ where: { id }, create: source, update: data });
    counts.sources += 1;
  }

  const slugs = new Map<string, string>();
  for (const tag of await tx.tag.findMany({ select: { id: true, slug: true } })) slugs.set(tag.id, tag.slug);

  const before = new Map<string, string>();
  const created: string[] = [];
  for (const memory of live) {
    const shelfId = remap(shelfMap, memory.shelfId);
    const tagIds = [...new Set(memory.tagIds.map((id) => remap(tagMap, id)))];
    const holder = await tx.memory.findUnique({ where: { callNumber: memory.callNumber }, select: { id: true } });
    if (holder && holder.id !== memory.id) {
      throw conflict(`${memory.callNumber} names another memory here. Call numbers are kept verbatim; import with replace, or move that memory first.`);
    }
    const alias = await tx.callNumberAlias.findUnique({ where: { oldCallNumber: memory.callNumber } });
    if (alias && alias.memoryId !== memory.id && !holder) {
      throw conflict(`${memory.callNumber} once named another memory here and is never reissued.`);
    }

    const scalars = memoryScalars(memory, shelfId, tagTextOf(tagIds, slugs));
    const existing = await tx.memory.findUnique({ where: { id: memory.id }, select: { callNumber: true, body: true } });
    if (existing) {
      before.set(memory.id, await contentHash(tx, memory.id));
      await tx.memory.update({ where: { id: memory.id }, data: scalars });
      if (existing.callNumber !== memory.callNumber) await writeAlias(tx, existing.callNumber, memory.id);
      if (existing.body !== memory.body) {
        await tx.embedding.deleteMany({ where: { memoryId: memory.id } });
        needsEmbedding.push(memory.id);
      }
    } else {
      await tx.memory.create({ data: { id: memory.id, ...scalars } });
      created.push(memory.id);
      needsEmbedding.push(memory.id);
    }

    await tx.memoryTag.deleteMany({ where: { memoryId: memory.id } });
    counts.memoryTags += await createMany(
      tagIds.map((tagId) => ({ memoryId: memory.id, tagId })),
      (data) => tx.memoryTag.createMany({ data }),
    );
    await tx.memoryRef.deleteMany({
      where: { OR: [{ memoryId: memory.id }, { id: { in: memory.refs.map((ref) => ref.id) } }] },
    });
    counts.refs += await createMany(
      memory.refs.map((ref) => ({ ...ref, memoryId: memory.id })),
      (data) => tx.memoryRef.createMany({ data }),
    );
    await tx.memorySource.deleteMany({ where: { memoryId: memory.id } });
    counts.citations += await createMany(
      memory.sources.map((citation) => ({ ...citation, memoryId: memory.id })),
      (data) => tx.memorySource.createMany({ data }),
    );
    counts.memories += 1;
  }

  for (const memory of live) {
    const supersededById =
      memory.supersededById !== null && skipped.has(memory.supersededById) ? null : memory.supersededById;
    const row = await tx.memory.findUniqueOrThrow({ where: { id: memory.id }, select: { supersededById: true } });
    if (row.supersededById === supersededById) continue;
    await tx.memory.update({ where: { id: memory.id }, data: { supersededById, updatedAt: memory.updatedAt } });
  }

  for (const version of snapshot.versions) {
    const existing = await tx.memoryVersion.findUnique({ where: { id: version.id }, select: { body: true } });
    if (existing) {
      // Redaction travels; content never comes back once cleared.
      if (version.body === null && existing.body !== null) {
        await tx.memoryVersion.update({ where: { id: version.id }, data: { body: null, contentSha256: null } });
      }
    } else {
      const forgotten = skipped.has(version.memoryId);
      await tx.memoryVersion.create({
        data: forgotten ? { ...version, body: null, contentSha256: null } : version,
      });
    }
    counts.versions += 1;
  }

  for (const alias of snapshot.aliases) {
    const memoryId = alias.memoryId !== null && skipped.has(alias.memoryId) ? null : alias.memoryId;
    const existing = await tx.callNumberAlias.findUnique({ where: { oldCallNumber: alias.oldCallNumber } });
    if (existing) {
      // A number retired here stays retired.
      if (existing.memoryId !== null && existing.memoryId !== memoryId) {
        await tx.callNumberAlias.update({ where: { oldCallNumber: alias.oldCallNumber }, data: { memoryId } });
      }
    } else {
      await tx.callNumberAlias.create({ data: { ...alias, memoryId } });
    }
    counts.aliases += 1;
  }

  for (const link of snapshot.links) {
    if (skipped.has(link.fromId) || skipped.has(link.toId)) continue;
    const pair = await tx.memoryLink.findUnique({
      where: { fromId_toId_relation: { fromId: link.fromId, toId: link.toId, relation: link.relation } },
    });
    if (!pair) {
      const idTaken = await tx.memoryLink.findUnique({ where: { id: link.id }, select: { id: true } });
      const { id, ...data } = link;
      await tx.memoryLink.create({ data: idTaken ? data : { id, ...data } });
    }
    counts.links += 1;
  }

  // History holds every content a memory has had (supersede, never
  // overwrite). The file's versions usually already record what the merge
  // wrote; when none does, one version records the import.
  const mutation = { actor: options.actor, at: options.at };
  for (const [memoryId, hashBefore] of before) {
    const hashAfter = await contentHash(tx, memoryId);
    if (hashAfter === hashBefore) continue;
    const recorded = await tx.memoryVersion.count({ where: { memoryId, contentSha256: hashAfter } });
    if (recorded > 0) continue;
    await appendVersion(tx, memoryId, { ...mutation, operation: "update" });
    counts.versionsAppended += 1;
  }
  for (const memoryId of created) {
    if ((await tx.memoryVersion.count({ where: { memoryId } })) > 0) continue;
    await appendVersion(tx, memoryId, { ...mutation, operation: "create" });
    counts.versionsAppended += 1;
  }

  return { counts, needsEmbedding };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function hasReturns(snapshot: ParsedSnapshot): boolean {
  const desk = snapshot.sections.find((section) => section.code === RETURNS.section);
  return desk !== undefined && snapshot.shelves.some((shelf) => shelf.sectionId === desk.id && shelf.code === RETURNS.shelf);
}

/**
 * Read a snapshot back into the silo, in one transaction. `merge` keeps what
 * is already there and lets the file win row by row; `replace` deletes every
 * table the snapshot covers first (planReplace names the counts beforehand)
 * and then writes the file verbatim. memory_fts follows through its
 * triggers, so search finds every imported memory.
 *
 * A replace with a file that has no Returns shelf is refused: nothing may be
 * left without a home, and Returns always exists.
 */
export async function importSnapshot(
  db: Db,
  input: unknown,
  mode: ImportMode,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const parsedMode = parseInput(importModeSchema, mode);
  const snapshot = parseInput(snapshotSchema, input);
  if (parsedMode === "replace" && !hasReturns(snapshot)) {
    throw new DomainError(
      "refused",
      `Refusing to replace the library with a file that has no ${RETURNS.section}/${RETURNS.shelf} shelf: Returns always exists.`,
    );
  }
  const resolved: Required<ImportOptions> = { actor: options.actor ?? "import", at: options.at ?? new Date() };

  return atomic(db, async (tx) => {
    if (parsedMode === "replace") {
      const destroyed = await planReplace(tx);
      await deleteEverything(tx);
      const written = await insertAll(tx, snapshot);
      return { mode: parsedMode, destroyed, ...written };
    }
    const written = await mergeAll(tx, snapshot, resolved);
    return { mode: parsedMode, destroyed: null, ...written };
  });
}
