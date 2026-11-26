import {
  embeddingText,
  prepareVector,
  storeVector,
  type EmbedFn,
  type EmbeddingOutcome,
  type EmbeddingTarget,
  type PreparedVector,
} from "../../domain/embeddings.js";
import type { ToolContext } from "../registry.js";

/**
 * The embedding step of every write tool that creates a memory or changes its
 * title or body (docs/SPEC.md section 13, step 7). Each tool calls
 * prepareEmbedding before its commit opens and storeEmbedding right after it
 * returns; domain/embeddings.ts says why the row is written after the commit
 * rather than inside it.
 *
 * With no models port, or no embedding.model in config, both are no-ops and
 * the tool's result carries no `embedding` field: nothing happens and nothing
 * fails. With both, the result carries `embedding`, which says `missing` with
 * the reason when the model failed or took longer than
 * WRITE_EMBED_TIMEOUT_MS. The memory is committed either way, and the
 * missing vector is filled later by `reverie reindex` or the host's re-embed
 * hook. While a re-embed is under way the write still embeds with the model
 * config names, the one applied; the re-embed's next pass replaces it.
 */

/** The models port and the configured model, or null when vectors are off. */
export function embeddingSetup(ctx: ToolContext): { embed: EmbedFn; target: EmbeddingTarget } | null {
  const models = ctx.ports.models;
  const model = ctx.config.embedding.model;
  if (!models || !model) return null;
  return { embed: (texts) => models.embed(texts), target: { model, dim: ctx.config.embedding.dim } };
}

/** Computes the vector for a memory's title and body. Null when vectors are off. Never throws. */
export async function prepareEmbedding(
  ctx: ToolContext,
  memory: { title: string; body: string },
): Promise<PreparedVector | null> {
  const setup = embeddingSetup(ctx);
  if (!setup) return null;
  return prepareVector(setup.embed, setup.target, embeddingText(memory));
}

/** Writes what prepareEmbedding computed. Undefined when vectors are off. */
export async function storeEmbedding(
  ctx: ToolContext,
  memoryId: string,
  prepared: PreparedVector | null,
): Promise<EmbeddingOutcome | undefined> {
  if (!prepared) return undefined;
  // Stamped with the wall clock, as Prisma stamps Memory.updatedAt, never with
  // ctx.now: a vector older than its memory's last edit is how reindex finds
  // a stale one.
  return storeVector(ctx.db, memoryId, prepared);
}

/** The `embedding` field of a tool result: present only when vectors are on. */
export function embeddingField(outcome: EmbeddingOutcome | undefined): { embedding?: EmbeddingOutcome } {
  return outcome ? { embedding: outcome } : {};
}
