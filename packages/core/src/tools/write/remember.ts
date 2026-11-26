// memory.remember. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.remember`; section 13, "The direct door"; section 5, "The Returns
// shelf"; section 6 (inline #tags); section 7 (discipline, incognito);
// section 8, "Two standalone hosts" (attendees kept as names when
// unresolved); guardrails 2, 3, 4, 7 and 9.

import { z } from "zod";

import { checkSecrets } from "../../domain/discipline.js";
import { createMemory } from "../../domain/memories.js";
import { duplicateGuard } from "../../domain/reconcile.js";
import { dateOnlySchema, dayKey, optionalText } from "../../schemas/common.js";
import { MemoryKind, MemoryScope } from "../../schemas/enums.js";
import { BODY_MAX_LENGTH, importanceSchema, TITLE_MAX_LENGTH } from "../../schemas/memory.js";
import { shelfRefSchema } from "../../schemas/shelf.js";
import { tagSlugSchema } from "../../schemas/tag.js";
import type { TrustTier } from "../../schemas/enums.js";
import { defineTool, ToolError, type ToolContext } from "../registry.js";
import type { DraftedProvenance } from "../shared/confirm-drafted.js";
import { enforceDiscipline, refuseFindings } from "../shared/discipline.js";
import { projectShelfPath, resolveProject } from "../shared/project.js";
import { buildRefs, personInputSchema } from "../shared/refs.js";
import { capQuote, scopeRefFor, statedSource } from "../shared/session.js";
import { memoryView, type MemoryView } from "../shared/views.js";
import { emitWritten } from "../shared/write-common.js";
import { embeddingField, prepareEmbedding, storeEmbedding } from "../shared/embedding.js";
import type { EmbeddingOutcome } from "../../domain/embeddings.js";
import { backRefCall, memoryUri, type BackRefCall } from "../../domain/people-link.js";

/** A title cut from the body when none is given. Starting value. */
export const DERIVED_TITLE_MAX = 80;

