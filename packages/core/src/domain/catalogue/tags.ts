// Tags: one vocabulary of lowercase slugs. docs/SPEC.md section 6.
//
// A shelf answers where a memory lives; a tag answers what else it is about.
// Every write path normalises before lookup, so #NightStash, #nightstash and
// nightstash are one tag. Memory.tagText carries the slugs for memory_fts,
// because no trigger on Memory can join MemoryTag, and core keeps it in step on
// every tag change.

import { normaliseTagSlug, tagSlugSchema } from "../../schemas/tag.js";
import { atomic, type Db, type Tx } from "../db.js";
import { DomainError } from "../errors.js";
import { appendVersion, type MutationOptions } from "../versions.js";

export { normaliseTagSlug };

/** A tag slug, or a DomainError saying why it is not one. */
export function normaliseTag(input: string): string {
  const parsed = tagSlugSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("invalid_input", parsed.error.issues[0]?.message ?? "Not a tag");
  }
  return parsed.data;
}

/**
 * Inline `#tags` in a body, normalised, in the order first written, each once.
 *
 * A `#` counts only at the start of the text or after whitespace or opening
 * punctuation, so a URL fragment (`example.com/#top`), an HTML entity
 * (`&#39;`) and a markdown heading (`# Title`) are not tags. Trailing hyphens
 * are dropped (`#ns-` reads as `ns`). A word past 64 characters is not a tag
 * and is skipped. Starting value.
 */
