// memory.tags. docs/SPEC.md section 15, "Read, 18" table, row `memory.tags`;
// section 6 (one vocabulary, lowercase slugs, counts for the drafter).

import { z } from "zod";

import { tagVocabulary } from "../../domain/catalogue/tags.js";
import { defineTool } from "../registry.js";

export interface TagsResult {
  /** Most used first, then by slug. A count covers every entry carrying the tag, whatever its state. */
  tags: Array<{ slug: string; colour: string; count: number }>;
}

export const tool = defineTool({
  name: "memory.tags",
  title: "Tags",
  kind: "read",
  summary: "The tag vocabulary with counts, most used first. One vocabulary: #NightStash and nightstash are the same tag.",
  input: z.object({}),
  async handler(ctx): Promise<TagsResult> {
    const vocabulary = await tagVocabulary(ctx.db);
    return { tags: vocabulary.map((entry) => ({ slug: entry.slug, colour: entry.colour, count: entry.count })) };
  },
});
