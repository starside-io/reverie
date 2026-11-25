// Sections, shelves, and where each memory sits on them. docs/SPEC.md section 5.
//
// Every memory has exactly one home. Sections and shelves are the owner's to
// make, rename, reorder and merge; renaming changes the name, never the code.
// Moving a memory issues a new call number and keeps the old one as an alias,
// so a number quoted last month still resolves. A shelf with entries is merged
// or emptied, never deleted, and Returns (DSK/RET) always exists.

import type { Section, Shelf } from "../../../generated/prisma/index.js";
import { dateOnlySchema, dayKey } from "../../schemas/common.js";
import {
  sectionCreateSchema,
  sectionRenameSchema,
  type SectionCreateInput,
} from "../../schemas/section.js";
import {
  shelfCreateSchema,
  shelfRefSchema,
  shelfRenameSchema,
  type ShelfCreateInput,
  type ShelfRef,
  type ShelfRenameInput,
} from "../../schemas/shelf.js";
import { atomic, type Db, type Tx } from "../db.js";
import { DomainError, parseInput } from "../errors.js";
import { appendVersion, memoryIdOf, type MutationOptions } from "../versions.js";
import {
  formatCallNumber,
  isCallNumberTaken,
  issueCallNumber,
  writeAlias,
} from "./call-number.js";

/** Where an entry waits when nobody could tell where it goes. */
export const RETURNS = { section: "DSK", shelf: "RET" } as const;
export const RETURNS_PATH = `${RETURNS.section}/${RETURNS.shelf}`;

export interface SeedShelf {
  code: string;
  name: string;
  description: string;
}

export interface SeedSection {
  code: string;
  name: string;
  shelves: SeedShelf[];
}

/**
 * The starting set, seeded on first run. Codes and names are the design's;
 * the descriptions, written for the drafter, are starting values.
 */
export const STARTING_LIBRARY: readonly SeedSection[] = [
  {
    code: "WRK",
    name: "Work",
    shelves: [
      { code: "NST", name: "NightStash", description: "NightStash, the product: decisions, pricing, customers, releases." },
      { code: "FLW", name: "Fellowship", description: "Fellowship, the people app: design, decisions, releases." },
      { code: "CLI", name: "Clients", description: "Client work: who, what was agreed, how each one likes to work." },
    ],
  },
  {
    code: "LIF",
    name: "Life",
    shelves: [
      { code: "GTH", name: "Gatherings", description: "Parties, dinners and visits: who was there and what happened." },
      { code: "TRV", name: "Travel", description: "Trips: where, when, with whom, and what to remember next time." },
      { code: "HOM", name: "Home", description: "The house and the household: repairs, routines, where things are." },
      { code: "HLT", name: "Health", description: "Health, appointments and what helps. Saved only on an explicit ask." },
    ],
  },
  {
    code: "CRF",
    name: "Craft",
    shelves: [
      { code: "HOW", name: "How I work", description: "How to work for the owner: habits, rules, and the why behind each." },
      { code: "TLG", name: "Tooling", description: "Tools, editors and setups, and the settings that matter." },
      { code: "WRT", name: "Writing", description: "Voice, style rules, and drafts worth keeping." },
    ],
  },
  {
    code: "REF",
    name: "Reference",
    shelves: [
      { code: "LNK", name: "Links", description: "Pointers to pages, docs and dashboards worth finding again." },
      { code: "ACC", name: "Accounts", description: "Which service holds what and how it is set up. Never a password or a key." },
    ],
  },
  {
    code: "DSK",
    name: "Front desk",
    shelves: [
      { code: "RET", name: "Returns", description: "Waiting to be shelved: anything the drafter could not place, or that came with no shelf." },
    ],
  },
];

export type ShelfWithSection = Shelf & { section: Section };

function pathOf(shelf: ShelfWithSection): string {
  return `${shelf.section.code}/${shelf.code}`;
}

function isReturns(shelf: ShelfWithSection): boolean {
  return shelf.section.code === RETURNS.section && shelf.code === RETURNS.shelf;
}

/**
 * Seed the starting set on first run: only when the silo has no section at
 * all, so a shelf the owner merged away is never brought back.
 */
export async function seedLibrary(db: Db): Promise<{ seeded: boolean }> {
  return atomic(db, async (tx) => {
    if ((await tx.section.count()) > 0) return { seeded: false };
    for (const [sectionIndex, section] of STARTING_LIBRARY.entries()) {
      const created = await tx.section.create({
        data: { code: section.code, name: section.name, order: sectionIndex + 1 },
      });
      for (const [shelfIndex, shelf] of section.shelves.entries()) {
        await tx.shelf.create({
          data: { sectionId: created.id, ...shelf, order: shelfIndex + 1 },
        });
      }
    }
    return { seeded: true };
  });
}

