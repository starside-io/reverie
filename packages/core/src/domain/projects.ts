// The project registry. docs/SPEC.md section 4, "Projects"; section 11,
// `Project`.
//
// A project is slug, name, repository, shelf, tag and description, recorded
// once in the silo. Its local folder paths are not here and never will be: a
// path is true on one machine only, so the host keeps them (the settings
// port's localPaths). Nothing in this file takes or stores a path.
//
// Each new project gets a shelf and a tag, proposed and shown before they are
// made. proposeProjectHome is the proposal; createProject makes what it is
// given.

import type { Project, Section, Shelf, Tag } from "../../generated/prisma/index.js";
import { normaliseRepoUrl, projectSlugSchema } from "../schemas/project.js";
import type { ShelfRef } from "../schemas/shelf.js";
import { createShelf, resolveShelf, type ShelfWithSection } from "./catalogue/shelving.js";
import { ensureTag, normaliseTag } from "./catalogue/tags.js";
import { atomic, type Db, type Tx } from "./db.js";
import { DomainError, parseInput } from "./errors.js";

/** Where a new project's shelf goes unless told otherwise: Work. Starting value. */
export const PROJECT_SECTION = "WRK";

export type ProjectRow = Project & { shelf: (Shelf & { section: Section }) | null; tag: Tag | null };

export interface ProjectView {
  slug: string;
  name: string;
  repoUrl: string | null;
  /** "WRK/NST", or null when it has no shelf. */
  shelf: string | null;
  /** The tag slug, no `#`. */
  tag: string | null;
  description: string | null;
  archived: boolean;
}

export function projectView(row: ProjectRow): ProjectView {
  return {
    slug: row.slug,
    name: row.name,
    repoUrl: row.repoUrl,
    shelf: row.shelf ? `${row.shelf.section.code}/${row.shelf.code}` : null,
    tag: row.tag?.slug ?? null,
    description: row.description,
    archived: row.archived,
  };
}

const INCLUDE = { shelf: { include: { section: true } }, tag: true } as const;

export async function getProject(db: Db, slug: string): Promise<ProjectRow> {
  const row = await db.project.findUnique({ where: { slug }, include: INCLUDE });
  if (!row) throw new DomainError("not_found", `No project ${slug}.`);
  return row;
}

export function normaliseProjectSlug(input: string): string {
  return parseInput(projectSlugSchema, input);
}

/** The repository as `github.com/owner/name`, or invalid_input. */
export function requireRepoUrl(input: string): string {
  const repo = normaliseRepoUrl(input);
  if (repo === null) {
    throw new DomainError("invalid_input", `"${input}" is not a repository. Expected one such as github.com/owner/name.`);
  }
  return repo;
}

export interface ProposedShelf {
  /** An existing shelf with the project's name, used as it is. */
  existing: string | null;
  /** A shelf to make, when none exists. */
  create: { section: string; code: string; name: string; description: string } | null;
}

export interface ProjectHomeProposal {
  shelf: ProposedShelf | null;
  /** The tag slug: the project's slug. */
  tag: string;
  /** True when the tag is already in the vocabulary. */
  tagExists: boolean;
}

