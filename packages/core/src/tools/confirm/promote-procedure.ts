// memory.promote_procedure. docs/SPEC.md section 15, "Needs OK, 6" table, row
// `memory.promote_procedure`; section 4, "Kinds" (a procedure holds how to
// work for you, with why and how to apply, and has no half life) and "Trust"
// (confirmed: drafted by a model, confirmed in review; external never yields
// a procedure); section 7 (discipline); section 16, gate "No instructions
// from outside"; guardrails 1, 2, 3 and 4.

import { z } from "zod";

import { checkSecrets } from "../../domain/discipline.js";
import { createMemory } from "../../domain/memories.js";
import { duplicateGuard } from "../../domain/reconcile.js";
import { dateOnlySchema, dayKey } from "../../schemas/common.js";
import { MemoryScope, worseTrust, type TrustTier } from "../../schemas/enums.js";
import { BODY_MAX_LENGTH, importanceSchema, TITLE_MAX_LENGTH } from "../../schemas/memory.js";
import { shelfRefSchema } from "../../schemas/shelf.js";
import { quoteSchema, sourceCreateSchema } from "../../schemas/source.js";
import { tagSlugSchema } from "../../schemas/tag.js";
import { defineTool, ToolError } from "../registry.js";
import { enforceDiscipline, refuseFindings } from "../shared/discipline.js";
import { confirmedByUser } from "../shared/inputs.js";
import { projectShelfPath, resolveProject } from "../shared/project.js";
import { capQuote, scopeRefFor, statedSource } from "../shared/session.js";
import { memoryView, type MemoryView } from "../shared/views.js";
import { emitWritten } from "../shared/write-common.js";
import { embeddingField, prepareEmbedding, storeEmbedding } from "../shared/embedding.js";
import type { EmbeddingOutcome } from "../../domain/embeddings.js";
import { deriveTitle } from "../write/remember.js";

const procedureText = z.string().trim().min(1).max(BODY_MAX_LENGTH);

export const promoteProcedureInputSchema = z.object({
  /** The rule itself: how to work for the owner. */
  body: procedureText,
  /** Defaults to the body's first sentence. */
  title: z.string().trim().min(1).max(TITLE_MAX_LENGTH).optional(),
  /** Why the owner wants it. A procedure says why (section 4). */
  why: procedureText,
  /** When and how it applies. A procedure says how to apply it (section 4). */
  howToApply: procedureText,
  /** Defaults to Returns, as every write does. How I work, CRF/HOW, is the usual home. */
  shelf: shelfRefSchema.optional(),
  /** The day it was established. Defaults to today. */
  occurredOn: dateOnlySchema.optional(),
  scope: MemoryScope.default("global"),
  scopeRef: z.string().trim().min(1).max(200).optional(),
  tags: z.array(tagSlugSchema).max(50).default([]),
  importance: importanceSchema.default(3),
  /**
   * Where it came from, with the words it came from. A drafted procedure
   * carries the material's source; with none given, the owner's statement in
   * this session is the source, quoted from `said` or the body.
   */
  sources: z
    .array(z.object({ source: sourceCreateSchema, quote: quoteSchema }))
    .min(1)
    .max(10)
    .optional(),
  /** The owner's own words, when the body restates them. Used when no sources are given. */
  said: z.string().trim().min(1).max(BODY_MAX_LENGTH).optional(),
  explicitAsk: z.boolean().default(false),
  confirmedByUser,
});

export type PromoteProcedureInput = z.input<typeof promoteProcedureInputSchema>;

export interface PromoteProcedureResult {
  memory: MemoryView;
  /**
   * The memory's vector, when a models port and embedding.model are both
   * set: `written`, or `missing` with the reason when the model failed. The
   * memory is committed either way. Absent when vectors are off.
   */
  embedding?: EmbeddingOutcome;
}

export const tool = defineTool({
  name: "memory.promote_procedure",
  title: "Promote to procedure",
  kind: "needs-ok",
  summary:
    "Writes a procedure, the one kind a model can never write alone: it changes how every later session behaves. Takes the rule, why, and how to apply it, and lands at trust confirmed. Refused outright for an external source. Discipline and the duplicate guard run. Show the owner the exact procedure and get an explicit yes first.",
  input: promoteProcedureInputSchema,
  async handler(ctx, input): Promise<PromoteProcedureResult> {
    const sources = input.sources ?? [statedSource(ctx, input.said ?? input.body) as { source: z.input<typeof sourceCreateSchema>; quote: string }];

    // Guardrail 4: never from an external source, whatever else it says.
    if (sources.some((entry) => entry.source.trust === "external")) {
      throw new ToolError(
        "refused",
        "A procedure changes how every later session behaves, and an external source can never yield one. Nothing was written.",
        { externalSource: true },
      );
    }
    const sourceTrust = sources
      .map((entry) => entry.source.trust)
      .reduce<TrustTier>((worst, trust) => worseTrust(worst, trust), "stated");

    const title = input.title ?? deriveTitle(input.body);
    enforceDiscipline({
      kind: "procedure",
      title,
      body: input.body,
      why: input.why,
      howToApply: input.howToApply,
      sourceTrust,
      explicitAsk: input.explicitAsk,
    });
    // The quote is stored too. Only the secret scan applies to it, as remember does.
    for (const entry of sources) {
      refuseFindings(checkSecrets({ kind: "procedure", title, body: entry.quote, sourceTrust }).findings);
    }

    const project =
      input.scope === "project" && !input.scopeRef ? (await resolveProject(ctx)).project : null;
    const scopeRef = scopeRefFor(ctx, input.scope, input.scopeRef, project);

    const duplicate = await duplicateGuard(ctx.db, {
      title,
      body: input.body,
      kind: "procedure",
      tags: input.tags,
      scope: input.scope,
      scopeRef: scopeRef ?? null,
      ...(input.shelf !== undefined ? { shelf: input.shelf } : {}),
    });
    if (duplicate.duplicate) {
      throw new ToolError("conflict", `Already held as ${duplicate.callNumber}. Nothing was written.`, {
        call: duplicate.callNumber,
        memoryId: duplicate.memoryId,
        match: duplicate.match,
      });
    }

    // The vector is computed before the commit opens, never with the writer held.
    const vector = await prepareEmbedding(ctx, { title, body: input.body });

    const created = await createMemory(
      ctx.db,
      {
        shelf:
          input.shelf ??
          (input.scope === "project" ? await projectShelfPath(ctx.db, scopeRef) : null) ??
          ctx.config.defaultShelf,
        occurredOn: input.occurredOn ?? dayKey(ctx.now),
        kind: "procedure",
        scope: input.scope,
        ...(scopeRef !== undefined ? { scopeRef } : {}),
        title,
        body: input.body,
        why: input.why,
        howToApply: input.howToApply,
        importance: input.importance,
        trust: "confirmed",
        tags: input.tags,
        sources: sources.map((entry) => ({ source: entry.source, quote: capQuote(entry.quote) })),
      },
      { actor: ctx.actor, at: ctx.now },
    );

    const embedding = await storeEmbedding(ctx, created.id, vector);
    emitWritten(ctx, created, "create");

    return { memory: await memoryView(ctx, created.id), ...embeddingField(embedding) };
  },
  auditIds: (_input, result) => (result ? { memoryIds: [result.memory.id], calls: [result.memory.call] } : undefined),
});
