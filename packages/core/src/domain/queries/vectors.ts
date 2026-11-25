/**
 * Embedding vectors as the silo stores them, and the cosine recall ranks by.
 * docs/SPEC.md section 14, "Search twice".
 *
 * Encoding, starting value: `Embedding.vector` holds the vector as 32 bit
 * floats, little endian, `dim` of them, nothing else. domain/embeddings.ts
 * writes them, through encodeVector, so the two sides agree. A vector whose byte length does not match its dim decodes to
 * null and is skipped, never guessed at.
 */

const BYTES_PER_FLOAT = 4;

export function encodeVector(vector: readonly number[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(vector.length * BYTES_PER_FLOAT));
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => view.setFloat32(index * BYTES_PER_FLOAT, value, true));
  return bytes;
}

export function decodeVector(bytes: Uint8Array, dim: number): number[] | null {
  if (!Number.isInteger(dim) || dim <= 0 || bytes.byteLength !== dim * BYTES_PER_FLOAT) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let index = 0; index < dim; index += 1) out.push(view.getFloat32(index * BYTES_PER_FLOAT, true));
  return out;
}

/** Cosine similarity, or null when the lengths differ or either vector is all zeros. */
export function cosine(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] as number;
    const y = b[index] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return null;
  return dot / Math.sqrt(normA * normB);
}

/** How many vector hits one recall fuses at most. Starting value. */
export const VECTOR_TOP_K = 50;

/**
 * Ids best first by cosine against the query, ties by id. Only positive
 * similarities count, at most VECTOR_TOP_K.
 */
export function rankByCosine(
  query: readonly number[],
  candidates: ReadonlyArray<{ id: string; vector: readonly number[] }>,
  topK: number = VECTOR_TOP_K,
): string[] {
  return candidates
    .map((candidate) => ({ id: candidate.id, similarity: cosine(query, candidate.vector) }))
    .filter((entry): entry is { id: string; similarity: number } => entry.similarity !== null && entry.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, topK)
    .map((entry) => entry.id);
}
