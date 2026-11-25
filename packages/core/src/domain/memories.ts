// The commit primitives. docs/SPEC.md sections 4 and 13.
//
// Each runs in one transaction: the call number is issued inside it (never at
// proposal), the row, its tags, refs and sources are written, and a version is
// appended, so the FTS trigger and the history move with the row. No source,
// no memory. Discipline, events, audit and embeddings are wired around these
// by the caller, not here.

import type { Memory } from "../../generated/prisma/index.js";
import {
  memoryCreateSchema,
  memoryUpdateSchema,
  NO_SOURCE_MESSAGE,
  type MemoryCreateInput,
  type MemoryUpdateInput,
  type ParsedMemoryCreate,
} from "../schemas/memory.js";
import {
  memorySourceInputSchema,
  type MemorySourceInput,
  type ParsedMemorySource,
} from "../schemas/source.js";
import { issueCallNumber } from "./catalogue/call-number.js";
import { resolveShelf } from "./catalogue/shelving.js";
import { attachTagsRaw, parseInlineTags } from "./catalogue/tags.js";
import { atomic, type Db, type Tx } from "./db.js";
import { DomainError, parseInput } from "./errors.js";
import { appendVersion, memoryIdOf, type MutationOptions } from "./versions.js";

export type { Memory };

function hasSources(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const sources = (input as { sources?: unknown }).sources;
  return Array.isArray(sources) && sources.length > 0;
}

/** Refused before anything else is looked at: guardrail 2. */
function requireSource(input: unknown): void {
  if (!hasSources(input)) throw new DomainError("refused", NO_SOURCE_MESSAGE);
}

async function writeSources(tx: Tx, memoryId: string, sources: ParsedMemoryCreate["sources"]): Promise<void> {
  const seen = new Set<string>();
  for (const entry of sources) {
    let sourceId: string;
    if ("sourceId" in entry) {
      const existing = await tx.source.findUnique({ where: { id: entry.sourceId }, select: { id: true } });
      if (!existing) throw new DomainError("not_found", `No source with id ${entry.sourceId}.`);
      sourceId = existing.id;
    } else {
      const created = await tx.source.create({
        data: {
          kind: entry.source.kind,
          uri: entry.source.uri ?? null,
          label: entry.source.label,
          occurredAt: entry.source.occurredAt ?? null,
          trust: entry.source.trust,
        },
      });
      sourceId = created.id;
    }
    // One citation per source per memory: the first quote stands.
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    await tx.memorySource.create({ data: { memoryId, sourceId, quote: entry.quote } });
  }
}

async function createMemoryTx(
  tx: Tx,
  data: ParsedMemoryCreate,
  options: MutationOptions & { shelfId?: string; validFrom?: Date },
): Promise<Memory> {
  const shelfId = options.shelfId ?? (await resolveShelf(tx, data.shelf)).id;
  const issued = await issueCallNumber(tx, { shelfId, occurredOn: data.occurredOn });
  const at = options.at ?? new Date();

  const memory = await tx.memory.create({
    data: {
      callNumber: issued.callNumber,
      shelfId,
      occurredOn: data.occurredOn,
      seq: issued.seq,
      kind: data.kind,
      scope: data.scope,
      scopeRef: data.scope === "global" ? null : (data.scopeRef ?? null),
      title: data.title,
      body: data.body,
      why: data.why ?? null,
      howToApply: data.howToApply ?? null,
      importance: data.importance,
      trust: data.trust,
      validFrom: options.validFrom ?? data.validFrom ?? data.occurredOn,
      pinned: data.pinned,
      lastConfirmedAt: data.lastConfirmedAt ?? at,
    },
  });

  const tags = [...data.tags];
  for (const slug of parseInlineTags(data.body)) if (!tags.includes(slug)) tags.push(slug);
  await attachTagsRaw(tx, memory.id, tags);

  if (data.refs.length > 0) {
    await tx.memoryRef.createMany({
      data: data.refs.map((ref) => ({ memoryId: memory.id, ...ref })),
    });
  }
  await writeSources(tx, memory.id, data.sources);
  await appendVersion(tx, memory.id, { actor: options.actor, at, operation: "create" });

  return tx.memory.findUniqueOrThrow({ where: { id: memory.id } });
}

/**
 * A new active memory. Lands on Returns when no shelf is given. Refused with
 * no source. Inline #tags in the body are attached beside the given ones.
 * validFrom defaults to occurredOn.
 */
export async function createMemory(
  db: Db,
  input: MemoryCreateInput,
  options: MutationOptions,
): Promise<Memory> {
  requireSource(input);
  const data = parseInput(memoryCreateSchema, input);
  return atomic(db, (tx) => createMemoryTx(tx, data, options));
}

