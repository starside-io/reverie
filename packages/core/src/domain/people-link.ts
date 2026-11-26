// The people module's side of the Fellowship link, as this module codes to
// it. docs/SPEC.md section 8.
//
// Every assumption Reverie makes about Fellowship lives in this file: the
// URIs, the tool names and inputs the follow ups name, and the payloads of the
// three people events. Nothing here calls the people module, and nothing here
// can: the assistant runs these calls, or a host delivers these events. A
// change on Fellowship's side is a change here and nowhere else.
//
// What is read from Fellowship's code (packages/core/src/tools/write.ts and
// schemas/event.ts, schemas/note.ts):
//   people.log_interaction  { title, type, occurredAt, location?, description?,
//                             sentiment?, weight?, participants: [{ personId? | name?, role?, sentiment? }] }
//                           returns { written: true, event: { id, title, occurredAt }, personIds }
//                           or { written: false, unmatched: [{ name, candidates }] }
//   people.add_note         { personId | eventId, body: Tiptap doc, occurredAt?, pinned?, tagIds? }
//   people.resolve_person   { name } returns { status: "unique" | "ambiguous" | "none", match, candidates }
//   people.activity         { days?, limit?, personId? }, recent occasions
//   people.timeline         { personId }, one person's occasions, newest first
//   people.person.created       { personId, displayName }
//   people.interaction.logged   { eventId, personIds, occurredAt }
//
// The Fellowship additions for this link (section 8, "What Fellowship needs
// for this"), as the Fellowship side reports them (branch reverie-link):
//   people.log_interaction takes `refs: [{ uri, label }]` and returns them on
//     the event; at most 20 refs, uri up to 500 characters, label 1 to 200;
//   people.update_interaction { eventId, patch: { refs, title?, type?,
//     occurredAt?, location?, description?, sentiment?, weight?, participants? } },
//     where `refs` and `participants` replace the whole list;
//   an event's refs are readable in people.timeline (entries[].event.refs),
//     people.activity (events[].refs) and the event ref's resolution detail;
//   the event ref resolves with label "<title>, YYYY-MM-DD" and detail
//     participants [{ personId, name }];
//   people.interaction.changed  { eventId, change: "participants" | "updated" | "removed",
//                                 occurredAt, title, participants: [{ personId, name }] }
//     ("removed" is declared but nothing emits it yet: Fellowship deletes no occasion).

/** The field an occasion's outside references ride in. */
export const REFS_FIELD = "refs" as const;

/** The people module's tools the follow ups and the skill name. Dotted, as module.json names tools. */
export const PEOPLE_TOOLS = {
  logInteraction: "people.log_interaction",
  /** The update path for an event's facts, participants and outside references. */
  updateInteraction: "people.update_interaction",
  addNote: "people.add_note",
  resolvePerson: "people.resolve_person",
  activity: "people.activity",
  timeline: "people.timeline",
} as const;

/** The occasion type the people module never adds a bystander to. */
export const CONFLICT_TYPE = "CONFLICT";

export const PERSON_URI_PREFIX = "module://people/person/";
export const EVENT_URI_PREFIX = "module://people/event/";
/** What the mini-host refs port answers: an id or a call number, current or old. */
export const MEMORY_URI_PREFIX = "module://memory/memory/";

export const PERSON_URI_PATTERN = /^module:\/\/people\/person\/[^\s/]+$/;
export const EVENT_URI_PATTERN = /^module:\/\/people\/event\/[^\s/]+$/;

/** Fellowship's ids, as a URI's last part may hold them. */
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function personUri(personId: string): string {
  return `${PERSON_URI_PREFIX}${personId}`;
}

export function eventUri(eventId: string): string {
  return `${EVENT_URI_PREFIX}${eventId}`;
}

/** The URI the people module stores to point back at a memory: by call number, which survives a reshelve as an alias. */
export function memoryUri(call: string): string {
  return `${MEMORY_URI_PREFIX}${call}`;
}

/** The id at the end of a people URI, or null when it is not one of `kind`. */
export function idOf(uri: string, kind: "person" | "event"): string | null {
  const pattern = kind === "person" ? PERSON_URI_PATTERN : EVENT_URI_PATTERN;
  const prefix = kind === "person" ? PERSON_URI_PREFIX : EVENT_URI_PREFIX;
  return pattern.test(uri) ? uri.slice(prefix.length) : null;
}

