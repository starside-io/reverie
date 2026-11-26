// memory.link_occasion. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.link_occasion`; section 8 ("Division of authority": who was there is
// the people module's; "Two standalone hosts": the follow up ends in
// link_occasion, and the assistant is the bridge; "It works in both
// directions, and alone"); section 12 (refs port); section 18 ("Listened
// to"); gates "No invented attendees", "One event, not two", "Follow up is
// optional" and "Works without Fellowship"; guardrails 7 and 9.
//
// Two forms, one tool:
//
//   link    { call, occasion, label?, participants?, type?, occasionRefs? }
//           ties an episode to an occasion and syncs its attendees.
//   report  { report: { event, payload } }
//           what the people module just did, told by the assistant when no
//           bus carries the event between two standalone hosts. It runs the
//           same handler a host's delivery runs (listeners.ts), so the
//           outcome is the same either way.

import { z } from "zod";

import { deliverEvent, type DeliveryResult } from "../../listeners.js";
import {
  linkedElsewhere,
  linkOccasion,
  OCCASION_URI_PATTERN,
  participantsFrom,
  type OccasionAttendee,
} from "../../domain/occasions.js";
import {
  backRefCall,
  CONFLICT_TYPE,
  memoryUri,
  PERSON_URI_PATTERN,
  REFS_MAX,
  type BackRefCall,
} from "../../domain/people-link.js";
import { defineTool, ToolError } from "../registry.js";
import { clearOccasionPending } from "../shared/front-desk.js";
import { callSchema } from "../shared/inputs.js";
import { personObject } from "../shared/refs.js";
import { memoryView, type MemoryView } from "../shared/views.js";
import { loadByCall, mutation, refuseSuperseded } from "../shared/write-common.js";

const occasionUriSchema = z
  .string()
  .trim()
  .regex(OCCASION_URI_PATTERN, "Expected an occasion URI such as module://people/event/<id>");

const personUriSchema = z
  .string()
  .trim()
  .regex(PERSON_URI_PATTERN, "Expected a person URI such as module://people/person/<id>");

/** The three people events a report may carry, as section 18 lists them. */
export const REPORTABLE_EVENTS = ["people.person.created", "people.interaction.logged", "people.interaction.changed"] as const;

export const linkOccasionInputSchema = z
  .object({
    /** The episode. Current or old number. */
    call: callSchema.optional(),
    /** `module://people/event/<id>`, as the people module gave it. */
    occasion: occasionUriSchema.optional(),
    /** The occasion's title as the caller saw it, kept when the people module does not answer. */
    label: z.string().trim().min(1).max(200).optional(),
    /**
     * The occasion's participants as the people module showed them to the
     * caller, used when the refs port cannot answer (two standalone hosts).
     * Names that match take the person's URI; labels are refreshed. Never a
     * score or a sentiment.
     */
    participants: z
      .array(personObject({ uri: personUriSchema, label: z.string().trim().min(1).max(200) }))
      .max(100)
      .optional(),
    /** The occasion's type, such as PARTY. A CONFLICT never drops an attendee for not being in it. */
    type: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z_]{1,39}$/, "Expected an occasion type such as PARTY")
      .optional(),
    /**
     * The occasion's outside references as the people module holds them now,
     * so the back reference returned is the whole merged list its update
     * takes.
     */
    occasionRefs: z
      .array(personObject({ uri: z.string().trim().min(1).max(500), label: z.string().trim().min(1).max(200) }))
      .max(REFS_MAX)
      .optional(),
    /** What the people module just did, when no bus delivered it. Alone: no other field goes with it. */
    report: z
      .object({
        event: z.enum(REPORTABLE_EVENTS),
        payload: z.record(z.unknown()),
      })
      .strict()
      .optional(),
  })
  .refine(
    (value) =>
      value.report !== undefined
        ? Object.entries(value).every(([key, entry]) => key === "report" || entry === undefined)
        : value.call !== undefined && value.occasion !== undefined,
    { message: "Give call and occasion to link, or report alone to tell what the people module did" },
  );

export type LinkOccasionInput = z.input<typeof linkOccasionInputSchema>;

