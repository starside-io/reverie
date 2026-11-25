// Immutable history. docs/SPEC.md sections 4, 11 and 16 ("Supersede, never
// overwrite", "Forget is real").
//
// Every mutation of a memory appends one MemoryVersion: the operation, who made
// it, and the user-visible fields as JSON text with their hash. Nothing edits a
// version except redaction, which clears the content and the hash and keeps
// the operation, the actor and the time.

import { createHash } from "node:crypto";

import { dayKey } from "../schemas/common.js";
import type { RefRole, VersionOperation } from "../schemas/enums.js";
import { aliasesOf, resolveCallNumber, writeAlias } from "./catalogue/call-number.js";
import { atomic, type Db, type Tx } from "./db.js";
import { DomainError } from "./errors.js";

/** The user-visible fields of one memory at one moment. Keys in a fixed order. */
export interface VersionContent {
  callNumber: string;
  shelf: string;
  occurredOn: string;
  kind: string;
  scope: string;
  scopeRef: string | null;
  title: string;
  body: string;
  why: string | null;
  howToApply: string | null;
  importance: number;
  trust: string;
  state: string;
  validFrom: string;
  validTo: string | null;
  supersededById: string | null;
  pinned: boolean;
  tags: string[];
  refs: Array<{ role: RefRole; uri: string | null; label: string; resolved: boolean }>;
  sources: Array<{ sourceId: string; quote: string }>;
}

export interface VersionRow {
  id: string;
  memoryId: string;
  operation: VersionOperation;
  actor: string;
  at: Date;
  contentSha256: string | null;
  /** Null once redacted. */
  content: VersionContent | null;
}

export interface MutationOptions {
  /** Who made the change: "user", "proposal:<id>", "import". */
  actor: string;
  /** When. Defaults to now. Tests pin it. */
  at?: Date;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The content of a memory as it stands, read from the silo. */
export async function snapshotMemory(db: Db, memoryId: string): Promise<VersionContent> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    include: {
      shelf: { include: { section: true } },
      tags: { include: { tag: true } },
      refs: true,
      sources: true,
    },
  });
  if (!memory) throw new DomainError("not_found", `No memory with id ${memoryId}.`);

  return {
    callNumber: memory.callNumber,
    shelf: `${memory.shelf.section.code}/${memory.shelf.code}`,
    occurredOn: dayKey(memory.occurredOn),
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
    validTo: memory.validTo ? memory.validTo.toISOString() : null,
    supersededById: memory.supersededById,
    pinned: memory.pinned,
    tags: memory.tags.map((row) => row.tag.slug).sort(compareText),
    refs: memory.refs
      .map((ref) => ({
        role: ref.role as RefRole,
        uri: ref.uri,
        label: ref.label,
        resolved: ref.resolved,
      }))
      .sort(
        (a, b) =>
          compareText(a.role, b.role) ||
          compareText(a.label, b.label) ||
          compareText(a.uri ?? "", b.uri ?? ""),
      ),
    sources: memory.sources
      .map((row) => ({ sourceId: row.sourceId, quote: row.quote }))
      .sort((a, b) => compareText(a.sourceId, b.sourceId)),
  };
}

