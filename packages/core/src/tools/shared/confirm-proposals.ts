import { z } from "zod";

import { DraftJob } from "../../domain/drafting/schemas.js";
import {
  CONFLICT_TYPE,
  logInteractionInput,
  memoryUri,
  noteCall,
  PEOPLE_TOOLS,
  type HeldPerson,
  type LogInteractionInput,
  type NoteCall,
} from "../../domain/people-link.js";
import type { Proposal } from "../../ports.js";
import { SourceKind, TrustTier } from "../../schemas/enums.js";
import { ToolError, type ToolContext } from "../registry.js";

/**
 * What a drafted proposal carries beside the tool input, and the one rule
 * every proposal obeys. Shared by memory.propose_draft, which queues, and
 * memory.decide, which settles. docs/SPEC.md section 15, guardrail 8;
 * section 8, "When a model inferred it".
 */

/**
 * Tools a proposal may not name. Deciding or proposing from inside a
 * proposal would let a draft confirm another draft, which is the one loop the
 * review queue exists to rule out (guardrail 8). Checked when a proposal is
 * queued and again when it is decided.
 */
export const NOT_PROPOSABLE: ReadonlySet<string> = new Set(["memory.decide", "memory.propose_draft"]);

export function assertProposable(tool: string): void {
  if (NOT_PROPOSABLE.has(tool)) {
    throw new ToolError("refused", `A proposal may not name ${tool}: a draft never decides or proposes another draft.`, {
      tool,
    });
  }
}

/** Every proposal this module queues goes through here, so none names decide or propose_draft. */
export async function queueProposal(ctx: ToolContext, proposal: Proposal): Promise<{ id: string }> {
  assertProposable(proposal.tool);
  return ctx.ports.review.propose(proposal);
}

/** The key in a proposal's payload that holds the draft's provenance. The named tool ignores it. */
export const DRAFT_KEY = "draft";

/**
 * The occasion an episode implies, riding inside the episode's proposal
 * (section 8). Nothing is queued in the people module; decide hands it back
 * as a followUp for whoever confirmed to run.
 */
export const pendingOccasionSchema = z
  .object({
    title: z.string().min(1).max(200),
    type: z.string().min(1).max(40),
    occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /**
     * The occasion's participants by name: the episode's attendees, never a
     * person the story does not name. For a conflict, only who was in it, as
     * the draft named them, and possibly nobody yet: an attendee is never
     * made a participant of a conflict by being there.
     */
    participants: z.array(z.string().min(1).max(200)).max(30),
  })
  .refine((value) => value.type === CONFLICT_TYPE || value.participants.length > 0, {
    message: "An occasion other than a conflict has at least one participant.",
    path: ["participants"],
  });
export type PendingOccasion = z.infer<typeof pendingOccasionSchema>;

/**
 * A fact about one guest the telling carries ("Sam has a new partner"),
 * riding beside the episode for the people module, where it lives (section
 * 8, "Division of authority"). Nothing here stores it; decide hands it back.
 */
export const pendingNoteSchema = z.object({
  /** The person as named in the material, one of the episode's people. */
  person: z.string().min(1).max(200),
  /** The person's URI when the people module resolved the name to exactly one person. */
  uri: z
    .string()
    .regex(/^module:\/\/people\/person\/[^\s/]+$/)
    .nullable(),
  body: z.string().min(1).max(1000),
  occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type PendingNote = z.infer<typeof pendingNoteSchema>;

/**
 * Provenance a drafted proposal carries under `draft`. The owner reads it with
 * the rest of the payload; decide reads it to land the memory at the right
 * trust, citing the material it was drafted from.
 */
export const draftEnvelopeSchema = z.object({
  job: DraftJob,
  /** The trust the memory lands at when confirmed: `confirmed`, or `external` for external material. */
  trust: z.enum(["confirmed", "external"]).optional(),
  /** The trust of the material the quote was found in. */
  sourceTrust: TrustTier.optional(),
  source: z
    .object({
      kind: SourceKind,
      label: z.string().min(1).max(200),
      uri: z.string().min(1).max(2000).optional(),
      occurredAt: z.string().optional(),
      trust: TrustTier,
    })
    .optional(),
  quote: z.string().min(1).max(500).optional(),
  sessionDate: z.string().optional(),
  pendingOccasion: pendingOccasionSchema.nullable().optional(),
  pendingNotes: z.array(pendingNoteSchema).max(10).optional(),
  /** Names that could be more than one person, asked rather than guessed. */
  questions: z.array(z.string()).optional(),
  newTags: z.array(z.string()).optional(),
});
export type DraftEnvelope = z.infer<typeof draftEnvelopeSchema>;

/** A payload split into the tool's input and the draft envelope, when there is one. */
export function splitPayload(payload: unknown): { input: Record<string, unknown>; draft: DraftEnvelope | null } {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const { [DRAFT_KEY]: raw, ...input } = record;
  if (raw === undefined) return { input, draft: null };
  const parsed = draftEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ToolError("invalid_input", "The proposal's draft provenance is not in the shape this module writes.", {
      issues: parsed.error.issues.slice(0, 10),
    });
  }
  return { input, draft: parsed.data };
}

/**
 * The followUp decide returns for a confirmed episode with a pending
 * occasion, in section 8's shape: the people module's call with its real
 * input, back reference included, then the link back. This module never
 * makes either call itself. `then` is null only when the owner kept the
 * occasion and turned the episode down: there is no memory to point back at
 * or to link.
 */
export interface FollowUp {
  tool: typeof PEOPLE_TOOLS.logInteraction;
  input: LogInteractionInput;
  then: { tool: "memory.link_occasion"; call: string } | null;
  /** Set for a conflict with nobody named as in it yet: ask the owner before logging. */
  notice?: string;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The occasion's participants as held people: each name the occasion
 * carries, matched to the person the memory holds under it (so a resolved
 * attendee goes by id), else kept as the name.
 */
function participantsOf(occasion: PendingOccasion, people: readonly HeldPerson[]): HeldPerson[] {
  return occasion.participants.map((name) => people.find((person) => sameName(person.label, name)) ?? { uri: null, label: name });
}

export function followUpFor(
  occasion: PendingOccasion,
  people: readonly HeldPerson[],
  memory: { call: string; title: string } | null,
): FollowUp {
  const backRef = memory ? { uri: memoryUri(memory.call), label: memory.title } : null;
  const input = logInteractionInput(occasion, participantsOf(occasion, people), backRef);
  return {
    tool: PEOPLE_TOOLS.logInteraction,
    input,
    then: memory ? { tool: "memory.link_occasion", call: memory.call } : null,
    ...(occasion.type === CONFLICT_TYPE && input.participants.length === 0
      ? {
          notice:
            "A conflict names who was in it, and being there does not put an attendee in it. Ask the owner who was in it and add them before logging.",
        }
      : {}),
  };
}

/** The notes a confirmed proposal hands back, one people.add_note call each. */
export function noteFollowUps(notes: readonly PendingNote[], people: readonly HeldPerson[]): NoteCall[] {
  return notes.map((note) => {
    const held = note.uri ? { uri: note.uri, label: note.person } : (people.find((person) => sameName(person.label, note.person)) ?? { uri: null, label: note.person });
    return noteCall(held, note.body, note.occurredAt);
  });
}
