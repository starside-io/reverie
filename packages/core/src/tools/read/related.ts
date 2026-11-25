// memory.related. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.related`; section 6, the paragraph on memory.related (the
// cross-reference desk: shared tags, people, occasion, with the reason).

import { z } from "zod";

import { relatedMemories } from "../../domain/catalogue/related.js";
import type { MemoryState } from "../../schemas/enums.js";
import { defineTool } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import { limitSchema } from "../shared/read-entries.js";
import { findByCall } from "../shared/views.js";

export const relatedInputSchema = z.object({
  call: callSchema,
  limit: limitSchema(20, 100),
  /** Retired entries are in the stacks: included only when asked. */
  includeRetired: z.boolean().default(false),
});

export interface RelatedItem {
  id: string;
  call: string;
  title: string;
  state: MemoryState;
  sharedTags: string[];
  /** Shared people, by the label the reference holds. */
  sharedPeople: string[];
  sharedOccasion: boolean;
  /** Tags plus people plus the occasion: what the order sorts on. */
  score: number;
  /** "2 tags, 1 person". */
  reason: string;
}

export interface RelatedResult {
  /** The memory asked about, by its number now. */
  call: string;
  memoryId: string;
  items: RelatedItem[];
}

export const tool = defineTool({
  name: "memory.related",
  title: "Related memories",
  kind: "read",
  summary:
    "Cross-reference from one memory: others sharing its tags, people or occasion, ranked by how much they share, each with the reason it matched (\"2 tags, 1 person\"). Active and superseded; retired when asked.",
  input: relatedInputSchema,
  async handler(ctx, input): Promise<RelatedResult> {
    const found = await findByCall(ctx, input.call);
    const states: MemoryState[] = input.includeRetired ? ["active", "superseded", "retired"] : ["active", "superseded"];
    const related = await relatedMemories(ctx.db, { id: found.memoryId }, { limit: input.limit, states });
    return {
      call: found.call,
      memoryId: found.memoryId,
      items: related.map((entry) => ({
        id: entry.memoryId,
        call: entry.callNumber,
        title: entry.title,
        state: entry.state as MemoryState,
        sharedTags: entry.sharedTags,
        sharedPeople: entry.sharedPeople,
        sharedOccasion: entry.sharedOccasion,
        score: entry.score,
        reason: entry.reason,
      })),
    };
  },
  auditIds: (input, result) => ({
    calls: result ? [input.call, result.call, ...result.items.map((item) => item.call)] : [input.call],
    ...(result ? { memoryIds: [result.memoryId, ...result.items.map((item) => item.id)] } : {}),
  }),
});
