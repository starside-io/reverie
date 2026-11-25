import type { z } from "zod";

import { dayKey } from "../../schemas/common.js";
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
import { atomic, type Db } from "../db.js";
import { SNAPSHOT_VERSION, type ExportSnapshot } from "./snapshot.js";

/**
 * An enum column on the way out. SQLite hands these back as plain strings, so
 * they are checked against the zod enum rather than trusted: the CHECK
 * constraints should make a bad value impossible, and a snapshot is the worst
 * place to find out they did not.
 */
function enumValue<T extends string>(schema: z.ZodEnum<[T, ...T[]]>, value: string, column: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${column} holds "${value}", which is not one of its allowed values`);
  }
  return parsed.data;
}

function timestamp(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The whole library as one JSON object (snapshot.ts says what is in it and
 * what is not). Ids are preserved so a snapshot imports back over the same
 * silo without duplicating anything, and every collection is in a fixed order
 * (library order for memories, natural keys elsewhere), so the same silo
 * exports the same bytes bar `exportedAt`. Read inside one transaction, so a
 * write landing halfway through cannot leave a memory citing a source the
 * file does not carry.
 */
export async function buildExportSnapshot(db: Db, options: { now?: Date } = {}): Promise<ExportSnapshot> {
  const [sections, shelves, projects, tags, sources, memories, versions, aliases, links] = await atomic(db, (tx) => Promise.all([
    tx.section.findMany({ orderBy: [{ order: "asc" }, { code: "asc" }] }),
    tx.shelf.findMany({ include: { section: { select: { order: true, code: true } } } }),
    tx.project.findMany({ orderBy: { slug: "asc" } }),
    tx.tag.findMany({ orderBy: { slug: "asc" } }),
    tx.source.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    tx.memory.findMany({
      orderBy: { callNumber: "asc" },
      include: {
        tags: { select: { tagId: true } },
        refs: true,
        sources: { select: { sourceId: true, quote: true } },
      },
    }),
    tx.memoryVersion.findMany({ orderBy: [{ memoryId: "asc" }, { at: "asc" }, { id: "asc" }] }),
    tx.callNumberAlias.findMany({ orderBy: { oldCallNumber: "asc" } }),
    tx.memoryLink.findMany({ orderBy: [{ fromId: "asc" }, { toId: "asc" }, { relation: "asc" }] }),
  ]));

  shelves.sort(
    (a, b) =>
      a.section.order - b.section.order ||
      compareText(a.section.code, b.section.code) ||
      a.order - b.order ||
      compareText(a.code, b.code),
  );

  return {
    version: SNAPSHOT_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    sections: sections.map((section) => ({
      id: section.id,
      code: section.code,
      name: section.name,
      order: section.order,
    })),
    shelves: shelves.map((shelf) => ({
      id: shelf.id,
      sectionId: shelf.sectionId,
      code: shelf.code,
      name: shelf.name,
      description: shelf.description,
      order: shelf.order,
    })),
    // Every column the silo has for a project. There is no folder path among
    // them: paths are the host's, in host.db.
    projects: projects.map((project) => ({
      id: project.id,
      slug: project.slug,
      name: project.name,
      repoUrl: project.repoUrl,
      shelfId: project.shelfId,
      tagId: project.tagId,
      description: project.description,
      archived: project.archived,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    })),
    tags: tags.map((tag) => ({ id: tag.id, slug: tag.slug, colour: tag.colour })),
    sources: sources.map((source) => ({
      id: source.id,
      kind: enumValue(SourceKind, source.kind, "Source.kind"),
      uri: source.uri,
      label: source.label,
      occurredAt: timestamp(source.occurredAt),
      trust: enumValue(TrustTier, source.trust, "Source.trust"),
      createdAt: source.createdAt.toISOString(),
    })),
    memories: memories.map((memory) => ({
      id: memory.id,
      callNumber: memory.callNumber,
      shelfId: memory.shelfId,
      occurredOn: dayKey(memory.occurredOn),
      seq: memory.seq,
      kind: enumValue(MemoryKind, memory.kind, "Memory.kind"),
      scope: enumValue(MemoryScope, memory.scope, "Memory.scope"),
      scopeRef: memory.scopeRef,
      title: memory.title,
      body: memory.body,
      why: memory.why,
      howToApply: memory.howToApply,
      importance: memory.importance,
      trust: enumValue(TrustTier, memory.trust, "Memory.trust"),
      state: enumValue(MemoryState, memory.state, "Memory.state"),
      validFrom: memory.validFrom.toISOString(),
      validTo: timestamp(memory.validTo),
      supersededById: memory.supersededById,
      pinned: memory.pinned,
      lastConfirmedAt: memory.lastConfirmedAt.toISOString(),
      lastRecalledAt: timestamp(memory.lastRecalledAt),
      recallCount: memory.recallCount,
      createdAt: memory.createdAt.toISOString(),
      updatedAt: memory.updatedAt.toISOString(),
      tagIds: memory.tags.map((row) => row.tagId).sort(compareText),
      refs: memory.refs
        .map((ref) => ({
          id: ref.id,
          role: enumValue(RefRole, ref.role, "MemoryRef.role"),
          uri: ref.uri,
          label: ref.label,
          resolved: ref.resolved,
        }))
        .sort((a, b) => compareText(a.role, b.role) || compareText(a.label, b.label) || compareText(a.id, b.id)),
      sources: memory.sources
        .map((row) => ({ sourceId: row.sourceId, quote: row.quote }))
        .sort((a, b) => compareText(a.sourceId, b.sourceId)),
    })),
    versions: versions.map((version) => ({
      id: version.id,
      memoryId: version.memoryId,
      operation: enumValue(VersionOperation, version.operation, "MemoryVersion.operation"),
      actor: version.actor,
      contentSha256: version.contentSha256,
      body: version.body,
      at: version.at.toISOString(),
    })),
    aliases: aliases.map((alias) => ({
      oldCallNumber: alias.oldCallNumber,
      memoryId: alias.memoryId,
      createdAt: alias.createdAt.toISOString(),
    })),
    links: links.map((link) => ({
      id: link.id,
      fromId: link.fromId,
      toId: link.toId,
      relation: enumValue(LinkRelation, link.relation, "MemoryLink.relation"),
      createdAt: link.createdAt.toISOString(),
    })),
  };
}

/** Local calendar date, used to name an exported file. */
export function fileStamp(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
