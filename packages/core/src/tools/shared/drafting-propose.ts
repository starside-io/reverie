import { resolveShelf } from "../../domain/catalogue/shelving.js";
import { tagVocabulary } from "../../domain/catalogue/tags.js";
import {
  proceduresInCore,
  readCoreCandidates,
  readStretch,
  type ExtractWithMaterial,
  type TargetOf,
} from "../../domain/drafting/context.js";
import {
  findQuote,
  isExternal,
  materialText,
  namedInMaterial,
  normaliseWhitespace,
  shortDigest,
  sourceFor,
  type DraftedSource,
  type Material,
} from "../../domain/drafting/gates.js";
import type {
  ConsolidateDraft,
  CoreDraft,
  ExtractCandidate,
  ExtractDraft,
  ReconcileDraft,
} from "../../domain/drafting/schemas.js";
import { checkSecrets, runDiscipline, type DisciplineFinding } from "../../domain/discipline.js";
import { DomainError } from "../../domain/errors.js";
import { duplicateGuard, resolveVerdictTarget } from "../../domain/reconcile.js";
import { CORE_TRUST } from "../../domain/recall/core-block.js";
import type { Proposal, ProposalGroup } from "../../ports.js";
import { dayKey } from "../../schemas/common.js";
import type { TrustTier } from "../../schemas/enums.js";
import { normaliseTagSlug } from "../../schemas/tag.js";
import { ToolError, type ToolContext } from "../registry.js";
import { CONFLICT_TYPE } from "../../domain/people-link.js";
import { DRAFT_KEY, type DraftEnvelope, type PendingNote, type PendingOccasion } from "./confirm-proposals.js";
import { findHeldOccasion, type HeldOccasion } from "./front-desk.js";
import { projectShelfPath, resolveProject } from "./project.js";
import { scopeRefFor } from "./session.js";
import { readOwnerLine } from "./host-values.js";

/**
 * From a validated answer to proposals, through the propose time gates.
 * docs/SPEC.md section 15, guardrails 2, 3, 4, 5, 7 and 8; section 8 (one
 * telling, the pending occasion); section 13 (the write path).
 *
 * Every gate here is re-asserted where the write finally runs (discipline in
 * remember and promote_procedure, the source in the commit), but refusing at
 * propose time means the owner never reads a draft in review that could not
 * be confirmed. Nothing here writes to the silo: what survives is a Proposal
 * for the caller to queue.
 */

/** One refused part of an answer, with the reason the caller can act on. */
export interface DraftRejection {
  /**
   * Index into the answer's list: candidates, actions, or pins then unpins. 0
   * for a single verb. A core answer's owner line comes after its pins and
   * unpins: index pin.length + unpin.length.
   */
  index: number;
  code: string;
  reason: string;
  detail?: Record<string, unknown>;
}

export interface DraftOutcome {
  proposals: Proposal[];
  rejected: DraftRejection[];
  /** Questions for the owner: the drafter's own, and every ambiguous name. */
  questions: string[];
}

function reject(index: number, code: string, reason: string, detail?: Record<string, unknown>): DraftRejection {
  return { index, code, reason, ...(detail ? { detail } : {}) };
}

/** Findings as a refusal detail shows them: check, code, label, field and reason, never a matched secret. */
function shownFindings(findings: readonly DisciplineFinding[]) {
  return findings.map((finding) => ({
    check: finding.check,
    code: finding.code,
    label: finding.label,
    ...(finding.field ? { field: finding.field } : {}),
    reason: finding.reason,
  }));
}

/** A person in the payload remember takes: a name, or a URI with the name as its label. */
type AttendeeInput = string | { uri: string; label: string };

/** A candidate that passed every gate, ready to become a proposal. */
export interface PreparedCandidate {
  candidate: ExtractCandidate;
  shelf: string | null;
  /** Set when the drafter named a shelf this library does not have; it waits on Returns. */
  unknownShelf: string | null;
  scopeRef: string | null;
  tags: string[];
  newTags: string[];
  attendees: AttendeeInput[];
  /** People the memory mentions without their having been there. */
  mentions: AttendeeInput[];
  /** Names that could be more than one person, kept as labels and asked. */
  ambiguous: string[];
  source: DraftedSource;
  sourceTrust: TrustTier;
  /** What the memory lands at when confirmed. */
  trust: "confirmed" | "external";
  explicitAsk: boolean;
  /** The occasion to log in the people module after confirmation: none when one is already held. */
  occasion: PendingOccasion | null;
  /** The occasion the people module already holds, linked on the memory itself. */
  linkedOccasion: LinkedOccasion | null;
  /** Facts about one of the people, for the people module, riding beside the memory. */
  notes: PendingNote[];
}

