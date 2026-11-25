// memory.pin. docs/SPEC.md section 15, "Write, 13" table, row `memory.pin`
// (starting reading); section 14, "The core block" (pinned slot; only stated
// and confirmed; pinning past the cap is refused until something is
// unpinned); section 17, `coreTokenCap`; gate "Core is clean"; guardrails 5
// and 9.

import { z } from "zod";

import type { Memory } from "../../../generated/prisma/index.js";
import { pinMemory } from "../../domain/memories.js";
import { buildCoreBlock, CORE_TRUST, type CoreMemory } from "../../domain/recall/core-block.js";
import type { Db } from "../../domain/db.js";
import type { MemoryKind, TrustTier } from "../../schemas/enums.js";
import { defineTool, ToolError, type ToolContext } from "../registry.js";
import { enforceDiscipline } from "../shared/discipline.js";
import { OWNER_LINE_KEY, OWNER_LINE_MAX_LENGTH, readOwnerLine } from "../shared/host-values.js";
import { callSchema } from "../shared/inputs.js";
import { memoryView, type MemoryView } from "../shared/views.js";
import { loadByCall, mutation } from "../shared/write-common.js";

function toCore(row: Memory, pinned: boolean): CoreMemory {
  return {
    call: row.callNumber,
    kind: row.kind as MemoryKind,
    title: row.title,
    body: row.body,
    why: row.why,
    howToApply: row.howToApply,
    trust: row.trust as TrustTier,
    pinned,
  };
}

export interface CoreFit {
  fits: boolean;
  /** Tokens the procedures and pinned slots take with the candidate in, owner line excluded. */
  tokens: number;
  cap: number;
  /** Call numbers the cap would cut from the procedures or pinned slot. */
  wouldDrop: string[];
}

/**
 * Whether the core block still holds every procedure and every pinned memory
 * with one more pinned. Built with the pure core block builder from the
 * memories that can enter it (active, stated or confirmed), the candidate
 * pinned, and the lower slots empty: overflow cuts from the bottom slot up,
 * so the project, library and status slots give way before a pinned memory
 * does, and only the slots above them decide the fit. The owner line, when
 * one is set, sits above them all and counts. With no candidate it answers
 * whether what is pinned now still fits, for a new owner line. Starting value.
 */
export async function coreFitWithPin(
  db: Db,
  candidate: Memory | null,
  tokenCap: number,
  ownerLine: string | null = null,
): Promise<CoreFit> {
  const rows = await db.memory.findMany({
    where: {
      state: "active",
      trust: { in: [...CORE_TRUST] },
      OR: [{ kind: "procedure" }, { pinned: true }, ...(candidate ? [{ id: candidate.id }] : [])],
    },
    orderBy: { callNumber: "asc" },
  });
  const pinnedOf = (row: Memory) => row.pinned || row.id === candidate?.id;
  const block = buildCoreBlock({
    ownerLine,
    procedures: rows.filter((row) => row.kind === "procedure").map((row) => toCore(row, pinnedOf(row))),
    pinned: rows.filter((row) => row.kind !== "procedure" && pinnedOf(row)).map((row) => toCore(row, true)),
    project: null,
    library: { sections: [], tags: [] },
    status: { proposalsWaiting: 0, consolidationDue: false },
    tokenCap,
  });
  const wouldDrop = block.dropped
    .filter((item) => item.slot === "procedures" || item.slot === "pinned")
    .map((item) => item.ref);
  return { fits: wouldDrop.length === 0, tokens: block.tokens, cap: tokenCap, wouldDrop };
}

/** memory.pin with `ownerLine`: the owner line as it now stands. */
export interface OwnerLineResult {
  ownerLine: string | null;
  /** False when it already read that way: nothing was written. */
  changed: boolean;
}

export interface PinToolResult {
  memory: MemoryView;
  /** False when it was already set that way: nothing was written. */
  changed: boolean;
  /** Whether this memory is eligible for the core block: pinned, active, stated or confirmed. */
  entersCore: boolean;
  /** Says why a pinned memory stays out of the core, when it does. */
  notice: string | null;
}

