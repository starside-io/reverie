import { resolveCallNumber } from "../../domain/catalogue/call-number.js";
import type { Db } from "../../domain/db.js";
import { dayKey } from "../../schemas/common.js";
import type { MemoryKind, MemoryScope, MemoryState, SourceKind, TrustTier } from "../../schemas/enums.js";
import { ToolError, type ToolContext } from "../registry.js";
import { renderRef, type RenderedRef } from "./refs.js";

/**
 * One memory as a tool hands it back. Every tool that returns a whole memory
 * returns this shape, so a caller learns it once.
 */
export interface MemoryView {
  id: string;
  call: string;
  /** "LIF/GTH" */
  shelf: string;
  /** "2026-12-24": when it happened. */
  occurredOn: string;
  seq: number;
  kind: MemoryKind;
  scope: MemoryScope;
  scopeRef: string | null;
  title: string;
  body: string;
  why: string | null;
  howToApply: string | null;
  importance: number;
  trust: TrustTier;
  state: MemoryState;
  validFrom: string;
  validTo: string | null;
  /** The call number of the entry that replaced this one. */
  supersededBy: string | null;
  pinned: boolean;
  lastConfirmedAt: string;
  createdAt: string;
  tags: string[];
  attendees: RenderedRef[];
  occasion: RenderedRef | null;
  mentions: RenderedRef[];
  sources: Array<{
    sourceId: string;
    kind: SourceKind;
    label: string;
    uri: string | null;
    trust: TrustTier;
    quote: string;
  }>;
  /** Old numbers that still resolve to this memory, in library order. */
  aliases: string[];
}

/** A memory by id, rendered. Refs go through the refs port; an absent people module renders as unavailable. */
export async function memoryView(ctx: ToolContext, memoryId: string, db: Db = ctx.db): Promise<MemoryView> {
  const row = await db.memory.findUnique({
    where: { id: memoryId },
    include: {
      shelf: { include: { section: true } },
      supersededBy: { select: { callNumber: true } },
      tags: { include: { tag: { select: { slug: true } } } },
      refs: true,
      sources: { include: { source: true } },
      aliases: { select: { oldCallNumber: true }, orderBy: { oldCallNumber: "asc" } },
    },
  });
  if (!row) throw new ToolError("not_found", `No memory with id ${memoryId}.`);

  const refs = await Promise.all(row.refs.map((ref) => renderRef(ctx, ref)));
  const byRole = (role: string) => refs.filter((ref) => ref.role === role);

  return {
    id: row.id,
    call: row.callNumber,
    shelf: `${row.shelf.section.code}/${row.shelf.code}`,
    occurredOn: dayKey(row.occurredOn),
    seq: row.seq,
    kind: row.kind as MemoryKind,
    scope: row.scope as MemoryScope,
    scopeRef: row.scopeRef,
    title: row.title,
    body: row.body,
    why: row.why,
    howToApply: row.howToApply,
    importance: row.importance,
    trust: row.trust as TrustTier,
    state: row.state as MemoryState,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo?.toISOString() ?? null,
    supersededBy: row.supersededBy?.callNumber ?? null,
    pinned: row.pinned,
    lastConfirmedAt: row.lastConfirmedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    tags: row.tags.map((entry) => entry.tag.slug).sort(),
    attendees: byRole("attendee"),
    occasion: byRole("occasion")[0] ?? null,
    mentions: byRole("mentions"),
    sources: row.sources
      .map((entry) => ({
        sourceId: entry.sourceId,
        kind: entry.source.kind as SourceKind,
        label: entry.source.label,
        uri: entry.source.uri,
        trust: entry.source.trust as TrustTier,
        quote: entry.quote,
      }))
      .sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)),
    aliases: row.aliases.map((alias) => alias.oldCallNumber),
  };
}

export interface FoundByCall {
  memoryId: string;
  /** The memory's number now. */
  call: string;
  /** `alias` when the number asked for is an old one that moved. */
  via: "current" | "alias";
  asked: string;
}

/**
 * A call number, current or alias, to the memory it names. A forgotten number
 * and an unknown one are both `not_found`, with messages that tell them apart.
 */
export async function findByCall(ctx: ToolContext, call: string, db: Db = ctx.db): Promise<FoundByCall> {
  const resolved = await resolveCallNumber(db, call);
  if (resolved.status === "current" || resolved.status === "alias") {
    return { memoryId: resolved.memoryId, call: resolved.callNumber, via: resolved.status, asked: call };
  }
  if (resolved.status === "forgotten") {
    throw new ToolError("not_found", `${call} was forgotten. Its number points at nothing and is never reissued.`, {
      call,
      forgotten: true,
    });
  }
  throw new ToolError("not_found", `No memory has the call number ${call}.`, { call, forgotten: false });
}