export function parseInlineTags(body: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|[\s([{"'])#([A-Za-z0-9][A-Za-z0-9-]*)/g;
  for (const match of body.matchAll(pattern)) {
    const raw = (match[1] as string).replace(/-+$/, "");
    const slug = normaliseTagSlug(raw);
    if (slug !== null && !found.includes(slug)) found.push(slug);
  }
  return found;
}

/**
 * Tag colours, deterministic by slug. The design names a colour column and no
 * palette; these are Fellowship's twelve avatar tones. Starting value.
 */
export const TAG_PALETTE = [
  "#b3162f",
  "#dc7465",
  "#c8955a",
  "#6f9a7e",
  "#4f8f8b",
  "#5b82a6",
  "#5f6aa0",
  "#8a6a9e",
  "#a8617f",
  "#d0828f",
  "#6b6d75",
  "#8d9a52",
] as const;

export function tagColourFor(slug: string): string {
  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) {
    hash = (hash * 31 + slug.charCodeAt(index)) >>> 0;
  }
  return TAG_PALETTE[hash % TAG_PALETTE.length] as string;
}

/** The tag row for a slug, made when it is new. */
export async function ensureTag(
  db: Db,
  input: string,
  colour?: string,
): Promise<{ id: string; slug: string; colour: string }> {
  const slug = normaliseTag(input);
  return db.tag.upsert({
    where: { slug },
    create: { slug, colour: colour ?? tagColourFor(slug) },
    update: {},
  });
}

/** Rewrites Memory.tagText from the join rows: slugs, sorted, space separated. */
export async function refreshTagText(tx: Tx, memoryId: string): Promise<string> {
  const rows = await tx.memoryTag.findMany({
    where: { memoryId },
    include: { tag: { select: { slug: true } } },
  });
  const tagText = rows
    .map((row) => row.tag.slug)
    .sort()
    .join(" ");
  await tx.memory.update({ where: { id: memoryId }, data: { tagText } });
  return tagText;
}

/** The slugs on one memory, sorted. */
export async function tagsOf(db: Db, memoryId: string): Promise<string[]> {
  const rows = await db.memoryTag.findMany({
    where: { memoryId },
    include: { tag: { select: { slug: true } } },
  });
  return rows.map((row) => row.tag.slug).sort();
}

/**
 * Attach tags inside an open transaction, with no version: for a commit that
 * writes its own version afterwards.
 */
export async function attachTagsRaw(tx: Tx, memoryId: string, slugs: string[]): Promise<string[]> {
  const added: string[] = [];
  for (const input of slugs) {
    const tag = await ensureTag(tx, input);
    const existing = await tx.memoryTag.findUnique({
      where: { memoryId_tagId: { memoryId, tagId: tag.id } },
    });
    if (existing) continue;
    await tx.memoryTag.create({ data: { memoryId, tagId: tag.id } });
    added.push(tag.slug);
  }
  await refreshTagText(tx, memoryId);
  return added;
}

async function requireMemory(tx: Tx, memoryId: string): Promise<void> {
  const row = await tx.memory.findUnique({ where: { id: memoryId }, select: { id: true } });
  if (!row) throw new DomainError("not_found", `No memory with id ${memoryId}.`);
}

/** Attach tags to one memory. A change writes an `update` version. */
export async function attachTags(
  db: Db,
  memoryId: string,
  slugs: string[],
  options: MutationOptions,
): Promise<{ added: string[]; tags: string[] }> {
  const normalised = slugs.map(normaliseTag);
  return atomic(db, async (tx) => {
    await requireMemory(tx, memoryId);
    const added = await attachTagsRaw(tx, memoryId, normalised);
    if (added.length > 0) await appendVersion(tx, memoryId, { ...options, operation: "update" });
    return { added, tags: await tagsOf(tx, memoryId) };
  });
}

/** Detach tags from one memory. The tag stays in the vocabulary. */
export async function detachTags(
  db: Db,
  memoryId: string,
  slugs: string[],
  options: MutationOptions,
): Promise<{ removed: string[]; tags: string[] }> {
  const normalised = slugs.map(normaliseTag);
  return atomic(db, async (tx) => {
    await requireMemory(tx, memoryId);
    const removed: string[] = [];
    for (const slug of normalised) {
      const tag = await tx.tag.findUnique({ where: { slug } });
      if (!tag) continue;
      const result = await tx.memoryTag.deleteMany({ where: { memoryId, tagId: tag.id } });
      if (result.count > 0) removed.push(slug);
    }
    await refreshTagText(tx, memoryId);
    if (removed.length > 0) await appendVersion(tx, memoryId, { ...options, operation: "update" });
    return { removed, tags: await tagsOf(tx, memoryId) };
  });
}

async function refreshTagTextFor(tx: Tx, memoryIds: Iterable<string>): Promise<void> {
  for (const memoryId of new Set(memoryIds)) await refreshTagText(tx, memoryId);
}

/**
 * Rename a tag across the vocabulary. The row keeps its id, so every memory
 * and project carrying it follows; no body is rewritten. Renaming onto a slug
 * that already exists is a merge, and is refused here so the caller says so.
 *
 * Vocabulary operations write no MemoryVersion: they change what a tag is
 * called, not what any memory says. Starting value.
 */
export async function renameTag(
  db: Db,
  from: string,
  to: string,
): Promise<{ id: string; slug: string; memories: number }> {
  const fromSlug = normaliseTag(from);
  const toSlug = normaliseTag(to);
  return atomic(db, async (tx) => {
    const tag = await tx.tag.findUnique({ where: { slug: fromSlug } });
    if (!tag) throw new DomainError("not_found", `No tag #${fromSlug}.`);
    if (fromSlug === toSlug) return { id: tag.id, slug: toSlug, memories: 0 };
    const clash = await tx.tag.findUnique({ where: { slug: toSlug } });
    if (clash) {
      throw new DomainError(
        "conflict",
        `#${toSlug} already exists. Merge #${fromSlug} into it instead.`,
      );
    }
    await tx.tag.update({ where: { id: tag.id }, data: { slug: toSlug } });
    const rows = await tx.memoryTag.findMany({ where: { tagId: tag.id }, select: { memoryId: true } });
    await refreshTagTextFor(tx, rows.map((row) => row.memoryId));
    return { id: tag.id, slug: toSlug, memories: rows.length };
  });
}

/**
 * Merge one tag into another: `#ns` into `#nightstash`. Rewrites the MemoryTag
 * join rows only. A memory carrying both keeps one row, on the target. A
 * project pointing at the old tag is repointed. The old Tag row is deleted, so
 * nothing is left on the old slug. A target that does not exist yet is made.
 */
export async function mergeTags(
  db: Db,
  from: string,
  into: string,
): Promise<{ into: string; moved: number; alreadyTagged: number }> {
  const fromSlug = normaliseTag(from);
  const intoSlug = normaliseTag(into);
  if (fromSlug === intoSlug) {
    throw new DomainError("invalid_input", `Cannot merge #${fromSlug} into itself.`);
  }
  return atomic(db, async (tx) => {
    const source = await tx.tag.findUnique({ where: { slug: fromSlug } });
    if (!source) throw new DomainError("not_found", `No tag #${fromSlug}.`);
    const target = await ensureTag(tx, intoSlug, source.colour);

    const rows = await tx.memoryTag.findMany({ where: { tagId: source.id }, select: { memoryId: true } });
    const memoryIds = rows.map((row) => row.memoryId);
    const both = await tx.memoryTag.findMany({
      where: { tagId: target.id, memoryId: { in: memoryIds } },
      select: { memoryId: true },
    });
    const carriesBoth = new Set(both.map((row) => row.memoryId));

    await tx.memoryTag.deleteMany({ where: { tagId: source.id } });
    const toMove = memoryIds.filter((memoryId) => !carriesBoth.has(memoryId));
    if (toMove.length > 0) {
      await tx.memoryTag.createMany({
        data: toMove.map((memoryId) => ({ memoryId, tagId: target.id })),
      });
    }

    await tx.project.updateMany({ where: { tagId: source.id }, data: { tagId: target.id } });
    await tx.tag.delete({ where: { id: source.id } });
    await refreshTagTextFor(tx, memoryIds);

    return { into: intoSlug, moved: toMove.length, alreadyTagged: carriesBoth.size };
  });
}

export interface VocabularyEntry {
  id: string;
  slug: string;
  colour: string;
  count: number;
}

/**
 * The vocabulary with counts, most used first, then by slug. This is the list
 * the extract job is handed so the drafter proposes from the existing set.
 * Counts every memory row, whatever its state.
 */
export async function tagVocabulary(db: Db): Promise<VocabularyEntry[]> {
  const tags = await db.tag.findMany({ include: { _count: { select: { memories: true } } } });
  return tags
    .map((tag) => ({ id: tag.id, slug: tag.slug, colour: tag.colour, count: tag._count.memories }))
    .sort((a, b) => b.count - a.count || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}
