import { linkOccasion, markOccasionUnavailable, memoriesForOccasion, participantsFrom } from "./domain/occasions.js";
import { readInteractionChanged, readInteractionLogged, readPersonCreated } from "./domain/people-link.js";
import type { HostPorts, ListenedEventName } from "./ports.js";
import { dropLoggedOccasion, recordOccasionLogged } from "./tools/shared/front-desk.js";
import { endSession } from "./tools/shared/host-values.js";

/**
 * The events this module listens to, docs/SPEC.md section 18 "Listened to",
 * as module.json lists them. The host's bus delivers each one through
 * ModuleApi.deliver (activate.ts) after the emitting module's transaction has
 * committed.
 *
 * Fellowship declares a listened event in its manifest but wires no handler
 * for it in core or the mini-host, so there is no Fellowship mechanism to
 * lift here. This is the smallest one that fits the same boundary: the host
 * calls deliver with the event's name and payload, core does what it can with
 * its own ports, and the answer says what happened. The people payloads are
 * read in domain/people-link.ts, the one place that knows their shape.
 *
 * Under two standalone hosts no bus carries the people events across. The
 * assistant tells Reverie instead, through memory.link_occasion's `report`
 * form, which calls deliverEvent here: one handler, either way.
 *
 * While incognito is on nothing is written, as no write tool runs then
 * (section 7: no session is marked for extraction).
 */

export const LISTENED_EVENTS: readonly ListenedEventName[] = [
  "people.person.created",
  "people.interaction.logged",
  "people.interaction.changed",
  "host.session.ended",
];

/** Who a version written on an event's behalf is attributed to. Starting value. */
export const EVENT_ACTOR_PREFIX = "event:";

export type DeliveryResult =
  | {
      event: ListenedEventName;
      handled: true;
      /** What changed or was found, as ids, call numbers and counts. Never memory text. */
      detail: Record<string, unknown>;
    }
  | {
      event: ListenedEventName;
      handled: false;
      /** Why nothing was done: incognito, a payload core cannot read, a missing port, or a later milestone. */
      reason: "incognito" | "invalid_payload" | "no_settings_values" | "deferred" | "unknown_event";
      detail?: Record<string, unknown>;
    };