/** The JSON text a version stores. Deterministic: same content, same bytes. */
export function serialiseContent(content: VersionContent): string {
  return JSON.stringify(content);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Append one version. With no content given, the memory is read as it stands
 * now. `null` writes a row with no content, for a forget.
 *
 * Times within one memory's history strictly increase: two writes in the same
 * millisecond would otherwise tie, and history has to read in order.
 */
export async function appendVersion(
  tx: Tx,
  memoryId: string,
  input: MutationOptions & { operation: VersionOperation; content?: VersionContent | null },
): Promise<VersionRow> {
  const content =
    input.content === undefined ? await snapshotMemory(tx, memoryId) : input.content;
  const body = content === null ? null : serialiseContent(content);

  const last = await tx.memoryVersion.findFirst({
    where: { memoryId },
    orderBy: { at: "desc" },
    select: { at: true },
  });
  let at = input.at ?? new Date();
  if (last && at.getTime() <= last.at.getTime()) at = new Date(last.at.getTime() + 1);

  const row = await tx.memoryVersion.create({
    data: {
      memoryId,
      operation: input.operation,
      actor: input.actor,
      contentSha256: body === null ? null : sha256(body),
      body,
      at,
    },
  });
  return toVersionRow(row);
}

function toVersionRow(row: {
  id: string;
  memoryId: string;
  operation: string;
  actor: string;
  at: Date;
  contentSha256: string | null;
  body: string | null;
}): VersionRow {
  return {
    id: row.id,
    memoryId: row.memoryId,
    operation: row.operation as VersionOperation,
    actor: row.actor,
    at: row.at,
    contentSha256: row.contentSha256,
    content: row.body === null ? null : (JSON.parse(row.body) as VersionContent),
  };
}

/** Every version of one memory, oldest first. Redacted rows keep their place. */
export async function history(db: Db, memoryId: string): Promise<VersionRow[]> {
  const rows = await db.memoryVersion.findMany({
    where: { memoryId },
    orderBy: { at: "asc" },
  });
  return rows.map(toVersionRow);
}

export interface AsOfResult {
  memoryId: string;
  callNumber: string;
  /** The version that held at that time. */
  version: VersionRow;
  /** Null when that version was redacted. */
  content: VersionContent | null;
}

/** Every memory in one supersede chain, either direction. */
async function supersedeChain(db: Db, memoryId: string): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [memoryId];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = await db.memory.findUnique({
      where: { id },
      select: { supersededById: true, supersedes: { select: { id: true } } },
    });
    if (!row) continue;
    if (row.supersededById) queue.push(row.supersededById);
    for (const older of row.supersedes) queue.push(older.id);
  }
  return [...seen];
}

/**
 * What was valid at one time, starting from any memory in a supersede chain.
 *
 * The entry is the one whose validFrom to validTo window holds `at` (validTo
 * exclusive, open when null). Its content is the latest version written at or
 * before `at`; when the entry was recorded after `at` (a memory written today
 * about a fact true since last year), its first version stands for it. Null
 * when nothing in the chain was valid then. Starting reading: the design names
 * asOf without fixing how record time and valid time combine.
 */
export async function asOf(db: Db, memoryId: string, at: Date): Promise<AsOfResult | null> {
  const ids = await supersedeChain(db, memoryId);
  const rows = await db.memory.findMany({
    where: {
      id: { in: ids },
      validFrom: { lte: at },
      OR: [{ validTo: null }, { validTo: { gt: at } }],
    },
    orderBy: { validFrom: "desc" },
    select: { id: true, callNumber: true },
  });
  const entry = rows[0];
  if (!entry) return null;

  const versions = await history(db, entry.id);
  const before = versions.filter((version) => version.at.getTime() <= at.getTime());
  const version = before[before.length - 1] ?? versions[0];
  if (!version) return null;
  return { memoryId: entry.id, callNumber: entry.callNumber, version, content: version.content };
}

/** Clears content and hash from every version of a memory, or every one but those kept. */
async function clearVersions(tx: Tx, memoryId: string, keepIds: string[] = []): Promise<number> {
  const result = await tx.memoryVersion.updateMany({
    where: { memoryId, id: { notIn: keepIds } },
    data: { body: null, contentSha256: null },
  });
  return result.count;
}

/**
 * Redact the past of a memory that stays: every version but the newest one
 * with content loses its content and hash, and a `redact` row records who did
 * it and when. Operation, actor and time survive on every row.
 */
