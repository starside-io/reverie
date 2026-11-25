// memory.link_occasion. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.link_occasion`; section 8 ("Division of authority": who was there is
// the people module's; "Two standalone hosts": the follow up ends in
// link_occasion; "It works in both directions, and alone"); section 12 (refs
// port); gates "No invented attendees", "Follow up is optional" and "Works
// without Fellowship"; guardrails 7 and 9.

import { z } from "zod";

import { linkOccasion, OCCASION_URI_PATTERN, participantsFrom } from "../../domain/occasions.js";
import { defineTool, ToolError } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import { memoryView, type MemoryView } from "../shared/views.js";
import { loadByCall, mutation, refuseSuperseded } from "../shared/write-common.js";

export const linkOccasionInputSchema = z.object({
  /** The episode. Current or old number. */
  call: callSchema,
  /** `module://people/event/<id>`, as the people module gave it. */
  occasion: z
    .string()
    .trim()
    .regex(OCCASION_URI_PATTERN, "Expected an occasion URI such as module://people/event/<id>"),
  /** The occasion's title as the caller saw it, kept when the people module does not answer. */
  label: z.string().trim().min(1).max(200).optional(),
});

export type LinkOccasionInput = z.input<typeof linkOccasionInputSchema>;

export interface LinkOccasionToolResult {
  memory: MemoryView;
  /** False when the memory already pointed at this occasion and nothing needed syncing. */
  changed: boolean;
  /** True when the people module answered with participants and the attendees were synced from them. */
  synced: boolean;
  /** Why the attendees were left as they are, when they were. */
  notice: string | null;
  /** The occasion this memory pointed at before, when it was another one. */
  replaced: string | null;
  /** Person URIs added to or removed from the attendees by the sync. */
  added: string[];
  removed: string[];
  /** Unresolved names that matched a participant and now carry their URI. */
  resolvedNames: string[];
  /** Unresolved names no participant matched, kept as told. */
  keptNames: string[];
}

export const tool = defineTool({
  name: "memory.link_occasion",
  title: "Link an occasion",
  kind: "write",
  summary:
    "Ties an episode to an occasion in the people module (module://people/event/<id>) and, when the people module answers, syncs its attendees from the occasion's participants: names that match take the person's URI, names that match nobody stay as told. With the people module absent it records the occasion as given, with its label, and leaves the attendees as they are. Run it after people.log_interaction, with the id it returned.",
  input: linkOccasionInputSchema,
  async handler(ctx, input): Promise<LinkOccasionToolResult> {
    const { row } = await loadByCall(ctx, input.call);
    await refuseSuperseded(ctx, row, "linked to an occasion");
    if (row.kind !== "episode") {
      throw new ToolError(
        "refused",
        `${row.callNumber} is a ${row.kind}. An occasion is tied to an episode: something that happened, with who was there.`,
      );
    }

    const answer = await ctx.ports.refs.resolve(input.occasion);
    const resolved = answer.status === "resolved";
    const participants = resolved ? participantsFrom(answer.detail) : null;
    const label = resolved ? answer.label : (input.label ?? input.occasion);

    const result = await linkOccasion(
      ctx.db,
      row.id,
      { uri: input.occasion, label, attendees: participants },
      mutation(ctx),
    );

    const notice = !resolved
      ? "The people module did not answer for this occasion, so it is recorded as given and the attendees are left as they are."
      : participants === null
        ? "The people module named no participants for this occasion, so the attendees are left as they are."
        : null;

    return {
      memory: await memoryView(ctx, row.id),
      changed: result.changed,
      synced: participants !== null,
      notice,
      replaced: result.replaced,
      added: result.added,
      removed: result.removed,
      resolvedNames: result.resolvedNames,
      keptNames: result.keptNames,
    };
  },
  auditIds: (input, result) =>
    result ? { memoryIds: [result.memory.id], calls: [result.memory.call] } : { calls: [input.call] },
});
