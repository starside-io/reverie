// An episode tied to an occasion in the people module. docs/SPEC.md section
// 8: the memory holds a reference to the occasion and its attendees as
// references to people; who was there is the people module's to say, and a
// change there updates the references. Guardrail 7: a name that does not
// resolve stays an unresolved label, never turned into a person.
//
// The occasion reference and the attendee references are part of the memory's
// content, so a change writes an `update` version.

import { atomic, type Db } from "./db.js";
import { DomainError } from "./errors.js";
import { appendVersion, type MutationOptions } from "./versions.js";

/** `module://people/event/<id>`. */
export const OCCASION_URI_PATTERN = /^module:\/\/people\/event\/[^\s/]+$/;
export const PERSON_URI_PREFIX = "module://people/person/";

/** A label as stored: MemoryRef.label holds at most 200 characters. */
const LABEL_MAX = 200;

function clip(label: string): string {
  const trimmed = label.trim();
  return trimmed.length <= LABEL_MAX ? trimmed : trimmed.slice(0, LABEL_MAX).trimEnd();
}

export interface OccasionAttendee {
  uri: string;
  label: string;
}

export interface OccasionLink {
  uri: string;
  label: string;
  /**
   * The occasion's participants as the people module answered them, or null
   * when it did not answer: the attendees are then left as they are.
   */
  attendees: OccasionAttendee[] | null;
}

