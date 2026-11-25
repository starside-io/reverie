import { z } from "zod";

import { hexColourSchema } from "./common.js";

/** The most characters a tag slug may hold. docs/SPEC.md section 6, starting value. */
export const TAG_SLUG_MAX_LENGTH = 64;

/** After lowercasing: `[a-z0-9][a-z0-9-]*`. Starting value. */
export const TAG_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Lowercases, trims and strips the leading `#`. `#NightStash`, `#nightstash`
 * and `nightstash` all come out as `nightstash`. Returns null when what is left
 * is not a slug.
 */
export function normaliseTagSlug(input: string): string | null {
  let slug = input.trim().toLowerCase();
  if (slug.startsWith("#")) slug = slug.slice(1);
  if (slug.length === 0 || slug.length > TAG_SLUG_MAX_LENGTH) return null;
  return TAG_SLUG_PATTERN.test(slug) ? slug : null;
}

/** A tag as any write path takes it: normalised before lookup. */
export const tagSlugSchema = z.string().transform((value, ctx) => {
  const slug = normaliseTagSlug(value);
  if (slug === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `"${value}" is not a tag: lowercase letters, digits and hyphens, starting with a letter or digit, at most ${TAG_SLUG_MAX_LENGTH} characters`,
    });
    return z.NEVER;
  }
  return slug;
});

export const tagCreateSchema = z.object({
  slug: tagSlugSchema,
  colour: hexColourSchema.optional(),
});

export const tagRenameSchema = z.object({
  from: tagSlugSchema,
  to: tagSlugSchema,
});

export const tagMergeSchema = z.object({
  from: tagSlugSchema,
  into: tagSlugSchema,
});

export type TagCreateInput = z.input<typeof tagCreateSchema>;
export type TagRenameInput = z.input<typeof tagRenameSchema>;
export type TagMergeInput = z.input<typeof tagMergeSchema>;
