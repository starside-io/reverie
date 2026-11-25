// memory.merge. docs/SPEC.md section 15, "Needs OK, 6" table, row
// `memory.merge` (a starting reading); section 5, "The call number" (old
// numbers still resolve, never reissued); guardrail 1.

import { z } from "zod";

import { mergeMemories } from "../../domain/merge.js";
import { defineTool } from "../registry.js";
import { callSchema, confirmedByUser } from "../shared/inputs.js";
import { findByCall, memoryView, type MemoryView } from "../shared/views.js";
import { emitWritten } from "../shared/write-common.js";
import { embeddingField, embeddingSetup, prepareEmbedding, storeEmbedding } from "../shared/embedding.js";
import type { EmbeddingOutcome } from "../../domain/embeddings.js";

export interface MergeToolResult {
  /** The memory that stays, as it reads after the merge. */
  memory: MemoryView;
  absorbed: {
    memoryId: string;
    call: string;
    /** Every number it was known by, each now resolving to the survivor. */
    aliases: string[];
  };
  sourcesAdded: number;
  tagsAdded: string[];
  refsAdded: number;
  linksMoved: number;
  /**
   * The survivor's vector, when a models port and embedding.model are both
   * set. A merge does not change the survivor's title or body, so a vector it
   * already holds for the model stands; one it lacks is computed. `missing`
   * with the reason when the model failed. Absent when vectors are off.
   */
  embedding?: EmbeddingOutcome;
}

export const tool = defineTool({
  name: "memory.merge",
  title: "Merge memories",
  kind: "needs-ok",
  summary:
    "Folds one memory into another. The survivor keeps its number and gains the absorbed memory's sources and quotes, tags, people and links; the absorbed number and all its old numbers become aliases of the survivor. The absorbed row is removed but not forgotten: its history keeps its content. Show the owner both memories and get an explicit yes first.",
  input: z.object({
    /** The memory that stays. */
    survivor: callSchema,
    /** The memory folded into it. */
    absorbed: callSchema,
    confirmedByUser,
  }),
  async handler(ctx, input): Promise<MergeToolResult> {
    const survivor = await findByCall(ctx, input.survivor);
    const absorbed = await findByCall(ctx, input.absorbed);

    // Computed before the merge opens its transaction, and only when the survivor has no vector of this model.
    const setup = embeddingSetup(ctx);
    const held = setup
      ? await ctx.db.embedding.findFirst({ where: { memoryId: survivor.memoryId, model: setup.target.model }, select: { memoryId: true } })
      : null;
    const before = setup && !held
      ? await ctx.db.memory.findUnique({ where: { id: survivor.memoryId }, select: { title: true, body: true } })
      : null;
    const vector = before ? await prepareEmbedding(ctx, before) : null;

    const result = await mergeMemories(
      ctx.db,
      { survivor: { id: survivor.memoryId }, absorbed: { id: absorbed.memoryId } },
      { actor: ctx.actor, at: ctx.now },
    );

    const embedding = setup
      ? held
        ? { status: "written" as const, model: setup.target.model }
        : await storeEmbedding(ctx, result.survivor.id, vector)
      : undefined;
    emitWritten(ctx, result.survivor, "merge", { absorbedId: result.absorbedId, absorbedCall: result.absorbedCall });

    return {
      memory: await memoryView(ctx, result.survivor.id),
      absorbed: { memoryId: result.absorbedId, call: result.absorbedCall, aliases: result.aliasesMoved },
      sourcesAdded: result.sourcesAdded,
      tagsAdded: result.tagsAdded,
      refsAdded: result.refsAdded,
      linksMoved: result.linksMoved,
      ...embeddingField(embedding),
    };
  },
  auditIds: (input, result) =>
    result
      ? {
          memoryIds: [result.memory.id, result.absorbed.memoryId],
          calls: [result.memory.call, ...result.absorbed.aliases],
        }
      : { calls: [input.survivor, input.absorbed] },
});
