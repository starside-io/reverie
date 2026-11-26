import { normaliseWhitespace } from "../../domain/drafting/gates.js";
import type { InteractionLogged } from "../../domain/people-link.js";
import type { HostPorts } from "../../ports.js";
import { dayKey } from "../../schemas/common.js";
import type { ToolContext } from "../registry.js";
import { followUpFor, pendingOccasionSchema, type FollowUp, type PendingOccasion } from "./confirm-proposals.js";
import { transact, valuesOf } from "./host-values.js";

/**
 * The Fellowship link's part of the front desk (docs/SPEC.md section 20:
 * "occasions with no story yet, unresolved names"; section 8: "occasion
 * pending"), and the lookup that keeps a telling from logging a second
 * occasion.
 *
 * Two lists are host state, kept in the settings values in host.db beside the
 * review queue they come from, never in the silo:
 *
 *   people.occasionsWithNoStory  what people.interaction.logged reported, by
 *                                occasion URI. An occasion drops off the
 *                                list as soon as a memory links to it.
 *   people.occasionsPending      memory id to the occasion its confirmed
 *                                proposal implied. A memory drops off once it
 *                                links an occasion, or is forgotten.
 *
 * The unresolved names are read from the silo. Without settings values the
 * two host lists read as empty, and the result says so.
 */

export const OCCASIONS_NO_STORY_KEY = "people.occasionsWithNoStory";
export const OCCASIONS_PENDING_KEY = "people.occasionsPending";

/** The most occasions kept on the no story list; the oldest drop first. Starting value. */
export const NO_STORY_MAX = 200;
/** The most memories kept as occasion pending; the oldest drop first. Starting value. */
export const PENDING_MAX = 500;

export interface LoggedOccasion {
  occasion: string;
  occurredOn: string | null;
  /** Person URIs, sorted. */
  people: string[];
  title: string | null;
  /** When this host heard of it. */
  loggedAt: string;
}

function loggedList(value: unknown): LoggedOccasion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is LoggedOccasion =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as LoggedOccasion).occasion === "string" &&
      Array.isArray((entry as LoggedOccasion).people),
  );
}

export interface PendingEntry {
  call: string;
  occasion: PendingOccasion;
  at: string;
}

function pendingMap(value: unknown): Record<string, PendingEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, PendingEntry> = {};
  for (const [memoryId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const occasion = pendingOccasionSchema.safeParse(entry["occasion"]);
    if (!occasion.success || typeof entry["call"] !== "string") continue;
    out[memoryId] = { call: entry["call"], occasion: occasion.data, at: typeof entry["at"] === "string" ? entry["at"] : "" };
  }
  return out;
}

/** Lists one occasion the people module logged. Null when the host keeps no values; false when it was already listed. */
export async function recordOccasionLogged(
  ports: HostPorts,
  logged: InteractionLogged,
  at: Date,
): Promise<boolean | null> {
  let added = false;
  const written = await transact(ports, [OCCASIONS_NO_STORY_KEY], (current) => {
    const list = loggedList(current[OCCASIONS_NO_STORY_KEY]);
    const existing = list.find((entry) => entry.occasion === logged.occasion);
    if (existing) {
      // Heard again: keep what is newer, never lose what was known.
      existing.occurredOn = logged.occurredOn ?? existing.occurredOn;
      existing.title = logged.title ?? existing.title;
      if (logged.people.length > 0) existing.people = [...logged.people];
      return { [OCCASIONS_NO_STORY_KEY]: list };
    }
    added = true;
    const entry: LoggedOccasion = {
      occasion: logged.occasion,
      occurredOn: logged.occurredOn,
      people: [...logged.people],
      title: logged.title,
      loggedAt: at.toISOString(),
    };
    return { [OCCASIONS_NO_STORY_KEY]: [...list, entry].slice(-NO_STORY_MAX) };
  });
  return written === null ? null : added;
}

/** Takes one occasion off the no story list, as when the people module removed it. */
export async function dropLoggedOccasion(ports: HostPorts, uri: string): Promise<void> {
  await transact(ports, [OCCASIONS_NO_STORY_KEY], (current) => {
    const list = loggedList(current[OCCASIONS_NO_STORY_KEY]);
    return list.some((entry) => entry.occasion === uri)
      ? { [OCCASIONS_NO_STORY_KEY]: list.filter((entry) => entry.occasion !== uri) }
      : {};
  });
}

