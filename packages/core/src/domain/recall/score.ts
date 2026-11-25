import type { HalfLifeDays } from "../../config/index.js";
import type { MemoryKind, TrustTier } from "../../schemas/enums.js";

/**
 * Weighing a fused hit. docs/SPEC.md section 14:
 *
 *   recency = 0.5 ^ (daysSince(lastConfirmedAt) / halfLife[kind])      procedure: 1
 *   score   = relevance * (0.5 + 0.5 * recency) * (0.6 + 0.1 * importance) * trustWeight
 *
 * Recency halves the weight at most and never zeroes it. Nothing is cached, so
 * a half life change applies on the next recall. Time is a parameter: nothing
 * here reads the clock.
 */

export const DAY_MS = 86_400_000;

/** Section 4, trust. */
export const TRUST_WEIGHT: Readonly<Record<TrustTier, number>> = {
  stated: 1.0,
  confirmed: 0.9,
  inferred: 0.6,
  external: 0.3,
};

/** Importance runs 1 to 5 (the silo schema), so its factor runs 0.7 to 1.1. */
export const IMPORTANCE_MIN = 1;
export const IMPORTANCE_MAX = 5;

/**
 * Whole and fractional days from `from` to `now`. A `from` in the future
 * counts as zero days, so recency never exceeds 1. Starting value.
 */
export function daysSince(from: Date, now: Date): number {
  return Math.max(0, (now.getTime() - from.getTime()) / DAY_MS);
}

/** 0.5 ^ (days / halfLife[kind]); always 1 for a procedure. */
export function recency(kind: MemoryKind, days: number, halfLifeDays: HalfLifeDays): number {
  if (kind === "procedure") return 1;
  return Math.pow(0.5, Math.max(0, days) / halfLifeDays[kind]);
}

/** 0.6 + 0.1 * importance, with importance clamped to 1..5. */
export function importanceFactor(importance: number): number {
  const clamped = Math.min(IMPORTANCE_MAX, Math.max(IMPORTANCE_MIN, importance));
  return 0.6 + 0.1 * clamped;
}

export interface ScoreInput {
  /** From fuse: 1.0 for rank 1 in every list that ran. */
  relevance: number;
  kind: MemoryKind;
  /** 1 to 5. */
  importance: number;
  trust: TrustTier;
  lastConfirmedAt: Date;
}

export interface ScoreContext {
  now: Date;
  halfLifeDays: HalfLifeDays;
}

/**
 * The score with the four numbers behind it, which the recall inspector and
 * `memory.explain` show: relevance, recency, importance and trust weight.
 */
export interface ScoreBreakdown {
  score: number;
  relevance: number;
  recency: number;
  /** The importance factor, 0.6 + 0.1 * importance. */
  importance: number;
  trustWeight: number;
  /** Days since lastConfirmedAt, fractional. */
  daysSinceConfirmed: number;
}

export function scoreMemory(input: ScoreInput, context: ScoreContext): ScoreBreakdown {
  const days = daysSince(input.lastConfirmedAt, context.now);
  const recencyValue = recency(input.kind, days, context.halfLifeDays);
  const importance = importanceFactor(input.importance);
  const trustWeight = TRUST_WEIGHT[input.trust];
  const score = input.relevance * (0.5 + 0.5 * recencyValue) * importance * trustWeight;
  return {
    score,
    relevance: input.relevance,
    recency: recencyValue,
    importance,
    trustWeight,
    daysSinceConfirmed: days,
  };
}
