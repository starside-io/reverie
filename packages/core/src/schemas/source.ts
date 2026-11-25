import { z } from "zod";

import { QUOTE_MAX_LENGTH } from "../storage/enum-checks.js";
import { dateTimeSchema, idSchema } from "./common.js";
import { SourceKind, TrustTier } from "./enums.js";

export { QUOTE_MAX_LENGTH };

/**
 * A short quote from the material. Never the transcript: at most 500
 * characters, the same cap the CHECK in the migration holds.
 */
export const quoteSchema = z
  .string()
  .trim()
  .min(1, "A quote is required")
  .max(QUOTE_MAX_LENGTH, `A quote holds at most ${QUOTE_MAX_LENGTH} characters`);

/** A new Source row: where something was read or said. */
export const sourceCreateSchema = z.object({
  kind: SourceKind,
  uri: z.string().trim().min(1).max(2000).optional(),
  /** "session of 2026-12-27". Never the transcript itself. */
  label: z.string().trim().min(1, "A label is required").max(200),
  occurredAt: dateTimeSchema.optional(),
  trust: TrustTier,
});

/**
 * One citation on a memory: a quote, and either a new source or an existing
 * one by id.
 */
export const memorySourceInputSchema = z.union([
  z.object({ sourceId: idSchema, quote: quoteSchema }),
  z.object({ source: sourceCreateSchema, quote: quoteSchema }),
]);

export type SourceCreateInput = z.input<typeof sourceCreateSchema>;
export type MemorySourceInput = z.input<typeof memorySourceInputSchema>;
export type ParsedMemorySource = z.output<typeof memorySourceInputSchema>;
