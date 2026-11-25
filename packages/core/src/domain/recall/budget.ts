import type { RecallConfig } from "../../config/index.js";

/**
 * Floor and pack. docs/SPEC.md section 14: drop under the floor, then fill by
 * score until the token budget or the item cap, whichever is hit first. When
 * nothing clears the floor the answer is `{ items: [], sufficient: false }`,
 * never padded from below it.
 */

/**
 * Characters per token for the estimate. Starting value: about four
 * characters of English per token for current tokenizers. It errs a little
 * high on prose and low on code and ids; the budget is a ceiling, not a bill.
 */
export const CHARS_PER_TOKEN = 4;

/** ceil(length / 4). 0 for an empty string. Starting value. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The tokens one item costs once serialised the way it is handed over. */
export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value));
}

export interface PackCandidate {
  score: number;
  /** What this item costs inside the budget. */
  tokens: number;
}

export type PackLimits = Pick<RecallConfig, "floor" | "maxItems" | "tokenBudget">;

export interface PackResult<T> {
  items: T[];
  /** True when at least one item is returned. */
  sufficient: boolean;
  /** Tokens the returned items cost. */
  tokens: number;
  /** How many candidates scored under the floor. */
  belowFloor: number;
  /** How many cleared the floor but did not fit. */
  overLimit: number;
}

/**
 * Packs by score, highest first; equal scores keep their input order, so a
 * caller that sorted by call number gets a stable result.
 *
 * The pack stops at the first item that would break the budget or the cap,
 * as section 17 puts it: "whichever of the two limits is hit first stops the
 * pack". It does not skip ahead to a smaller, lower scored item. A first item
 * bigger than the whole budget therefore returns nothing and
 * `sufficient: false`. Starting value.
 */
export function pack<T extends PackCandidate>(candidates: readonly T[], limits: PackLimits): PackResult<T> {
  const cleared = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.score >= limits.floor)
    .sort((a, b) => b.candidate.score - a.candidate.score || a.index - b.index)
    .map(({ candidate }) => candidate);

  const items: T[] = [];
  let tokens = 0;
  for (const candidate of cleared) {
    if (items.length >= limits.maxItems) break;
    if (tokens + candidate.tokens > limits.tokenBudget) break;
    items.push(candidate);
    tokens += candidate.tokens;
  }

  return {
    items,
    sufficient: items.length > 0,
    tokens,
    belowFloor: candidates.length - cleared.length,
    overLimit: cleared.length - items.length,
  };
}
