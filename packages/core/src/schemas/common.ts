import { z } from "zod";

export const idSchema = z.string().uuid("Expected a valid id");

export const hexColourSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Expected a hex colour such as #6366f1");

/** Trims text, turns blanks into null. */
const nullableText = z.union([z.string(), z.null()]).transform((value) => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
});

export const optionalText = nullableText.optional();

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Midnight UTC on the UTC calendar day of a date. Every date-only column
 * (occurredOn) is stored this way, docs/SPEC.md section 11.
 */
export function toDateOnly(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/** "2026-12-24" for a date, read on the UTC calendar. */
export function dayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDateInput(value: string | Date): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = new Date(DATE_ONLY.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  // A string like 2026-02-31 parses by rolling over; refuse it rather than
  // shelve a memory on a day that was never written.
  if (DATE_ONLY.test(trimmed) && dayKey(parsed) !== trimmed) return null;
  return parsed;
}

/** A required point in time: a Date, or an ISO string. A bare date is midnight UTC. */
export const dateTimeSchema = z.union([z.string(), z.date()]).transform((value, ctx) => {
  const parsed = parseDateInput(value);
  if (parsed === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a valid date" });
    return z.NEVER;
  }
  return parsed;
});

/**
 * A required calendar day, normalised to midnight UTC. A full timestamp is cut
 * to its UTC day.
 */
export const dateOnlySchema = z.union([z.string(), z.date()]).transform((value, ctx) => {
  const parsed = parseDateInput(value);
  if (parsed === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a valid date" });
    return z.NEVER;
  }
  return toDateOnly(parsed);
});

/** Three uppercase letters: a section code or a shelf code. Stable under rename. */
export const codeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, "Expected a code of three uppercase letters, such as LIF");

/** Who made a change: "user", "proposal:<id>", "import". Starting value. */
export const actorSchema = z.string().trim().min(1, "An actor is required").max(120);