export interface CandidateContext {
  material: Material;
  sessionDate: string;
  /** The session the material is from: the one being extracted, else the one calling. */
  sessionId: string | null;
  /** Lowercased, whitespace normalised material text, for the name gate. */
  text: string;
  vocabulary: ReadonlySet<string>;
}

export async function candidateContext(
  ctx: ToolContext,
  material: Material,
  sessionDate: string,
  sourceSession: string | null = null,
): Promise<CandidateContext> {
  const vocabulary = new Set((await tagVocabulary(ctx.db)).map((tag) => tag.slug));
  return { material, sessionDate, sessionId: sourceSession ?? ctx.session.id, text: materialText(material), vocabulary };
}

/**
 * Every gate one candidate meets before it may be queued, in order: the quote
 * is in the material, a procedure is never from outside and says why and how
 * to apply, discipline passes, tags are slugs, every person is named in the
 * material and stays a label unless resolved to exactly one person, an
 * occasion belongs to an episode with attendees, and the scope names what it
 * is scoped to. Returns the prepared candidate or the reason it was refused.
 */
export async function prepareCandidate(
  ctx: ToolContext,
  candidate: ExtractCandidate,
  index: number,
  context: CandidateContext,
): Promise<PreparedCandidate | DraftRejection> {
  // Guardrail 2: no source, no memory, and a drafted quote is in the material it was drafted from.
  const match = findQuote(context.material, candidate.quote);
  if (match === null) {
    return reject(
      index,
      "quote-not-in-material",
      "The quote does not appear in the material it was drafted from. A quote is copied exactly, at most 500 characters.",
    );
  }
  const source = sourceFor(context.material, match, { sessionDate: context.sessionDate, sessionId: context.sessionId });
  const sourceTrust = match.trust;
  const external = isExternal(sourceTrust);

  // Guardrail 4: a procedure only through promote_procedure, never from outside.
  if (candidate.kind === "procedure") {
    if (external) {
      return reject(
        index,
        "external-procedure",
        "A procedure changes how every later session behaves, and an external source can never yield one. Refused outright.",
      );
    }
    if (!candidate.why || !candidate.howToApply) {
      return reject(index, "procedure-incomplete", "A procedure says why and how to apply it. Give both.");
    }
  }

  // An explicit ask is the owner's, in their own words: only a quote from what the owner said carries one.
  const explicitAsk = candidate.explicitAsk && sourceTrust === "stated";

  // Guardrail 3: discipline on every write, and the quote is scanned for secrets too.
  const verdict = runDiscipline({
    kind: candidate.kind,
    title: candidate.title,
    body: candidate.body,
    why: candidate.why,
    howToApply: candidate.howToApply,
    sourceTrust,
    explicitAsk,
  });
  const quoteSecrets = checkSecrets({
    kind: candidate.kind,
    title: candidate.title,
    body: candidate.quote,
    sourceTrust,
  }).findings;
  const findings = [...verdict.findings, ...quoteSecrets];
  if (findings.length > 0) {
    return reject(index, "discipline", `Refused by discipline. ${findings.map((f) => f.reason).join(" ")}`, {
      findings: shownFindings(findings),
    });
  }

  const tags: string[] = [];
  for (const raw of candidate.tags) {
    const slug = normaliseTagSlug(raw);
    if (slug === null) return reject(index, "bad-tag", "A tag is a lowercase slug of letters, digits and hyphens.");
    if (!tags.includes(slug)) tags.push(slug);
  }
  const newTags = tags.filter((slug) => !context.vocabulary.has(slug));

  // Guardrail 7: no attendee invented. Every name is in the material; a name
  // stays a label unless the people module resolved it to exactly one person;
  // an ambiguous name becomes a question, never a guess.
  const attendees: AttendeeInput[] = [];
  const mentions: AttendeeInput[] = [];
  const ambiguous: string[] = [];
  /** Each person as resolved: a URI only when the people module named exactly one person. */
  const held = new Map<string, string | null>();
  for (const person of candidate.people) {
    if (!namedInMaterial(context.text, person.name)) {
      return reject(index, "person-not-in-material", "The draft names a person the material does not mention.", {
        name: person.name,
      });
    }
    const into = person.role === "attendee" ? attendees : mentions;
    const options = [...new Set([...(person.uri ? [person.uri] : []), ...person.candidates])];
    if (options.length >= 2) {
      if (!ambiguous.includes(person.name)) ambiguous.push(person.name);
      into.push(person.name);
      continue;
    }
    const uri = options[0];
    if (uri) {
      const answer = await ctx.ports.refs.resolve(uri);
      into.push(answer.status === "resolved" ? { uri, label: person.name } : person.name);
      held.set(normaliseWhitespace(person.name).toLowerCase(), answer.status === "resolved" ? uri : null);
    } else {
      into.push(person.name);
      held.set(normaliseWhitespace(person.name).toLowerCase(), null);
    }
  }
  const heldUri = (name: string) => held.get(normaliseWhitespace(name).toLowerCase()) ?? null;

  // A fact about one of the people goes to the people module as a note on
  // them. It names one of this candidate's people, and passes discipline.
  const notes: PendingNote[] = [];
  for (const note of candidate.notes) {
    const person = candidate.people.find(
      (entry) => normaliseWhitespace(entry.name).toLowerCase() === normaliseWhitespace(note.person).toLowerCase(),
    );
    if (!person) {
      return reject(index, "note-person-unknown", "A note is about one of the candidate's people, by the name the material gives.", {
        name: note.person,
      });
    }
    const noteVerdict = runDiscipline({ kind: "fact", title: note.person, body: note.body, sourceTrust, explicitAsk });
    if (noteVerdict.findings.length > 0) {
      return reject(index, "discipline", `A note was refused by discipline. ${noteVerdict.findings.map((f) => f.reason).join(" ")}`, {
        findings: shownFindings(noteVerdict.findings),
      });
    }
    notes.push({ person: person.name, uri: heldUri(person.name), body: note.body, occurredAt: candidate.occurredOn });
  }

  let occasion: PendingOccasion | null = null;
  let linkedOccasion: LinkedOccasion | null = null;
  if (candidate.occasion) {
    if (candidate.kind !== "episode") {
      return reject(index, "occasion-not-episode", "Only an episode carries an occasion.");
    }
    const present = candidate.people.filter((person) => person.role === "attendee").map((person) => person.name);
    if (present.length === 0) {
      return reject(index, "occasion-without-attendees", "An occasion needs at least one attendee the material names.");
    }
    // A conflict never gains a bystander: its participants are only who the
    // draft says was in it, each one an attendee. Any other occasion's
    // participants are the attendees.
    let participants = present;
    if (candidate.occasion.type === CONFLICT_TYPE) {
      participants = [];
      for (const name of candidate.occasion.participants ?? []) {
        const match = present.find((entry) => normaliseWhitespace(entry).toLowerCase() === normaliseWhitespace(name).toLowerCase());
        if (!match) {
          return reject(index, "conflict-participant-not-attendee", "Who was in a conflict is named among the episode's attendees.", { name });
        }
        if (!participants.includes(match)) participants.push(match);
      }
    }
    // One event, not two: an occasion the people module already holds is
    // linked, never logged again. Named by the drafter, found on an episode
    // already linked to it on that day with the same people, or reported
    // logged by the people module that day with the same people.
    linkedOccasion = candidate.occasion.uri
      ? { uri: candidate.occasion.uri, label: candidate.occasion.title, via: "named" }
      : await findHeldOccasion(ctx, candidate.occurredOn, present.map((name) => ({ name, uri: heldUri(name) })));
    if (!linkedOccasion) {
      occasion = {
        title: candidate.occasion.title,
        type: candidate.occasion.type,
        occurredAt: candidate.occurredOn,
        participants,
      };
    }
  }

  let shelf: string | null = candidate.shelf;
  let unknownShelf: string | null = null;
  if (shelf !== null) {
    try {
      await resolveShelf(ctx.db, shelf);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "not_found") throw error;
      // Nothing is refused for want of a home: it waits on Returns.
      unknownShelf = shelf;
      shelf = null;
    }
  }

  let scopeRef: string | null = null;
  if (candidate.scope !== "global") {
    try {
      const project = candidate.scope === "project" ? (await resolveProject(ctx)).project : null;
      scopeRef = scopeRefFor(ctx, candidate.scope, undefined, project) ?? null;
    } catch (error) {
      if (error instanceof ToolError) return reject(index, "scope", error.message);
      throw error;
    }
  }

  // A project memory the drafter gave no shelf goes to its project's shelf,
  // shown in review as such, as memory.remember would put it.
  if (candidate.shelf === null && candidate.scope === "project") shelf = await projectShelfPath(ctx.db, scopeRef);

  return {
    candidate,
    shelf,
    unknownShelf,
    scopeRef,
    tags,
    newTags,
    attendees,
    mentions,
    ambiguous,
    source,
    sourceTrust,
    trust: external ? "external" : "confirmed",
    explicitAsk,
    occasion,
    linkedOccasion,
    notes,
  };
}

