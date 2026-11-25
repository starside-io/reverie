import { z } from "zod";

import type { Prisma } from "../../../generated/prisma/index.js";
import type { ModuleConfig } from "../../config/index.js";
import { dayKey } from "../../schemas/common.js";
import type { MemoryKind, MemoryScope, TrustTier } from "../../schemas/enums.js";
import { estimateTokens } from "../recall/budget.js";
import { CORE_TRUST } from "../recall/core-block.js";
import { DAY_MS } from "../recall/score.js";
import { resolveShelf } from "../catalogue/shelving.js";
import { normaliseTag, tagVocabulary } from "../catalogue/tags.js";
import type { Db } from "../db.js";
import { DomainError } from "../errors.js";
import { bodySimilarity, findNeighbours, NEIGHBOUR_LIMIT } from "../reconcile.js";
import { materialSchema, materialTrust, type Material } from "./gates.js";
import {
  CONSOLIDATE_RULES,
  consolidatePrompt,
  CORE_RULES,
  corePrompt,
  DISCIPLINE_RULES,
  EXTRACT_RULES,
  extractPrompt,
  RECONCILE_RULES,
  reconcilePrompt,
} from "./prompts.js";
import {
  draftCallSchema,
  draftDateSchema,
  draftShelfSchema,
  extractCandidateSchema,
  jsonSchemaFor,
  type DraftJob,
} from "./schemas.js";

/**
 * Drafting without a model. docs/SPEC.md section 15, "Drafting, 2"; section
 * 13, steps 2 to 5.
 *
 * The module never calls one. Whatever model drives it asks for the context,
 * does the thinking, and hands the answer back to memory.propose_draft. The
 * module supplies the material, the rules and the schema on the way out and
 * enforces them on the way in, so every model meets the same gates. As
 * Fellowship's domain/drafting/context.ts, with Reverie's four jobs.
 *
 * Reads only. Nothing here writes to the silo or the review queue.
 */

/** Starting value: how many memories one consolidate stretch hands over by default. */
export const CONSOLIDATE_DEFAULT_LIMIT = 50;
/** Starting value: the most one stretch may hold. */
export const CONSOLIDATE_MAX_LIMIT = 200;
/** Starting value: at or above this body similarity two memories in a stretch are hinted as duplicates. */
export const CONSOLIDATE_DUPLICATE_HINT = 0.6;
/** Starting value: how many core candidates are handed over at most. */
export const CORE_CANDIDATES_MAX = 200;

/**
 * What draft_context is asked for, and what propose_draft is handed back.
 * draft_context returns it pinned (the session date filled, the stretch or
 * the candidates listed by call number) and propose_draft takes it back as it
 * was given: that is the binding between a proposal and the context it was
 * drafted from.
 */
export const draftTargetSchema = z.discriminatedUnion("job", [
  z
    .object({
      job: z.literal("extract"),
      material: materialSchema,
      /** The day the material is from, for resolving relative dates. Defaults to today. */
      sessionDate: draftDateSchema.optional(),
    })
    .strict(),
  z
    .object({
      job: z.literal("reconcile"),
      /** The material the candidate was drafted from, so its quote is checked against it. */
      material: materialSchema,
      sessionDate: draftDateSchema.optional(),
      candidate: extractCandidateSchema,
    })
    .strict(),
  z
    .object({
      job: z.literal("consolidate"),
      shelf: draftShelfSchema.optional(),
      from: draftDateSchema.optional(),
      to: draftDateSchema.optional(),
      limit: z.number().int().min(1).max(CONSOLIDATE_MAX_LIMIT).optional(),
      /** The stretch, by call number. draft_context fills it; pass it back as given. */
      calls: z.array(draftCallSchema).max(CONSOLIDATE_MAX_LIMIT).optional(),
    })
    .strict(),
  z
    .object({
      job: z.literal("core"),
      /** The candidates, by call number. draft_context fills it; pass it back as given. */
      calls: z.array(draftCallSchema).max(CORE_CANDIDATES_MAX).optional(),
    })
    .strict(),
]);

export type DraftTarget = z.infer<typeof draftTargetSchema>;
export type DraftTargetInput = z.input<typeof draftTargetSchema>;
export type TargetOf<J extends DraftJob> = Extract<DraftTarget, { job: J }>;

export interface DraftContext {
  job: DraftJob;
  /** How the model should behave. */
  system: string;
  /** The material as text a model reads. */
  prompt: string;
  /** The rules in words: the job's own, then discipline. */
  rules: string[];
  /** The JSON schema the answer must fit. Pass it as constrained decoding where the model supports it. */
  schema: Record<string, unknown>;
  /** The material as data, for a caller that renders it itself. */
  material: Record<string, unknown>;
  /** How much was handed over. */
  counts: Record<string, number>;
  /**
   * The trust of the material: `external` when any of it came from a page, a
   * file or a tool result, so it stays external all the way to review. Null
   * for a job that reads only the library.
   */
  sourceTrust: TrustTier | null;
  /** The exact target to hand back to memory.propose_draft. */
  target: DraftTarget;
}

