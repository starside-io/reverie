/**
 * The cosine recall ranks by. docs/SPEC.md section 14, "Search twice".
 *
 * The encoding (32 bit floats, little endian, `dim` of them) lives in
 * storage/embeddings.ts and is re-exported here for the callers that read it
 * from this file.
 */

export { decodeVector, encodeVector } from "../../storage/embeddings.js";

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