export async function redactMemory(
  db: Db,
  memoryId: string,
  options: MutationOptions,
): Promise<{ redacted: number }> {
  return atomic(db, async (tx) => {
    const exists = await tx.memory.findUnique({ where: { id: memoryId }, select: { id: true } });
    if (!exists) throw new DomainError("not_found", `No memory with id ${memoryId}.`);
    const latest = await tx.memoryVersion.findFirst({
      where: { memoryId, body: { not: null } },
      orderBy: { at: "desc" },
      select: { id: true },
    });
    const redacted = await clearVersions(tx, memoryId, latest ? [latest.id] : []);
    await appendVersion(tx, memoryId, { ...options, operation: "redact", content: null });
    return { redacted };
  });
}

export interface ForgetResult {
  memoryId: string;
  callNumber: string;
  /** Every number that named it, now pointing at nothing. */
  retiredNumbers: string[];
  /** Sources cited by no other memory, deleted with it. */
  sourcesDeleted: number;
  /** Its tags that no other memory carries and no project points at, deleted with it. */
  tagsDeleted: number;
}

/**
 * Forget, in storage terms (section 11). The row goes, which cascades its tags,
 * refs, sources and vector, and the FTS trigger drops its index entry. Its
 * current number and every alias stay in CallNumberAlias pointing at nothing,
 * so none is ever reissued. Every version keeps operation, actor and time and
 * loses its content. A Source cited by no other memory goes too, so nothing
 * forgotten survives in a label. Starting value for that last part. A tag the
 * forgotten memory carried that no memory carries any more and no project
 * points at goes the same way, so its slug does not outlive it in the
 * vocabulary. Only forget does this: a tag emptied by detach or merge stays.
 *
 * Takes a memory id or a call number (current or alias).
 */
export async function forgetMemory(
  db: Db,
  memory: string | { id: string },
  options: MutationOptions,
): Promise<ForgetResult> {
  return atomic(db, async (tx) => {
    const memoryId = await memoryIdOf(tx, memory);
    const row = await tx.memory.findUnique({
      where: { id: memoryId },
      select: {
        id: true,
        callNumber: true,
        sources: { select: { sourceId: true } },
        tags: { select: { tagId: true } },
      },
    });
    if (!row) throw new DomainError("not_found", `No memory with id ${memoryId}.`);

    const oldNumbers = await aliasesOf(tx, memoryId);
    await writeAlias(tx, row.callNumber, null);
    await tx.callNumberAlias.updateMany({ where: { memoryId }, data: { memoryId: null } });

    await appendVersion(tx, memoryId, { ...options, operation: "forget", content: null });
    await clearVersions(tx, memoryId);

    await tx.memory.delete({ where: { id: memoryId } });

    let sourcesDeleted = 0;
    for (const { sourceId } of row.sources) {
      const stillCited = await tx.memorySource.count({ where: { sourceId } });
      if (stillCited === 0) {
        await tx.source.delete({ where: { id: sourceId } });
        sourcesDeleted += 1;
      }
    }

    let tagsDeleted = 0;
    for (const { tagId } of row.tags) {
      const stillCarried = await tx.memoryTag.count({ where: { tagId } });
      const projects = await tx.project.count({ where: { tagId } });
      if (stillCarried === 0 && projects === 0) {
        await tx.tag.delete({ where: { id: tagId } });
        tagsDeleted += 1;
      }
    }

    return {
      memoryId,
      callNumber: row.callNumber,
      retiredNumbers: [row.callNumber, ...oldNumbers].sort(compareText),
      sourcesDeleted,
      tagsDeleted,
    };
  });
}

/** A memory id from an id or a call number, current or alias. */
export async function memoryIdOf(db: Db, memory: string | { id: string }): Promise<string> {
  if (typeof memory !== "string") return memory.id;
  if (!memory.includes("/")) return memory;
  const resolved = await resolveCallNumber(db, memory);
  if (resolved.status === "current" || resolved.status === "alias") return resolved.memoryId;
  if (resolved.status === "forgotten") {
    throw new DomainError("not_found", `${memory} was forgotten. Its number points at nothing.`);
  }
  throw new DomainError("not_found", `No memory has the call number ${memory}.`);
}