export interface DraftContextOptions {
  now: Date;
  /** The scopeRef a scoped reconcile candidate is reconciled within, filled from the session. */
  scopeRef?: string | null;
  /** The owner line as the host holds it, for the core job. Null when none is set. */
  ownerLine?: string | null;
}

export async function buildDraftContext(
  db: Db,
  config: ModuleConfig,
  target: DraftTarget,
  options: DraftContextOptions,
): Promise<DraftContext> {
  switch (target.job) {
    case "extract":
      return extractContext(db, target, options.now);
    case "reconcile":
      return reconcileContext(db, target, options);
    case "consolidate":
      return consolidateContext(db, config, target, options.now);
    case "core":
      return coreContext(db, config, target, options.ownerLine ?? null);
  }
}

/** The material as the prompt shows it: each turn labelled by who said it. */
export function renderMaterial(material: Material): string {
  if (material.kind === "file") return `[file ${material.name}, ${material.trust}]\n${material.text}`;
  return material.turns.map((turn, index) => `[${index + 1} ${turn.role}] ${turn.text}`).join("\n");
}

/** Every shelf with its path and description, in library order. */
export async function shelfList(db: Db): Promise<Array<{ path: string; name: string; description: string }>> {
  const sections = await db.section.findMany({
    orderBy: { order: "asc" },
    include: { shelves: { orderBy: { order: "asc" } } },
  });
  return sections.flatMap((section) =>
    section.shelves.map((shelf) => ({
      path: `${section.code}/${shelf.code}`,
      name: `${section.name}, ${shelf.name}`,
      description: shelf.description,
    })),
  );
}

async function extractContext(db: Db, target: TargetOf<"extract">, now: Date): Promise<DraftContext> {
  const sessionDate = target.sessionDate ?? dayKey(now);
  const [shelves, vocabulary] = await Promise.all([shelfList(db), tagVocabulary(db)]);
  const tags = vocabulary.map((tag) => ({ slug: tag.slug, count: tag.count }));
  const pinned: TargetOf<"extract"> = { ...target, sessionDate };
  const characters =
    target.material.kind === "file"
      ? target.material.text.length
      : target.material.turns.reduce((sum, turn) => sum + turn.text.length, 0);

  return {
    job: "extract",
    ...extractPrompt({ sessionDate, shelves, tags, materialText: renderMaterial(target.material) }),
    rules: [...EXTRACT_RULES, ...DISCIPLINE_RULES],
    schema: jsonSchemaFor("extract"),
    material: {
      sessionDate,
      ...(target.material.kind === "file"
        ? { file: { name: target.material.name, text: target.material.text, trust: target.material.trust } }
        : { turns: target.material.turns }),
      shelves,
      tags,
    },
    counts: {
      turns: target.material.kind === "turns" ? target.material.turns.length : 0,
      characters,
      shelves: shelves.length,
      tags: tags.length,
    },
    sourceTrust: materialTrust(target.material),
    target: pinned,
  };
}

/** The tags a candidate names, as slugs. A tag that does not normalise is left out here; the gate reports it. */
export function candidateSlugs(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    try {
      const slug = normaliseTag(tag);
      if (!out.includes(slug)) out.push(slug);
    } catch {
      // Reported by the propose gate.
    }
  }
  return out;
}

