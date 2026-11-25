import type { Memory } from "../../../generated/prisma/index.js";
import type { MutationOptions } from "../../domain/versions.js";
import { ToolError, type ToolContext } from "../registry.js";
import { findByCall, type FoundByCall } from "./views.js";

/**
 * Pieces the write tools share. Owned by the write tools: nothing in phase 1
 * imports this file.
 */

/** The refusal every write tool gives for a procedure (guardrail 4). */
export const PROCEDURE_REFUSAL =
  "A procedure changes how every later session behaves, so it is written or changed only through memory.promote_procedure, with the owner's yes.";

export function procedureRefusal(): ToolError {
  return new ToolError("refused", PROCEDURE_REFUSAL);
}

/** Who and when, for a domain mutation made by this call. */
export function mutation(ctx: ToolContext): MutationOptions {
  return { actor: ctx.actor, at: ctx.now };
}

export interface LoadedMemory {
  found: FoundByCall;
  row: Memory;
}

/** A call number, current or alias, to the row it names. not_found otherwise. */
export async function loadByCall(ctx: ToolContext, call: string): Promise<LoadedMemory> {
  const found = await findByCall(ctx, call);
  const row = await ctx.db.memory.findUnique({ where: { id: found.memoryId } });
  if (!row) throw new ToolError("not_found", `No memory has the call number ${call}.`, { call });
  return { found, row };
}

/** A superseded entry is history: changes go to the entry that replaced it. */
export async function refuseSuperseded(ctx: ToolContext, row: Memory, what: string): Promise<void> {
  if (row.state !== "superseded") return;
  const next = row.supersededById
    ? await ctx.db.memory.findUnique({ where: { id: row.supersededById }, select: { callNumber: true } })
    : null;
  throw new ToolError(
    "refused",
    `${row.callNumber} was superseded and is history, so it is not ${what}.${next ? ` Use ${next.callNumber}, the entry that replaced it.` : ""}`,
    { call: row.callNumber, supersededBy: next?.callNumber ?? null },
  );
}

/** What `memory.memory.written` says about how a write came in. */
export type WrittenOperation = "create" | "update" | "refine" | "supersede" | "merge";

/**
 * Which way a write came in: `direct` for the owner's own call, `review` for
 * a proposal confirmed with memory.decide, `import` for a memory a snapshot
 * import created or changed.
 */
export type WrittenDoor = "direct" | "review" | "import";

/** The door a call's actor implies. memory.import names its door itself. */
export function doorOf(ctx: ToolContext): WrittenDoor {
  return ctx.actor.startsWith("proposal:") ? "review" : "direct";
}

/**
 * Queues `memory.memory.written` (section 18: a memory commits, through either
 * door) with the one payload shape every tool uses: the memory's id and call
 * number, the door (WrittenDoor: `direct`, `review` or `import`), the
 * operation, and the kind and trust the row committed with. Ids, numbers and
 * enum values, never text.
 */
export function emitWritten(
  ctx: ToolContext,
  memory: Pick<Memory, "id" | "callNumber" | "kind" | "trust">,
  operation: WrittenOperation,
  extra: Record<string, string> = {},
  door: WrittenDoor = doorOf(ctx),
): void {
  ctx.emit("memory.memory.written", {
    memoryId: memory.id,
    call: memory.callNumber,
    door,
    operation,
    kind: memory.kind,
    trust: memory.trust,
    ...extra,
  });
}
