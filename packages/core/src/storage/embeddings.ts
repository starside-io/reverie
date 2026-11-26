import type { Prisma } from "../../generated/prisma/index.js";
import type { Db } from "../domain/db.js";

/**
 * The `Embedding` table, in storage terms. docs/SPEC.md section 11:
 * `Embedding.vector` is `Bytes`, little-endian float32, `dim` values, keyed on
 * `memoryId` with a cascade from Memory, so forgetting a memory drops its
 * vector with the row. One row per memory: a memory holds at most one vector,
 * of one model and one dim, at a time.
 *
 * domain/embeddings.ts decides when a vector is computed and written;
 * memory.recall reads through loadEmbeddings. Both go through the encoding
 * here, so the bytes agree.
 */

const BYTES_PER_FLOAT = 4;

/** A vector as the silo stores it: float32, little endian, nothing else. */
export function encodeVector(vector: readonly number[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(vector.length * BYTES_PER_FLOAT));
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => view.setFloat32(index * BYTES_PER_FLOAT, value, true));
  return bytes;
}

/** The vector back, or null when the byte length does not match `dim`: skipped, never guessed at. */
export function decodeVector(bytes: Uint8Array, dim: number): number[] | null {
  if (!Number.isInteger(dim) || dim <= 0 || bytes.byteLength !== dim * BYTES_PER_FLOAT) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let index = 0; index < dim; index += 1) out.push(view.getFloat32(index * BYTES_PER_FLOAT, true));
  return out;
}

export interface EmbeddingRow {
  memoryId: string;
  model: string;
  dim: number;
  vector: readonly number[];
}

/**
 * Writes one memory's vector, replacing whatever row it had. `at` is when it
 * was written, by the wall clock as Prisma stamps `Memory.updatedAt`; a row
 * older than its memory's last edit is stale, which is how `reverie reindex`
 * finds one left behind by a crash between a commit and its vector write.
 */
export async function upsertEmbedding(db: Db, row: EmbeddingRow, at: Date = new Date()): Promise<void> {
  if (row.vector.length !== row.dim) {
    throw new Error(`A vector of ${row.vector.length} values cannot be stored as dim ${row.dim}.`);
  }
  const data = { model: row.model, dim: row.dim, vector: encodeVector(row.vector), createdAt: at };
  await db.embedding.upsert({ where: { memoryId: row.memoryId }, create: { memoryId: row.memoryId, ...data }, update: data });
}

/** Drops one memory's vector, if it has one. */
export async function deleteEmbedding(db: Db, memoryId: string): Promise<void> {
  await db.embedding.deleteMany({ where: { memoryId } });
}

/** Drops every vector that is not of this model and dim. Null drops them all. */
export async function deleteOtherEmbeddings(db: Db, keep: { model: string; dim: number | null } | null): Promise<number> {
  if (!keep) return (await db.embedding.deleteMany()).count;
  const where: Prisma.EmbeddingWhereInput =
    keep.dim === null ? { model: { not: keep.model } } : { OR: [{ model: { not: keep.model } }, { dim: { not: keep.dim } }] };
  return (await db.embedding.deleteMany({ where })).count;
}

/**
 * The vectors of one model, and one dim when given, for memories that pass
 * `memory`: what the vector leg of recall ranks. Rows of another model or
 * dim are never returned, so two models are never mixed in one ranking. A row
 * whose bytes do not decode is skipped.
 */
export async function loadEmbeddings(
  db: Db,
  options: { model: string; dim?: number | null; memory?: Prisma.MemoryWhereInput },
): Promise<Array<{ id: string; vector: number[] }>> {
  const rows = await db.embedding.findMany({
    where: {
      model: options.model,
      ...(options.dim ? { dim: options.dim } : {}),
      ...(options.memory ? { memory: options.memory } : {}),
    },
    select: { memoryId: true, dim: true, vector: true },
    orderBy: { memoryId: "asc" },
  });
  return rows.flatMap((row) => {
    const vector = decodeVector(row.vector, row.dim);
    return vector ? [{ id: row.memoryId, vector }] : [];
  });
}

/**
 * The filter for a memory with no usable vector of this model (and dim, when
 * given): no row, or a row of another model or dim.
 */
export function missingEmbeddingWhere(model: string, dim: number | null): Prisma.MemoryWhereInput {
  const other: Prisma.EmbeddingWhereInput[] = [{ model: { not: model } }];
  if (dim !== null) other.push({ dim: { not: dim } });
  return { OR: [{ embedding: null }, { embedding: { OR: other } }] };
}
