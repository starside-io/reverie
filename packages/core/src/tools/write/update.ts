// memory.update. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.update`; section 13, "The four reconcile verbs" (refine: same
// memory, same call number, new version); section 7 (discipline); section 16,
// gate "Supersede, never overwrite"; guardrails 3, 4 and 9.

import { z } from "zod";

import type { Memory } from "../../../generated/prisma/index.js";
import { atomic } from "../../domain/db.js";
import { checkSecrets } from "../../domain/discipline.js";
import { parseInput } from "../../domain/errors.js";
import { attachSourceRaw, updateMemory } from "../../domain/memories.js";
import { appendVersion } from "../../domain/versions.js";
import { refreshPeople, type RefreshPeopleResult } from "../../domain/occasions.js";
import { PERSON_URI_PATTERN } from "../../domain/people-link.js";
import { personObject } from "../shared/refs.js";
import type { MemoryUpdateInput } from "../../schemas/memory.js";
import { memorySourceInputSchema } from "../../schemas/source.js";
import { optionalText } from "../../schemas/common.js";
import { MemoryKind, worseTrust, type TrustTier } from "../../schemas/enums.js";
import { BODY_MAX_LENGTH, importanceSchema, TITLE_MAX_LENGTH } from "../../schemas/memory.js";
import { defineTool, ToolError, type ToolContext } from "../registry.js";
import type { DraftedProvenance } from "../shared/confirm-drafted.js";
import { enforceDiscipline, refuseFindings } from "../shared/discipline.js";
import { capQuote } from "../shared/session.js";
import { callSchema } from "../shared/inputs.js";
import { memoryView, type MemoryView } from "../shared/views.js";
import { embeddingField, prepareEmbedding, storeEmbedding } from "../shared/embedding.js";
import type { EmbeddingOutcome } from "../../domain/embeddings.js";
import { emitWritten, loadByCall, mutation, procedureRefusal, refuseSuperseded } from "../shared/write-common.js";