export async function loggedOccasions(ports: HostPorts): Promise<LoggedOccasion[]> {
  const values = valuesOf(ports);
  return values ? loggedList(await values.get(OCCASIONS_NO_STORY_KEY)) : [];
}

/** Keeps the occasion a confirmed proposal implied, until its memory links one. False when the host keeps no values. */
export async function recordOccasionPending(
  ports: HostPorts,
  memoryId: string,
  entry: PendingEntry,
): Promise<boolean> {
  const written = await transact(ports, [OCCASIONS_PENDING_KEY], (current) => {
    const map = pendingMap(current[OCCASIONS_PENDING_KEY]);
    const kept = Object.entries({ ...map, [memoryId]: entry }).slice(-PENDING_MAX);
    return { [OCCASIONS_PENDING_KEY]: Object.fromEntries(kept) };
  });
  return written !== null;
}

export async function clearOccasionPending(ports: HostPorts, memoryId: string): Promise<void> {
  await transact(ports, [OCCASIONS_PENDING_KEY], (current) => {
    const map = pendingMap(current[OCCASIONS_PENDING_KEY]);
    if (!(memoryId in map)) return {};
    const { [memoryId]: _dropped, ...rest } = map;
    return { [OCCASIONS_PENDING_KEY]: rest };
  });
}

/* ------------------------------------------------- one event, not two */

/** An occasion the people module already holds, which a telling links to. */
export interface HeldOccasion {
  uri: string;
  label: string;
  /**
   * `named`: the caller gave its URI. `found`: an episode that day already
   * links it, with the same people. `logged`: the people module reported it
   * logged that day with the same people, and no story has it yet.
   */
  via: "named" | "found" | "logged";
  /** The episode that already links it, when found. */
  call?: string;
}

const norm = (name: string) => normaliseWhitespace(name).toLowerCase();

/**
 * The occasion this day's telling belongs to, when the people module already
 * holds exactly one for the same people: an episode that day already linked
 * to it with the same names, case folded; or an occasion the people module
 * logged that day whose participants are exactly these people, by URI. Null
 * when there is none, or more than one, which is the owner's to settle.
 */
export async function findHeldOccasion(
  ctx: ToolContext,
  occurredOn: string,
  attendees: ReadonlyArray<{ name: string; uri: string | null }>,
): Promise<HeldOccasion | null> {
  const day = new Date(`${occurredOn}T00:00:00.000Z`);
  const found = new Map<string, HeldOccasion>();

  const rows = await ctx.db.memory.findMany({
    where: { kind: "episode", state: "active", occurredOn: day, refs: { some: { role: "occasion", uri: { not: null } } } },
    include: { refs: true },
    orderBy: { callNumber: "asc" },
  });
  const wanted = new Set(attendees.map((person) => norm(person.name)));
  for (const row of rows) {
    const occasionRef = row.refs.find((ref) => ref.role === "occasion" && ref.uri !== null && ref.resolved);
    if (!occasionRef?.uri) continue;
    const names = new Set(row.refs.filter((ref) => ref.role === "attendee").map((ref) => norm(ref.label)));
    if (names.size !== wanted.size || [...wanted].some((name) => !names.has(name))) continue;
    if (!found.has(occasionRef.uri)) {
      found.set(occasionRef.uri, { uri: occasionRef.uri, label: occasionRef.label, via: "found", call: row.callNumber });
    }
  }

  const uris = attendees.map((person) => person.uri);
  if (found.size === 0 && uris.length > 0 && uris.every((uri): uri is string => uri !== null)) {
    const people = [...new Set(uris)].sort();
    for (const logged of await unlinkedLoggedOccasions(ctx)) {
      if (logged.occurredOn !== occurredOn) continue;
      if (logged.people.length !== people.length || logged.people.some((uri, index) => uri !== people[index])) continue;
      found.set(logged.occasion, { uri: logged.occasion, label: logged.title ?? logged.occasion, via: "logged" });
    }
  }
  return found.size === 1 ? ([...found.values()][0] as HeldOccasion) : null;
}

