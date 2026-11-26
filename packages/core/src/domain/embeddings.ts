// The write side of the vector cache. docs/SPEC.md section 11 (`Embedding`:
// a cache of body and model), section 12 (`models` is used from core for
// `embed()` only), section 13 (the embedding comes after FTS, computed before
// the transaction opens), section 17 (the cache rule and the re-embed hook).
//
// The bytes and the table are storage/embeddings.ts. The read side is
// memory.recall, through loadEmbeddings.
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
// recall never ranks a memory by text it no longer holds. A vector that is
// missing is filled later: by `reverie reindex`, or by the host's re-embed
// hook when it next runs (fillMissingEmbeddings, runReembed).

import type { MemoryState } from "../schemas/enums.js";
import {
  deleteEmbedding,
  deleteOtherEmbeddings,
  missingEmbeddingWhere,
  upsertEmbedding,
} from "../storage/embeddings.js";
import type { Db } from "./db.js";

/** What core asks of a models port: one vector per text, in order. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** The configured model, and its dimension when config gives one. */
export interface EmbeddingTarget {
  model: string;
  /** Null when config leaves it open: the first vector's length is taken. */
  dim: number | null;
}

/**
 * The states a vector is kept for: what recall can return. Active entries,
 * and superseded ones, which `asOf` recalls. Retired entries are out of
 * recall either way.
 */
export const EMBEDDED_STATES: readonly MemoryState[] = ["active", "superseded"];

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

/**
 * How long one write waits for its vector before it commits without one.
 * The model call happens before the commit opens, so a slow model would
 * otherwise hold up the write it belongs to. Starting value.
 */
export const WRITE_EMBED_TIMEOUT_MS = 5000;

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

/** The promise, or a rejection once `ms` has passed. The timer never keeps the process up. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Computes one vector. Never throws: a model that fails, answers in the
 * wrong shape, or takes longer than `timeoutMs` comes back as `failed` with
 * the reason, because an embed failure must not fail or hold up the write it
 * belongs to.
 */
export async function prepareVector(
  embed: EmbedFn,
  target: EmbeddingTarget,
  text: string,
  options: { timeoutMs?: number } = {},
): Promise<PreparedVector> {
  const timeoutMs = options.timeoutMs ?? WRITE_EMBED_TIMEOUT_MS;
  try {
    const [vector] = await withTimeout(
      Promise.resolve().then(() => embed([text])),
      timeoutMs,
      `The model gave no vector within ${timeoutMs}ms.`,
    );
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
 * between the commit and this write) is left alone. Never throws: the
 * memory has committed by the time this runs, and a cache row is not worth
 * failing it for.
 */
export async function storeVector(
  db: Db,
  memoryId: string,
  prepared: PreparedVector,
  at: Date = new Date(),
): Promise<EmbeddingOutcome> {
  try {
    if (prepared.status === "failed") {
      await deleteEmbedding(db, memoryId);
      return { status: "missing", model: prepared.model, reason: prepared.reason };
    }
    const exists = await db.memory.findUnique({ where: { id: memoryId }, select: { id: true } });
    if (!exists) return { status: "missing", model: prepared.model, reason: "The memory is no longer in the silo." };
    await upsertEmbedding(db, { memoryId, model: prepared.model, dim: prepared.dim, vector: prepared.vector }, at);
    return { status: "written", model: prepared.model };
  } catch (error) {
    return { status: "missing", model: prepared.model, reason: `The vector could not be stored: ${reasonOf(error)}` };
  }
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
  onBatch?: (progress: { embedded: number; failed: number }) => void | Promise<void>,
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
      await onBatch?.({ embedded: result.embedded.length, failed: result.failed.length });
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
      const outcome = await storeVector(db, row.id, { status: "ready", model: target.model, ...checked });
      if (outcome.status === "written") result.embedded.push(row.id);
      else if (outcome.reason !== "The memory is no longer in the silo.") result.failed.push({ memoryId: row.id, reason: outcome.reason });
    }
    await onBatch?.({ embedded: result.embedded.length, failed: result.failed.length });
  }
  result.dim = dim;
  return result;
}

export interface ReembedResult extends EmbedManyResult {
  /** Rows of any other model deleted once the new vectors were written. */
  removed: number;
}

/**
 * Recomputes the vector of every memory recall can return with the new
 * model, replacing each memory's row, then deletes every row left of any
 * other model: every vector of the old model is stale. A memory whose embed
 * failed is listed in `failed`; fillMissingEmbeddings picks it up later.
 *
 * The single pass the re-embed hook started from. runReembed is the
 * resumable form the mini-host's hook runs.
 */
export async function reembedAll(
  db: Db,
  embed: EmbedFn,
  target: EmbeddingTarget,
  options: { batchSize?: number } = {},
): Promise<ReembedResult> {
  const ids = (
    await db.memory.findMany({
      where: { state: { in: [...EMBEDDED_STATES] } },
      select: { id: true },
      orderBy: { callNumber: "asc" },
    })
  ).map((row) => row.id);
  const result = await embedMany(db, embed, target, ids, options.batchSize ?? EMBED_BATCH_SIZE);
  const removed = await db.embedding.deleteMany({ where: { model: { not: target.model } } });
  return { ...result, removed: removed.count };
}

