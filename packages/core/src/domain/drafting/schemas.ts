import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { MemoryKind, MemoryScope } from "../../schemas/enums.js";
import { ReconcileVerb } from "../../schemas/reconcile.js";

/**
 * What a model may answer with, one schema per drafting job. docs/SPEC.md
 * section 15, "Drafting, 2".
 *
 * Each one is handed out by memory.draft_context as a JSON schema for
 * constrained decoding and used again by memory.propose_draft to parse the
 * answer, because an endpoint that ignores the schema fails silently
 * otherwise. The same JSON schemas sit in adapters/grammars/ for a local
 * model, generated from these, and a test keeps the two in agreement.
 *
 * These are plain shapes on purpose: no transforms, so the JSON schema says
 * exactly what is parsed. Normalising (tag slugs, dates to midnight UTC) and
 * the gates (the quote is in the material, discipline, names) run after the
 * parse, in gates.ts and the propose tool.
 *
 * None of this writes anything. A draft becomes a proposal, and a proposal
 * becomes a write when the owner says so.
 */

/** The four jobs, in the order section 15 lists them. */
export const DRAFT_JOBS = ["extract", "reconcile", "consolidate", "core"] as const;
export const DraftJob = z.enum(DRAFT_JOBS);
export type DraftJob = z.infer<typeof DraftJob>;

/** At most 500 characters, the cap the MemorySource CHECK holds. */
export const draftQuoteSchema = z.string().trim().min(1).max(500);

/** YYYY-MM-DD. A date the drafter resolved, never "yesterday". */
export const draftDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date, YYYY-MM-DD");

/** SECTION/SHELF, such as LIF/GTH. */
export const draftShelfSchema = z.string().regex(/^[A-Z]{3}\/[A-Z]{3}$/, "Expected a shelf such as LIF/GTH");

/** A full call number, LIF/GTH/2026-12-24/001. */
export const draftCallSchema = z
  .string()
  .regex(/^[A-Z]{3}\/[A-Z]{3}\/\d{4}-\d{2}-\d{2}\/\d{3}$/, "Expected a call number such as LIF/GTH/2026-12-24/001");

/** A tag as a model writes it: with or without the #, any case. Normalised after the parse. */
export const draftTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(65)
  .regex(/^#?[A-Za-z0-9][A-Za-z0-9-]*$/, "Expected a tag such as nightstash");

/** A module URI the people module issued, module://people/person/<id>. */
export const draftPersonUriSchema = z
  .string()
  .regex(/^module:\/\/people\/person\/[^\s/]+$/, "Expected module://people/person/<id>");

/** Starting value: the longest body a drafted candidate may carry. */
export const DRAFT_BODY_MAX = 4000;
/** Starting value: how many candidates one extract answer may carry. */
export const DRAFT_CANDIDATES_MAX = 40;

/* ---------------------------------------------------------------- extract */

/**
 * A person named in the material. The name stays a label: a URI is kept only
 * when the people module resolved it, and two or more candidates make the name
 * ambiguous, which becomes a question for the owner, never a guess.
 */
export const draftPersonSchema = z
  .object({
    /** The name as the material gives it. */
    name: z.string().trim().min(1).max(200),
    role: z.enum(["attendee", "mentions"]).default("attendee"),
    /** The one person the people module resolved this name to, when it did. */
    uri: draftPersonUriSchema.nullable().default(null),
    /** Every person the name could be, when it could be more than one. */
    candidates: z.array(draftPersonUriSchema).max(10).default([]),
  })
  .strict();

/**
 * The occasion an episode implies: a pending payload for the people module,
 * never a write here. Its participants are the episode's attendees, so the
 * drafter cannot add a guest the story does not name.
 */
export const draftOccasionSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    /** The people module's occasion type, such as PARTY. */
    type: z.string().regex(/^[A-Z][A-Z_]{1,39}$/, "Expected an occasion type such as PARTY"),
    /**
     * The occasion's URI when the people module already holds it. Then the
     * episode links to it and no second occasion is proposed.
     */
    uri: z
      .string()
      .regex(/^module:\/\/people\/event\/[^\s/]+$/, "Expected module://people/event/<id>")
      .nullable()
      .default(null),
    /**
     * Only for a CONFLICT: who was in it, by name, from the episode's
     * attendees. Being there does not put an attendee in a conflict, so
     * nobody is assumed: left null, the owner is asked. Ignored for any
     * other type, whose participants are the attendees.
     */
    participants: z.array(z.string().trim().min(1).max(200)).max(30).nullable().default(null),
  })
  .strict();

/**
 * A fact about one person the material gives ("Sam has a new partner"). It
 * lives in the people module as a note on that person, not in this library;
 * it rides beside the candidate for whoever confirms to write there.
 */
export const draftPersonNoteSchema = z
  .object({
    /** One of the candidate's people, by the name the material gives. */
    person: z.string().trim().min(1).max(200),
    /** The fact, in plain words, with every date written out. */
    body: z.string().trim().min(1).max(1000),
  })
  .strict();