/** An occasion the people module already holds, which a drafted episode links to. */
export type LinkedOccasion = HeldOccasion;

function isRejection(value: PreparedCandidate | DraftRejection): value is DraftRejection {
  return "code" in value && "reason" in value && !("candidate" in value);
}

function envelope(job: DraftEnvelope["job"], prepared: PreparedCandidate, sessionDate: string): DraftEnvelope {
  return {
    job,
    trust: prepared.trust,
    sourceTrust: prepared.sourceTrust,
    source: prepared.source,
    quote: prepared.candidate.quote,
    sessionDate,
    pendingOccasion: prepared.occasion,
    ...(prepared.notes.length > 0 ? { pendingNotes: prepared.notes } : {}),
    ...(prepared.ambiguous.length > 0 ? { questions: prepared.ambiguous.map(ambiguousQuestion) } : {}),
    ...(prepared.newTags.length > 0 ? { newTags: prepared.newTags } : {}),
  };
}

function ambiguousQuestion(name: string): string {
  return `"${name}" could be more than one person. Who is it?`;
}

/** The fields memory.remember and a supersede replacement share. */
function memoryFields(prepared: PreparedCandidate) {
  const c = prepared.candidate;
  return {
    kind: c.kind,
    title: c.title,
    body: c.body,
    ...(prepared.shelf ? { shelf: prepared.shelf } : {}),
    occurredOn: c.occurredOn,
    scope: c.scope,
    ...(prepared.scopeRef ? { scopeRef: prepared.scopeRef } : {}),
    tags: prepared.tags,
    attendees: prepared.attendees,
    ...(prepared.mentions.length > 0 ? { mentions: prepared.mentions } : {}),
    ...(prepared.linkedOccasion
      ? { occasion: { uri: prepared.linkedOccasion.uri, label: prepared.linkedOccasion.label } }
      : {}),
    ...(c.why ? { why: c.why } : {}),
    ...(c.howToApply ? { howToApply: c.howToApply } : {}),
    importance: c.importance,
    explicitAsk: prepared.explicitAsk,
  };
}

