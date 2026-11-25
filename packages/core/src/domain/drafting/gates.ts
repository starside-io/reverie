import { z } from "zod";

import { TRUST_ORDER, type SourceKind, type TrustTier } from "../../schemas/enums.js";

/**
 * The material a draft is made from, and the gates that tie a draft back to
 * it. docs/SPEC.md sections 13 and 15, guardrails 2 and 7, gate "No source,
 * no memory".
 *
 * Binding a proposal to its context follows Fellowship: memory.draft_context
 * returns a `target`, and memory.propose_draft takes that target back as it
 * was given, beside the answer. For extract and reconcile the target carries
 * the material itself, so the quote is checked against the very text the
 * drafter read, not against whatever the silo holds by then. Pure: no
 * database, no ports.
 */

/** Starting value: the most text one drafting call carries, all turns together. */
export const MATERIAL_MAX_CHARS = 200_000;

export const turnSchema = z
  .object({
    /** `user` is the owner, `assistant` the model, `tool` a tool result read into the session. */
    role: z.enum(["user", "assistant", "tool"]),
    text: z.string().min(1).max(MATERIAL_MAX_CHARS),
  })
  .strict();

export const materialSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("turns"),
        turns: z.array(turnSchema).min(1).max(5000),
      })
      .strict(),
    z
      .object({
        kind: z.literal("file"),
        text: z.string().min(1).max(MATERIAL_MAX_CHARS),
        /** Shown as the source's label: "notes.md". Never the text itself. */
        name: z.string().trim().min(1).max(200),
        uri: z.string().trim().min(1).max(2000).optional(),
        sourceKind: z.enum(["file", "page", "tool_result"]).default("file"),
        /**
         * `stated` only when the file is the owner's own writing. Anything read
         * from outside is `external`, the default, and stays external.
         */
        trust: z.enum(["stated", "external"]).default("external"),
      })
      .strict(),
  ])
  .superRefine((material, ctx) => {
    const size =
      material.kind === "file" ? material.text.length : material.turns.reduce((sum, turn) => sum + turn.text.length, 0);
    if (size > MATERIAL_MAX_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `The material holds ${size} characters; one drafting call takes at most ${MATERIAL_MAX_CHARS}. Split it.`,
      });
    }
  });

export type Material = z.infer<typeof materialSchema>;
export type MaterialInput = z.input<typeof materialSchema>;

/**
 * Whitespace normalised: every run of whitespace is one space, ends trimmed.
 * The quote gate compares in this form, so a line break in the transcript
 * where the drafter wrote a space still matches. Nothing else is folded:
 * case, punctuation and quote marks must be as written.
 */
export function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Where a quote was found, and the trust of what it was found in. */
export interface QuoteMatch {
  /** Index of the turn, or 0 for a file. */
  at: number;
  role: "user" | "assistant" | "tool" | "file";
  trust: TrustTier;
}

/**
 * How trusted each part of the material is. The owner's turns are their own
 * words, `stated`. A model's turn is `inferred`: the owner did not say it. A
 * tool result is `external`. A file carries the trust the caller gave it.
 * Starting values.
 */
export function turnTrust(role: "user" | "assistant" | "tool"): TrustTier {
  return role === "user" ? "stated" : role === "assistant" ? "inferred" : "external";
}


/**
 * The quote, found verbatim (after whitespace normalisation) within one turn
 * or the file. Null when it appears nowhere: the draft invented it. When it
 * appears in several turns the most trusted one is the source, because the
 * owner saying it is what makes it theirs; an injection repeated by the owner
 * is the owner's to confirm.
 */
export function findQuote(material: Material, quote: string): QuoteMatch | null {
  const needle = normaliseWhitespace(quote);
  if (needle.length === 0) return null;
  if (material.kind === "file") {
    return normaliseWhitespace(material.text).includes(needle)
      ? { at: 0, role: "file", trust: material.trust }
      : null;
  }
  let best: QuoteMatch | null = null;
  material.turns.forEach((turn, index) => {
    if (!normaliseWhitespace(turn.text).includes(needle)) return;
    const trust = turnTrust(turn.role);
    if (best === null || TRUST_ORDER.indexOf(trust) < TRUST_ORDER.indexOf(best.trust)) {
      best = { at: index, role: turn.role, trust };
    }
  });
  return best;
}

/** The trust of the material as a whole: its least trusted part. */
export function materialTrust(material: Material): TrustTier {
  if (material.kind === "file") return material.trust;
  let worst: TrustTier = "stated";
  for (const turn of material.turns) {
    const trust = turnTrust(turn.role);
    if (TRUST_ORDER.indexOf(trust) > TRUST_ORDER.indexOf(worst)) worst = trust;
  }
  return worst;
}

/** True when the trust tier is the one the attack surface rules key on. */
export function isExternal(trust: TrustTier): boolean {
  return trust === "external";
}

/** The Source a drafted memory cites, built from the material and where its quote was found. */
export interface DraftedSource {
  kind: SourceKind;
  label: string;
  uri?: string;
  /** The day the material was from, midnight UTC, as an ISO string. */
  occurredAt: string;
  trust: TrustTier;
}

export function sourceFor(
  material: Material,
  match: QuoteMatch,
  context: { sessionDate: string; sessionId: string | null },
): DraftedSource {
  const occurredAt = `${context.sessionDate}T00:00:00.000Z`;
  if (material.kind === "file") {
    return {
      kind: material.sourceKind,
      label: material.name,
      ...(material.uri ? { uri: material.uri } : {}),
      occurredAt,
      trust: material.trust,
    };
  }
  return {
    kind: match.role === "tool" ? "tool_result" : "conversation",
    label: `session of ${context.sessionDate}`,
    ...(context.sessionId ? { uri: `session:${context.sessionId}` } : {}),
    occurredAt,
    trust: match.trust,
  };
}

/**
 * The text of the material, whitespace normalised and lowercased, for the
 * name check: a person the draft names must be named in the material.
 */
export function materialText(material: Material): string {
  const raw = material.kind === "file" ? material.text : material.turns.map((turn) => turn.text).join("\n");
  return normaliseWhitespace(raw).toLowerCase();
}

/**
 * True when the material names this person. Whole words, case folded, so
 * "Sam" is found in "Sam brought" but not in "Samuel". Starting value.
 */
export function namedInMaterial(text: string, name: string): boolean {
  const needle = normaliseWhitespace(name).toLowerCase();
  if (needle.length === 0) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(text);
}

/** A short stable digest of a value, for group ids. Not a secret, not a check. */
export function shortDigest(value: unknown): string {
  // FNV-1a over the JSON, 32 bits, hex. Enough to tell one session's group from another's.
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