export interface LinkOccasionResult {
  changed: boolean;
  /** The occasion this memory pointed at before, when it was another one. */
  replaced: string | null;
  /** Attendee URIs added and removed by the sync. Empty when nothing was synced. */
  added: string[];
  removed: string[];
  /** Unresolved names that now carry the URI of the participant they name. */
  resolvedNames: string[];
  /** Unresolved names no participant matched, kept as told. */
  keptNames: string[];
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Point one memory at an occasion, and, when the people module answered, sync
 * its attendees to the occasion's participants:
 *
 * - every attendee with a URI becomes exactly the participant list, labels
 *   refreshed;
 * - an unresolved name that matches a participant's label takes its URI;
 * - an unresolved name no participant matches is kept as told: the owner
 *   said it, and nothing is dropped for the people module's silence.
 *
 * Starting reading for the last two.
 */
export async function linkOccasion(
  db: Db,
  memoryId: string,
  occasion: OccasionLink,
  options: MutationOptions,
): Promise<LinkOccasionResult> {
  if (!OCCASION_URI_PATTERN.test(occasion.uri)) {
    throw new DomainError("invalid_input", "An occasion is a module://people/event/<id> URI.");
  }
  const label = clip(occasion.label) || occasion.uri;

  return atomic(db, async (tx) => {
    const row = await tx.memory.findUnique({ where: { id: memoryId }, include: { refs: true } });
    if (!row) throw new DomainError("not_found", `No memory with id ${memoryId}.`);

    let changed = false;
    const result: LinkOccasionResult = {
      changed: false,
      replaced: null,
      added: [],
      removed: [],
      resolvedNames: [],
      keptNames: [],
    };

    // The occasion: one per memory.
    const occasions = row.refs.filter((ref) => ref.role === "occasion");
    const current = occasions.find((ref) => ref.uri === occasion.uri);
    const others = occasions.filter((ref) => ref !== current);
    if (others.length > 0) {
      result.replaced = others.find((ref) => ref.uri)?.uri ?? others[0]?.label ?? null;
      await tx.memoryRef.deleteMany({ where: { id: { in: others.map((ref) => ref.id) } } });
      changed = true;
    }
    if (!current) {
      await tx.memoryRef.create({ data: { memoryId, role: "occasion", uri: occasion.uri, label, resolved: true } });
      changed = true;
    } else if (current.label !== label) {
      await tx.memoryRef.update({ where: { id: current.id }, data: { label } });
      changed = true;
    }

    // The attendees, only when the people module answered.
    if (occasion.attendees !== null) {
      const participants = new Map<string, string>();
      for (const person of occasion.attendees) {
        if (!participants.has(person.uri)) participants.set(person.uri, clip(person.label) || person.uri);
      }
      const attendees = row.refs.filter((ref) => ref.role === "attendee");
      const linked = attendees.filter((ref) => ref.uri !== null);
      const names = attendees.filter((ref) => ref.uri === null);
      const present = new Set<string>();

      for (const ref of linked) {
        const wanted = participants.get(ref.uri as string);
        if (wanted === undefined || present.has(ref.uri as string)) {
          await tx.memoryRef.delete({ where: { id: ref.id } });
          result.removed.push(ref.uri as string);
          changed = true;
          continue;
        }
        present.add(ref.uri as string);
        if (ref.label !== wanted || !ref.resolved) {
          await tx.memoryRef.update({ where: { id: ref.id }, data: { label: wanted, resolved: true } });
          changed = true;
        }
      }

      for (const ref of names) {
        const match = [...participants.entries()].find(([uri, name]) => !present.has(uri) && sameName(name, ref.label));
        if (!match) {
          result.keptNames.push(ref.label);
          continue;
        }
        const [uri, name] = match;
        await tx.memoryRef.update({ where: { id: ref.id }, data: { uri, label: name, resolved: true } });
        present.add(uri);
        result.resolvedNames.push(ref.label);
        result.added.push(uri);
        changed = true;
      }

      for (const [uri, name] of participants) {
        if (present.has(uri)) continue;
        await tx.memoryRef.create({ data: { memoryId, role: "attendee", uri, label: name, resolved: true } });
        present.add(uri);
        result.added.push(uri);
        changed = true;
      }
    }

    if (changed) await appendVersion(tx, memoryId, { ...options, operation: "update" });
    result.changed = changed;
    return result;
  });
}

/**
 * The participants in a refs port answer's detail, read leniently: an array
 * under `participants` or `attendees`, each a person URI, or an object with a `uri`, `ref` or `id` and a `label` or `name`. Anything else is
 * skipped. Null when the detail names no participant list at all. The people
 * module does not answer refs yet, so the shape is a starting value.
 */
export function participantsFrom(detail: Record<string, unknown> | undefined): OccasionAttendee[] | null {
  if (!detail) return null;
  const list = Array.isArray(detail.participants)
    ? detail.participants
    : Array.isArray(detail.attendees)
      ? detail.attendees
      : null;
  if (list === null) return null;

  // A bare id is read only from an `id` field: a bare string could as well
  // be a name, and a name is never turned into a person.
  const toUri = (value: unknown, bareId: boolean): string | null => {
    if (typeof value !== "string" || value.trim().length === 0) return null;
    const text = value.trim();
    if (text.startsWith(PERSON_URI_PREFIX)) return /^module:\/\/people\/person\/[^\s/]+$/.test(text) ? text : null;
    return bareId && /^[A-Za-z0-9_.:-]{1,128}$/.test(text) ? `${PERSON_URI_PREFIX}${text}` : null;
  };

  const out: OccasionAttendee[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      const uri = toUri(entry, false);
      if (uri) out.push({ uri, label: uri });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const uri = toUri(record.uri, false) ?? toUri(record.ref, false) ?? toUri(record.id, true);
    if (!uri) continue;
    const label = typeof record.label === "string" ? record.label : typeof record.name === "string" ? record.name : uri;
    out.push({ uri, label });
  }
  return out;
}

/**
 * The occasion behind `uri` was removed in the people module (section 18,
 * `people.interaction.changed`): every memory linked to it keeps the
 * reference, now marked unresolved, so it renders as unavailable rather than
 * vanishing. Attendees are left as they are: the people were there whether or
 * not the occasion is still on record. One `update` version per memory that
 * changed. Returns the ids of those memories.
 */
export async function markOccasionUnavailable(db: Db, uri: string, options: MutationOptions): Promise<string[]> {
  if (!OCCASION_URI_PATTERN.test(uri)) {
    throw new DomainError("invalid_input", "An occasion is a module://people/event/<id> URI.");
  }
  return atomic(db, async (tx) => {
    const refs = await tx.memoryRef.findMany({
      where: { role: "occasion", uri, resolved: true },
      select: { id: true, memoryId: true },
    });
    const memoryIds = [...new Set(refs.map((ref) => ref.memoryId))].sort();
    if (refs.length === 0) return [];
    await tx.memoryRef.updateMany({ where: { id: { in: refs.map((ref) => ref.id) } }, data: { resolved: false } });
    for (const memoryId of memoryIds) await appendVersion(tx, memoryId, { ...options, operation: "update" });
    return memoryIds;
  });
}

/** Memories linked to the occasion behind `uri`, by id, in call number order. */
export async function memoriesForOccasion(db: Db, uri: string): Promise<string[]> {
  const rows = await db.memory.findMany({
    where: { refs: { some: { role: "occasion", uri } } },
    select: { id: true },
    orderBy: { callNumber: "asc" },
  });
  return rows.map((row) => row.id);
}