/**
 * One shelf, by "WRK/NST", by codes, or by id. With nothing given, Returns:
 * nothing is refused for want of a home.
 */
export async function resolveShelf(db: Db, ref?: ShelfRef | null): Promise<ShelfWithSection> {
  const parsed = ref === undefined || ref === null ? RETURNS_PATH : parseInput(shelfRefSchema, ref);
  if (typeof parsed === "object" && "id" in parsed) {
    const shelf = await db.shelf.findUnique({ where: { id: parsed.id }, include: { section: true } });
    if (!shelf) throw new DomainError("not_found", `No shelf with id ${parsed.id}.`);
    return shelf;
  }
  const [section, code] =
    typeof parsed === "string" ? (parsed.split("/") as [string, string]) : [parsed.section, parsed.shelf];
  const shelf = await db.shelf.findFirst({
    where: { code, section: { code: section } },
    include: { section: true },
  });
  if (!shelf) {
    const hint =
      section === RETURNS.section && code === RETURNS.shelf ? " Seed the library first." : "";
    throw new DomainError("not_found", `No shelf ${section}/${code}.${hint}`);
  }
  return shelf;
}

/** Returns, DSK/RET: the default shelf when none is given. */
export async function defaultShelf(db: Db): Promise<ShelfWithSection> {
  return resolveShelf(db, RETURNS_PATH);
}

async function sectionByCode(db: Db, code: string): Promise<Section> {
  const section = await db.section.findUnique({ where: { code } });
  if (!section) throw new DomainError("not_found", `No section ${code}.`);
  return section;
}

// Sections ------------------------------------------------------------------

export async function createSection(db: Db, input: SectionCreateInput): Promise<Section> {
  const data = parseInput(sectionCreateSchema, input);
  return atomic(db, async (tx) => {
    if (await tx.section.findUnique({ where: { code: data.code } })) {
      throw new DomainError("conflict", `Section ${data.code} already exists.`);
    }
    const last = await tx.section.aggregate({ _max: { order: true } });
    return tx.section.create({
      data: { code: data.code, name: data.name, order: data.order ?? (last._max.order ?? 0) + 1 },
    });
  });
}

/** Renaming changes the name, never the code. */
export async function renameSection(db: Db, code: string, name: string): Promise<Section> {
  const data = parseInput(sectionRenameSchema, { name });
  const section = await sectionByCode(db, code);
  return db.section.update({ where: { id: section.id }, data: { name: data.name } });
}

function assertPermutation(given: string[], existing: string[], what: string): void {
  const sortedGiven = [...given].sort();
  const sortedExisting = [...existing].sort();
  const same =
    sortedGiven.length === sortedExisting.length &&
    sortedGiven.every((value, index) => value === sortedExisting[index]);
  if (!same) {
    throw new DomainError(
      "invalid_input",
      `Name every ${what} exactly once, in the new order: ${sortedExisting.join(", ")}.`,
    );
  }
}

/** Set the order of every section, first to last. */
export async function reorderSections(db: Db, codes: string[]): Promise<Section[]> {
  return atomic(db, async (tx) => {
    const sections = await tx.section.findMany();
    assertPermutation(codes, sections.map((section) => section.code), "section");
    for (const [index, code] of codes.entries()) {
      await tx.section.update({ where: { code }, data: { order: index + 1 } });
    }
    return tx.section.findMany({ orderBy: { order: "asc" } });
  });
}

/**
 * Merge one section into another. Each shelf moves across; where the target
 * already has a shelf with the same code, the two shelves merge. Every entry
 * whose number changes keeps its old one as an alias. The emptied section is
 * deleted. The front desk cannot be merged away: Returns lives there.
 */