/**
 * The proposal that adds one prepared candidate: memory.remember for every
 * kind but a procedure, which becomes memory.promote_procedure (guardrail 4),
 * carrying its source.
 */
export function addProposal(
  job: DraftEnvelope["job"],
  prepared: PreparedCandidate,
  sessionDate: string,
  group: ProposalGroup,
): Proposal {
  const c = prepared.candidate;
  const draft = envelope(job, prepared, sessionDate);
  if (c.kind === "procedure") {
    return {
      tool: "memory.promote_procedure",
      payload: {
        title: c.title,
        body: c.body,
        why: c.why,
        howToApply: c.howToApply,
        ...(prepared.shelf ? { shelf: prepared.shelf } : {}),
        occurredOn: c.occurredOn,
        scope: c.scope,
        ...(prepared.scopeRef ? { scopeRef: prepared.scopeRef } : {}),
        tags: prepared.tags,
        importance: c.importance,
        explicitAsk: prepared.explicitAsk,
        sources: [{ source: prepared.source, quote: c.quote }],
        [DRAFT_KEY]: draft,
      },
      summary: summaryFor("Procedure", prepared),
      group,
    };
  }
  return {
    tool: "memory.remember",
    payload: { ...memoryFields(prepared), said: c.quote, [DRAFT_KEY]: draft },
    summary: summaryFor(`New ${c.kind}`, prepared),
    group,
  };
}

