// The call number: LIF/GTH/2026-12-24/001. docs/SPEC.md section 5.
//
// Section, shelf, the day it happened, and the order that day. Stored, not
// computed, so plain text order is section, shelf, time, sequence, and a prefix
// is one range scan. Issued only at commit, inside the transaction, and never
// reissued: a number that once named a memory stays in CallNumberAlias, even
// when the memory is forgotten and the alias points at nothing.

import type { Prisma } from "../../../generated/prisma/index.js";
import { dayKey } from "../../schemas/common.js";
import { SEQ_MAX, SEQ_MIN } from "../../schemas/memory.js";
import type { Db, Tx } from "../db.js";
import { DomainError } from "../errors.js";

export { SEQ_MAX, SEQ_MIN };

/** The full form, every part required. */
export const CALL_NUMBER_PATTERN = /^([A-Z]{3})\/([A-Z]{3})\/(\d{4}-\d{2}-\d{2})\/(\d{3})$/;

export interface CallNumberParts {
  section: string;
  shelf: string;
  /** "2026-12-24" */
  day: string;
  /** The same day as a Date, midnight UTC. */
  occurredOn: Date;
  seq: number;
}

/** "001". Three digits, fixed from the first entry: a wider number would break text order. */
export function formatSeq(seq: number): string {
  if (!Number.isInteger(seq) || seq < SEQ_MIN || seq > SEQ_MAX) {
    throw new DomainError(
      "invalid_input",
      `A sequence runs ${SEQ_MIN} to ${SEQ_MAX}; ${seq} is outside it.`,
    );
  }
  return String(seq).padStart(3, "0");
}

function isRealDay(day: string): boolean {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && dayKey(parsed) === day;
}

function dayOf(value: Date | string): string {
  if (typeof value === "string") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isRealDay(value)) {
      throw new DomainError("invalid_input", `"${value}" is not a calendar day.`);
    }
    return value;
  }
  return dayKey(value);
}

export function formatCallNumber(parts: {
  section: string;
  shelf: string;
  occurredOn: Date | string;
  seq: number;
}): string {
  if (!/^[A-Z]{3}$/.test(parts.section) || !/^[A-Z]{3}$/.test(parts.shelf)) {
    throw new DomainError("invalid_input", "Section and shelf codes are three uppercase letters.");
  }
  return `${parts.section}/${parts.shelf}/${dayOf(parts.occurredOn)}/${formatSeq(parts.seq)}`;
}

/** The parts of a full call number, or null when it is not one. */
export function parseCallNumber(value: string): CallNumberParts | null {
  const match = CALL_NUMBER_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, section, shelf, day, seqText] = match as unknown as [string, string, string, string, string];
  const seq = Number(seqText);
  if (seq < SEQ_MIN || seq > SEQ_MAX || !isRealDay(day)) return null;
  return { section, shelf, day, occurredOn: new Date(`${day}T00:00:00.000Z`), seq };
}

export function isCallNumber(value: string): boolean {
  return parseCallNumber(value) !== null;
}

/** The parts, or a DomainError naming what is wrong. */
export function validateCallNumber(value: string): CallNumberParts {
  const parts = parseCallNumber(value);
  if (!parts) {
    throw new DomainError(
      "invalid_input",
      `"${value}" is not a call number. Expected SECTION/SHELF/YYYY-MM-DD/NNN, such as LIF/GTH/2026-12-24/001.`,
    );
  }
  return parts;
}

/**
 * Plain code unit order, which is the library's order. Never localeCompare:
 * the whole point is that text order is section, shelf, time, sequence.
 */