async function reconcileContext(
  db: Db,
  target: TargetOf<"reconcile">,
  options: DraftContextOptions,
): Promise<DraftContext> {
  const sessionDate = target.sessionDate ?? dayKey(options.now);
  const candidate = target.candidate;
  const scoped = candidate.scope !== "global" && options.scopeRef;
  const neighbours = await findNeighbours(
    db,
    {
      title: candidate.title,
      body: candidate.body,
      kind: candidate.kind,
      tags: candidateSlugs(candidate.tags),
      ...(candidate.shelf ? { shelf: candidate.shelf } : {}),
      ...(scoped ? { scope: candidate.scope, scopeRef: options.scopeRef ?? null } : { scope: "global" }),
    },
    { limit: NEIGHBOUR_LIMIT },
  ).catch((error: unknown) => {
    // A candidate naming a shelf that does not exist still gets its neighbours, from anywhere.
    if (error instanceof DomainError && error.code === "not_found") {
      return findNeighbours(db, { title: candidate.title, body: candidate.body, kind: candidate.kind });
    }
    throw error;
  });

  const shown = neighbours.map((neighbour) => ({
    call: neighbour.callNumber,
    kind: neighbour.kind,
    shelf: neighbour.shelf,
    occurredOn: neighbour.occurredOn,
    title: neighbour.title,
    body: neighbour.body,
    tags: neighbour.tags,
    trust: neighbour.trust,
    similarity: Math.round(neighbour.similarity * 1000) / 1000,
  }));

  return {
    job: "reconcile",
    ...reconcilePrompt({
      candidate: {
        kind: candidate.kind,
        title: candidate.title,
        body: candidate.body,
        shelf: candidate.shelf,
        occurredOn: candidate.occurredOn,
      },
      neighbours: shown,
    }),
    rules: [...RECONCILE_RULES, ...DISCIPLINE_RULES],
    schema: jsonSchemaFor("reconcile"),
    material: { sessionDate, candidate, neighbours: shown },
    counts: { neighbours: shown.length },
    sourceTrust: materialTrust(target.material),
    target: { ...target, sessionDate },
  };
}

export interface StretchMemory {
  id: string;
  call: string;
  kind: MemoryKind;
  title: string;
  body: string;
  trust: TrustTier;
  tags: string[];
  occurredOn: string;
  lastConfirmedOn: string;
}

/** The stretch a consolidate target names: active memories in call number order. */
export async function readStretch(
  db: Db,
  target: TargetOf<"consolidate">,
): Promise<StretchMemory[]> {
  const where: Prisma.MemoryWhereInput = { state: "active" };
  if (target.calls) {
    where.callNumber = { in: target.calls };
  } else {
    if (target.shelf) where.shelfId = (await resolveShelf(db, target.shelf)).id;
    if (target.from || target.to) {
      where.occurredOn = {
        ...(target.from ? { gte: new Date(`${target.from}T00:00:00.000Z`) } : {}),
        ...(target.to ? { lte: new Date(`${target.to}T00:00:00.000Z`) } : {}),
      };
    }
  }
  const rows = await db.memory.findMany({
    where,
    orderBy: { callNumber: "asc" },
    take: target.calls ? CONSOLIDATE_MAX_LIMIT : (target.limit ?? CONSOLIDATE_DEFAULT_LIMIT),
    include: { tags: { include: { tag: { select: { slug: true } } } } },
  });
  return rows.map((row) => ({
    id: row.id,
    call: row.callNumber,
    kind: row.kind as MemoryKind,
    title: row.title,
    body: row.body,
    trust: row.trust as TrustTier,
    tags: row.tags.map((entry) => entry.tag.slug).sort(),
    occurredOn: dayKey(row.occurredOn),
    lastConfirmedOn: dayKey(row.lastConfirmedAt),
  }));
}

async function consolidateContext(
  db: Db,
  config: ModuleConfig,
  target: TargetOf<"consolidate">,
  now: Date,
): Promise<DraftContext> {
  const memories = await readStretch(db, target);
  const ids = memories.map((memory) => memory.id);
  const byId = new Map(memories.map((memory) => [memory.id, memory.call]));

  const duplicates: Array<{ a: string; b: string; similarity: number }> = [];
  for (let i = 0; i < memories.length; i += 1) {
    for (let j = i + 1; j < memories.length; j += 1) {
      const a = memories[i] as StretchMemory;
      const b = memories[j] as StretchMemory;
      const similarity = bodySimilarity(a.body, b.body);
      if (similarity >= CONSOLIDATE_DUPLICATE_HINT) {
        duplicates.push({ a: a.call, b: b.call, similarity: Math.round(similarity * 1000) / 1000 });
      }
    }
  }

  const links =
    ids.length === 0
      ? []
      : await db.memoryLink.findMany({
          where: { relation: "contradicts", fromId: { in: ids }, toId: { in: ids } },
          select: { fromId: true, toId: true },
        });
  const contradictions = links.map((link) => ({ from: byId.get(link.fromId) ?? "", to: byId.get(link.toId) ?? "" }));

  const staleBefore = now.getTime() - config.staleAfterDays * DAY_MS;
  const stale = memories
    .filter((memory) => new Date(`${memory.lastConfirmedOn}T00:00:00.000Z`).getTime() < staleBefore)
    .map((memory) => memory.call);

  const shown = memories.map(({ id: _id, ...memory }) => memory);
  const hints = { duplicates, contradictions, stale };
  return {
    job: "consolidate",
    ...consolidatePrompt({ memories: shown, hints }),
    rules: [...CONSOLIDATE_RULES],
    schema: jsonSchemaFor("consolidate"),
    material: { memories: shown, hints },
    counts: {
      memories: memories.length,
      duplicates: duplicates.length,
      contradictions: contradictions.length,
      stale: stale.length,
    },
    sourceTrust: null,
    target: {
      job: "consolidate",
      ...(target.shelf ? { shelf: target.shelf } : {}),
      ...(target.from ? { from: target.from } : {}),
      ...(target.to ? { to: target.to } : {}),
      ...(target.limit ? { limit: target.limit } : {}),
      calls: memories.map((memory) => memory.call),
    },
  };
}