/** Three letter codes from a name, most readable first: the first three letters, then the first and later letters in order. */
export function codeCandidates(source: string): string[] {
  const letters = source.toUpperCase().replace(/[^A-Z]/g, "");
  const out: string[] = [];
  const push = (code: string) => {
    if (code.length === 3 && !out.includes(code)) out.push(code);
  };
  if (letters.length >= 3) push(letters.slice(0, 3));
  const first = letters[0];
  if (first) {
    for (let i = 1; i < letters.length; i += 1) {
      for (let j = i + 1; j < letters.length; j += 1) push(`${first}${letters[i]}${letters[j]}`);
    }
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lead = first ?? "P";
  for (const a of alphabet) for (const b of alphabet) push(`${lead}${a}${b}`);
  return out;
}

/**
 * The shelf and tag a new project would get, written nowhere. A shelf in the
 * section already named like the project is proposed as it is; otherwise a
 * new one, with the first free code read from the name. Null for the shelf
 * when the section does not exist.
 */
export async function proposeProjectHome(
  db: Db,
  input: { slug: string; name: string; description?: string | null },
  sectionCode: string = PROJECT_SECTION,
): Promise<ProjectHomeProposal> {
  const slug = normaliseProjectSlug(input.slug);
  const tagExists = (await db.tag.findUnique({ where: { slug }, select: { id: true } })) !== null;
  const section = await db.section.findUnique({
    where: { code: sectionCode },
    include: { shelves: { select: { code: true, name: true } } },
  });
  if (!section) return { shelf: null, tag: slug, tagExists };

  const wanted = input.name.trim().toLowerCase();
  const same = section.shelves.find((shelf) => shelf.name.trim().toLowerCase() === wanted);
  if (same) return { shelf: { existing: `${section.code}/${same.code}`, create: null }, tag: slug, tagExists };

  const taken = new Set(section.shelves.map((shelf) => shelf.code));
  const code = codeCandidates(input.name).find((candidate) => !taken.has(candidate));
  if (!code) return { shelf: null, tag: slug, tagExists };
  const description = input.description?.trim() || `${input.name.trim()}, the project: decisions, releases and how it is built.`;
  return {
    shelf: { existing: null, create: { section: section.code, code, name: input.name.trim(), description } },
    tag: slug,
    tagExists,
  };
}

export interface ProjectCreate {
  slug: string;
  name: string;
  repoUrl?: string | null;
  description?: string | null;
  /** An existing shelf, or null for none. */
  shelf?: ShelfRef | null;
  /** A shelf to make for it. Exclusive with `shelf`. */
  newShelf?: { section: string; code: string; name: string; description: string };
  /** A tag slug, made when new, or null for none. */
  tag?: string | null;
}

async function assertRepoFree(tx: Tx, repoUrl: string, slug: string | null): Promise<void> {
  const holder = await tx.project.findUnique({ where: { repoUrl }, select: { slug: true } });
  if (holder && holder.slug !== slug) {
    throw new DomainError("conflict", `${repoUrl} is already the repository of ${holder.slug}.`, {
      repoUrl,
      heldBy: holder.slug,
    });
  }
}

/** One new project. The shelf and tag it names are made when asked for. */
export async function createProject(db: Db, input: ProjectCreate): Promise<ProjectRow & { createdShelf: ShelfWithSection | null }> {
  const slug = normaliseProjectSlug(input.slug);
  const name = input.name.trim();
  if (name.length === 0) throw new DomainError("invalid_input", "A project needs a name.");
  if (input.shelf && input.newShelf) {
    throw new DomainError("invalid_input", "Give an existing shelf or a new one, not both.");
  }
  const repoUrl = input.repoUrl ? requireRepoUrl(input.repoUrl) : null;
  const tagSlug = input.tag ? normaliseTag(input.tag) : null;

  return atomic(db, async (tx) => {
    if (await tx.project.findUnique({ where: { slug }, select: { id: true } })) {
      throw new DomainError("conflict", `A project ${slug} already exists.`, { slug });
    }
    if (repoUrl) await assertRepoFree(tx, repoUrl, null);

    const createdShelf = input.newShelf ? await createShelf(tx, input.newShelf) : null;
    const shelfId = createdShelf?.id ?? (input.shelf ? (await resolveShelf(tx, input.shelf)).id : null);
    const tagId = tagSlug ? (await ensureTag(tx, tagSlug)).id : null;

    const row = await tx.project.create({
      data: {
        slug,
        name,
        repoUrl,
        description: input.description?.trim() || null,
        shelfId,
        tagId,
      },
      include: INCLUDE,
    });
    return { ...row, createdShelf };
  });
}

export interface ProjectPatch {
  name?: string;
  repoUrl?: string | null;
  description?: string | null;
  shelf?: ShelfRef | null;
  tag?: string | null;
  archived?: boolean;
}

/** Rename, archive, or set the repository, shelf, tag or description. Null clears. */
export async function updateProject(db: Db, slugInput: string, patch: ProjectPatch): Promise<{ project: ProjectRow; changed: boolean }> {
  const slug = normaliseProjectSlug(slugInput);
  const repoUrl = patch.repoUrl === undefined ? undefined : patch.repoUrl === null ? null : requireRepoUrl(patch.repoUrl);
  const tagSlug = patch.tag === undefined ? undefined : patch.tag === null ? null : normaliseTag(patch.tag);

  return atomic(db, async (tx) => {
    const current = await getProject(tx, slug);
    if (repoUrl) await assertRepoFree(tx, repoUrl, slug);

    const data: {
      name?: string;
      repoUrl?: string | null;
      description?: string | null;
      shelfId?: string | null;
      tagId?: string | null;
      archived?: boolean;
    } = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length === 0) throw new DomainError("invalid_input", "A project needs a name.");
      if (name !== current.name) data.name = name;
    }
    if (repoUrl !== undefined && repoUrl !== current.repoUrl) data.repoUrl = repoUrl;
    if (patch.description !== undefined) {
      const description = patch.description?.trim() || null;
      if (description !== current.description) data.description = description;
    }
    if (patch.shelf !== undefined) {
      const shelfId = patch.shelf === null ? null : (await resolveShelf(tx, patch.shelf)).id;
      if (shelfId !== current.shelfId) data.shelfId = shelfId;
    }
    if (tagSlug !== undefined) {
      const tagId = tagSlug === null ? null : (await ensureTag(tx, tagSlug)).id;
      if (tagId !== current.tagId) data.tagId = tagId;
    }
    if (patch.archived !== undefined && patch.archived !== current.archived) data.archived = patch.archived;

    if (Object.keys(data).length === 0) return { project: current, changed: false };
    const project = await tx.project.update({ where: { id: current.id }, data, include: INCLUDE });
    return { project, changed: true };
  });
}
