// memory.shelve. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.shelve`; section 5, "The call number" (it survives a move; the last
// part is order within shelf and day and can be reordered by hand; reordering
// swaps sequence numbers and writes an alias for each number that moved);
// section 18 (`memory.memory.shelved`); gate "Call numbers are stable";
// guardrails 6 and 9.

import { z } from "zod";

import { reorderDay, reshelveMemory, type ReshelveResult } from "../../domain/catalogue/shelving.js";
import { dateOnlySchema } from "../../schemas/common.js";
import { shelfRefSchema } from "../../schemas/shelf.js";
import { defineTool, ToolError, type ToolContext } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import { memoryView, type MemoryView } from "../shared/views.js";
import { loadByCall, mutation } from "../shared/write-common.js";

const moveSchema = z.object({
  action: z.literal("move"),
  /** Current or old number. */
  call: callSchema,
  /** The shelf it moves to, "LIF/GTH". Defaults to where it is. */
  shelf: shelfRefSchema.optional(),
  /** The day it moves to, when the date was wrong. Defaults to its own. */
  occurredOn: dateOnlySchema.optional(),
});

const reorderSchema = z.object({
  action: z.literal("reorder"),
  shelf: shelfRefSchema,
  occurredOn: dateOnlySchema,
  /** Every entry of that shelf and day, by call number, first to last. */
  order: z.array(callSchema).min(1).max(999),
});

export const shelveInputSchema = z.discriminatedUnion("action", [moveSchema, reorderSchema]);

export type ShelveInput = z.input<typeof shelveInputSchema>;

export interface ShelveMove {
  memoryId: string;
  from: string;
  to: string;
}

export type ShelveToolResult =
  | { action: "move"; memory: MemoryView; from: string; to: string }
  | { action: "reorder"; moved: ShelveMove[] };

function emitShelved(ctx: ToolContext, moves: readonly ReshelveResult[], via: "move" | "reorder"): void {
  for (const move of moves) {
    ctx.emit("memory.memory.shelved", { memoryId: move.memoryId, from: move.from, to: move.to, via });
  }
}

export const tool = defineTool({
  name: "memory.shelve",
  title: "Shelve",
  kind: "write",
  summary:
    "Moves a memory (action move) to another shelf, another day, or both: it gets a new call number and the old one is kept as an alias, so the old number still resolves. Reorders the entries of one shelf and day (action reorder): name every entry once, first to last; they take that day's sequence numbers in that order and each number that moved is aliased.",
  input: shelveInputSchema,
  async handler(ctx, input): Promise<ShelveToolResult> {
    if (input.action === "move") {
      if (input.shelf === undefined && input.occurredOn === undefined) {
        throw new ToolError("invalid_input", "Say where it moves: a shelf, a day, or both.");
      }
      const { row } = await loadByCall(ctx, input.call);
      const moved = await reshelveMemory(
        ctx.db,
        { id: row.id },
        {
          ...(input.shelf !== undefined ? { shelf: input.shelf } : {}),
          ...(input.occurredOn !== undefined ? { occurredOn: input.occurredOn } : {}),
        },
        mutation(ctx),
      );
      emitShelved(ctx, [moved], "move");
      return { action: "move", memory: await memoryView(ctx, row.id), from: moved.from, to: moved.to };
    }

    const moves = await reorderDay(
      ctx.db,
      { shelf: input.shelf, occurredOn: input.occurredOn, order: input.order },
      mutation(ctx),
    );
    emitShelved(ctx, moves, "reorder");
    return { action: "reorder", moved: moves.map((move) => ({ ...move })) };
  },
  auditIds: (input, result) => {
    if (!result) return { calls: input.action === "move" ? [input.call] : input.order };
    if (result.action === "move") {
      return { memoryIds: [result.memory.id], calls: [result.from, result.to] };
    }
    return {
      memoryIds: result.moved.map((move) => move.memoryId),
      calls: result.moved.flatMap((move) => [move.from, move.to]),
    };
  },
});
