// memory.about. docs/SPEC.md section 15, "Read, 18" table, row
// `memory.about`; section 8, "Reading it: asking about people asks both"
// (newest first) and "It works in both directions, and alone"; section 5,
// "Finding things"; guardrail 7; gate "Works without Fellowship".
//
// Matching, starting reading. A Fellowship id or a module:// URI matches the
// references that carry that URI. A name matches the references that carry
// no URI and hold that label, case and spacing aside: the names kept while
// the people module was absent. A name is never matched to a URI reference
// by its label and a URI is never matched to a bare name, so nothing guesses
// who a name is (guardrail 7). Pass both to get both.

import { z } from "zod";

import type { Prisma } from "../../../generated/prisma/index.js";
import { RECALL_NOTICE } from "../../domain/recall/frame.js";
import type { MemoryState, RefRole } from "../../schemas/enums.js";
import { MODULE_URI_PATTERN, moduleUriSchema } from "../../schemas/ref.js";
import { defineTool, ToolError } from "../registry.js";
import { ENTRY_INCLUDE, limitSchema, toEntry, type EntryView } from "../shared/read-entries.js";
import { renderRef, type RenderedRef } from "../shared/refs.js";

/** Fellowship's ids are uuids. */
const FELLOWSHIP_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const subjectSchema = z.union([
  /** A module:// URI, a Fellowship id (a uuid), or a name as told. */
  z.string().trim().min(1).max(200),
  z
    .object({
      id: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,128}$/, "Expected a Fellowship id").optional(),
      uri: moduleUriSchema.optional(),
      name: z.string().trim().min(1).max(200).optional(),
    })
    .refine((value) => value.id || value.uri || value.name, { message: "Give an id, a uri or a name" }),
]);

export const aboutInputSchema = z
  .object({
    person: subjectSchema.optional(),
    occasion: subjectSchema.optional(),
    /** Retired entries are in the stacks: included only when asked. */
    includeRetired: z.boolean().default(false),
    limit: limitSchema(50, 200),
  })
  .refine((value) => (value.person === undefined) !== (value.occasion === undefined), {
    message: "Give a person or an occasion, not both and not neither",
  });

export type AboutInput = z.input<typeof aboutInputSchema>;

export interface AboutItem extends EntryView {
  /** How this memory carries the subject. */
  role: RefRole;
  /** `uri`: by reference. `label`: by a name kept unresolved. */
  matchedBy: "uri" | "label";
}

export interface AboutResult {
  notice: typeof RECALL_NOTICE;
  /** The subject as the refs port renders it. Null for a name with no URI. */
  subject: RenderedRef | null;
  /** The name matched against unresolved labels, when one was given. */
  name: string | null;
  /** Newest first: by the day it happened, then by call number. */
  items: AboutItem[];
  /** How many match in all; items stops at limit. */
  total: number;
}

function subjectOf(
  value: z.output<typeof subjectSchema>,
  kind: "person" | "occasion",
): { uri: string | null; name: string | null } {
  const uriFor = (id: string) => `module://people/${kind === "person" ? "person" : "event"}/${id}`;
  if (typeof value === "string") {
    if (MODULE_URI_PATTERN.test(value)) return { uri: value, name: null };
    if (FELLOWSHIP_ID.test(value)) return { uri: uriFor(value), name: null };
    return { uri: null, name: value };
  }
  const uri = value.uri ?? (value.id ? uriFor(value.id) : null);
  return { uri, name: value.name ?? null };
}

function sameName(a: string, b: string): boolean {
  const norm = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

export const tool = defineTool({
  name: "memory.about",
  title: "About a person or occasion",
  kind: "read",
  summary:
    "Everything attached to a person or an occasion, by reference, newest first. Takes a Fellowship id, a module:// URI, or a name. A name matches the names kept unresolved while Fellowship was absent; it is never guessed into a person. Works with the people module absent.",
  input: aboutInputSchema,
  async handler(ctx, input): Promise<AboutResult> {
    const kind = input.person !== undefined ? "person" : "occasion";
    const subject = subjectOf((input.person ?? input.occasion)!, kind);
    const roles: RefRole[] = kind === "person" ? ["attendee", "mentions"] : ["occasion"];

    const or: Prisma.MemoryRefWhereInput[] = [];
    if (subject.uri) or.push({ uri: subject.uri });
    if (subject.name) or.push({ uri: null });
    if (or.length === 0) throw new ToolError("invalid_input", "Give an id, a uri or a name.");

    const refs = await ctx.db.memoryRef.findMany({
      where: { role: { in: roles }, OR: or },
      select: { memoryId: true, role: true, uri: true, label: true },
    });
    const matched = new Map<string, { role: RefRole; matchedBy: "uri" | "label" }>();
    for (const ref of refs) {
      const byUri = subject.uri !== null && ref.uri === subject.uri;
      const byLabel = !byUri && subject.name !== null && ref.uri === null && sameName(ref.label, subject.name);
      if (!byUri && !byLabel) continue;
      // A URI match outranks a label match; then an attendee outranks a mention.
      const next = { role: ref.role as RefRole, matchedBy: byUri ? ("uri" as const) : ("label" as const) };
      const rank = (hit: { role: RefRole; matchedBy: "uri" | "label" }) =>
        (hit.matchedBy === "uri" ? 2 : 0) + (hit.role === "mentions" ? 0 : 1);
      const previous = matched.get(ref.memoryId);
      if (!previous || rank(next) > rank(previous)) matched.set(ref.memoryId, next);
    }

    const states: MemoryState[] = input.includeRetired ? ["active", "superseded", "retired"] : ["active", "superseded"];
    const where: Prisma.MemoryWhereInput = { id: { in: [...matched.keys()] }, state: { in: states } };
    const [rows, total] =
      matched.size === 0
        ? [[], 0]
        : await Promise.all([
            ctx.db.memory.findMany({
              where,
              orderBy: [{ occurredOn: "desc" }, { callNumber: "desc" }],
              take: input.limit,
              include: ENTRY_INCLUDE,
            }),
            ctx.db.memory.count({ where }),
          ]);

    const rendered = subject.uri
      ? await renderRef(ctx, { role: roles[0] as RefRole, uri: subject.uri, label: subject.name ?? subject.uri })
      : null;

    return {
      notice: RECALL_NOTICE,
      subject: rendered,
      name: subject.name,
      items: rows.map((row) => {
        const hit = matched.get(row.id)!;
        return { ...toEntry(row), role: hit.role, matchedBy: hit.matchedBy };
      }),
      total,
    };
  },
  auditIds: (_input, result) =>
    result ? { memoryIds: result.items.map((item) => item.id), calls: result.items.map((item) => item.call) } : undefined,
});