function summaryFor(lead: string, prepared: PreparedCandidate): string {
  const c = prepared.candidate;
  const parts = [`${lead} on ${prepared.shelf ?? "Returns"}, ${c.occurredOn}: ${c.title}`];
  if (prepared.unknownShelf) parts.push(`(no shelf ${prepared.unknownShelf}, so it waits on Returns)`);
  if (prepared.newTags.length > 0) parts.push(`new tags: ${prepared.newTags.map((slug) => `#${slug}`).join(" ")}`);
  if (prepared.trust === "external") parts.push("from external material");
  if (prepared.occasion) parts.push(`occasion pending: ${prepared.occasion.title}`);
  if (prepared.linkedOccasion) {
    parts.push(
      prepared.linkedOccasion.call
        ? `links to the occasion ${prepared.linkedOccasion.call} already links, not a second one`
        : prepared.linkedOccasion.via === "logged"
          ? `links to the occasion the people module logged that day, not a second one: ${prepared.linkedOccasion.label}`
          : `links to the occasion already held: ${prepared.linkedOccasion.label}`,
    );
  }
  if (prepared.notes.length > 0) parts.push(`notes for the people module: ${prepared.notes.map((note) => note.person).join(", ")}`);
  if (prepared.ambiguous.length > 0) parts.push(`ask who: ${prepared.ambiguous.join(", ")}`);
  return parts.join(". ");
}

/** The group one session's drafts share: the session extracted, else the one calling. */
export function sessionGroup(
  ctx: ToolContext,
  material: Material,
  sessionDate: string,
  job: string,
  sourceSession: string | null = null,
): ProposalGroup {
  const key = sourceSession ?? ctx.session.id ?? shortDigest(material);
  return {
    id: `session:${key}:${sessionDate}`,
    title: `Session of ${sessionDate}`,
    meta: { job, sessionDate },
  };
}

/** The group one event's drafts share: a heading, not a transaction. */
export function eventGroup(occasion: PendingOccasion): ProposalGroup {
  return {
    id: `event:${shortDigest([occasion.title, occasion.occurredAt, occasion.participants])}`,
    title: `${occasion.title}, ${occasion.occurredAt}`,
    ...(occasion.participants.length > 0 ? { detail: `With ${occasion.participants.join(", ")}` } : {}),
    meta: { job: "extract", occurredAt: occasion.occurredAt },
  };
}

async function duplicateOf(ctx: ToolContext, prepared: PreparedCandidate, index: number): Promise<DraftRejection | null> {
  const c = prepared.candidate;
  const check = await duplicateGuard(ctx.db, {
    title: c.title,
    body: c.body,
    kind: c.kind,
    tags: prepared.tags,
    scope: c.scope,
    scopeRef: prepared.scopeRef,
    ...(prepared.shelf ? { shelf: prepared.shelf } : {}),
  });
  if (!check.duplicate) return null;
  return reject(
    index,
    "duplicate",
    `Already remembered as ${check.callNumber}. Reconcile it as a duplicate instead, which adds this as a source.`,
    { call: check.callNumber },
  );
}

/* ----------------------------------------------------------------- extract */

export async function extractOutcome(
  ctx: ToolContext,
  target: ExtractWithMaterial & { sessionDate: string },
  draft: ExtractDraft,
): Promise<DraftOutcome> {
  const source = target.session ?? null;
  const context = await candidateContext(ctx, target.material, target.sessionDate, source);
  const session = sessionGroup(ctx, target.material, target.sessionDate, "extract", source);
  const outcome: DraftOutcome = { proposals: [], rejected: [], questions: draft.questions.map((q) => q.question) };

  for (const [index, candidate] of draft.candidates.entries()) {
    const prepared = await prepareCandidate(ctx, candidate, index, context);
    if (isRejection(prepared)) {
      outcome.rejected.push(prepared);
      continue;
    }
    const duplicate = await duplicateOf(ctx, prepared, index);
    if (duplicate) {
      outcome.rejected.push(duplicate);
      continue;
    }
    outcome.questions.push(...prepared.ambiguous.map(ambiguousQuestion));
    const group = prepared.occasion ? eventGroup(prepared.occasion) : session;
    outcome.proposals.push(addProposal("extract", prepared, target.sessionDate, group));
  }
  return outcome;
}

/* --------------------------------------------------------------- reconcile */

export async function reconcileOutcome(
  ctx: ToolContext,
  target: TargetOf<"reconcile"> & { sessionDate: string },
  draft: ReconcileDraft,
): Promise<DraftOutcome> {
  const outcome: DraftOutcome = { proposals: [], rejected: [], questions: [] };
  const context = await candidateContext(ctx, target.material, target.sessionDate);
  const prepared = await prepareCandidate(ctx, target.candidate, 0, context);
  if (isRejection(prepared)) {
    outcome.rejected.push(prepared);
    return outcome;
  }
  outcome.questions.push(...prepared.ambiguous.map(ambiguousQuestion));
  const group = prepared.occasion ? eventGroup(prepared.occasion) : sessionGroup(ctx, target.material, target.sessionDate, "reconcile");
  const c = prepared.candidate;

  if (draft.verb === "add") {
    const duplicate = await duplicateOf(ctx, prepared, 0);
    if (duplicate) outcome.rejected.push(duplicate);
    else outcome.proposals.push(addProposal("reconcile", prepared, target.sessionDate, group));
    return outcome;
  }

  if (draft.target === null) {
    outcome.rejected.push(reject(0, "no-target", `${draft.verb} names the neighbour it acts on by its call number.`));
    return outcome;
  }
  if (c.kind === "procedure") {
    outcome.rejected.push(
      reject(0, "procedure-verb", "A drafted procedure is only ever added, through memory.promote_procedure."),
    );
    return outcome;
  }

  let memory;
  try {
    memory = await resolveVerdictTarget(
      ctx.db,
      { verb: draft.verb, target: draft.target },
      { scope: c.scope, scopeRef: prepared.scopeRef },
    );
  } catch (error) {
    if (error instanceof DomainError) {
      outcome.rejected.push(reject(0, "target", error.message, { call: draft.target }));
      return outcome;
    }
    throw error;
  }
  if (!memory) return outcome;
  if (memory.kind === "procedure") {
    outcome.rejected.push(
      reject(0, "procedure-target", `${memory.callNumber} is a procedure. A draft never changes a procedure.`),
    );
    return outcome;
  }

  // Each payload is exactly the input the named tool takes. The source and
  // the quote ride in the draft envelope, which decide reads to commit the
  // memory citing the material, in the same commit.
  const draftKey = envelope("reconcile", prepared, target.sessionDate);
  const call = memory.callNumber;
  switch (draft.verb) {
    case "refine":
      outcome.proposals.push({
        tool: "memory.update",
        memoryId: memory.id,
        payload: {
          call,
          title: c.title,
          body: c.body,
          ...(c.why ? { why: c.why } : {}),
          ...(c.howToApply ? { howToApply: c.howToApply } : {}),
          explicitAsk: prepared.explicitAsk,
          [DRAFT_KEY]: draftKey,
        },
        summary: `Refine ${call}: ${c.title}. ${draft.reason}`,
        group,
      });
      break;
    case "supersede": {
      const { scope: _scope, scopeRef: _scopeRef, ...fields } = memoryFields(prepared);
      outcome.proposals.push({
        tool: "memory.supersede",
        memoryId: memory.id,
        payload: { call, ...fields, said: c.quote, [DRAFT_KEY]: draftKey },
        summary: `Supersede ${call} with: ${c.title}. ${draft.reason}`,
        group,
      });
      break;
    }
    case "duplicate":
      outcome.proposals.push({
        tool: "memory.add_source",
        memoryId: memory.id,
        payload: { call, source: prepared.source, quote: c.quote, [DRAFT_KEY]: draftKey },
        summary: `Already held as ${call}: add this as a source. ${draft.reason}`,
        group,
      });
      break;
  }
  return outcome;
}

/* ------------------------------------------------------------- consolidate */

export async function consolidateOutcome(
  ctx: ToolContext,
  target: TargetOf<"consolidate"> & { calls: string[] },
  draft: ConsolidateDraft,
): Promise<DraftOutcome & { group: ProposalGroup }> {
  const stretch = await readStretch(ctx.db, target);
  const active = new Map(stretch.map((memory) => [memory.call, memory]));
  const handed = new Set(target.calls);
  const group: ProposalGroup = {
    id: `consolidation:${shortDigest(target.calls)}:${dayKey(ctx.now)}`,
    title: `Consolidation of ${target.calls.length} memories, ${dayKey(ctx.now)}`,
    meta: { job: "consolidate" },
  };
  const outcome: DraftOutcome & { group: ProposalGroup } = { proposals: [], rejected: [], questions: [], group };

  for (const [index, action] of draft.actions.entries()) {
    const calls = action.action === "merge" ? [action.survivor, action.absorbed] : action.action === "retire" ? [action.call] : [action.from, action.to];
    const outside = calls.find((call) => !handed.has(call));
    if (outside) {
      outcome.rejected.push(reject(index, "not-in-stretch", `${outside} is not in the stretch handed over.`, { call: outside }));
      continue;
    }
    const gone = calls.find((call) => !active.has(call));
    if (gone) {
      outcome.rejected.push(reject(index, "not-active", `${gone} is no longer an active entry.`, { call: gone }));
      continue;
    }
    if (new Set(calls).size !== calls.length) {
      outcome.rejected.push(reject(index, "same-memory", "An action names two different memories."));
      continue;
    }
    if (action.action !== "link" && calls.some((call) => active.get(call)?.kind === "procedure")) {
      outcome.rejected.push(
        reject(index, "procedure", "A procedure is never merged or retired by a draft. The owner does that by hand."),
      );
      continue;
    }

    const draftKey: DraftEnvelope = { job: "consolidate" };
    switch (action.action) {
      case "merge":
        outcome.proposals.push({
          tool: "memory.merge",
          memoryId: active.get(action.absorbed)?.id ?? null,
          payload: { survivor: action.survivor, absorbed: action.absorbed, [DRAFT_KEY]: draftKey },
          summary: `Merge ${action.absorbed} into ${action.survivor}. ${action.reason}`,
          group,
        });
        break;
      case "retire":
        outcome.proposals.push({
          tool: "memory.retire",
          memoryId: active.get(action.call)?.id ?? null,
          payload: { call: action.call, [DRAFT_KEY]: draftKey },
          summary: `Retire ${action.call}. ${action.reason}`,
          group,
        });
        break;
      case "link":
        outcome.proposals.push({
          tool: "memory.link",
          memoryId: active.get(action.from)?.id ?? null,
          payload: { from: action.from, to: action.to, relation: action.relation, [DRAFT_KEY]: draftKey },
          summary: `Mark ${action.from} as ${action.relation === "contradicts" ? "contradicting" : "elaborating"} ${action.to}. ${action.reason}`,
          group,
        });
        break;
    }
  }
  return outcome;
}

/* -------------------------------------------------------------------- core */

export async function coreOutcome(
  ctx: ToolContext,
  target: TargetOf<"core"> & { calls: string[] },
  draft: CoreDraft,
): Promise<DraftOutcome> {
  const handed = new Set(target.calls);
  const named = [...draft.pin, ...draft.unpin].map((choice) => choice.call);
  const rows = new Map((await readCoreCandidates(ctx.db, [...new Set([...target.calls, ...named])])).map((row) => [row.call, row]));
  const group: ProposalGroup = { id: `core:${dayKey(ctx.now)}`, title: `Core block, ${dayKey(ctx.now)}`, meta: { job: "core" } };
  const outcome: DraftOutcome = { proposals: [], rejected: [], questions: [] };
  const draftKey: DraftEnvelope = { job: "core" };
  const unpinned = new Set<string>();

  for (const [offset, choice] of draft.unpin.entries()) {
    const index = draft.pin.length + offset;
    const row = rows.get(choice.call);
    if (!row || !row.pinned) {
      outcome.rejected.push(reject(index, "not-pinned", `${choice.call} is not pinned.`, { call: choice.call }));
      continue;
    }
    unpinned.add(choice.call);
    outcome.proposals.push({
      tool: "memory.pin",
      memoryId: row.id,
      payload: { call: choice.call, pinned: false, [DRAFT_KEY]: draftKey },
      summary: `Take ${choice.call} out of the core block. ${choice.reason}`,
      group,
    });
  }

  // Guardrail 5: the core block never exceeds coreTokenCap. What is pinned
  // now and stays pinned, with the procedures, is the starting load.
  let load = await proceduresInCore(ctx.db);
  for (const row of rows.values()) {
    if (row.pinned && row.state === "active" && !unpinned.has(row.call)) load += row.tokens;
  }

  for (const [index, choice] of draft.pin.entries()) {
    const row = rows.get(choice.call);
    if (!handed.has(choice.call) || !row) {
      outcome.rejected.push(reject(index, "not-a-candidate", `${choice.call} is not among the candidates handed over.`, { call: choice.call }));
      continue;
    }
    // Guardrail 5: nothing inferred or external, and nothing from external material, ever targets the core block.
    if (!CORE_TRUST.includes(row.trust) || row.outsideSource) {
      outcome.rejected.push(
        reject(index, "core-trust", `${choice.call} is inferred or drawn from external material, and never enters the core block.`, {
          call: choice.call,
        }),
      );
      continue;
    }
    if (row.state !== "active") {
      outcome.rejected.push(reject(index, "not-active", `${choice.call} is no longer an active entry.`, { call: choice.call }));
      continue;
    }
    if (row.kind === "procedure") {
      outcome.rejected.push(reject(index, "procedure", `${choice.call} is a procedure, already in the core block.`, { call: choice.call }));
      continue;
    }
    if (row.pinned) {
      outcome.rejected.push(reject(index, "already-pinned", `${choice.call} is already pinned.`, { call: choice.call }));
      continue;
    }
    if (load + row.tokens > ctx.config.coreTokenCap) {
      outcome.rejected.push(
        reject(index, "over-cap", `${choice.call} would take the core block past its cap of ${ctx.config.coreTokenCap} tokens.`, {
          call: choice.call,
          tokens: row.tokens,
          load,
        }),
      );
      continue;
    }
    load += row.tokens;
    outcome.proposals.push({
      tool: "memory.pin",
      memoryId: row.id,
      payload: { call: choice.call, pinned: true, [DRAFT_KEY]: draftKey },
      summary: `Pin ${choice.call} into the core block. ${choice.reason}`,
      group,
    });
  }

  // The owner line: a proposal for memory.pin { ownerLine }, which lands it in
  // the host's settings values when the owner confirms it with decide.
  if (draft.ownerLine) {
    const index = draft.pin.length + draft.unpin.length;
    const text = draft.ownerLine.text;
    const findings = runDiscipline({ kind: "fact", title: "", body: text, sourceTrust: "inferred", explicitAsk: true }).findings;
    if (!ctx.ports.settings.values) {
      outcome.rejected.push(reject(index, "unavailable", "This host keeps no settings values, so the owner line cannot be set here."));
    } else if (/[\r\n]/.test(text)) {
      outcome.rejected.push(reject(index, "not-one-line", "The owner line is one line."));
    } else if (findings.length > 0) {
      outcome.rejected.push(
        reject(index, "discipline", `The owner line was refused. ${findings.map((finding) => finding.reason).join(" ")}`, {
          findings: shownFindings(findings),
        }),
      );
    } else if (text === (await readOwnerLine(ctx.ports))) {
      outcome.rejected.push(reject(index, "unchanged", "The owner line already reads that way."));
    } else {
      outcome.proposals.push({
        tool: "memory.pin",
        memoryId: null,
        payload: { ownerLine: text, [DRAFT_KEY]: draftKey },
        summary: `Word the core block's owner line as: ${text} ${draft.ownerLine.reason}`,
        group,
      });
    }
  }
  return outcome;
}