/** What one memory costs in the core block, rendered as the pinned slot renders it. */
export function coreTokens(memory: { call: string; kind: string; title: string; body: string }): number {
  return estimateTokens(`[${memory.call}] (${memory.kind}) ${memory.title}\n${memory.body}`);
}

/** What one procedure costs in the core block, why and how to apply included. */
export function procedureTokens(memory: {
  call: string;
  title: string;
  body: string;
  why: string | null;
  howToApply: string | null;
}): number {
  const lines = [`[${memory.call}] ${memory.title}`, memory.body];
  if (memory.why) lines.push(`Why: ${memory.why}`);
  if (memory.howToApply) lines.push(`How to apply: ${memory.howToApply}`);
  return estimateTokens(lines.join("\n"));
}

export interface CoreCandidate {
  id: string;
  call: string;
  kind: MemoryKind;
  scope: MemoryScope;
  state: string;
  title: string;
  body: string;
  trust: TrustTier;
  pinned: boolean;
  tokens: number;
  /** True when any source behind it is external or inferred. Such a memory never enters the core block. */
  outsideSource: boolean;
}

/**
 * The memories that may enter the core block: active, not procedures (they
 * are in the block already), trust stated or confirmed, and every source
 * stated or confirmed too. Nothing from external material, and nothing
 * inferred. With `calls`, those memories as they stand now, eligible or not,
 * so the gate can say why one is refused.
 */
export async function readCoreCandidates(db: Db, calls?: readonly string[]): Promise<CoreCandidate[]> {
  const rows = await db.memory.findMany({
    where: calls
      ? { callNumber: { in: [...calls] } }
      : { state: "active", kind: { not: "procedure" }, trust: { in: [...CORE_TRUST] } },
    orderBy: { callNumber: "asc" },
    take: CORE_CANDIDATES_MAX,
    include: { sources: { include: { source: { select: { trust: true } } } } },
  });
  const out: CoreCandidate[] = rows.map((row) => ({
    id: row.id,
    call: row.callNumber,
    kind: row.kind as MemoryKind,
    scope: row.scope as MemoryScope,
    state: row.state,
    title: row.title,
    body: row.body,
    trust: row.trust as TrustTier,
    pinned: row.pinned,
    tokens: coreTokens({ call: row.callNumber, kind: row.kind, title: row.title, body: row.body }),
    outsideSource: row.sources.some((entry) => !CORE_TRUST.includes(entry.source.trust as TrustTier)),
  }));
  return calls ? out : out.filter((row) => !row.outsideSource);
}

/** The tokens the procedures already in the core block take: every active, trusted procedure. */
export async function proceduresInCore(db: Db): Promise<number> {
  const rows = await db.memory.findMany({
    where: { state: "active", kind: "procedure", trust: { in: [...CORE_TRUST] } },
    select: { callNumber: true, title: true, body: true, why: true, howToApply: true },
  });
  return rows.reduce(
    (sum, row) =>
      sum +
      procedureTokens({ call: row.callNumber, title: row.title, body: row.body, why: row.why, howToApply: row.howToApply }),
    0,
  );
}

async function coreContext(
  db: Db,
  config: ModuleConfig,
  target: TargetOf<"core">,
  ownerLine: string | null,
): Promise<DraftContext> {
  const [candidates, proceduresTokens] = await Promise.all([readCoreCandidates(db), proceduresInCore(db)]);
  const shown = candidates.map((candidate) => ({
    call: candidate.call,
    kind: candidate.kind,
    title: candidate.title,
    body: candidate.body,
    trust: candidate.trust,
    pinned: candidate.pinned,
    tokens: candidate.tokens,
  }));
  void target;
  return {
    job: "core",
    ...corePrompt({ ownerLine, tokenCap: config.coreTokenCap, proceduresTokens, candidates: shown }),
    rules: [...CORE_RULES],
    schema: jsonSchemaFor("core"),
    material: { ownerLine, tokenCap: config.coreTokenCap, proceduresTokens, candidates: shown },
    counts: { candidates: shown.length, pinned: shown.filter((candidate) => candidate.pinned).length },
    sourceTrust: null,
    target: { job: "core", calls: shown.map((candidate) => candidate.call) },
  };
}
