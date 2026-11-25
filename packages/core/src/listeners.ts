import { linkOccasion, markOccasionUnavailable, memoriesForOccasion, participantsFrom, OCCASION_URI_PATTERN, PERSON_URI_PREFIX } from "./domain/occasions.js";
import type { HostPorts, ListenedEventName } from "./ports.js";
import { countSession, markReadyForExtraction, setTranscriptPointer } from "./tools/shared/host-values.js";

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
 * its own ports, and the answer says what happened. Payload shapes are
 * starting readings: the people module does not emit two of these yet
 * (section 8).
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
      const marked = await markReadyForExtraction(ports, sessionId);
      const sessionsSince = marked ? await countSession(ports) : null;
      const transcriptPath = text(payload, "transcriptPath");
      const transcript = transcriptPath ? await setTranscriptPointer(ports, sessionId, transcriptPath) : false;
      return {
        event,
        handled: true,
        detail: { sessionId, readyForExtraction: true, counted: marked, sessionsSince, transcript },
      };
    }

    case "people.person.created": {
      // Section 18: proposes resolving unresolved attendee names that now
      // match. What the domain supports today is finding them: every
      // unresolved attendee or mention whose label is the new person's name.
      // Proposing the resolution needs a write tool that sets a reference's
      // URI on a memory, and none of the 41 does (memory.link_occasion
      // resolves names only against an occasion's participants, and
      // memory.update takes no people), so the proposal belongs with the
      // Fellowship link (M5). The matches are reported, nothing is written,
      // and a name is never turned into a person here.
      const uri = text(payload, "uri") ?? (text(payload, "personId", "id") ? `${PERSON_URI_PREFIX}${text(payload, "personId", "id")}` : null);
      let label = text(payload, "name", "label");
      if (!label && uri) {
        const resolution = await ports.refs.resolve(uri);
        if (resolution.status === "resolved") label = resolution.label;
      }
      if (!label) return { event, handled: false, reason: "invalid_payload", detail: { expected: "name or a resolvable uri" } };
      const refs = await db.memoryRef.findMany({
        where: { uri: null, role: { in: ["attendee", "mentions"] } },
        select: { memoryId: true, label: true, memory: { select: { callNumber: true } } },
      });
      const calls = [...new Set(refs.filter((ref) => sameName(ref.label, label)).map((ref) => ref.memory.callNumber))].sort();
      return { event, handled: true, detail: { person: uri, matches: calls, proposed: 0 } };
    }

    case "people.interaction.logged":
      // Section 18: lists the occasion under "occasions with no story yet".
      // That list is a front desk screen (section 20), which is the
      // standalone UI (M6) reading the Fellowship link (M5); nothing in the
      // silo holds it, and no story is ever invented for it. Nothing to do
      // in core until then.
      return { event, handled: false, reason: "deferred", detail: { milestone: "M5/M6", list: "occasions with no story yet" } };

    case "people.interaction.changed": {
      // Section 18: updates the attendee references on memories linked to
      // that occasion, or marks the occasion unavailable when it is removed.
      const uri = text(payload, "uri") ?? (text(payload, "interactionId", "id") ? `module://people/event/${text(payload, "interactionId", "id")}` : null);
      if (!uri || !OCCASION_URI_PATTERN.test(uri)) {
        return { event, handled: false, reason: "invalid_payload", detail: { expected: "a module://people/event/<id> uri" } };
      }
      if (payload["removed"] === true) {
        const memoryIds = await markOccasionUnavailable(db, uri, mutation);
        return { event, handled: true, detail: { occasion: uri, removed: true, memoryIds } };
      }

      // The participants ride in the payload, or the refs port answers them.
      let participants = participantsFrom(payload);
      let label = text(payload, "label", "title");
      if (participants === null || label === null) {
        const resolution = await ports.refs.resolve(uri);
        if (resolution.status === "resolved") {
          participants ??= participantsFrom(resolution.detail);
          label ??= resolution.label;
        }
      }
      const memoryIds = await memoriesForOccasion(db, uri);
      const changed: string[] = [];
      for (const memoryId of memoryIds) {
        const current = label ?? (await db.memoryRef.findFirst({ where: { memoryId, role: "occasion", uri }, select: { label: true } }))?.label ?? uri;
        const result = await linkOccasion(db, memoryId, { uri, label: current, attendees: participants }, mutation);
        if (result.changed) changed.push(memoryId);
      }
      return {
        event,
        handled: true,
        detail: { occasion: uri, memoryIds, changed, attendeesSynced: participants !== null },
      };
    }
  }
}