export const extractCandidateSchema = z
  .object({
    kind: MemoryKind,
    title: z.string().trim().min(1).max(200),
    /** What to keep, in plain words, with every date written out. */
    body: z.string().trim().min(1).max(DRAFT_BODY_MAX),
    /** Where it lives, from the shelf list. Null when the drafter cannot tell: it waits on Returns. */
    shelf: draftShelfSchema.nullable().default(null),
    /** When it happened, resolved against the session date. */
    occurredOn: draftDateSchema,
    /** From the tag list first. A new tag is allowed and shown as new. */
    tags: z.array(draftTagSchema).max(20).default([]),
    people: z.array(draftPersonSchema).max(30).default([]),
    /** Only on an episode. */
    occasion: draftOccasionSchema.nullable().default(null),
    /** Facts about one of the candidate's people, for the people module. Never a score or how it went. */
    notes: z.array(draftPersonNoteSchema).max(10).default([]),
    /** A procedure says why and how to apply it. */
    why: z.string().trim().min(1).max(2000).nullable().default(null),
    howToApply: z.string().trim().min(1).max(2000).nullable().default(null),
    importance: z.number().int().min(1).max(5).default(3),
    scope: MemoryScope.default("global"),
    /** True only when the owner, in their own words, asked for this to be kept. */
    explicitAsk: z.boolean().default(false),
    /** The words it came from, copied exactly from the material. */
    quote: draftQuoteSchema,
  })
  .strict();

export const extractDraftSchema = z
  .object({
    candidates: z.array(extractCandidateSchema).max(DRAFT_CANDIDATES_MAX),
    /** What the drafter could not settle and wants the owner to answer. */
    questions: z
      .array(z.object({ question: z.string().trim().min(1).max(400) }).strict())
      .max(20)
      .default([]),
  })
  .strict();

export type ExtractCandidate = z.infer<typeof extractCandidateSchema>;
export type ExtractCandidateInput = z.input<typeof extractCandidateSchema>;
export type ExtractDraft = z.infer<typeof extractDraftSchema>;

/* -------------------------------------------------------------- reconcile */

/**
 * One verb for one candidate. `target` names the neighbour a refine,
 * supersede or duplicate acts on, by its call number, and is null for add.
 */
export const reconcileDraftSchema = z
  .object({
    verb: ReconcileVerb,
    target: draftCallSchema.nullable().default(null),
    reason: z.string().trim().min(1).max(400),
  })
  .strict();

export type ReconcileDraft = z.infer<typeof reconcileDraftSchema>;

/* ------------------------------------------------------------ consolidate */

const reasonSchema = z.string().trim().min(1).max(400);

export const consolidateActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("merge"),
      /** The memory that stays. */
      survivor: draftCallSchema,
      /** The memory folded into it. Its number becomes an alias of the survivor. */
      absorbed: draftCallSchema,
      reason: reasonSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("retire"),
      call: draftCallSchema,
      reason: reasonSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("link"),
      from: draftCallSchema,
      to: draftCallSchema,
      relation: z.enum(["contradicts", "elaborates"]),
      reason: reasonSchema,
    })
    .strict(),
]);

export const consolidateDraftSchema = z
  .object({
    actions: z.array(consolidateActionSchema).max(40),
  })
  .strict();

export type ConsolidateAction = z.infer<typeof consolidateActionSchema>;
export type ConsolidateDraft = z.infer<typeof consolidateDraftSchema>;

/* ------------------------------------------------------------------- core */

const coreChoiceSchema = z.object({ call: draftCallSchema, reason: reasonSchema }).strict();

/** The most characters a proposed owner line holds. Matches tools/shared/host-values.ts. */
export const OWNER_LINE_DRAFT_MAX = 300;

/**
 * Which candidates to pin into the core block, which pins to take out, and,
 * when the drafter has one to offer, how to word the owner line: who the
 * owner is, in one line (section 14).
 */
export const coreDraftSchema = z
  .object({
    pin: z.array(coreChoiceSchema).max(40).default([]),
    unpin: z.array(coreChoiceSchema).max(40).default([]),
    ownerLine: z
      .object({ text: z.string().trim().min(1).max(OWNER_LINE_DRAFT_MAX), reason: reasonSchema })
      .strict()
      .optional(),
  })
  .strict();

export type CoreDraft = z.infer<typeof coreDraftSchema>;

/* ------------------------------------------------------------------- jobs */

export const DRAFT_SCHEMAS = {
  extract: extractDraftSchema,
  reconcile: reconcileDraftSchema,
  consolidate: consolidateDraftSchema,
  core: coreDraftSchema,
} as const;

export type DraftAnswer = {
  extract: ExtractDraft;
  reconcile: ReconcileDraft;
  consolidate: ConsolidateDraft;
  core: CoreDraft;
};

/**
 * The constrained decoding schema for a job, from the zod schema itself. No
 * name and no refs: an endpoint wants the object schema, and a $ref into a
 * definitions block is the shape half of them choke on. As Fellowship's
 * jsonSchemaFor.
 */
export function jsonSchemaFor(job: DraftJob): Record<string, unknown> {
  return zodToJsonSchema(DRAFT_SCHEMAS[job], {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
}

/** The file name of a job's grammar in adapters/grammars/. */
export function grammarFileName(job: DraftJob): string {
  return `${job}.schema.json`;
}

/** A grammar file's text: the JSON schema, two space indent, one trailing newline. */
export function grammarFileText(job: DraftJob): string {
  return `${JSON.stringify(jsonSchemaFor(job), null, 2)}\n`;
}