async function loadMemory(tx: Tx, memory: string | { id: string }): Promise<Memory> {
  const memoryId = await memoryIdOf(tx, memory);
  const row = await tx.memory.findUnique({ where: { id: memoryId } });
  if (!row) throw new DomainError("not_found", `No memory with id ${memoryId}.`);
  return row;
}

export interface UpdateResult {
  memory: Memory;
  /** False when the patch matched what was stored: no version is written. */
  changed: boolean;
}

/**
 * A new version of one memory, same call number. `operation` is `update` by
 * default and `refine` when reconcile says so. New inline #tags in a changed
 * body are attached; tags no longer written inline stay, because they may
 * have been attached by hand. A superseded entry is history and is refused.
 */
export async function updateMemory(
  db: Db,
  memory: string | { id: string },
  patch: MemoryUpdateInput,
  options: MutationOptions & { operation?: "update" | "refine" },
): Promise<UpdateResult> {
  const data = parseInput(memoryUpdateSchema, patch);
  return atomic(db, async (tx) => {
    const row = await loadMemory(tx, memory);
    if (row.state === "superseded") {
      throw new DomainError(
        "refused",
        `${row.callNumber} was superseded and is history. Change the entry that replaced it.`,
      );
    }

    const next = {
      title: data.title ?? row.title,
      body: data.body ?? row.body,
      why: data.why === undefined ? row.why : data.why,
      howToApply: data.howToApply === undefined ? row.howToApply : data.howToApply,
      importance: data.importance ?? row.importance,
    };
    const changed =
      next.title !== row.title ||
      next.body !== row.body ||
      next.why !== row.why ||
      next.howToApply !== row.howToApply ||
      next.importance !== row.importance;
    if (!changed) return { memory: row, changed: false };

    await tx.memory.update({ where: { id: row.id }, data: next });
    if (next.body !== row.body) await attachTagsRaw(tx, row.id, parseInlineTags(next.body));
    await appendVersion(tx, row.id, { ...options, operation: options.operation ?? "update" });
    return { memory: await tx.memory.findUniqueOrThrow({ where: { id: row.id } }), changed: true };
  });
}

export interface SupersedeResult {
  old: Memory;
  replacement: Memory;
}

/**
 * The world changed, not the wording. The old entry gets validTo, state
 * superseded and supersededById, and stays on its shelf with its number. The
 * replacement is a new memory with its own number, shelved at its own date, on
 * the old entry's shelf unless another is given.
 *
 * The replacement's validFrom defaults to the time of the commit (not its
 * occurredOn, as a plain create does), and the old entry's validTo is set to
 * exactly that instant, so the two windows meet without overlap. Starting
 * value.
 */
export async function supersedeMemory(
  db: Db,
  old: string | { id: string },
  replacement: MemoryCreateInput,
  options: MutationOptions,
): Promise<SupersedeResult> {
  requireSource(replacement);
  const data = parseInput(memoryCreateSchema, replacement);
  return atomic(db, async (tx) => {
    const previous = await loadMemory(tx, old);
    if (previous.state !== "active") {
      throw new DomainError("refused", `${previous.callNumber} is ${previous.state}; only an active entry is superseded.`);
    }
    const at = options.at ?? new Date();
    const validFrom = data.validFrom ?? at;
    if (validFrom.getTime() <= previous.validFrom.getTime()) {
      throw new DomainError(
        "invalid_input",
        `The replacement must become valid after ${previous.callNumber} did (${previous.validFrom.toISOString()}).`,
      );
    }

    const shelfId = data.shelf === undefined ? previous.shelfId : undefined;
    const created = await createMemoryTx(tx, data, {
      ...options,
      at,
      validFrom,
      ...(shelfId !== undefined ? { shelfId } : {}),
    });

    await tx.memory.update({
      where: { id: previous.id },
      data: { state: "superseded", validTo: validFrom, supersededById: created.id },
    });
    await appendVersion(tx, previous.id, { ...options, at, operation: "supersede" });

    return {
      old: await tx.memory.findUniqueOrThrow({ where: { id: previous.id } }),
      replacement: created,
    };
  });
}

// Sources --------------------------------------------------------------------

/**
 * The Source a citation names: the one given by id, or, for a new descriptor,
 * an existing row with the same kind, uri, label, occurredAt and trust, so
 * one session cited twice stays one Source. Made when there is none. Starting
 * value for the reuse rule.
 */
