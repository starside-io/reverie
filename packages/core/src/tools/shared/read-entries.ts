import { z } from "zod";

import type { Prisma } from "../../../generated/prisma/index.js";
import { callQueryWhere, parseCallQuery } from "../../domain/catalogue/call-number.js";
import { DomainError } from "../../domain/errors.js";
import { dayKey } from "../../schemas/common.js";
import type { MemoryKind, MemoryScope, MemoryState, TrustTier } from "../../schemas/enums.js";
import { tagSlugSchema } from "../../schemas/tag.js";

/**
 * The compact entry the listing read tools hand back (browse, about, search,
 * stale): enough to tell entries apart and to follow one up with `get`, never
 * the whole body. Owned by the read tools; a tool that returns a whole memory
 * uses MemoryView from views.ts instead.
 */

/** How much of the body an entry carries. Starting value. */
export const EXCERPT_MAX = 240;

export const ENTRY_INCLUDE = {
  shelf: { include: { section: true } },
  tags: { include: { tag: { select: { slug: true } } } },
} as const satisfies Prisma.MemoryInclude;

export type EntryRow = Prisma.MemoryGetPayload<{ include: typeof ENTRY_INCLUDE }>;

export interface EntryView {
  id: string;
  call: string;
  shelf: string;
  occurredOn: string;
  kind: MemoryKind;
  state: MemoryState;
  trust: TrustTier;
  scope: MemoryScope;
  scopeRef: string | null;
  title: string;
  /** The body's start, cut at a word to EXCERPT_MAX characters. */
  excerpt: string;
  tags: string[];
  pinned: boolean;
  lastConfirmedAt: string;
}

/** The body's start, whitespace collapsed, cut at a word. */
export function excerpt(body: string, max: number = EXCERPT_MAX): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

export function toEntry(row: EntryRow): EntryView {
  return {
    id: row.id,
    call: row.callNumber,
    shelf: `${row.shelf.section.code}/${row.shelf.code}`,
    occurredOn: dayKey(row.occurredOn),
    kind: row.kind as MemoryKind,
    state: row.state as MemoryState,
    trust: row.trust as TrustTier,
    scope: row.scope as MemoryScope,
    scopeRef: row.scopeRef,
    title: row.title,
    excerpt: excerpt(row.body),
    tags: row.tags.map((entry) => entry.tag.slug).sort(),
    pinned: row.pinned,
    lastConfirmedAt: row.lastConfirmedAt.toISOString(),
  };
}

/** Tags as a filter takes them: normalised slugs, at most 20. */
export const tagFilterSchema = z.array(tagSlugSchema).max(20).optional();

/**
 * Include and exclude by tag. A memory passes `include` when it carries at
 * least one of the tags (any of), and passes `exclude` when it carries none
 * of them. Starting value: any of, not all of.
 */
export function tagWhere(include?: readonly string[], exclude?: readonly string[]): Prisma.MemoryWhereInput[] {
  const where: Prisma.MemoryWhereInput[] = [];
  if (include && include.length > 0) where.push({ tags: { some: { tag: { slug: { in: [...include] } } } } });
  if (exclude && exclude.length > 0) where.push({ NOT: { tags: { some: { tag: { slug: { in: [...exclude] } } } } } });
  return where;
}

/**
 * A call number query as a tool takes it: `WRK/NST`, `LIF/GTH/2026-12`,
 * `*\/*\/2026-12-24`. Validated by the catalogue's own parser.
 */
export const callQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .superRefine((value, ctx) => {
    try {
      parseCallQuery(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof DomainError ? error.message : "Not a call number query",
      });
    }
  });

/** The Prisma filter for a validated call number query. */
export function callPrefixWhere(query: string): Prisma.MemoryWhereInput {
  return callQueryWhere(query);
}

/** A page size, with a default and a ceiling. */
export function limitSchema(fallback: number, max: number) {
  return z.number().int().min(1).max(max).default(fallback);
}
