import { z } from "zod";

import { dateOnlySchema, dateTimeSchema, optionalText } from "./common.js";
import { MemoryKind, MemoryScope, TrustTier } from "./enums.js";
import { refInputSchema } from "./ref.js";
import { shelfRefSchema } from "./shelf.js";
import { memorySourceInputSchema } from "./source.js";
import { tagSlugSchema } from "./tag.js";

/** Order within one shelf and day. Rendered three digits, zero padded. */
export const SEQ_MIN = 1;
export const SEQ_MAX = 999;
export const seqSchema = z.number().int().min(SEQ_MIN).max(SEQ_MAX);

/** 1 to 5. The recall factor 0.6 + 0.1 * importance runs 0.7 to 1.1. */
export const importanceSchema = z.number().int().min(1).max(5);

/** Starting values: the design gives no length for a title or a body. */
export const TITLE_MAX_LENGTH = 200;
export const BODY_MAX_LENGTH = 20_000;

const titleSchema = z.string().trim().min(1, "A title is required").max(TITLE_MAX_LENGTH);
const bodySchema = z.string().trim().min(1, "A body is required").max(BODY_MAX_LENGTH);
const longText = optionalText.refine(
  (value) => value === undefined || value === null || value.length <= BODY_MAX_LENGTH,
  `At most ${BODY_MAX_LENGTH} characters`,
);

export const NO_SOURCE_MESSAGE =
  "No source, no memory: every memory cites at least one source with a quote.";

/** `global` names nothing; every other scope names what it is scoped to. */
function scopeIsConsistent(value: { scope: MemoryScope; scopeRef?: string | null }): boolean {
  const hasRef = typeof value.scopeRef === "string" && value.scopeRef.length > 0;
  return value.scope === "global" ? !hasRef : hasRef;
}

const SCOPE_MESSAGE =
  "A global memory takes no scopeRef; a project, agent or session memory names one";

/**
 * What a commit writes for a new memory. The call number is not here: it is
 * issued at commit, inside the transaction (guardrail 6).
 */
export const memoryCreateSchema = z
  .object({
    /** Where it lives. Defaults to Returns, DSK/RET. */
    shelf: shelfRefSchema.optional(),
    /** When it happened, not when it was written. Midnight UTC. */
    occurredOn: dateOnlySchema,
    kind: MemoryKind,
    scope: MemoryScope.default("global"),
    scopeRef: z.string().trim().min(1).max(200).optional(),
    title: titleSchema,
    body: bodySchema,
    why: longText,
    howToApply: longText,
    importance: importanceSchema.default(3),
    trust: TrustTier,
    /** When it became true. Defaults to occurredOn. Starting value. */
    validFrom: dateTimeSchema.optional(),
    pinned: z.boolean().default(false),
    /** Slugs, normalised. Inline #tags in the body are added to these. */
    tags: z.array(tagSlugSchema).default([]),
    refs: z.array(refInputSchema).default([]),
    sources: z.array(memorySourceInputSchema).min(1, NO_SOURCE_MESSAGE),
    /** Defaults to the time of the commit. */
    lastConfirmedAt: dateTimeSchema.optional(),
  })
  .refine(scopeIsConsistent, { message: SCOPE_MESSAGE, path: ["scopeRef"] });

/**
 * A new version of one memory, same call number. Moving it (shelf or date) is
 * reshelving, and its tags have their own calls, so neither is here.
 */
export const memoryUpdateSchema = z
  .object({
    title: titleSchema.optional(),
    body: bodySchema.optional(),
    why: longText,
    howToApply: longText,
    importance: importanceSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Nothing to update",
  });

/** The replacement in a supersede: a full new memory, shelved at its own date. */
export const memorySupersedeSchema = memoryCreateSchema;

export type MemoryCreateInput = z.input<typeof memoryCreateSchema>;
export type ParsedMemoryCreate = z.output<typeof memoryCreateSchema>;
export type MemoryUpdateInput = z.input<typeof memoryUpdateSchema>;
export type ParsedMemoryUpdate = z.output<typeof memoryUpdateSchema>;