export async function mergeSections(
  db: Db,
  from: string,
  into: string,
  options: MutationOptions,
): Promise<{ moved: number; reshelved: number }> {
  if (from === into) throw new DomainError("invalid_input", `Cannot merge ${from} into itself.`);
  if (from === RETURNS.section) {
    throw new DomainError("refused", `${from} holds Returns, the default shelf, and cannot be merged away.`);
  }
  return atomic(db, async (tx) => {
    const source = await sectionByCode(tx, from);
    const target = await sectionByCode(tx, into);
    const shelves = await tx.shelf.findMany({
      where: { sectionId: source.id },
      orderBy: { order: "asc" },
    });
    const lastOrder = (await tx.shelf.aggregate({ where: { sectionId: target.id }, _max: { order: true } }))
      ._max.order ?? 0;

    let reshelved = 0;
    let nextOrder = lastOrder + 1;
    for (const shelf of shelves) {
      const clash = await tx.shelf.findUnique({
        where: { sectionId_code: { sectionId: target.id, code: shelf.code } },
      });
      if (clash) {
        reshelved += (await mergeShelvesTx(tx, shelf.id, clash.id, options)).reshelved;
        continue;
      }
      await tx.shelf.update({ where: { id: shelf.id }, data: { sectionId: target.id, order: nextOrder } });
      nextOrder += 1;
      // Same shelf, same day: only the section code changes, so each entry
      // keeps its sequence unless that number was used before.
      const memories = await tx.memory.findMany({
        where: { shelfId: shelf.id },
        orderBy: { callNumber: "asc" },
        select: { id: true, occurredOn: true, seq: true },
      });
      for (const memory of memories) {
        await reshelveTx(tx, memory.id, { shelfId: shelf.id, occurredOn: memory.occurredOn }, options, memory.seq);
        reshelved += 1;
      }
    }

    await tx.section.delete({ where: { id: source.id } });
    return { moved: shelves.length, reshelved };
  });
}

// Shelves -------------------------------------------------------------------

export async function createShelf(db: Db, input: ShelfCreateInput): Promise<ShelfWithSection> {
  const data = parseInput(shelfCreateSchema, input);
  return atomic(db, async (tx) => {
    const section = await sectionByCode(tx, data.section);
    const clash = await tx.shelf.findUnique({
      where: { sectionId_code: { sectionId: section.id, code: data.code } },
    });
    if (clash) throw new DomainError("conflict", `Shelf ${data.section}/${data.code} already exists.`);
    const last = await tx.shelf.aggregate({ where: { sectionId: section.id }, _max: { order: true } });
    return tx.shelf.create({
      data: {
        sectionId: section.id,
        code: data.code,
        name: data.name,
        description: data.description,
        order: data.order ?? (last._max.order ?? 0) + 1,
      },
      include: { section: true },
    });
  });
}

/** Renaming changes the name, and the description if given, never the code. */
export async function renameShelf(
  db: Db,
  ref: ShelfRef,
  input: ShelfRenameInput,
): Promise<ShelfWithSection> {
  const data = parseInput(shelfRenameSchema, input);
  const shelf = await resolveShelf(db, ref);
  return db.shelf.update({
    where: { id: shelf.id },
    data: { name: data.name, ...(data.description !== undefined ? { description: data.description } : {}) },
    include: { section: true },
  });
}

/** Set the order of every shelf in one section, first to last. */
export async function reorderShelves(db: Db, sectionCode: string, codes: string[]): Promise<Shelf[]> {
  return atomic(db, async (tx) => {
    const section = await sectionByCode(tx, sectionCode);
    const shelves = await tx.shelf.findMany({ where: { sectionId: section.id } });
    assertPermutation(codes, shelves.map((shelf) => shelf.code), `shelf in ${sectionCode}`);
    for (const [index, code] of codes.entries()) {
      await tx.shelf.update({
        where: { sectionId_code: { sectionId: section.id, code } },
        data: { order: index + 1 },
      });
    }
    return tx.shelf.findMany({ where: { sectionId: section.id }, orderBy: { order: "asc" } });
  });
}

async function mergeShelvesTx(
  tx: Tx,
  fromId: string,
  intoId: string,
  options: MutationOptions,
): Promise<{ reshelved: number }> {
  // In library order, so each day's entries land after the target's own, in
  // the order they had.
  const memories = await tx.memory.findMany({
    where: { shelfId: fromId },
    orderBy: { callNumber: "asc" },
    select: { id: true, occurredOn: true },
  });
  for (const memory of memories) {
    await reshelveTx(tx, memory.id, { shelfId: intoId, occurredOn: memory.occurredOn }, options);
  }
  await tx.project.updateMany({ where: { shelfId: fromId }, data: { shelfId: intoId } });
  await tx.shelf.delete({ where: { id: fromId } });
  return { reshelved: memories.length };
}

/**
 * Merge one shelf into another: every entry is reshelved, every old number
 * kept as an alias, projects repointed, and the emptied shelf deleted.
 * Returns cannot be merged away.
 */
