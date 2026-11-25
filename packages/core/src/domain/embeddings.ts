// The write side of the vector cache. docs/SPEC.md section 11 (`Embedding`:
// a cache of body and model), section 12 (`models` is used from core for
// `embed()` only), section 13 (the embedding comes after FTS, computed before
// the transaction opens), section 17 (the cache rule and the re-embed hook).
//
// The read side is queries/vectors.ts and memory.recall. Every vector written
// here goes through encodeVector, so the two agree on the bytes.
//
// One rule runs through all of it: a model call never happens while a
// transaction is open. Computing a vector can take as long as the model
// likes, and the silo has one writer, so holding it across that call would
// stall every other session. Each function here computes first and writes
// after, in short writes of its own.
//
// Where the write lands, decided once for every write path: immediately after
// the memory's own commit, not inside it. The commit functions (createMemory,
// updateMemory, supersedeMemory, mergeMemories, importSnapshot) each open
// their own transaction, and threading a vector through every one of them
// would change most of the domain for a row that is a cache. The vector is
// computed before the commit opens and written right after it returns. A
// vector that could not be computed leaves no row: a stale one is deleted, so
// recall never ranks a memory by text it no longer holds.

import { encodeVector } from "./queries/vectors.js";
import type { Db } from "./db.js";

/** What core asks of a models port: one vector per text, in order. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** The configured model, and its dimension when config gives one. */
export interface EmbeddingTarget {
  model: string;
  /** Null when config leaves it open: the first vector's length is taken. */
  dim: number | null;
}

/** What a memory's vector is computed from: its title and body, the two fields recall matches on. */
export function embeddingText(memory: { title: string; body: string }): string {
  return `${memory.title}\n\n${memory.body}`;
}

/** A vector computed ahead of a commit, or the reason it could not be. */
export type PreparedVector =
  | { status: "ready"; model: string; dim: number; vector: number[] }
  | { status: "failed"; model: string; reason: string };

/** How a memory's vector stands after a write. */
export type EmbeddingOutcome =
  | { status: "written"; model: string }
  | { status: "missing"; model: string; reason: string };

function checkVector(vector: unknown, target: EmbeddingTarget): { dim: number; vector: number[] } | string {
  if (!Array.isArray(vector) || vector.length === 0) return "The model returned no vector.";
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return "The model returned a vector with a value that is not a finite number.";
  }
  if (target.dim !== null && vector.length !== target.dim) {
    return `The model returned ${vector.length} values; embedding.dim is ${target.dim}.`;
  }
  return { dim: vector.length, vector: vector as number[] };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Computes one vector. Never throws: a model that fails or answers in the
 * wrong shape comes back as `failed` with the reason, because an embed
 * failure must not fail the write it belongs to.
 */
export async function prepareVector(embed: EmbedFn, target: EmbeddingTarget, text: string): Promise<PreparedVector> {
  try {
    const [vector] = await embed([text]);
    const checked = checkVector(vector, target);
    if (typeof checked === "string") return { status: "failed", model: target.model, reason: checked };
    return { status: "ready", model: target.model, ...checked };
  } catch (error) {
    return { status: "failed", model: target.model, reason: reasonOf(error) };
  }
}

/**
 * Writes a prepared vector for one memory, replacing whatever row it had.
 * A failed one deletes the row instead, so no vector of an older body or an
 * older model outlives the write. A memory that is gone by now (forgotten
 * between the commit and this write) is left alone.
 */
export async function storeVector(db: Db, memoryId: string, prepared: PreparedVector): Promise<EmbeddingOutcome> {
  if (prepared.status === "failed") {
    await db.embedding.deleteMany({ where: { memoryId } });
    return { status: "missing", model: prepared.model, reason: prepared.reason };
  }
  const exists = await db.memory.findUnique({ where: { id: memoryId }, select: { id: true } });
  if (!exists) return { status: "missing", model: prepared.model, reason: "The memory is no longer in the silo." };
  const data = { model: prepared.model, dim: prepared.dim, vector: encodeVector(prepared.vector) };
  await db.embedding.upsert({ where: { memoryId }, create: { memoryId, ...data }, update: data });
  return { status: "written", model: prepared.model };
}

/** How many texts go to the model in one embed call. Starting value. */
export const EMBED_BATCH_SIZE = 32;

/**
 * Computes vectors for many texts ahead of one commit, a batch per model
 * call, keyed by memory id. Never throws: a batch the model fails comes back
 * as `failed` for each of its memories.
 */
export async function prepareVectors(
  embed: EmbedFn,
  target: EmbeddingTarget,
  items: ReadonlyArray<{ memoryId: string; text: string }>,
  batchSize: number = EMBED_BATCH_SIZE,
): Promise<Map<string, PreparedVector>> {
  const out = new Map<string, PreparedVector>();
  let dim = target.dim;
  for (let start = 0; start < items.length; start += batchSize) {
    const slice = items.slice(start, start + batchSize);
    let vectors: number[][];
    try {
      vectors = await embed(slice.map((item) => item.text));
    } catch (error) {
      for (const item of slice) out.set(item.memoryId, { status: "failed", model: target.model, reason: reasonOf(error) });
      continue;
    }
    for (const [index, item] of slice.entries()) {
      const checked = checkVector(vectors[index], { model: target.model, dim });
      if (typeof checked === "string") {
        out.set(item.memoryId, { status: "failed", model: target.model, reason: checked });
        continue;
      }
      dim ??= checked.dim;
      out.set(item.memoryId, { status: "ready", model: target.model, ...checked });
    }
  }
  return out;
}