/** One outside reference on a people event. */
export interface OutsideRef {
  uri: string;
  label: string;
}

/** One call for whoever confirmed to run on the people module's side. */
export interface PeopleCall<Input = Record<string, unknown>> {
  tool: string;
  input: Input;
}

/** A participant as people.log_interaction takes it. Never a sentiment: how it went is the owner's to say there. */
export type LogParticipant = { personId: string } | { name: string };

export interface LogInteractionInput {
  title: string;
  type: string;
  /** YYYY-MM-DD. The people module reads it as midnight UTC. */
  occurredAt: string;
  participants: LogParticipant[];
  /** The memory this occasion points back at. Absent when there is none yet. */
  refs?: OutsideRef[];
}

/** A person as Reverie holds one: a URI with its label, or a name kept unresolved. */
export interface HeldPerson {
  uri: string | null;
  label: string;
}

/** A held person as a participant: by id when the URI is a person's, else by name. */
export function participantFor(person: HeldPerson): LogParticipant {
  const id = person.uri ? idOf(person.uri, "person") : null;
  return id ? { personId: id } : { name: person.label };
}

export function logInteractionInput(
  occasion: { title: string; type: string; occurredAt: string },
  participants: readonly HeldPerson[],
  backRef: OutsideRef | null,
): LogInteractionInput {
  const seen = new Set<string>();
  const list: LogParticipant[] = [];
  for (const person of participants) {
    const participant = participantFor(person);
    const key = "personId" in participant ? `id:${participant.personId}` : `name:${participant.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(participant);
  }
  return {
    title: occasion.title,
    type: occasion.type,
    occurredAt: occasion.occurredAt,
    participants: list,
    ...(backRef ? { [REFS_FIELD]: [backRef] } : {}),
  };
}

/** The most outside references one people event carries. */
export const REFS_MAX = 20;

export interface BackRefCall extends PeopleCall<{ eventId: string; patch: { refs: OutsideRef[] } }> {
  /** `refs` replaces the whole list on the people side: what to do before running it. */
  merge: string;
}

/**
 * The call that points an occasion the people module already holds back at
 * a memory. `refs` replaces the occasion's whole list there, so `current`
 * is the list the caller read from the people module (people.timeline or
 * people.activity); this memory's reference is added to it, never doubled.
 */
export function backRefCall(occasionUri: string, ref: OutsideRef, current: readonly OutsideRef[] = []): BackRefCall | null {
  const eventId = idOf(occasionUri, "event");
  if (!eventId) return null;
  const refs = [...current.filter((entry) => entry.uri !== ref.uri), ref].slice(-REFS_MAX);
  return {
    tool: PEOPLE_TOOLS.updateInteraction,
    input: { eventId, patch: { [REFS_FIELD]: refs } },
    merge:
      "refs replaces the occasion's whole list. Read its current refs first (people.timeline entries[].event.refs or people.activity events[].refs) and send them together with this one.",
  };
}

/** A Tiptap document of one paragraph, the body people.add_note takes. */
export function tiptapDoc(text: string): Record<string, unknown> {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

export interface AddNoteInput {
  personId: string;
  body: Record<string, unknown>;
  occurredAt: string;
}

/**
 * A note on one person. With the person still a name, there is no personId
 * to give: the call names people.resolve_person first, and the note waits on
 * its answer.
 */
export interface NoteCall {
  tool: typeof PEOPLE_TOOLS.addNote;
  /** Null until the person is resolved: run `resolveFirst`, then fill in the personId. */
  input: AddNoteInput | (Omit<AddNoteInput, "personId"> & { personId: null });
  /** The person the note is about, as the memory holds them. */
  person: HeldPerson;
  /** Set when the person is still a name. */
  resolveFirst: PeopleCall<{ name: string }> | null;
}

export function noteCall(person: HeldPerson, body: string, occurredAt: string): NoteCall {
  const id = person.uri ? idOf(person.uri, "person") : null;
  return {
    tool: PEOPLE_TOOLS.addNote,
    input: { personId: id, body: tiptapDoc(body), occurredAt },
    person: { uri: person.uri, label: person.label },
    resolveFirst: id ? null : { tool: PEOPLE_TOOLS.resolvePerson, input: { name: person.label } },
  } as NoteCall;
}

/* ----------------------------------------------------------- the events */

function text(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** "2026-12-24T00:00:00.000Z" or "2026-12-24" to the day, or null. */
export function dayOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? (match[1] as string) : null;
}

/** An event id or URI from a payload, as an occasion URI. Reads `eventId`, then the older `uri`, `interactionId`, `id`. */
function occasionOf(payload: Record<string, unknown>): string | null {
  const uri = text(payload, "uri");
  if (uri) return EVENT_URI_PATTERN.test(uri) ? uri : null;
  const id = text(payload, "eventId", "interactionId", "id");
  return id && ID_PATTERN.test(id) ? eventUri(id) : null;
}

export interface PersonCreated {
  uri: string | null;
  name: string | null;
}

/** people.person.created: `{ personId, displayName }`, as Fellowship emits it. `uri` and `name` are read too. */
export function readPersonCreated(payload: Record<string, unknown>): PersonCreated {
  const given = text(payload, "uri");
  const id = text(payload, "personId", "id");
  const uri = given && PERSON_URI_PATTERN.test(given) ? given : id && ID_PATTERN.test(id) ? personUri(id) : null;
  return { uri, name: text(payload, "displayName", "name", "label") };
}

export interface InteractionLogged {
  occasion: string;
  occurredOn: string | null;
  people: string[];
  title: string | null;
}

/** people.interaction.logged: `{ eventId, personIds, occurredAt }`, as Fellowship emits it. A title is read when there is one. */
export function readInteractionLogged(payload: Record<string, unknown>): InteractionLogged | null {
  const occasion = occasionOf(payload);
  if (!occasion) return null;
  const ids = Array.isArray(payload["personIds"]) ? payload["personIds"] : [];
  const people = [
    ...new Set(
      ids.filter((id): id is string => typeof id === "string" && ID_PATTERN.test(id.trim())).map((id) => personUri(id.trim())),
    ),
  ].sort();
  return { occasion, occurredOn: dayOf(payload["occurredAt"]), people, title: text(payload, "title") };
}

export type InteractionChange = "participants" | "updated" | "removed";

export interface InteractionChanged {
  occasion: string;
  change: InteractionChange;
  occurredOn: string | null;
  title: string | null;
  /** Null when the payload carries no list: then the attendees are left as they are. */
  participants: Array<{ uri: string; label: string }> | null;
}

/**
 * people.interaction.changed, as the contract gives it: `{ eventId, change,
 * occurredAt, title, participants: [{ personId, name }] }`. Only the
 * person's id and name are read from a participant: a sentiment or a score
 * in the payload is never read, so it is never stored. The older `removed:
 * true` and `uri` are still read.
 */
export function readInteractionChanged(payload: Record<string, unknown>): InteractionChanged | null {
  const occasion = occasionOf(payload);
  if (!occasion) return null;
  const raw = text(payload, "change");
  const change: InteractionChange | null =
    raw === "participants" || raw === "updated" || raw === "removed"
      ? raw
      : payload["removed"] === true
        ? "removed"
        : raw === null
          ? "updated"
          : null;
  if (change === null) return null;

  let participants: Array<{ uri: string; label: string }> | null = null;
  if (change !== "removed" && Array.isArray(payload["participants"])) {
    participants = [];
    for (const entry of payload["participants"] as unknown[]) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = text(record, "personId", "id");
      const given = text(record, "uri");
      const uri = given && PERSON_URI_PATTERN.test(given) ? given : id && ID_PATTERN.test(id) ? personUri(id) : null;
      if (!uri) continue;
      participants.push({ uri, label: text(record, "name", "displayName", "label") ?? uri });
    }
  }
  return { occasion, change, occurredOn: dayOf(payload["occurredAt"]), title: text(payload, "title", "label"), participants };
}

/* ------------------------------------------------------- never a score */

/**
 * Keys that would carry how it went between the owner and a person. Reverie
 * never stores one (section 8, "Division of authority": sentiment and
 * closeness are the people module's). A person input carrying one is refused
 * with this reason rather than quietly dropped, so the caller knows where it
 * belongs.
 */
export const SCORE_KEYS: ReadonlySet<string> = new Set([
  "sentiment",
  "score",
  "closeness",
  "rating",
  "weight",
  "affinity",
  "mood",
]);

export const SCORE_REFUSAL =
  "Reverie never stores a score or a sentiment about a person. How it went between you is the people module's to hold: give it to people.log_interaction there.";
