// memory.supersede. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.supersede`; section 13, "The four reconcile verbs" (supersede: the
// old entry gets validTo and stays on its shelf marked superseded, the new one
// is shelved at its own date); section 4, "Lifecycle"; section 7
// (discipline); section 18 (`memory.memory.superseded`,
// `memory.memory.written`); gate "Supersede, never overwrite"; guardrails 2,
// 3, 4, 7 and 9.

import { z } from "zod";

import { checkSecrets } from "../../domain/discipline.js";
import { supersedeMemory } from "../../domain/memories.js";
import { dateOnlySchema, dayKey, optionalText } from "../../schemas/common.js";
import { MemoryKind, type MemoryScope, type TrustTier } from "../../schemas/enums.js";
import { BODY_MAX_LENGTH, importanceSchema, TITLE_MAX_LENGTH } from "../../schemas/memory.js";
import type { RefInput } from "../../schemas/ref.js";
import { shelfRefSchema } from "../../schemas/shelf.js";
import { tagSlugSchema } from "../../schemas/tag.js";
import { defineTool, ToolError, type ToolContext } from "../registry.js";
import type { DraftedProvenance } from "../shared/confirm-drafted.js";
import { enforceDiscipline, refuseFindings } from "../shared/discipline.js";
import { callSchema } from "../shared/inputs.js";
import { buildRefs, personInputSchema } from "../shared/refs.js";
import { capQuote, statedSource } from "../shared/session.js";
import { memoryView, type MemoryView } from "../shared/views.js";
import { embeddingField, prepareEmbedding, storeEmbedding } from "../shared/embedding.js";
import type { EmbeddingOutcome } from "../../domain/embeddings.js";
import { emitWritten, loadByCall, mutation, procedureRefusal, refuseSuperseded } from "../shared/write-common.js";
import { deriveTitle } from "./remember.js";

export const supersedeInputSchema = z.object({
  /** The entry the world moved past. Current or old number. */
  call: callSchema,
  /** The replacement, in the owner's words, dates absolute. */
  body: z.string().trim().min(1, "A body is required").max(BODY_MAX_LENGTH),
  /** Defaults to the body's first sentence. */
  title: z.string().trim().min(1).max(TITLE_MAX_LENGTH).optional(),
  /** Defaults to the old entry's kind. Never procedure. */
  kind: MemoryKind.optional(),
  /** Defaults to the old entry's shelf. */
  shelf: shelfRefSchema.optional(),
  /** When the new state of things began. Defaults to today. */
  occurredOn: dateOnlySchema.optional(),
  /** Defaults to the old entry's tags. */
  tags: z.array(tagSlugSchema).max(50).optional(),
  /** Defaults to the old entry's attendees. */
  attendees: z.array(personInputSchema).max(100).optional(),
  /** Defaults to the old entry's occasion. */
  occasion: personInputSchema.optional(),
  /** People the replacement mentions. Defaults to the old entry's. */
  mentions: z.array(personInputSchema).max(100).optional(),
  why: optionalText,
  howToApply: optionalText,
  /** Defaults to the old entry's importance. */
  importance: importanceSchema.optional(),
  /** The owner's own words, when the body restates them. The quote is taken from here, else the body. */
  said: z.string().trim().min(1).max(BODY_MAX_LENGTH).optional(),
  explicitAsk: z.boolean().default(false),
});

export type SupersedeInput = z.input<typeof supersedeInputSchema>;
export type ParsedSupersedeInput = z.output<typeof supersedeInputSchema>;

export interface SupersedeToolResult {
  /** The closed entry: state superseded, validTo set, still on its shelf with its number. */
  old: MemoryView;
  replacement: MemoryView;
  /** Names on the replacement kept as unresolved labels. */
  unresolved: string[];
  /**
   * The replacement's vector, when a models port and embedding.model are both
   * set: `written`, or `missing` with the reason when the model failed. The
   * replacement is committed either way. Absent when vectors are off.
   */
  embedding?: EmbeddingOutcome;
}

export const tool = defineTool({
  name: "memory.supersede",
  title: "Supersede a memory",
  kind: "write",
  summary:
    "The world changed, not the wording: closes one entry with validTo, keeps it on its shelf marked superseded, and shelves its replacement at its own date with its own number. The replacement keeps the old shelf, kind, scope, tags and people unless told otherwise, is trust stated, and cites the owner's words. Discipline runs. Never makes a procedure.",
  input: supersedeInputSchema,
  handler: (ctx, input) => commitSupersede(ctx, input),
  auditIds: (input, result) =>
    result
      ? {
          memoryIds: [result.old.id, result.replacement.id],
          calls: [result.old.call, result.replacement.call],
        }
      : { calls: [input.call] },
});