export const updateInputSchema = z.object({
  /** Current or old number. */
  call: callSchema,
  title: z.string().trim().min(1).max(TITLE_MAX_LENGTH).optional(),
  /** Dates resolved to absolute ones. New inline #tags are attached. */
  body: z.string().trim().min(1).max(BODY_MAX_LENGTH).optional(),
  why: optionalText,
  howToApply: optionalText,
  importance: importanceSchema.optional(),
  /**
   * Only the kind it already has. A different kind is refused: a procedure
   * only through promote_procedure (guardrail 4), and any other change of kind
   * is a supersede, because it is a different kind of thing. Starting value.
   */
  kind: MemoryKind.optional(),
  /** True only when the owner explicitly asked to keep something sensitive (section 7). */
  explicitAsk: z.boolean().default(false),
  /**
   * People on the memory as the people module shows them now (section 8,
   * "Names without the other host"): references to `uri` take `label`, and
   * with `name`, the unresolved name kept for them takes the URI. Nobody is
   * added. Never a score or a sentiment.
   */
  people: z
    .array(
      personObject({
        uri: z.string().trim().regex(PERSON_URI_PATTERN, "Expected a person URI such as module://people/person/<id>"),
        label: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .max(50)
    .optional(),
});

export type UpdateInput = z.input<typeof updateInputSchema>;
export type ParsedUpdateInput = z.output<typeof updateInputSchema>;

export interface UpdateToolResult {
  memory: MemoryView;
  /** False when the input matched what was stored: no version was written. */
  changed: boolean;
  /** What `people` changed, when it was given. */
  people?: Omit<RefreshPeopleResult, "changed">;
  /**
   * The memory's vector, when a models port and embedding.model are both
   * set and the title or body changed: `written`, or `missing` with the reason when the model failed. The
   * memory is committed either way. Absent when vectors are off.
   */
  embedding?: EmbeddingOutcome;
}

export const tool = defineTool({
  name: "memory.update",
  title: "Update a memory",
  kind: "write",
  summary:
    "A new version of one memory, same call number. Never an in-place edit: the previous content stays readable through history. Discipline runs on the new content. A procedure is never made or changed here: use memory.promote_procedure. To change the kind, or when the world changed rather than the wording, use memory.supersede. people refreshes the label snapshots of people on it to what the people module shows now, and resolves an unresolved name to a person's URI.",
  input: updateInputSchema,
  handler: (ctx, input) => commitUpdate(ctx, input),
  auditIds: (input, result) =>
    result ? { memoryIds: [result.memory.id], calls: [result.memory.call] } : { calls: [input.call] },
});

/**
 * The commit behind memory.update, shared with memory.decide. Only decide
 * passes `drafted`: a reconcile `refine` confirmed in review. Then, in one
 * transaction, the memory cites the material it was drafted from with the
 * drafted quote, takes the new wording in a `refine` version, and its trust
 * drops to the draft's when that is lower, so wording drawn from external
 * material is never left looking stated (section 4). No tool input reaches
 * `drafted`.
 */
export async function commitUpdate(
  ctx: ToolContext,
  input: ParsedUpdateInput,
  drafted?: DraftedProvenance,
): Promise<UpdateToolResult> {
  const { row } = await loadByCall(ctx, input.call);

  if (input.kind === "procedure" || row.kind === "procedure") throw procedureRefusal();
  if (input.kind !== undefined && input.kind !== row.kind) {
    throw new ToolError(
      "refused",
      `${row.callNumber} is a ${row.kind}. A memory keeps its kind; supersede it with a ${input.kind} instead.`,
    );
  }
  await refuseSuperseded(ctx, row, "changed");

  const fields = {
    title: input.title,
    body: input.body,
    why: input.why,
    howToApply: input.howToApply,
    importance: input.importance,
  };
  const contentGiven = !Object.values(fields).every((value) => value === undefined);
  if (!contentGiven && !input.people) {
    throw new ToolError("invalid_input", "Nothing to update: give a title, body, why, howToApply, importance or people.");
  }
  if (!contentGiven && input.people) {
    // Only the people on it: no wording changes, so no discipline to rerun and no new vector.
    const people = await refreshPeople(ctx.db, row.id, input.people as Array<{ uri: string; label: string; name?: string }>, mutation(ctx));
    const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: row.id } });
    if (people.changed) emitWritten(ctx, memory, "update");
    return {
      memory: await memoryView(ctx, row.id),
      changed: people.changed,
      people: { resolvedNames: people.resolvedNames, refreshed: people.refreshed },
    };
  }

  // Discipline runs on the content as it will stand, at the memory's own
  // trust, so an external entry stays under the external rules.
  const next = {
    title: input.title ?? row.title,
    body: input.body ?? row.body,
    why: input.why === undefined ? row.why : input.why,
    howToApply: input.howToApply === undefined ? row.howToApply : input.howToApply,
  };
  enforceDiscipline({
    kind: row.kind as MemoryKind,
    ...next,
    sourceTrust: drafted ? worseTrust(row.trust as TrustTier, drafted.sourceTrust) : (row.trust as TrustTier),
    explicitAsk: input.explicitAsk,
  });
  if (drafted) {
    refuseFindings(
      checkSecrets({ kind: row.kind as MemoryKind, title: "", body: drafted.citation.quote, sourceTrust: drafted.sourceTrust })
        .findings,
    );
  }

  const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  // A new title or body is a new vector, computed before the commit opens.
  const reworded = next.title !== row.title || next.body !== row.body;
  const vector = reworded ? await prepareEmbedding(ctx, { title: next.title, body: next.body }) : null;
  const result = drafted
    ? await refineDrafted(ctx, row, patch, drafted)
    : await updateMemory(ctx.db, { id: row.id }, patch, mutation(ctx));

  const embedding = result.changed ? await storeEmbedding(ctx, row.id, vector) : undefined;
  const people = input.people
    ? await refreshPeople(ctx.db, row.id, input.people as Array<{ uri: string; label: string; name?: string }>, mutation(ctx))
    : null;
  if (result.changed || people?.changed) emitWritten(ctx, result.memory, drafted ? "refine" : "update");

  return {
    memory: await memoryView(ctx, row.id),
    changed: result.changed || (people?.changed ?? false),
    ...(people ? { people: { resolvedNames: people.resolvedNames, refreshed: people.refreshed } } : {}),
    ...embeddingField(embedding),
  };
}

/** A drafted refine, in one transaction: the citation, the trust, the wording, one version. */
async function refineDrafted(
  ctx: ToolContext,
  row: Memory,
  patch: MemoryUpdateInput,
  drafted: DraftedProvenance,
): Promise<{ memory: Memory; changed: boolean }> {
  const citation = parseInput(memorySourceInputSchema, {
    source: drafted.citation.source,
    quote: capQuote(drafted.citation.quote),
  });
  const trust = worseTrust(row.trust as TrustTier, drafted.trust);
  return atomic(ctx.db, async (tx) => {
    const attached = await attachSourceRaw(tx, row.id, citation);
    if (trust !== row.trust) await tx.memory.update({ where: { id: row.id }, data: { trust } });
    const result = await updateMemory(tx, { id: row.id }, patch, { ...mutation(ctx), operation: "refine" });
    const moved = attached.added || trust !== row.trust;
    if (!result.changed && moved) await appendVersion(tx, row.id, { ...mutation(ctx), operation: "refine" });
    return { memory: await tx.memory.findUniqueOrThrow({ where: { id: row.id } }), changed: result.changed || moved };
  });
}
