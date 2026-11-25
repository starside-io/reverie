// memory.core. docs/SPEC.md section 15, "Read, 18" table, row `memory.core`;
// section 14, "The core block"; guardrail 5; section 16, gates "Core is
// clean" and "Core is stable".
//
// This file reads the silo into plain data and hands it to the pure builder
// in domain/recall/core-block.ts, which owns the layout, the trust rule, the
// cap and the byte stability. What is read here, starting readings:
//
// - Owner line: the host's settings value `core.ownerLine`, read through
//   the settings port (tools/shared/host-values.ts). It is host level
//   configuration of how the block opens, set by the owner with memory.pin
//   { ownerLine }, directly or by confirming a `core` drafting proposal.
//   Empty when none is set or the host keeps no values.
// - Procedures and pinned: active entries visible to this session's scope
//   (global, its project, agent and session). The builder drops anything
//   inferred or external.
// - Current project: the project the session resolves to; its entries are
//   the active ones on its shelf or scoped to it.
// - Library map: every section and shelf with active counts, and the tag
//   vocabulary.
// - Status: pending proposals from the review port, and whether consolidation
//   is due per consolidateEvery, from the host's settings values
//   `consolidation.lastAt` (set when the consolidate job queues proposals)
//   and `consolidation.sessionsSince` (counted on host.session.ended). The
//   status slot stays last: it is the part that changes between sessions.

import { z } from "zod";

import type { Prisma } from "../../../generated/prisma/index.js";
import { tagVocabulary } from "../../domain/catalogue/tags.js";
import { shelfCounts } from "../../domain/queries/counts.js";
import {
  buildCoreBlock,
  type CoreBlock,
  type CoreMemory,
  type CoreProject,
  type CoreSection,
} from "../../domain/recall/core-block.js";
import type { MemoryKind, TrustTier } from "../../schemas/enums.js";
import { defineTool } from "../registry.js";
import { scopeWhere, visibleScopes } from "../shared/read-scope.js";
import { consolidationDue, readConsolidation, readOwnerLine } from "../shared/host-values.js";

export interface CoreResult extends CoreBlock {
  /** coreTokenCap at the time of the call. */
  cap: number;
  /** The project slot's project, by slug. */
  project: string | null;
}

type CoreRow = {
  callNumber: string;
  kind: string;
  title: string;
  body: string;
  why: string | null;
  howToApply: string | null;
  trust: string;
  pinned: boolean;
};

const CORE_SELECT = {
  callNumber: true,
  kind: true,
  title: true,
  body: true,
  why: true,
  howToApply: true,
  trust: true,
  pinned: true,
} as const satisfies Prisma.MemorySelect;

function toCoreMemory(row: CoreRow): CoreMemory {
  return {
    call: row.callNumber,
    kind: row.kind as MemoryKind,
    title: row.title,
    body: row.body,
    why: row.why,
    howToApply: row.howToApply,
    trust: row.trust as TrustTier,
    pinned: row.pinned,
  };
}

export const tool = defineTool({
  name: "memory.core",
  title: "Core block",
  kind: "read",
  summary:
    "The core block for the current scope, within coreTokenCap: owner line, procedures, pinned, current project, library map, status. Only stated and confirmed memories. Byte-stable: the same library gives the same bytes.",
  input: z.object({}),
  async handler(ctx): Promise<CoreResult> {
    const scopes = await visibleScopes(ctx);
    const visible: Prisma.MemoryWhereInput = { AND: [{ state: "active" }, scopeWhere(scopes.pairs)] };

    const [procedures, pinned, sections, counts, tags, pending, ownerLine, consolidation] = await Promise.all([
      ctx.db.memory.findMany({
        where: { AND: [visible, { kind: "procedure" }] },
        orderBy: { callNumber: "asc" },
        select: CORE_SELECT,
      }),
      ctx.db.memory.findMany({
        where: { AND: [visible, { pinned: true }] },
        orderBy: { callNumber: "asc" },
        select: CORE_SELECT,
      }),
      ctx.db.section.findMany({ include: { shelves: true } }),
      shelfCounts(ctx.db),
      tagVocabulary(ctx.db),
      ctx.ports.review.list("pending"),
      readOwnerLine(ctx.ports),
      readConsolidation(ctx.ports),
    ]);

    let project: CoreProject | null = null;
    const current = scopes.project;
    if (current) {
      const shelf = current.shelfId
        ? await ctx.db.shelf.findUnique({ where: { id: current.shelfId }, include: { section: true } })
        : null;
      const entries = await ctx.db.memory.findMany({
        where: {
          AND: [
            visible,
            {
              OR: [
                { scope: "project", scopeRef: current.slug },
                ...(current.shelfId ? [{ shelfId: current.shelfId }] : []),
              ],
            },
          ],
        },
        orderBy: { callNumber: "asc" },
        select: { callNumber: true, title: true, trust: true, lastConfirmedAt: true },
      });
      project = {
        name: current.name,
        shelf: shelf ? `${shelf.section.code}/${shelf.code}` : "none",
        entries: entries.map((entry) => ({
          call: entry.callNumber,
          title: entry.title,
          trust: entry.trust as TrustTier,
          lastConfirmedAt: entry.lastConfirmedAt,
        })),
      };
    }

    const library: CoreSection[] = sections.map((section) => ({
      code: section.code,
      name: section.name,
      shelves: section.shelves.map((shelf) => ({
        code: shelf.code,
        name: shelf.name,
        count: counts.get(shelf.id)?.count ?? 0,
      })),
    }));

    const block = buildCoreBlock({
      ownerLine,
      procedures: procedures.map(toCoreMemory),
      pinned: pinned.map(toCoreMemory),
      project,
      library: { sections: library, tags: tags.map((tag) => ({ slug: tag.slug, count: tag.count })) },
      status: {
        proposalsWaiting: pending.length,
        consolidationDue: consolidationDue(consolidation, ctx.config.consolidateEvery, ctx.now),
      },
      tokenCap: ctx.config.coreTokenCap,
    });

    return { ...block, cap: ctx.config.coreTokenCap, project: current?.slug ?? null };
  },
  // The registry keeps only refs shaped like call numbers, so slot labels drop out.
  auditIds: (_input, result) => (result ? { calls: result.included.map((item) => item.ref) } : undefined),
});