function text(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export async function deliverEvent(
  ports: HostPorts,
  name: string,
  payload: Record<string, unknown>,
  options: { now?: Date } = {},
): Promise<DeliveryResult> {
  if (!(LISTENED_EVENTS as readonly string[]).includes(name)) {
    return { event: name as ListenedEventName, handled: false, reason: "unknown_event" };
  }
  const event = name as ListenedEventName;
  const config = await ports.settings.get();
  if (config.incognito) return { event, handled: false, reason: "incognito" };
  const now = options.now ?? new Date();
  const db = ports.storage.silo();
  const mutation = { actor: `${EVENT_ACTOR_PREFIX}${event}`, at: now };

  switch (event) {
    case "host.session.ended": {
      // Marks the session ready for extraction, and counts it toward
      // consolidateEvery.sessions. A session delivered twice counts once.
      // With a transcriptPath in the payload (section 19: "with a pointer to
      // its transcript"), the path is kept beside the marker. Only the path:
      // nothing here opens or copies the transcript.
      const sessionId = text(payload, "sessionId", "id");
      if (!sessionId) return { event, handled: false, reason: "invalid_payload", detail: { expected: "sessionId" } };
      if (!ports.settings.values) return { event, handled: false, reason: "no_settings_values" };
      // One step in host.db: sessions ending together in several processes
      // each land in the list and count once.
      const ended = await endSession(ports, sessionId, text(payload, "transcriptPath"));
      const { marked, sessionsSince, transcript } = ended;
      return {
        event,
        handled: true,
        detail: { sessionId, readyForExtraction: true, counted: marked, sessionsSince, transcript },
      };
    }

    case "people.person.created": {
      // Section 18: proposes resolving unresolved attendee names that now
      // match. One proposal per memory, through review, never applied here:
      // memory.update with `people`, which the owner confirms with decide.
      // A name is never turned into a person without that yes.
      const created = readPersonCreated(payload);
      let label = created.name;
      if (!label && created.uri) {
        const resolution = await ports.refs.resolve(created.uri);
        if (resolution.status === "resolved") label = resolution.label;
      }
      if (!label || !created.uri) {
        return { event, handled: false, reason: "invalid_payload", detail: { expected: "personId and displayName" } };
      }
      const name = label;
      const uri = created.uri;
      const refs = await db.memoryRef.findMany({
        where: { uri: null, role: { in: ["attendee", "mentions"] }, memory: { state: { in: ["active", "superseded"] } } },
        select: { memoryId: true, label: true, memory: { select: { callNumber: true } } },
      });
      const matching = refs.filter((ref) => sameName(ref.label, name));
      const byMemory = new Map<string, { call: string; names: Set<string> }>();
      for (const ref of matching) {
        const entry = byMemory.get(ref.memoryId) ?? { call: ref.memory.callNumber, names: new Set<string>() };
        entry.names.add(ref.label);
        byMemory.set(ref.memoryId, entry);
      }
      const group = { id: `person:${uri}`, title: `Names that now match ${name}`, detail: "Added in the people module" };
      // Delivered twice, the same proposal is not queued twice.
      const waiting = new Set(
        (await ports.review.list("pending"))
          .filter((row) => row.tool === "memory.update" && row.group?.id === group.id && row.memoryId)
          .map((row) => row.memoryId as string),
      );
      const proposalIds: string[] = [];
      for (const [memoryId, entry] of [...byMemory.entries()].sort((a, b) => (a[1].call < b[1].call ? -1 : 1))) {
        if (waiting.has(memoryId)) continue;
        const names = [...entry.names].sort();
        const queued = await ports.review.propose({
          tool: "memory.update",
          memoryId,
          payload: { call: entry.call, people: names.map((told) => ({ uri, label: name, name: told })) },
          summary: `Resolve ${names.map((told) => `"${told}"`).join(", ")} on ${entry.call} to ${name}, just added in the people module`,
          group,
        });
        proposalIds.push(queued.id);
      }
      const calls = [...byMemory.values()].map((entry) => entry.call).sort();
      return { event, handled: true, detail: { person: uri, matches: calls, proposed: proposalIds.length, proposalIds } };
    }

    case "people.interaction.logged": {
      // Section 18: lists the occasion under "occasions with no story yet",
      // kept in host.db, never in the silo. No story is invented for it; a
      // telling of that day with those people attaches to it instead of
      // logging a second (front-desk.ts, findHeldOccasion).
      const logged = readInteractionLogged(payload);
      if (!logged) return { event, handled: false, reason: "invalid_payload", detail: { expected: "eventId" } };
      const told = await memoriesForOccasion(db, logged.occasion);
      if (told.length > 0) {
        return { event, handled: true, detail: { occasion: logged.occasion, listed: false, toldBy: told.length } };
      }
      const added = await recordOccasionLogged(ports, logged, now);
      if (added === null) return { event, handled: false, reason: "no_settings_values" };
      return { event, handled: true, detail: { occasion: logged.occasion, listed: true, added } };
    }

    case "people.interaction.changed": {
      // Section 18: updates the attendee references on memories linked to
      // that occasion, or marks the occasion unavailable when it is removed.
      // The memory's text is never touched: what happened is Reverie's.
      const changed = readInteractionChanged(payload);
      if (!changed) {
        return { event, handled: false, reason: "invalid_payload", detail: { expected: "eventId and change" } };
      }
      const uri = changed.occasion;
      if (changed.change === "removed") {
        await dropLoggedOccasion(ports, uri);
        const memoryIds = await markOccasionUnavailable(db, uri, mutation);
        return { event, handled: true, detail: { occasion: uri, removed: true, memoryIds } };
      }

      // The participants ride in the payload, or the refs port answers them.
      let participants = changed.participants;
      let label = changed.title;
      if (participants === null || label === null) {
        const resolution = await ports.refs.resolve(uri);
        if (resolution.status === "resolved") {
          participants ??= participantsFrom(resolution.detail);
          label ??= resolution.label;
        }
      }
      const memoryIds = await memoriesForOccasion(db, uri);
      const synced: string[] = [];
      for (const memoryId of memoryIds) {
        const current = await db.memoryRef.findFirst({ where: { memoryId, role: "occasion", uri }, select: { label: true } });
        const result = await linkOccasion(db, memoryId, { uri, label: label ?? current?.label ?? uri, attendees: participants }, mutation);
        if (result.changed) synced.push(memoryId);
      }
      return {
        event,
        handled: true,
        detail: { occasion: uri, change: changed.change, memoryIds, changed: synced, attendeesSynced: participants !== null },
      };
    }
  }
}