export function compareCallNumbers(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Queries ---------------------------------------------------------------------

/**
 * A prefix or wildcard query over call numbers: `WRK/NST`, `LIF/GTH/2026-12`,
 * `*\/*\/2026-12-24`, `LIF/*\/2026`. One to four segments; `*` matches any
 * value of its segment. A date segment may be a year, a month or a day.
 */
export interface CallQuery {
  section: string | null;
  shelf: string | null;
  /** "2026", "2026-12" or "2026-12-24". */
  date: string | null;
  seq: number | null;
  /** True when no segment is `*`: the query is one text prefix. */
  isPrefix: boolean;
  /** The text prefix, for a query with no wildcard. */
  prefix: string | null;
}

const DATE_PREFIX = /^\d{4}(-\d{2}(-\d{2})?)?$/;

export function parseCallQuery(value: string): CallQuery {
  const trimmed = value.trim().replace(/\/+$/, "");
  const segments = trimmed.split("/");
  const invalid = () =>
    new DomainError(
      "invalid_input",
      `"${value}" is not a call number query. Use SECTION, SECTION/SHELF, SECTION/SHELF/DATE or a full number, with * for any segment.`,
    );
  if (trimmed.length === 0 || segments.length > 4) throw invalid();

  const [sectionSeg, shelfSeg, dateSeg, seqSeg] = segments;
  const code = (segment: string | undefined) => {
    if (segment === undefined || segment === "*") return null;
    if (!/^[A-Z]{3}$/.test(segment)) throw invalid();
    return segment;
  };

  const section = code(sectionSeg);
  const shelf = code(shelfSeg);

  let date: string | null = null;
  if (dateSeg !== undefined && dateSeg !== "*") {
    if (!DATE_PREFIX.test(dateSeg)) throw invalid();
    if (dateSeg.length === 7) {
      const month = Number(dateSeg.slice(5, 7));
      if (month < 1 || month > 12) throw invalid();
    }
    if (dateSeg.length === 10 && !isRealDay(dateSeg)) throw invalid();
    date = dateSeg;
  }

  let seq: number | null = null;
  if (seqSeg !== undefined && seqSeg !== "*") {
    if (!/^\d{3}$/.test(seqSeg)) throw invalid();
    seq = Number(seqSeg);
    if (seq < SEQ_MIN || seq > SEQ_MAX) throw invalid();
  }

  const isPrefix = !segments.includes("*");
  let prefix: string | null = null;
  if (isPrefix) {
    prefix = segments.join("/");
    const last = segments[segments.length - 1] as string;
    if (segments.length < 4) {
      // A complete segment ends at a slash, so WRK/NS is not a prefix of
      // WRK/NST and 2026-12 does not reach 2026-120.
      prefix += segments.length === 3 && last.length < 10 ? "-" : "/";
    }
  }

  return { section, shelf, date, seq, isPrefix, prefix };
}

function dateRange(date: string): { gte: Date; lt: Date } {
  const year = Number(date.slice(0, 4));
  if (date.length === 4) {
    return { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) };
  }
  const month = Number(date.slice(5, 7)) - 1;
  if (date.length === 7) {
    return {
      gte: new Date(Date.UTC(year, month, 1)),
      lt: new Date(Date.UTC(year, month + 1, 1)),
    };
  }
  const day = Number(date.slice(8, 10));
  return {
    gte: new Date(Date.UTC(year, month, day)),
    lt: new Date(Date.UTC(year, month, day + 1)),
  };
}

/**
 * The Prisma filter for a query. A prefix is a range on the stored string, so
 * it rides the unique index on callNumber; a wildcard query filters by shelf,
 * section, date and sequence instead.
 */
export function callQueryWhere(query: string | CallQuery): Prisma.MemoryWhereInput {
  const parsed = typeof query === "string" ? parseCallQuery(query) : query;
  if (parsed.isPrefix && parsed.prefix !== null) {
    if (parsed.seq !== null) return { callNumber: parsed.prefix };
    return { callNumber: { gte: parsed.prefix, lt: `${parsed.prefix}￿` } };
  }

  const where: Prisma.MemoryWhereInput = {};
  if (parsed.section !== null || parsed.shelf !== null) {
    where.shelf = {
      ...(parsed.shelf !== null ? { code: parsed.shelf } : {}),
      ...(parsed.section !== null ? { section: { code: parsed.section } } : {}),
    };
  }
  if (parsed.date !== null) where.occurredOn = dateRange(parsed.date);
  if (parsed.seq !== null) where.seq = parsed.seq;
  return where;
}

/** Whether one call number falls inside a query. The same rule as callQueryWhere, in memory. */
export function matchesCallQuery(query: string | CallQuery, callNumber: string): boolean {
  const parsed = typeof query === "string" ? parseCallQuery(query) : query;
  const parts = parseCallNumber(callNumber);
  if (!parts) return false;
  if (parsed.section !== null && parsed.section !== parts.section) return false;
  if (parsed.shelf !== null && parsed.shelf !== parts.shelf) return false;
  if (parsed.date !== null && !parts.day.startsWith(parsed.date)) return false;
  if (parsed.seq !== null && parsed.seq !== parts.seq) return false;
  return true;
}

// Issuing ---------------------------------------------------------------------

export interface ShelfCodes {
  shelfId: string;
  section: string;
  shelf: string;
}

export async function shelfCodes(db: Db, shelfId: string): Promise<ShelfCodes> {
  const shelf = await db.shelf.findUnique({
    where: { id: shelfId },
    include: { section: true },
  });
  if (!shelf) throw new DomainError("not_found", `No shelf with id ${shelfId}.`);
  return { shelfId, section: shelf.section.code, shelf: shelf.code };
}

export interface IssuedCallNumber {
  callNumber: string;
  seq: number;
  section: string;
  shelf: string;
}

/**
 * The next free number for a shelf and day. Inside the caller's transaction,
 * never at proposal, so two commits cannot race for one sequence and a
 * discarded proposal burns nothing.
 *
 * The next sequence is one past the highest ever used on that shelf and day,
 * counting both live numbers and aliases, so a number that moved away or was
 * forgotten is never handed out again. The result is then checked against
 * both tables. Past 999 the write is refused: the width is never widened.
 */
