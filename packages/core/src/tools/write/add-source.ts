// memory.add_source. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.add_source`; section 11, `Source` and `MemorySource` (the raw
// transcript is not copied in; quote capped at 500 characters); section 13,
// "The four reconcile verbs" (duplicate: the existing memory gains the
// source); section 7 (the secret scan); guardrails 2 and 9.

import { z } from "zod";

import { checkSecrets } from "../../domain/discipline.js";
import { atomic } from "../../domain/db.js";
import { addSource, touchMemory } from "../../domain/memories.js";
import type { MemoryKind } from "../../schemas/enums.js";
import { idSchema } from "../../schemas/common.js";
import { quoteSchema, sourceCreateSchema, type MemorySourceInput } from "../../schemas/source.js";
import { defineTool, ToolError, type ToolContext } from "../registry.js";
import type { DraftedProvenance } from "../shared/confirm-drafted.js";
import { refuseFindings } from "../shared/discipline.js";
import { callSchema } from "../shared/inputs.js";
import { statedSource } from "../shared/session.js";
import { memoryView, type MemoryView } from "../shared/views.js";
import { loadByCall, mutation, refuseSuperseded } from "../shared/write-common.js";

export const addSourceInputSchema = z.object({
  /** Current or old number. */
  call: callSchema,
  /** What the source says, at most 500 characters. Never the transcript. */
  quote: quoteSchema,
  /** A new source: where it was read or said. */
  source: sourceCreateSchema.optional(),
  /** Or a source already in the silo, by id. */
  sourceId: idSchema.optional(),
});

export type AddSourceInput = z.input<typeof addSourceInputSchema>;
export type ParsedAddSourceInput = z.output<typeof addSourceInputSchema>;

export interface AddSourceToolResult {
  memory: MemoryView;
  sourceId: string;
  /** False when the memory already cited this source: the first quote stands and nothing was written. */
  added: boolean;
  /** True when a new Source row was made. */
  sourceCreated: boolean;
}

export const tool = defineTool({
  name: "memory.add_source",
  title: "Add a source",
  kind: "write",
  summary:
    "Cites one more source on an existing memory, with a quote of at most 500 characters: a new source (kind, label, optional uri, occurredAt, trust), one already in the silo by sourceId, or, with neither, the owner's words in this session. The quote is scanned for secrets. Citing a source the memory already cites writes nothing.",
  input: addSourceInputSchema,
  handler: (ctx, input) => commitAddSource(ctx, input),
  auditIds: (input, result) =>
    result ? { memoryIds: [result.memory.id], calls: [result.memory.call] } : { calls: [input.call] },
});

/**
 * The commit behind memory.add_source, shared with memory.decide. Only decide
 * passes `drafted`, for a reconcile `duplicate` confirmed in review: then, in
 * the same transaction, the memory's lastConfirmedAt moves too, which is how
 * repetition strengthens a memory without multiplying it (section 13). No
 * tool input reaches `drafted`.
 */
export async function commitAddSource(
  ctx: ToolContext,
  input: ParsedAddSourceInput,
  drafted?: DraftedProvenance,
): Promise<AddSourceToolResult> {
  if (input.source && input.sourceId) {
    throw new ToolError("invalid_input", "Give a new source or a sourceId, not both.");
  }
  const { row } = await loadByCall(ctx, input.call);
  await refuseSuperseded(ctx, row, "given new sources");

  const entry: MemorySourceInput = input.sourceId
    ? { sourceId: input.sourceId, quote: input.quote }
    : input.source
      ? { source: input.source, quote: input.quote }
      : statedSource(ctx, input.quote);

  const trust = input.source?.trust ?? (input.sourceId ? "external" : "stated");
  refuseFindings(
    checkSecrets({ kind: row.kind as MemoryKind, title: "", body: input.quote, sourceTrust: trust }).findings,
  );

  const result = await atomic(ctx.db, async (tx) => {
    const added = await addSource(tx, { id: row.id }, entry, mutation(ctx));
    if (drafted) await touchMemory(tx, { id: row.id }, { at: ctx.now });
    return added;
  });
  return {
    memory: await memoryView(ctx, row.id),
    sourceId: result.sourceId,
    added: result.added,
    sourceCreated: result.sourceCreated,
  };
}