export async function mergeShelves(
  db: Db,
  from: ShelfRef,
  into: ShelfRef,
  options: MutationOptions,
): Promise<{ reshelved: number }> {
  return atomic(db, async (tx) => {
    const source = await resolveShelf(tx, from);
    const target = await resolveShelf(tx, into);
    if (source.id === target.id) {
      throw new DomainError("invalid_input", `Cannot merge ${pathOf(source)} into itself.`);
    }
    if (isReturns(source)) {
      throw new DomainError("refused", `${RETURNS_PATH} is Returns, the default shelf, and cannot be merged away.`);
    }
    return mergeShelvesTx(tx, source.id, target.id, options);
  });
}

/**
 * Delete an empty shelf. A shelf with entries is refused: merge it or empty it
 * first, so nothing is ever without a home. Returns is never deleted. A shelf
 * a project points at is refused too, so the project keeps its home. Starting
 * value for that last rule.
 */
export async function deleteShelf(db: Db, ref: ShelfRef): Promise<void> {
  await atomic(db, async (tx) => {
    const shelf = await resolveShelf(tx, ref);
    if (isReturns(shelf)) {
      throw new DomainError("refused", `${RETURNS_PATH} is Returns, the default shelf, and is never deleted.`);
    }
    const entries = await tx.memory.count({ where: { shelfId: shelf.id } });
    if (entries > 0) {
      throw new DomainError(
        "refused",
        `${pathOf(shelf)} holds ${entries} ${entries === 1 ? "entry" : "entries"}. Merge it into another shelf or move them first.`,
        { shelf: pathOf(shelf), entries },
      );
    }
    const projects = await tx.project.findMany({ where: { shelfId: shelf.id }, select: { slug: true } });
    if (projects.length > 0) {
      throw new DomainError(
        "refused",
        `${pathOf(shelf)} is the shelf of ${projects.map((project) => project.slug).join(", ")}. Point the project elsewhere first.`,
      );
    }
    await tx.shelf.delete({ where: { id: shelf.id } });
  });
}

// Moving one memory ----------------------------------------------------------

export interface ReshelveResult {
  memoryId: string;
  from: string;
  to: string;
}

/**
 * Move one row, inside a transaction. `preferSeq` keeps the sequence when the
 * new number has never been used, which is what lets a shelf change section
 * without renumbering its days.
 */
async function reshelveTx(
  tx: Tx,
  memoryId: string,
  target: { shelfId: string; occurredOn: Date },
  options: MutationOptions,
  preferSeq?: number,
): Promise<ReshelveResult> {
  const memory = await tx.memory.findUnique({ where: { id: memoryId } });
  if (!memory) throw new DomainError("not_found", `No memory with id ${memoryId}.`);

  let next: { callNumber: string; seq: number } | null = null;
  if (preferSeq !== undefined) {
    const shelf = await tx.shelf.findUnique({ where: { id: target.shelfId }, include: { section: true } });
    if (!shelf) throw new DomainError("not_found", `No shelf with id ${target.shelfId}.`);
    const callNumber = formatCallNumber({
      section: shelf.section.code,
      shelf: shelf.code,
      occurredOn: target.occurredOn,
      seq: preferSeq,
    });
    const holder = await tx.memory.findUnique({
      where: {
        shelfId_occurredOn_seq: { shelfId: target.shelfId, occurredOn: target.occurredOn, seq: preferSeq },
      },
      select: { id: true },
    });
    const free = (!holder || holder.id === memoryId) && !(await isCallNumberTaken(tx, callNumber));
    if (free) next = { callNumber, seq: preferSeq };
  }
  next ??= await issueCallNumber(tx, target);

  await writeAlias(tx, memory.callNumber, memoryId);
  await tx.memory.update({
    where: { id: memoryId },
    data: {
      callNumber: next.callNumber,
      shelfId: target.shelfId,
      occurredOn: target.occurredOn,
      seq: next.seq,
    },
  });
  await appendVersion(tx, memoryId, { ...options, operation: "shelve" });
  return { memoryId, from: memory.callNumber, to: next.callNumber };
}

/**
 * Move one memory to another shelf, another day, or both. A new number is
 * issued and the old one kept as an alias. Takes an id or a call number.
 */