export async function issueCallNumber(
  tx: Tx,
  input: { shelfId: string; occurredOn: Date },
): Promise<IssuedCallNumber> {
  const codes = await shelfCodes(tx, input.shelfId);
  const day = dayKey(input.occurredOn);
  const prefix = `${codes.section}/${codes.shelf}/${day}/`;

  const live = await tx.memory.aggregate({
    where: { shelfId: input.shelfId, occurredOn: new Date(`${day}T00:00:00.000Z`) },
    _max: { seq: true },
  });
  const aliases = await tx.callNumberAlias.findMany({
    where: { oldCallNumber: { gte: prefix, lt: `${prefix}￿` } },
    select: { oldCallNumber: true },
  });
  // Live numbers under the prefix too, so a renumbering in progress (a shelf
  // moving to another section) cannot collide with one already rewritten.
  const liveByText = await tx.memory.findMany({
    where: { callNumber: { gte: prefix, lt: `${prefix}￿` } },
    select: { callNumber: true },
  });

  let highest = live._max.seq ?? 0;
  for (const row of [...aliases.map((a) => a.oldCallNumber), ...liveByText.map((m) => m.callNumber)]) {
    const parts = parseCallNumber(row);
    if (parts && parts.seq > highest) highest = parts.seq;
  }

  let seq = highest + 1;
  for (;;) {
    if (seq > SEQ_MAX) {
      throw new DomainError(
        "refused",
        `Shelf ${codes.section}/${codes.shelf} is full for ${day}: ${SEQ_MAX} entries is the most one shelf holds on one day. Put the rest on a new shelf; the sequence is never widened.`,
        { shelf: `${codes.section}/${codes.shelf}`, occurredOn: day, max: SEQ_MAX },
      );
    }
    const callNumber = `${prefix}${formatSeq(seq)}`;
    if (!(await isCallNumberTaken(tx, callNumber))) {
      return { callNumber, seq, section: codes.section, shelf: codes.shelf };
    }
    seq += 1;
  }
}

/** True when a number names a memory now or ever did. */
export async function isCallNumberTaken(db: Db, callNumber: string): Promise<boolean> {
  const [memory, alias] = await Promise.all([
    db.memory.findUnique({ where: { callNumber }, select: { id: true } }),
    db.callNumberAlias.findUnique({ where: { oldCallNumber: callNumber }, select: { oldCallNumber: true } }),
  ]);
  return memory !== null || alias !== null;
}

// Aliases ---------------------------------------------------------------------

/**
 * Record that `oldCallNumber` once named `memoryId`. Null for a forgotten
 * memory: the number then points at nothing and is still never reissued. An
 * existing alias is repointed, so the most recent holder of a number wins.
 */
export async function writeAlias(
  db: Db,
  oldCallNumber: string,
  memoryId: string | null,
): Promise<void> {
  validateCallNumber(oldCallNumber);
  await db.callNumberAlias.upsert({
    where: { oldCallNumber },
    create: { oldCallNumber, memoryId },
    update: { memoryId },
  });
}

/** Every old number that points at one memory, in library order. */
export async function aliasesOf(db: Db, memoryId: string): Promise<string[]> {
  const rows = await db.callNumberAlias.findMany({
    where: { memoryId },
    select: { oldCallNumber: true },
    orderBy: { oldCallNumber: "asc" },
  });
  return rows.map((row) => row.oldCallNumber);
}

export type CallNumberResolution =
  | { status: "current"; memoryId: string; callNumber: string }
  | { status: "alias"; memoryId: string; callNumber: string; asked: string }
  | { status: "forgotten"; asked: string }
  | { status: "unknown"; asked: string };

/**
 * A number to the memory it names: its current number first, then an alias.
 * An alias whose memory was forgotten resolves to `forgotten`, not to nothing,
 * so a caller can say so. A number that is both live and an alias (a reorder
 * swaps numbers) resolves to its live holder.
 */
export async function resolveCallNumber(db: Db, call: string): Promise<CallNumberResolution> {
  validateCallNumber(call);
  const asked = call.trim();
  const current = await db.memory.findUnique({
    where: { callNumber: asked },
    select: { id: true },
  });
  if (current) return { status: "current", memoryId: current.id, callNumber: asked };

  const alias = await db.callNumberAlias.findUnique({
    where: { oldCallNumber: asked },
    include: { memory: { select: { id: true, callNumber: true } } },
  });
  if (!alias) return { status: "unknown", asked };
  if (!alias.memory) return { status: "forgotten", asked };
  return { status: "alias", memoryId: alias.memory.id, callNumber: alias.memory.callNumber, asked };
}
