// memory.set_tags. docs/SPEC.md section 15, "Write, 13" table, row
// `memory.set_tags`; section 6 (tags are lowercase slugs, normalised at every
// write path; merge and rename are first class and rewrite no body; merge
// leaves no row on the old slug); gate "Tags are one vocabulary"; guardrail 9.

import { z } from "zod";

import { attachTagsRaw, mergeTags, renameTag, tagsOf } from "../../domain/catalogue/tags.js";
import { atomic } from "../../domain/db.js";
import { appendVersion } from "../../domain/versions.js";
import { tagSlugSchema } from "../../schemas/tag.js";
import { defineTool, ToolError } from "../registry.js";
import { callSchema } from "../shared/inputs.js";
import { loadByCall, mutation } from "../shared/write-common.js";

const slugs = z.array(tagSlugSchema).max(50).default([]);

const memorySchema = z.object({
  action: z.literal("memory"),
  /** Current or old number. */
  call: callSchema,
  /** `#NightStash`, `#nightstash` and `nightstash` are one tag. New slugs join the vocabulary. */
  attach: slugs,
  detach: slugs,
});

const renameSchema = z.object({
  action: z.literal("rename"),
  from: tagSlugSchema,
  to: tagSlugSchema,
});

const mergeSchema = z.object({
  action: z.literal("merge"),
  from: tagSlugSchema,
  into: tagSlugSchema,
});

export const setTagsInputSchema = z.discriminatedUnion("action", [memorySchema, renameSchema, mergeSchema]);

export type SetTagsInput = z.input<typeof setTagsInputSchema>;

export type SetTagsResult =
  | {
      action: "memory";
      memoryId: string;
      call: string;
      added: string[];
      removed: string[];
      /** Every tag on the memory now, sorted. */
      tags: string[];
      /** False when nothing changed: no version was written. */
      changed: boolean;
    }
  | { action: "rename"; from: string; to: string; memories: number }
  | { action: "merge"; from: string; into: string; moved: number; alreadyTagged: number };

export const tool = defineTool({
  name: "memory.set_tags",
  title: "Set tags",
  kind: "write",
  summary:
    "Tags are one vocabulary of lowercase slugs: #NightStash, #nightstash and nightstash are the same tag. Action memory attaches and detaches tags on one memory, one version for the change. Action rename renames a tag everywhere; action merge folds one tag into another, rewriting only the join rows and leaving no row on the old slug. Neither rewrites a body.",
  input: setTagsInputSchema,
  async handler(ctx, input): Promise<SetTagsResult> {
    if (input.action === "rename") {
      const renamed = await renameTag(ctx.db, input.from, input.to);
      return { action: "rename", from: input.from, to: renamed.slug, memories: renamed.memories };
    }
    if (input.action === "merge") {
      const merged = await mergeTags(ctx.db, input.from, input.into);
      return {
        action: "merge",
        from: input.from,
        into: merged.into,
        moved: merged.moved,
        alreadyTagged: merged.alreadyTagged,
      };
    }

    const attach = [...new Set(input.attach)];
    const detach = [...new Set(input.detach)];
    if (attach.length === 0 && detach.length === 0) {
      throw new ToolError("invalid_input", "Nothing to change: give tags to attach or detach.");
    }
    const both = attach.filter((slug) => detach.includes(slug));
    if (both.length > 0) {
      throw new ToolError("invalid_input", `#${both.join(", #")} is both attached and detached. Pick one.`);
    }

    const { row } = await loadByCall(ctx, input.call);
    // One transaction and one version for the whole change, the same
    // `update` operation the domain's attachTags and detachTags write.
    const result = await atomic(ctx.db, async (tx) => {
      const removed: string[] = [];
      for (const slug of detach) {
        const tag = await tx.tag.findUnique({ where: { slug } });
        if (!tag) continue;
        const gone = await tx.memoryTag.deleteMany({ where: { memoryId: row.id, tagId: tag.id } });
        if (gone.count > 0) removed.push(slug);
      }
      // Refreshes tagText too, for the detached half as well.
      const added = await attachTagsRaw(tx, row.id, attach);
      if (added.length > 0 || removed.length > 0) {
        await appendVersion(tx, row.id, { ...mutation(ctx), operation: "update" });
      }
      return { added, removed, tags: await tagsOf(tx, row.id) };
    });

    return {
      action: "memory",
      memoryId: row.id,
      call: row.callNumber,
      ...result,
      changed: result.added.length > 0 || result.removed.length > 0,
    };
  },
  auditIds: (input, result) => {
    if (input.action !== "memory") return undefined;
    return result && result.action === "memory"
      ? { memoryIds: [result.memoryId], calls: [result.call] }
      : { calls: [input.call] };
  },
});