/**
 * The commit behind memory.supersede, shared with memory.decide. The tool
 * shelves a replacement at trust `stated` citing the owner's words. Only
 * decide passes `drafted`, for a reconcile `supersede` confirmed in review:
 * the replacement then commits once at the trust a draft earns, citing the
 * material it was drafted from with the drafted quote. No tool input
 * reaches `drafted`.
 */
export async function commitSupersede(
  ctx: ToolContext,
  input: ParsedSupersedeInput,
  drafted?: DraftedProvenance,
): Promise<SupersedeToolResult> {
  const sourceTrust: TrustTier = drafted?.sourceTrust ?? "stated";
  const { row } = await loadByCall(ctx, input.call);
  await refuseSuperseded(ctx, row, "superseded again");
  if (row.state !== "active") {
    throw new ToolError("refused", `${row.callNumber} is ${row.state}; only an active entry is superseded.`);
  }

  const kind = input.kind ?? (row.kind as MemoryKind);
  if (kind === "procedure" || row.kind === "procedure") throw procedureRefusal();

  const title = input.title ?? deriveTitle(input.body);
  const why = input.why === undefined ? row.why : input.why;
  const howToApply = input.howToApply === undefined ? row.howToApply : input.howToApply;
  enforceDiscipline({
    kind,
    title,
    body: input.body,
    why,
    howToApply,
    sourceTrust,
    explicitAsk: input.explicitAsk,
  });
  for (const quote of [input.said, drafted?.citation.quote]) {
    if (quote) refuseFindings(checkSecrets({ kind, title, body: quote, sourceTrust }).findings);
  }

  const old = await ctx.db.memory.findUniqueOrThrow({
    where: { id: row.id },
    include: { tags: { include: { tag: { select: { slug: true } } } }, refs: true },
  });

  let refs: RefInput[];
  let unresolved: string[] = [];
  if (input.attendees === undefined && input.occasion === undefined && input.mentions === undefined) {
    refs = old.refs.map((ref) => ({ role: ref.role as RefInput["role"], label: ref.label, ...(ref.uri ? { uri: ref.uri } : {}) }));
  } else {
    const keptAttendees = old.refs
      .filter((ref) => ref.role === "attendee")
      .map((ref) => (ref.uri ? { uri: ref.uri, label: ref.label } : ref.label));
    const keptOccasion = old.refs.find((ref) => ref.role === "occasion");
    const built = await buildRefs(ctx, {
      attendees: input.attendees ?? keptAttendees,
      occasion:
        input.occasion ??
        (keptOccasion ? (keptOccasion.uri ? { uri: keptOccasion.uri, label: keptOccasion.label } : keptOccasion.label) : null),
      mentions:
        input.mentions ??
        old.refs
          .filter((ref) => ref.role === "mentions")
          .map((ref) => (ref.uri ? { uri: ref.uri, label: ref.label } : ref.label)),
    });
    refs = built.refs;
    unresolved = built.unresolved;
  }

  // The replacement's vector, computed before the commit opens. The old entry keeps its own.
  const vector = await prepareEmbedding(ctx, { title, body: input.body });

  const result = await supersedeMemory(
    ctx.db,
    { id: row.id },
    {
      ...(input.shelf !== undefined ? { shelf: input.shelf } : {}),
      occurredOn: input.occurredOn ?? dayKey(ctx.now),
      kind,
      scope: row.scope as MemoryScope,
      ...(row.scopeRef ? { scopeRef: row.scopeRef } : {}),
      title,
      body: input.body,
      why,
      howToApply,
      importance: input.importance ?? row.importance,
      trust: drafted?.trust ?? "stated",
      tags: input.tags ?? old.tags.map((entry) => entry.tag.slug),
      refs,
      sources: [
        drafted
          ? { source: drafted.citation.source, quote: capQuote(drafted.citation.quote) }
          : statedSource(ctx, input.said ?? input.body),
      ],
    },
    mutation(ctx),
  );

  const embedding = await storeEmbedding(ctx, result.replacement.id, vector);

  ctx.emit("memory.memory.superseded", {
    memoryId: result.old.id,
    call: result.old.callNumber,
    supersededById: result.replacement.id,
    supersededBy: result.replacement.callNumber,
  });
  emitWritten(ctx, result.replacement, "supersede");

  return {
    old: await memoryView(ctx, result.old.id),
    replacement: await memoryView(ctx, result.replacement.id),
    unresolved,
    ...embeddingField(embedding),
  };
}