/** The logged occasions no memory links to yet, oldest first. */
async function unlinkedLoggedOccasions(ctx: ToolContext): Promise<LoggedOccasion[]> {
  const logged = await loggedOccasions(ctx.ports);
  if (logged.length === 0) return [];
  const linked = await ctx.db.memoryRef.findMany({
    where: { role: "occasion", uri: { in: logged.map((entry) => entry.occasion) } },
    select: { uri: true },
  });
  const told = new Set(linked.map((ref) => ref.uri));
  return logged.filter((entry) => !told.has(entry.occasion));
}

/* ------------------------------------------------------ the front desk */

export interface OccasionPendingItem {
  call: string;
  title: string;
  occurredOn: string;
  /** The occasion the confirmed proposal implied. */
  occasion: { title: string; type: string; occurredAt: string };
  /**
   * The call to run, rebuilt from the memory as it stands now. Look in the
   * people module for an occasion on that day with those people first, and
   * link to it with memory.link_occasion instead when there is one.
   */
  followUp: FollowUp;
}

export interface NoStoryItem {
  occasion: string;
  title: string | null;
  occurredOn: string | null;
  people: string[];
  loggedAt: string;
}

export interface UnresolvedName {
  name: string;
  /** Memories that carry it unresolved, in call number order. */
  calls: string[];
}

export interface FrontDeskLink {
  /** Confirmed episodes whose implied occasion was never logged and linked. */
  occasionPending: OccasionPendingItem[];
  /** Occasions the people module logged that no memory tells yet. Nothing is invented for them. */
  occasionsWithNoStory: NoStoryItem[];
  /** Names kept unresolved on attendees and mentions, case and spacing folded. */
  unresolvedNames: UnresolvedName[];
  /** Says when the host keeps no settings values, so the two host lists cannot be kept. */
  notice: string | null;
}

export async function readFrontDesk(ctx: ToolContext): Promise<FrontDeskLink> {
  const values = valuesOf(ctx.ports);
  const pending = values ? pendingMap(await values.get(OCCASIONS_PENDING_KEY)) : {};

  const occasionPending: OccasionPendingItem[] = [];
  const ids = Object.keys(pending);
  if (ids.length > 0) {
    const rows = await ctx.db.memory.findMany({
      where: { id: { in: ids }, state: { in: ["active", "superseded"] } },
      include: { refs: true },
      orderBy: { callNumber: "asc" },
    });
    for (const row of rows) {
      if (row.refs.some((ref) => ref.role === "occasion" && ref.uri !== null)) continue;
      const entry = pending[row.id] as PendingEntry;
      const people = row.refs
        .filter((ref) => ref.role === "attendee")
        .map((ref) => ({ uri: ref.uri, label: ref.label }));
      occasionPending.push({
        call: row.callNumber,
        title: row.title,
        occurredOn: dayKey(row.occurredOn),
        occasion: { title: entry.occasion.title, type: entry.occasion.type, occurredAt: entry.occasion.occurredAt },
        followUp: followUpFor(entry.occasion, people, { call: row.callNumber, title: row.title }),
      });
    }
  }

  const occasionsWithNoStory = (await unlinkedLoggedOccasions(ctx))
    .map((entry) => ({
      occasion: entry.occasion,
      title: entry.title,
      occurredOn: entry.occurredOn,
      people: entry.people,
      loggedAt: entry.loggedAt,
    }))
    .sort((a, b) => ((b.occurredOn ?? "") < (a.occurredOn ?? "") ? -1 : (b.occurredOn ?? "") > (a.occurredOn ?? "") ? 1 : 0));

  const refs = await ctx.db.memoryRef.findMany({
    where: { uri: null, role: { in: ["attendee", "mentions"] }, memory: { state: { in: ["active", "superseded"] } } },
    select: { label: true, memory: { select: { callNumber: true } } },
  });
  const names = new Map<string, { name: string; calls: Set<string> }>();
  for (const ref of refs) {
    const key = norm(ref.label);
    const entry = names.get(key) ?? { name: normaliseWhitespace(ref.label), calls: new Set<string>() };
    entry.calls.add(ref.memory.callNumber);
    names.set(key, entry);
  }
  const unresolvedNames = [...names.values()]
    .map((entry) => ({ name: entry.name, calls: [...entry.calls].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    occasionPending,
    occasionsWithNoStory,
    unresolvedNames,
    notice: values
      ? null
      : "This host keeps no settings values, so occasions pending and occasions with no story yet are not kept.",
  };
}