export async function reshelveMemory(
  db: Db,
  memory: string | { id: string },
  target: { shelf?: ShelfRef; occurredOn?: Date | string },
  options: MutationOptions,
): Promise<ReshelveResult> {
  return atomic(db, async (tx) => {
    const memoryId = await memoryIdOf(tx, memory);
    const row = await tx.memory.findUnique({ where: { id: memoryId } });
    if (!row) throw new DomainError("not_found", `No memory with id ${memoryId}.`);
    const shelfId = target.shelf !== undefined ? (await resolveShelf(tx, target.shelf)).id : row.shelfId;
    const occurredOn =
      target.occurredOn !== undefined ? parseInput(dateOnlySchema, target.occurredOn) : row.occurredOn;
    if (shelfId === row.shelfId && occurredOn.getTime() === row.occurredOn.getTime()) {
      throw new DomainError("invalid_input", `${row.callNumber} is already there.`);
    }
    return reshelveTx(tx, memoryId, { shelfId, occurredOn }, options);
  });
}

/**
 * Put the entries of one shelf and day in a new order. `order` names every
 * entry of that day once (ids or call numbers), first to last; they take the
 * day's existing sequence numbers in that order. Each number that moved is
 * kept as an alias of the memory that held it. A number that is both live and
 * an alias resolves to its live holder.
 */
export async function reorderDay(
  db: Db,
  input: { shelf: ShelfRef; occurredOn: Date | string; order: string[] },
  options: MutationOptions,
): Promise<ReshelveResult[]> {
  return atomic(db, async (tx) => {
    const shelf = await resolveShelf(tx, input.shelf);
    const occurredOn = parseInput(dateOnlySchema, input.occurredOn);
    const ids: string[] = [];
    for (const entry of input.order) ids.push(await memoryIdOf(tx, entry));
    return permuteDay(tx, shelf, occurredOn, ids, options);
  });
}

/** Swap the sequence numbers of two entries on the same shelf and day. */
export async function swapSeq(
  db: Db,
  a: string | { id: string },
  b: string | { id: string },
  options: MutationOptions,
): Promise<ReshelveResult[]> {
  return atomic(db, async (tx) => {
    const first = await tx.memory.findUnique({
      where: { id: await memoryIdOf(tx, a) },
      include: { shelf: { include: { section: true } } },
    });
    const second = await tx.memory.findUnique({ where: { id: await memoryIdOf(tx, b) } });
    if (!first || !second) throw new DomainError("not_found", "Both memories must exist.");
    if (first.shelfId !== second.shelfId || first.occurredOn.getTime() !== second.occurredOn.getTime()) {
      throw new DomainError("invalid_input", `${first.callNumber} and ${second.callNumber} are not on the same shelf and day.`);
    }
    const day = await tx.memory.findMany({
      where: { shelfId: first.shelfId, occurredOn: first.occurredOn },
      orderBy: { seq: "asc" },
      select: { id: true },
    });
    const order = day.map((row) =>
      row.id === first.id ? second.id : row.id === second.id ? first.id : row.id,
    );
    return permuteDay(tx, first.shelf, first.occurredOn, order, options);
  });
}

async function permuteDay(
  tx: Tx,
  shelf: ShelfWithSection,
  occurredOn: Date,
  order: string[],
  options: MutationOptions,
): Promise<ReshelveResult[]> {
  const rows = await tx.memory.findMany({
    where: { shelfId: shelf.id, occurredOn },
    orderBy: { seq: "asc" },
    select: { id: true, seq: true, callNumber: true },
  });
  assertPermutation(order, rows.map((row) => row.id), `entry on ${pathOf(shelf)} for ${dayKey(occurredOn)}`);

  const seqs = rows.map((row) => row.seq);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const moves = order
    .map((id, index) => ({ row: byId.get(id) as (typeof rows)[number], seq: seqs[index] as number }))
    .filter((move) => move.row.seq !== move.seq);

  // Two passes, because (shelf, day, seq) and the call number are unique: park
  // every moving row on a number that cannot exist, then set the real ones.
  for (const [index, move] of moves.entries()) {
    await tx.memory.update({
      where: { id: move.row.id },
      data: { seq: -(index + 1), callNumber: `~reorder/${move.row.id}` },
    });
  }
  const results: ReshelveResult[] = [];
  for (const move of moves) {
    const callNumber = formatCallNumber({
      section: shelf.section.code,
      shelf: shelf.code,
      occurredOn,
      seq: move.seq,
    });
    await tx.memory.update({ where: { id: move.row.id }, data: { seq: move.seq, callNumber } });
    await writeAlias(tx, move.row.callNumber, move.row.id);
    await appendVersion(tx, move.row.id, { ...options, operation: "shelve" });
    results.push({ memoryId: move.row.id, from: move.row.callNumber, to: callNumber });
  }
  return results;
}
