import { z } from "zod";

import type { RefRole } from "../../schemas/enums.js";
import { MODULE_URI_PATTERN, moduleUriSchema, type RefInput } from "../../schemas/ref.js";
import type { ToolContext } from "../registry.js";

/**
 * People and occasions on a memory, as references (section 8, guardrail 7).
 * A `module://` URI is a reference and its label is asked of the refs port; a
 * plain name is kept as an unresolved label. Nothing here ever turns a name
 * into a person, and nothing fails because the people module is absent.
 */

const LABEL_MAX = 200;

/** A name as told, a `module://people/person/<id>` URI, or both. */
export const personInputSchema = z.union([
  z.string().trim().min(1, "A name or a module URI is required").max(2000),
  z.object({
    uri: moduleUriSchema,
    label: z.string().trim().min(1).max(LABEL_MAX).optional(),
  }),
]);
export type PersonInput = z.input<typeof personInputSchema>;

function isModuleUri(value: string): boolean {
  return MODULE_URI_PATTERN.test(value);
}

function clip(label: string): string {
  return label.length <= LABEL_MAX ? label : label.slice(0, LABEL_MAX).trimEnd();
}

/**
 * One reference to write. A URI keeps the label the caller gave, else the one
 * the refs port returns, else the URI itself when the port says unavailable:
 * the reference stands either way and renders as unavailable later. A name
 * keeps no URI and stays unresolved.
 */
export async function refFor(
  ctx: ToolContext,
  role: RefRole,
  value: PersonInput,
): Promise<RefInput & { resolved: boolean }> {
  const uri = typeof value === "string" ? (isModuleUri(value) ? value : null) : value.uri;
  if (uri === null) return { role, label: clip(value as string), resolved: false };

  const given = typeof value === "string" ? undefined : value.label;
  if (given) return { role, uri, label: clip(given), resolved: true };
  const answer = await ctx.ports.refs.resolve(uri);
  const label = answer.status === "resolved" ? answer.label : uri;
  return { role, uri, label: clip(label), resolved: true };
}

export interface BuiltRefs {
  refs: RefInput[];
  /** The names kept as unresolved labels, in the order given. */
  unresolved: string[];
}

/** Attendees, an occasion and mentions, as reference rows. Duplicates collapse. */
export async function buildRefs(
  ctx: ToolContext,
  input: { attendees?: PersonInput[]; occasion?: PersonInput | null; mentions?: PersonInput[] },
): Promise<BuiltRefs> {
  const refs: RefInput[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  const add = async (role: RefRole, value: PersonInput) => {
    const ref = await refFor(ctx, role, value);
    const key = `${role}|${ref.uri ?? `name:${ref.label.toLowerCase()}`}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!ref.resolved) unresolved.push(ref.label);
    refs.push({ role: ref.role, label: ref.label, ...(ref.uri ? { uri: ref.uri } : {}) });
  };

  for (const value of input.attendees ?? []) await add("attendee", value);
  if (input.occasion) await add("occasion", input.occasion);
  for (const value of input.mentions ?? []) await add("mentions", value);
  return { refs, unresolved };
}

export interface RenderedRef {
  role: RefRole;
  uri: string | null;
  label: string;
  /**
   * `resolved`: the refs port answered for the URI. `unavailable`: a URI the
   * port could not answer, such as with the people module absent.
   * `unresolved`: a name with no URI, never turned into a person.
   */
  status: "resolved" | "unavailable" | "unresolved";
}

/** A stored reference, rendered through the refs port. The stored label stands when the port cannot answer. */
export async function renderRef(
  ctx: ToolContext,
  ref: { role: string; uri: string | null; label: string },
): Promise<RenderedRef> {
  const role = ref.role as RefRole;
  if (ref.uri === null) return { role, uri: null, label: ref.label, status: "unresolved" };
  const answer = await ctx.ports.refs.resolve(ref.uri);
  if (answer.status === "resolved") return { role, uri: ref.uri, label: answer.label, status: "resolved" };
  return { role, uri: ref.uri, label: ref.label, status: "unavailable" };
}