export const tool = defineTool({
  name: "memory.pin",
  title: "Pin",
  kind: "write",
  summary:
    "Sets or clears pinned. A pinned stated or confirmed memory goes in the core block; pinning one that would push the block past coreTokenCap is refused until something is unpinned. An inferred or external memory may be pinned but never enters the core, and the answer says so. Unpinning always works. With ownerLine instead of call, sets the one line the core block opens with (null clears it); it is kept in the host's settings, not the library.",
  input: z.object({
    /** The memory to pin or unpin. Give this or ownerLine, not both. */
    call: callSchema.optional(),
    /** True to pin, false to unpin. */
    pinned: z.boolean().default(true),
    /**
     * The owner line: who the owner is, in one line, the first slot of the
     * core block. Null clears it. Give this or call, not both.
     */
    ownerLine: z.string().trim().min(1).max(OWNER_LINE_MAX_LENGTH).nullable().optional(),
  }),
  async handler(ctx, input): Promise<PinToolResult | OwnerLineResult> {
    if (input.ownerLine !== undefined) {
      if (input.call !== undefined) {
        throw new ToolError("invalid_input", "Give call to pin a memory, or ownerLine to word the core block's first line, not both.");
      }
      return setOwnerLine(ctx, input.ownerLine);
    }
    if (input.call === undefined) {
      throw new ToolError("invalid_input", "Give call to pin or unpin a memory, or ownerLine to word the core block's first line.");
    }
    const { row } = await loadByCall(ctx, input.call);
    const trusted = CORE_TRUST.includes(row.trust as TrustTier);

    if (input.pinned && !row.pinned) {
      if (row.state !== "active") {
        throw new ToolError("refused", `${row.callNumber} is ${row.state}; only an active entry is pinned.`);
      }
      if (trusted) {
        const fit = await coreFitWithPin(ctx.db, row, ctx.config.coreTokenCap, await readOwnerLine(ctx.ports));
        if (!fit.fits) {
          throw new ToolError(
            "refused",
            `Pinning ${row.callNumber} would push the core block past its cap of ${fit.cap} tokens, cutting ${fit.wouldDrop.join(", ")}. Unpin something first.`,
            { call: row.callNumber, cap: fit.cap, wouldDrop: fit.wouldDrop },
          );
        }
      }
    }

    const updated = await pinMemory(ctx.db, { id: row.id }, input.pinned, mutation(ctx));
    const entersCore = updated.pinned && updated.state === "active" && trusted;
    const notice =
      updated.pinned && !trusted
        ? `${updated.callNumber} is pinned, but it is ${updated.trust}, and nothing inferred or external enters the core block.`
        : null;

    return {
      memory: await memoryView(ctx, row.id),
      changed: updated.pinned !== row.pinned,
      entersCore,
      notice,
    };
  },
  auditIds: (input, result) =>
    result && "memory" in result
      ? { memoryIds: [result.memory.id], calls: [result.memory.call] }
      : { calls: input.call ? [input.call] : [] },
});

/**
 * The owner line lands in the host's settings values under core.ownerLine
 * (tools/shared/host-values.ts), never in the silo: it is host level
 * configuration of how the core block opens. The same discipline as any
 * write runs on it, because the core block is always in context. A line that
 * would push a procedure or a pinned memory out of the block is refused.
 */
async function setOwnerLine(ctx: ToolContext, line: string | null): Promise<OwnerLineResult> {
  const values = ctx.ports.settings.values;
  if (!values) {
    throw new ToolError(
      "unavailable",
      "This host keeps no settings values (the settings port has no values), so the owner line cannot be set here. The core block opens without one.",
      { values: false },
    );
  }
  const current = await readOwnerLine(ctx.ports);
  if (line === current) return { ownerLine: current, changed: false };

  if (line !== null) {
    if (/[\r\n]/.test(line)) throw new ToolError("invalid_input", "The owner line is one line.");
    enforceDiscipline({ kind: "fact", title: "", body: line, sourceTrust: "stated", explicitAsk: true });
    const fit = await coreFitWithPin(ctx.db, null, ctx.config.coreTokenCap, line);
    if (!fit.fits) {
      throw new ToolError(
        "refused",
        `That owner line would push the core block past its cap of ${fit.cap} tokens, cutting ${fit.wouldDrop.join(", ")}. Shorten it or unpin something first.`,
        { cap: fit.cap, wouldDrop: fit.wouldDrop },
      );
    }
  }
  await values.set(OWNER_LINE_KEY, line);
  return { ownerLine: line, changed: true };
}