/** Memories recall can return with no vector of this model (and dim, when given), by call number. */
export async function memoriesMissingEmbedding(db: Db, model: string, dim: number | null = null): Promise<string[]> {
  const rows = await db.memory.findMany({
    where: { AND: [{ state: { in: [...EMBEDDED_STATES] } }, missingEmbeddingWhere(model, dim)] },
    select: { id: true },
    orderBy: { callNumber: "asc" },
  });
  return rows.map((row) => row.id);
}

/**
 * Memories whose vector of this model was computed before their last edit:
 * left behind when a process stopped between a commit and its vector write.
 * `reverie reindex` re-embeds them.
 */
export async function memoriesWithStaleEmbedding(db: Db, model: string): Promise<string[]> {
  const rows = await db.embedding.findMany({
    where: { model, memory: { state: { in: [...EMBEDDED_STATES] } } },
    select: { memoryId: true, createdAt: true, memory: { select: { updatedAt: true, callNumber: true } } },
  });
  return rows
    .filter((row) => row.createdAt.getTime() < row.memory.updatedAt.getTime())
    .sort((a, b) => (a.memory.callNumber < b.memory.callNumber ? -1 : 1))
    .map((row) => row.memoryId);
}

/**
 * Fills in vectors that are missing: for the memories named (the
 * `needsEmbedding` list an import returns), or, with none named, for every
 * memory recall can return with no row of this model and dim. A memory that
 * already holds a vector of this model is left alone, so running it twice
 * embeds nothing twice.
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
          where: {
            memoryId: { in: [...options.memoryIds] },
            model: target.model,
            ...(target.dim !== null ? { dim: target.dim } : {}),
          },
          select: { memoryId: true },
        })
      ).map((row) => row.memoryId),
    );
    ids = [...new Set(options.memoryIds)].filter((id) => !held.has(id));
  } else {
    ids = await memoriesMissingEmbedding(db, target.model, target.dim);
  }
  return embedMany(db, embed, target, ids, options.batchSize ?? EMBED_BATCH_SIZE);
}

export interface RunReembedResult {
  model: string;
  /** The dim every vector of this run has: config's, or the model's when config left it open. Null when nothing was embedded and none was given. */
  dim: number | null;
  /** Vectors written by this run. */
  embedded: number;
  /** Memories still without a vector of the target, with the reason. Empty means the run is complete. */
  failed: Array<{ memoryId: string; reason: string }>;
  /** Rows of any other model or dim removed. Only once the run is complete. */
  removed: number;
  /** True when every memory recall can return holds a vector of the target. */
  complete: boolean;
}

/**
 * The re-embed the settings hook runs on a change of embedding model or dim
 * (section 17), before the new value counts as applied. Resumable by
 * construction: it keeps no progress counter of its own, because the silo is
 * the progress. Each pass embeds the memories that have no vector of the
 * target yet, so a run that stopped half way (a crash, a restart, a model
 * that went away) picks up where it stopped when it is run again, and a
 * memory written while it runs is caught by the next pass. Rows of the old
 * model are replaced one memory at a time and the rest are deleted only once
 * every memory holds a vector of the target, so until then the host keeps
 * recall on FTS alone (it marks the run in its settings values) and no
 * ranking ever mixes two models.
 */
export async function runReembed(
  db: Db,
  embed: EmbedFn,
  target: EmbeddingTarget,
  options: {
    batchSize?: number;
    onProgress?: (progress: { embedded: number; failed: number; remaining: number }) => void | Promise<void>;
  } = {},
): Promise<RunReembedResult> {
  const batchSize = options.batchSize ?? EMBED_BATCH_SIZE;
  let dim = target.dim;
  let embedded = 0;
  const failed = new Map<string, string>();
  // A pass per round: a write during the run leaves a memory without a vector
  // of the target, which the next round picks up. A memory that failed in
  // this run is not retried in it.
  for (let round = 0; round < 10; round += 1) {
    const todo = (await memoriesMissingEmbedding(db, target.model, dim)).filter((id) => !failed.has(id));
    if (todo.length === 0) break;
    const pass = await embedMany(db, embed, { model: target.model, dim }, todo, batchSize, async (progress) => {
      await options.onProgress?.({
        embedded: embedded + progress.embedded,
        failed: failed.size + progress.failed,
        remaining: Math.max(0, todo.length - progress.embedded - progress.failed),
      });
    });
    dim ??= pass.dim;
    embedded += pass.embedded.length;
    for (const entry of pass.failed) failed.set(entry.memoryId, entry.reason);
  }

  const remaining = await memoriesMissingEmbedding(db, target.model, dim);
  for (const id of remaining) if (!failed.has(id)) failed.set(id, "Not embedded yet.");
  const complete = failed.size === 0;
  const removed = complete ? await deleteOtherEmbeddings(db, { model: target.model, dim }) : 0;
  return {
    model: target.model,
    dim,
    embedded,
    failed: [...failed].map(([memoryId, reason]) => ({ memoryId, reason })),
    removed,
    complete,
  };
}

/** Drops every vector: the embedding model was set to null, so recall runs on FTS alone. */
export async function dropAllEmbeddings(db: Db): Promise<number> {
  return deleteOtherEmbeddings(db, null);
}
