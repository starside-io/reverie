// The cross-reference desk. docs/SPEC.md section 6.
//
// Given one memory, the others that share its tags, its people, or its
// occasion, ranked by how much they share, each with the reason it matched:
// "2 tags, 1 person".

import type { MemoryState } from "../../schemas/enums.js";
import type { Db } from "../db.js";
import { DomainError } from "../errors.js";
import { memoryIdOf } from "../versions.js";

export interface RelatedMemory {
  memoryId: string;
  callNumber: string;
  title: string;
  state: string;
  sharedTags: string[];
  /** The people both carry, by label. */
  sharedPeople: string[];
  sharedOccasion: boolean;
  /** Tags plus people plus the occasion. What the ranking sorts on. */
  score: number;
  /** "2 tags, 1 person", "1 occasion". */
  reason: string;
}

export interface RelatedOptions {
  /** At most this many. Starting value: 20. */
  limit?: number;
  /** Which states to include. Default active and superseded: retired is in the stacks. */
  states?: MemoryState[];
}

const PERSON_ROLES = ["attendee", "mentions"];

/**
 * A person or occasion as matched across memories: the module URI when the
 * reference is resolved, the name as told (trimmed, lowercased) when it is
 * not. An unresolved name only ever matches the same unresolved name, never a
 * resolved person: nothing is guessed. Starting value.
 */
function refKey(ref: { uri: string | null; label: string }): string {
  return ref.uri !== null ? `uri:${ref.uri}` : `name:${ref.label.trim().toLowerCase()}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function relatedReason(tags: number, people: number, occasion: boolean): string {
  const parts: string[] = [];
  if (tags > 0) parts.push(plural(tags, "tag", "tags"));
  if (people > 0) parts.push(plural(people, "person", "people"));
  if (occasion) parts.push("1 occasion");
  return parts.join(", ");
}

/**
 * Others that share tags, people refs or the occasion ref with one memory.
 * Ranked by the count of shared things, then a shared occasion, then shared
 * people, then call number. Each item counts once: a person who is an
 * attendee on one and mentioned on the other is one shared person.
 */
export async function relatedMemories(
  db: Db,
  memory: string | { id: string },
  options: RelatedOptions = {},
): Promise<RelatedMemory[]> {
  const memoryId = await memoryIdOf(db, memory);
  const limit = options.limit ?? 20;
  const states = options.states ?? ["active", "superseded"];

  const self = await db.memory.findUnique({
    where: { id: memoryId },
    include: { tags: { include: { tag: true } }, refs: true },
  });
  if (!self) throw new DomainError("not_found", `No memory with id ${memoryId}.`);

  const tagIds = self.tags.map((row) => row.tagId);
  const people = new Map<string, string>();
  const occasions = new Set<string>();
  for (const ref of self.refs) {
    if (ref.role === "occasion") occasions.add(refKey(ref));
    else if (PERSON_ROLES.includes(ref.role)) people.set(refKey(ref), ref.label);
  }

  const tagRows =
    tagIds.length === 0
      ? []
      : await db.memoryTag.findMany({
          where: { tagId: { in: tagIds }, memoryId: { not: memoryId } },
          include: { tag: { select: { slug: true } } },
        });

  const uris = self.refs.flatMap((ref) => (ref.uri !== null ? [ref.uri] : []));
  const hasUnresolved = self.refs.some((ref) => ref.uri === null);
  const refRows =
    self.refs.length === 0
      ? []
      : await db.memoryRef.findMany({
          where: {
            memoryId: { not: memoryId },
            OR: [
              ...(uris.length > 0 ? [{ uri: { in: uris } }] : []),
              ...(hasUnresolved ? [{ uri: null }] : []),
            ],
          },
        });

  interface Tally {
    tags: Set<string>;
    people: Map<string, string>;
    occasion: boolean;
  }
  const tallies = new Map<string, Tally>();
  const tally = (id: string): Tally => {
    let entry = tallies.get(id);
    if (!entry) {
      entry = { tags: new Set(), people: new Map(), occasion: false };
      tallies.set(id, entry);
    }
    return entry;
  };

  for (const row of tagRows) tally(row.memoryId).tags.add(row.tag.slug);
  for (const ref of refRows) {
    const key = refKey(ref);
    if (ref.role === "occasion") {
      if (occasions.has(key)) tally(ref.memoryId).occasion = true;
    } else if (PERSON_ROLES.includes(ref.role) && people.has(key)) {
      tally(ref.memoryId).people.set(key, people.get(key) as string);
    }
  }

  if (tallies.size === 0) return [];
  const rows = await db.memory.findMany({
    where: { id: { in: [...tallies.keys()] }, state: { in: states } },
    select: { id: true, callNumber: true, title: true, state: true },
  });

  const results = rows.map((row): RelatedMemory => {
    const entry = tallies.get(row.id) as Tally;
    const sharedTags = [...entry.tags].sort();
    const sharedPeople = [...entry.people.values()].sort();
    return {
      memoryId: row.id,
      callNumber: row.callNumber,
      title: row.title,
      state: row.state,
      sharedTags,
      sharedPeople,
      sharedOccasion: entry.occasion,
      score: sharedTags.length + sharedPeople.length + (entry.occasion ? 1 : 0),
      reason: relatedReason(sharedTags.length, sharedPeople.length, entry.occasion),
    };
  });

  results.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.sharedOccasion) - Number(a.sharedOccasion) ||
      b.sharedPeople.length - a.sharedPeople.length ||
      (a.callNumber < b.callNumber ? -1 : a.callNumber > b.callNumber ? 1 : 0),
  );
  return results.filter((result) => result.score > 0).slice(0, limit);
}