async function findOrCreateSource(
  tx: Tx,
  entry: ParsedMemorySource,
): Promise<{ sourceId: string; created: boolean }> {
  if ("sourceId" in entry) {
    const existing = await tx.source.findUnique({ where: { id: entry.sourceId }, select: { id: true } });
    if (!existing) throw new DomainError("not_found", `No source with id ${entry.sourceId}.`);
    return { sourceId: existing.id, created: false };
  }
  const data = {
    kind: entry.source.kind,
    uri: entry.source.uri ?? null,
    label: entry.source.label,
    occurredAt: entry.source.occurredAt ?? null,
    trust: entry.source.trust,
  };
  const same = await tx.source.findFirst({ where: data, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (same) return { sourceId: same.id, created: false };
  const created = await tx.source.create({ data });
  return { sourceId: created.id, created: true };
}

export interface AttachedSource {
  sourceId: string;
  /** False when the memory already cited this source: the first quote stands. */
  added: boolean;
  /** True when a new Source row was made for it. */
  sourceCreated: boolean;
}

/**
 * Cite one source on a memory inside an open transaction, with no version:
 * for a caller that writes its own version afterwards (reconcile).
 */
export async function attachSourceRaw(
  tx: Tx,
  memoryId: string,
  entry: ParsedMemorySource,
): Promise<AttachedSource> {
  const { sourceId, created } = await findOrCreateSource(tx, entry);
  const cited = await tx.memorySource.findUnique({
    where: { memoryId_sourceId: { memoryId, sourceId } },
    select: { memoryId: true },
  });
  if (cited) return { sourceId, added: false, sourceCreated: created };
  await tx.memorySource.create({ data: { memoryId, sourceId, quote: entry.quote } });
  return { sourceId, added: true, sourceCreated: created };
}

export interface AddSourceResult extends AttachedSource {
  memory: Memory;
}

/**
 * memory.add_source: attach a source and a quote (at most 500 characters) to
 * an existing memory, creating the Source or reusing one. Sources are part of
 * a version's content, so a new citation writes an `update` version, the same
 * operation a tag change writes. Citing a source the memory already cites
 * writes nothing: one citation per source per memory, the first quote stands.
 * A superseded entry is history and is refused, as updateMemory refuses it.
 */
export async function addSource(
  db: Db,
  memory: string | { id: string },
  input: MemorySourceInput,
  options: MutationOptions,
): Promise<AddSourceResult> {
  const entry = parseInput(memorySourceInputSchema, input);
  return atomic(db, async (tx) => {
    const row = await loadMemory(tx, memory);
    if (row.state === "superseded") {
      throw new DomainError(
        "refused",
        `${row.callNumber} was superseded and is history. Cite the source on the entry that replaced it.`,
      );
    }
    const attached = await attachSourceRaw(tx, row.id, entry);
    if (!attached.added) return { ...attached, memory: row };
    await appendVersion(tx, row.id, { ...options, operation: "update" });
    return { ...attached, memory: await tx.memory.findUniqueOrThrow({ where: { id: row.id } }) };
  });
}

/** Moves an active entry to the stacks: out of recall, browsable, history kept. */
export async function retireMemory(
  db: Db,
  memory: string | { id: string },
  options: MutationOptions,
): Promise<Memory> {
  return atomic(db, async (tx) => {
    const row = await loadMemory(tx, memory);
    if (row.state !== "active") {
      throw new DomainError("refused", `${row.callNumber} is ${row.state}; only an active entry is retired.`);
    }
    await tx.memory.update({ where: { id: row.id }, data: { state: "retired" } });
    await appendVersion(tx, row.id, { ...options, operation: "retire" });
    return tx.memory.findUniqueOrThrow({ where: { id: row.id } });
  });
}

/**
 * The owner says it is still true: moves lastConfirmedAt. Bookkeeping, like
 * recallCount, so it writes no version. Starting reading.
 */
export async function touchMemory(
  db: Db,
  memory: string | { id: string },
  options: { at?: Date } = {},
): Promise<Memory> {
  return atomic(db, async (tx) => {
    const row = await loadMemory(tx, memory);
    return tx.memory.update({
      where: { id: row.id },
      data: { lastConfirmedAt: options.at ?? new Date() },
    });
  });
}

/**
 * Sets or clears `pinned`. Pinned is a user-visible field, so a change writes
 * an `update` version; setting what is already set writes nothing.
 */
export async function pinMemory(
  db: Db,
  memory: string | { id: string },
  pinned: boolean,
  options: MutationOptions,
): Promise<Memory> {
  return atomic(db, async (tx) => {
    const row = await loadMemory(tx, memory);
    if (row.pinned === pinned) return row;
    await tx.memory.update({ where: { id: row.id }, data: { pinned } });
    await appendVersion(tx, row.id, { ...options, operation: "update" });
    return tx.memory.findUniqueOrThrow({ where: { id: row.id } });
  });
}