export interface LinkOccasionToolResult {
  memory: MemoryView;
  /** False when the memory already pointed at this occasion and nothing needed syncing. */
  changed: boolean;
  /** True when participants were known, from the people module or the caller, and the attendees were synced from them. */
  synced: boolean;
  /** Why the attendees were left as they are, or what else to know. */
  notice: string | null;
  /** The occasion this memory pointed at before, when it was another one. */
  replaced: string | null;
  /** Person URIs added to or removed from the attendees by the sync. */
  added: string[];
  removed: string[];
  /** Unresolved names that matched a participant and now carry their URI. */
  resolvedNames: string[];
  /** Unresolved names no participant matched, kept as told. */
  keptNames: string[];
  /** Other memories that already tell this occasion. Both point at it now. */
  alsoLinkedFrom: string[];
  /**
   * The people module's call that points the occasion back at this memory.
   * Already done when the occasion was logged by a followUp, whose input
   * carried the reference.
   */
  backRef: BackRefCall | null;
}

export interface ReportResult {
  report: DeliveryResult;
}

export const tool = defineTool({
  name: "memory.link_occasion",
  title: "Link an occasion",
  kind: "write",
  summary:
    "Ties an episode to an occasion in the people module (module://people/event/<id>) and syncs its attendees from the occasion's participants, as the people module answers them or as you pass them in participants: names that match take the person's URI, names that match nobody stay as told; a CONFLICT drops nobody. Returns backRef, the people.update_interaction call that points the occasion back at the memory. Run it after people.log_interaction, with the id it returned, or to attach a story to an occasion already logged. Also takes report { event, payload } alone, to tell Reverie what the people module just did (people.interaction.logged, people.interaction.changed, people.person.created) when no bus carries it: the same outcome a host delivery gives.",
  input: linkOccasionInputSchema,
  async handler(ctx, input): Promise<LinkOccasionToolResult | ReportResult> {
    if (input.report) {
      return { report: await deliverEvent(ctx.ports, input.report.event, input.report.payload, { now: ctx.now }) };
    }
    const occasionUri = input.occasion as string;
    const { row } = await loadByCall(ctx, input.call as string);
    await refuseSuperseded(ctx, row, "linked to an occasion");
    if (row.kind !== "episode") {
      throw new ToolError(
        "refused",
        `${row.callNumber} is a ${row.kind}. An occasion is tied to an episode: something that happened, with who was there.`,
      );
    }

    const answer = await ctx.ports.refs.resolve(occasionUri);
    const resolved = answer.status === "resolved";
    const fromPort = resolved ? participantsFrom(answer.detail) : null;
    const given: OccasionAttendee[] | null = input.participants
      ? input.participants.map((person) => ({ uri: person.uri, label: person.label }))
      : null;
    const participants = fromPort ?? given;
    const label = resolved ? answer.label : (input.label ?? occasionUri);
    const detailType = resolved && typeof answer.detail?.["type"] === "string" ? (answer.detail["type"] as string) : null;
    const conflict = (input.type ?? detailType) === CONFLICT_TYPE;

    const result = await linkOccasion(
      ctx.db,
      row.id,
      { uri: occasionUri, label, attendees: participants, additive: conflict },
      mutation(ctx),
    );
    await clearOccasionPending(ctx.ports, row.id);
    const alsoLinkedFrom = await linkedElsewhere(ctx.db, occasionUri, row.id);

    const notices: string[] = [];
    if (participants === null) {
      notices.push(
        resolved
          ? "The people module named no participants for this occasion, so the attendees are left as they are."
          : "The people module did not answer for this occasion and no participants were passed, so it is recorded as given and the attendees are left as they are.",
      );
    }
    if (conflict && participants !== null) {
      notices.push("A conflict: attendees who were not in it stay on the memory, and none is added to the occasion.");
    }
    if (alsoLinkedFrom.length > 0) {
      notices.push(
        `${alsoLinkedFrom.join(", ")} already tells this occasion, and both point at it now. If they are the same story, fold one into the other with memory.merge.`,
      );
    }

    const memory = await memoryView(ctx, row.id);
    return {
      memory,
      changed: result.changed,
      synced: participants !== null,
      notice: notices.length > 0 ? notices.join(" ") : null,
      replaced: result.replaced,
      added: result.added,
      removed: result.removed,
      resolvedNames: result.resolvedNames,
      keptNames: result.keptNames,
      alsoLinkedFrom,
      backRef: backRefCall(occasionUri, { uri: memoryUri(memory.call), label: memory.title }, input.occasionRefs ?? []),
    };
  },
  auditIds: (input, result) => {
    if (result && "memory" in result) return { memoryIds: [result.memory.id], calls: [result.memory.call] };
    return input.call ? { calls: [input.call] } : undefined;
  },
});