export interface EmbedManyResult {
  model: string;
  dim: number | null;
  /** Memories that now hold a vector of this model. */
  embedded: string[];
  /** Memories left with no vector, with the reason, for a later fill. */
  failed: Array<{ memoryId: string; reason: string }>;
}

/**
 * Computes and writes vectors for a list of memories, a batch at a time: each
 * batch is one model call with no transaction open, then one short write.
 * Memories no longer in the silo are skipped. A batch the model fails is
 * recorded as failed and the next batch still runs.
 */
async function embedMany(
  db: Db,
  embed: EmbedFn,
  target: EmbeddingTarget,
  ids: readonly string[],
  batchSize: number,
): Promise<EmbedManyResult> {
  const result: EmbedManyResult = { model: target.model, dim: target.dim, embedded: [], failed: [] };
  let dim = target.dim;
  for (let start = 0; start < ids.length; start += batchSize) {
    const slice = ids.slice(start, start + batchSize);
    const rows = await db.memory.findMany({
      where: { id: { in: [...slice] } },
      select: { id: true, title: true, body: true },
      orderBy: { callNumber: "asc" },
    });
    if (rows.length === 0) continue;

    let vectors: number[][];
    try {
      vectors = await embed(rows.map(embeddingText));
    } catch (error) {
      for (const row of rows) result.failed.push({ memoryId: row.id, reason: reasonOf(error) });
      continue;
    }

    for (const [index, row] of rows.entries()) {
      const checked = checkVector(vectors[index], { model: target.model, dim });
      if (typeof checked === "string") {
        result.failed.push({ memoryId: row.id, reason: checked });
        continue;
      }
      // With no dim configured the first vector fixes it, so one model run never mixes lengths.
      dim ??= checked.dim;
      await storeVector(db, row.id, { status: "ready", model: target.model, ...checked });
      result.embedded.push(row.id);
    }
  }
  result.dim = dim;
  return result;
}

export interface ReembedResult extends EmbedManyResult {
  /** Rows of any other model deleted once the new vectors were written. */
  removed: number;
}

/**
 * The re-embed the settings hook runs on an embedding model change (section
 * 17), before the new value counts as applied. Recomputes the vector of every
 * active memory with the new model, replacing each memory's row, then deletes
 * every row left of any other model: every vector of the old model is stale.
 *
 * Until it finishes, recall runs on FTS alone and says so: while it runs the
 * configured model still names the old one, whose rows are being replaced, so
 * recall finds an active memory with no row for it and reports
 * `partial_embeddings` rather than ranking a part of the library by vector.
 * A memory whose embed failed is listed in `failed`; fillMissingEmbeddings
 * picks it up later.
 */
export async function reembedAll(
  db: Db,
  embed: EmbedFn,
  target: EmbeddingTarget,
  options: { batchSize?: number } = {},
): Promise<ReembedResult> {
  const ids = (
    await db.memory.findMany({ where: { state: "active" }, select: { id: true }, orderBy: { callNumber: "asc" } })
  ).map((row) => row.id);
  const result = await embedMany(db, embed, target, ids, options.batchSize ?? EMBED_BATCH_SIZE);
  const removed = await db.embedding.deleteMany({ where: { model: { not: target.model } } });
  return { ...result, removed: removed.count };
}

/** Active memories with no vector of this model, by call number. */
export async function memoriesMissingEmbedding(db: Db, model: string): Promise<string[]> {
  const rows = await db.memory.findMany({
    where: { state: "active", OR: [{ embedding: null }, { embedding: { model: { not: model } } }] },
    select: { id: true },
    orderBy: { callNumber: "asc" },
  });
  return rows.map((row) => row.id);
}

/**
 * Fills in vectors that are missing: for the memories named (the
 * `needsEmbedding` list an import returns), or, with none named, for every
 * active memory with no row of this model. A memory that already holds a
 * vector of this model is left alone, so running it twice embeds nothing
 * twice.
 */
export async function fillMissingEmbeddings(
  db: Db,
  embed: EmbedFn,
  target: EmbeddingTarget,
  options: { memoryIds?: readonly string[]; batchSize?: number } = {},
): Promise<EmbedManyResult> {
  let ids: string[];
  if (options.memoryIds) {
    const held = new Set(
      (
        await db.embedding.findMany({
          where: { memoryId: { in: [...options.memoryIds] }, model: target.model },
          select: { memoryId: true },
        })
      ).map((row) => row.memoryId),
    );
    ids = [...new Set(options.memoryIds)].filter((id) => !held.has(id));
  } else {
    ids = await memoriesMissingEmbedding(db, target.model);
  }
  return embedMany(db, embed, target, ids, options.batchSize ?? EMBED_BATCH_SIZE);
}