/** The body's first sentence or line, cut at a word to DERIVED_TITLE_MAX characters. */
export function deriveTitle(body: string): string {
  const first = body.trim().split(/\n|(?<=[.!?])\s/)[0]?.trim() ?? "";
  const line = (first.length > 0 ? first : body.trim()).replace(/[.!?]+$/, "");
  if (line.length <= DERIVED_TITLE_MAX) return line;
  const cut = line.slice(0, DERIVED_TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > DERIVED_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd();
}

export const rememberInputSchema = z.object({
  /** What to keep, with dates resolved to absolute ones. Inline #tags are attached. */
  body: z.string().trim().min(1, "A body is required").max(BODY_MAX_LENGTH),
  /** Defaults to the body's first sentence. */
  title: z.string().trim().min(1).max(TITLE_MAX_LENGTH).optional(),
  kind: MemoryKind,
  /** Where it lives, "LIF/GTH". With none it waits on Returns. */
  shelf: shelfRefSchema.optional(),
  /** When it happened. Defaults to today. */
  occurredOn: dateOnlySchema.optional(),
  scope: MemoryScope.default("global"),
  /** Filled from the session when left out: the project's slug, the session id or the agent. */
  scopeRef: z.string().trim().min(1).max(200).optional(),
  tags: z.array(tagSlugSchema).max(50).default([]),
  /** Names as told, or module://people/person/<id> URIs. A name stays an unresolved label. */
  attendees: z.array(personInputSchema).max(100).default([]),
  /** A module://people/event/<id> URI, or the occasion's name. */
  occasion: personInputSchema.optional(),
  /**
   * People the memory mentions without their having been there: names as
   * told, or module://people/person/<id> URIs. A name stays an unresolved label.
   */
  mentions: z.array(personInputSchema).max(100).default([]),
  why: optionalText,
  howToApply: optionalText,
  importance: importanceSchema.default(3),
  /**
   * The owner's own words, when the body restates them. The quote is taken
   * from here, else from the body, and capped at 500 characters.
   */
  said: z.string().trim().min(1).max(BODY_MAX_LENGTH).optional(),
  /** True only when the owner explicitly asked to keep something sensitive (section 7). */
  explicitAsk: z.boolean().default(false),
});

export type RememberInput = z.input<typeof rememberInputSchema>;
export type ParsedRememberInput = z.output<typeof rememberInputSchema>;

export interface RememberResult {
  memory: MemoryView;
  /** True when no shelf was given and it waits on Returns. A project memory given none goes to its project's shelf instead. */
  landedOnReturns: boolean;
  /** Says where it landed when that was Returns. */
  notice: string | null;
  /** Names kept as unresolved labels: never turned into a person. */
  unresolved: string[];
  /**
   * The memory's vector, when a models port and embedding.model are both
   * set: `written`, or `missing` with the reason when the model failed. The
   * memory is committed either way. Absent when vectors are off.
   */
  embedding?: EmbeddingOutcome;
  /**
   * When the occasion is one the people module holds (a module://people/event
   * URI): the people.update_interaction call that points it back at this
   * memory. Null otherwise. This module never makes it.
   */
  backRef: BackRefCall | null;
}

export const tool = defineTool({
  name: "memory.remember",
  title: "Remember this",
  kind: "write",
  summary:
    "The direct door: what the owner says goes straight in with trust stated, because the owner asking is the confirmation. Discipline and the duplicate guard still run. With no shelf it lands on Returns and says so. The owner's words are its source. Names stay unresolved labels; pass module:// URIs for people the people module already knows. A procedure is refused here: use memory.promote_procedure.",
  input: rememberInputSchema,
  handler: (ctx, input) => commitRemember(ctx, input),
  auditIds: (_input, result) =>
    result ? { memoryIds: [result.memory.id], calls: [result.memory.call] } : undefined,
});

/**
 * The commit behind memory.remember, shared with memory.decide. The tool
 * calls it with the owner's words as the source and trust `stated`. Only
 * decide passes `drafted`, built from a proposal's draft envelope, so a
 * drafted memory commits once with the trust a draft earns and the material
 * it was drafted from as its source, and one event carries that trust. No
 * tool input reaches `drafted`.
 */
export async function commitRemember(
  ctx: ToolContext,
  input: ParsedRememberInput,
  drafted?: DraftedProvenance,
): Promise<RememberResult> {
  const sourceTrust: TrustTier = drafted?.sourceTrust ?? "stated";
  if (input.kind === "procedure") {
    throw new ToolError(
      "refused",
      "A procedure changes how every later session behaves, so it is written only through memory.promote_procedure, with the owner's yes.",
    );
  }

  const title = input.title ?? deriveTitle(input.body);
  enforceDiscipline({
    kind: input.kind,
    title,
    body: input.body,
    why: input.why ?? null,
    howToApply: input.howToApply ?? null,
    sourceTrust,
    explicitAsk: input.explicitAsk,
  });
  // The quote is stored too. Only the secret scan applies to it: the
  // owner's own words may say "yesterday" where the body says the date.
  for (const quote of [input.said, drafted?.citation.quote]) {
    if (quote) refuseFindings(checkSecrets({ kind: input.kind, title, body: quote, sourceTrust }).findings);
  }

  const project =
    input.scope === "project" && !input.scopeRef ? (await resolveProject(ctx)).project : null;
  const scopeRef = scopeRefFor(ctx, input.scope, input.scopeRef, project);

  const duplicate = await duplicateGuard(ctx.db, {
    title,
    body: input.body,
    kind: input.kind,
    tags: input.tags,
    scope: input.scope,
    scopeRef: scopeRef ?? null,
    ...(input.shelf !== undefined ? { shelf: input.shelf } : {}),
  });
  if (duplicate.duplicate) {
    throw new ToolError(
      "conflict",
      `Already remembered as ${duplicate.callNumber}. Nothing was written. To strengthen it, add this as a source with memory.add_source or confirm it with memory.touch.`,
      {
        call: duplicate.callNumber,
        memoryId: duplicate.memoryId,
        match: duplicate.match,
        similarity: duplicate.similarity,
      },
    );
  }

  const { refs, unresolved } = await buildRefs(ctx, {
    attendees: input.attendees,
    occasion: input.occasion ?? null,
    mentions: input.mentions,
  });
  // A project memory given no shelf goes to its project's shelf; anything
  // else given none waits on Returns.
  const projectShelf =
    input.shelf === undefined && input.scope === "project" ? await projectShelfPath(ctx.db, scopeRef) : null;
  const landedOnReturns = input.shelf === undefined && projectShelf === null;
  const shelf = input.shelf ?? projectShelf ?? ctx.config.defaultShelf;

  // The vector is computed before the commit opens, never with the writer held.
  const vector = await prepareEmbedding(ctx, { title, body: input.body });

  const created = await createMemory(
    ctx.db,
    {
      shelf,
      occurredOn: input.occurredOn ?? dayKey(ctx.now),
      kind: input.kind,
      scope: input.scope,
      ...(scopeRef !== undefined ? { scopeRef } : {}),
      title,
      body: input.body,
      why: input.why ?? null,
      howToApply: input.howToApply ?? null,
      importance: input.importance,
      trust: drafted?.trust ?? "stated",
      tags: input.tags,
      refs,
      sources: [
        drafted
          ? { source: drafted.citation.source, quote: capQuote(drafted.citation.quote) }
          : statedSource(ctx, input.said ?? input.body),
      ],
    },
    { actor: ctx.actor, at: ctx.now },
  );

  const embedding = await storeEmbedding(ctx, created.id, vector);
  emitWritten(ctx, created, "create");

  const memory = await memoryView(ctx, created.id);
  const occasionUri = memory.occasion?.uri ?? null;
  return {
    memory,
    backRef: occasionUri ? backRefCall(occasionUri, { uri: memoryUri(memory.call), label: memory.title }) : null,
    landedOnReturns,
    notice: landedOnReturns
      ? `No shelf was given, so ${memory.call} waits on ${memory.shelf} to be shelved.`
      : null,
    unresolved,
    ...embeddingField(embedding),
  };
}
