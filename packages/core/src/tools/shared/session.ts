import { dayKey } from "../../schemas/common.js";
import type { MemoryScope } from "../../schemas/enums.js";
import { QUOTE_MAX_LENGTH, type MemorySourceInput } from "../../schemas/source.js";
import { ToolError, type ToolContext } from "../registry.js";

/**
 * The owner's statement as the source of a memory (section 13, the direct
 * door; guardrail 2). No source, no memory: when the owner says "remember
 * this", what they said is the source, so the citation is built here rather
 * than asked for. A conversation Source labelled with the session's day,
 * pointing at the session when there is one, trust `stated`, and the quote
 * taken from the stated text and capped at 500 characters.
 */
export function statedSource(ctx: ToolContext, statedText: string): MemorySourceInput {
  return {
    source: {
      kind: "conversation",
      label: `session of ${dayKey(ctx.now)}`,
      ...(ctx.session.id ? { uri: `session:${ctx.session.id}` } : {}),
      occurredAt: ctx.now,
      trust: "stated",
    },
    quote: capQuote(statedText),
  };
}

/**
 * Text cut to the quote cap, whitespace trimmed, never ending in half a
 * surrogate pair. The cap counts UTF-16 units, which is never more than the
 * characters SQLite's CHECK counts.
 */
export function capQuote(text: string): string {
  let quote = text.trim();
  if (quote.length <= QUOTE_MAX_LENGTH) return quote;
  quote = quote.slice(0, QUOTE_MAX_LENGTH);
  const last = quote.charCodeAt(quote.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) quote = quote.slice(0, -1);
  return quote.trimEnd();
}

/**
 * What a scoped memory is scoped to, filled from the session when the caller
 * gave a scope and no scopeRef: the resolved project's slug for `project`,
 * the session id for `session`, the agent's name for `agent`, nothing for
 * `global`. Refuses with `invalid_input` when the scope names something the
 * session cannot supply. Never guesses a project by name.
 */
export function scopeRefFor(
  ctx: ToolContext,
  scope: MemoryScope,
  given: string | undefined,
  project: { slug: string } | null,
): string | undefined {
  if (scope === "global") {
    if (given) throw new ToolError("invalid_input", "A global memory takes no scopeRef.");
    return undefined;
  }
  if (given) return given;
  const fromSession =
    scope === "project" ? project?.slug : scope === "session" ? ctx.session.id : ctx.session.agent;
  if (fromSession) return fromSession;
  const what =
    scope === "project"
      ? "no project resolves from this session's folder or git remote"
      : scope === "session"
        ? "the call carries no session id"
        : "the call names no agent";
  throw new ToolError(
    "invalid_input",
    `A ${scope} memory names what it is scoped to, and ${what}. Pass scopeRef, or use scope global.`,
  );
}
