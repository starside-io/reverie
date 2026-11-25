// memory.sources. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.sources` (a starting reading); section 11, Source and
// MemorySource; guardrail 2 (no source, no memory).

import { z } from "zod";

import { RECALL_NOTICE } from "../../domain/recall/frame.js";
import type { SourceKind, TrustTier } from "../../schemas/enums.js";
import { defineTool } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import { findByCall } from "../shared/views.js";

export interface SourceEntry {
  sourceId: string;
  kind: SourceKind;
  label: string;
  uri: string | null;
  trust: TrustTier;
  /** When the source itself happened, when known. */
  occurredAt: string | null;
  createdAt: string;
  /** The words this memory cites from it, at most 500 characters. */
  quote: string;
  /** How many memories cite this source, this one included. */
  citedBy: number;
}

export interface SourcesResult {
  notice: typeof RECALL_NOTICE;
  memoryId: string;
  call: string;
  /** Oldest source first. */
  sources: SourceEntry[];
}

export const tool = defineTool({
  name: "memory.sources",
  title: "Sources",
  kind: "read",
  summary:
    "The sources and quotes behind one memory, oldest first: kind, label, uri, trust, when, the quote, and how many memories cite the same source.",
  input: z.object({ call: callSchema }),
  async handler(ctx, input): Promise<SourcesResult> {
    const found = await findByCall(ctx, input.call);
    const rows = await ctx.db.memorySource.findMany({
      where: { memoryId: found.memoryId },
      include: { source: { include: { _count: { select: { memories: true } } } } },
    });
    const sources = rows
      .map((row) => ({
        sourceId: row.sourceId,
        kind: row.source.kind as SourceKind,
        label: row.source.label,
        uri: row.source.uri,
        trust: row.source.trust as TrustTier,
        occurredAt: row.source.occurredAt?.toISOString() ?? null,
        createdAt: row.source.createdAt.toISOString(),
        quote: row.quote,
        citedBy: row.source._count.memories,
      }))
      .sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0,
      );
    return { notice: RECALL_NOTICE, memoryId: found.memoryId, call: found.call, sources };
  },
  auditIds: (input, result) => ({
    calls: result ? [input.call, result.call] : [input.call],
    ...(result ? { memoryIds: [result.memoryId] } : {}),
  }),
});
