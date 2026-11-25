import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/config/index.js";
import {
  DAY_MS,
  TRUST_WEIGHT,
  daysSince,
  importanceFactor,
  recency,
  scoreMemory,
} from "../../../src/domain/recall/score.js";

// docs/SPEC.md section 14:
//   recency = 0.5 ^ (daysSince(lastConfirmedAt) / halfLife[kind])      procedure: 1
//   score   = relevance * (0.5 + 0.5 * recency) * (0.6 + 0.1 * importance) * trustWeight

const NOW = new Date("2026-12-27T12:00:00.000Z");
const halfLifeDays = DEFAULT_CONFIG.halfLifeDays;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

describe("trust weights", () => {
  it("are the ones section 4 declares", () => {
    expect(TRUST_WEIGHT).toEqual({ stated: 1.0, confirmed: 0.9, inferred: 0.6, external: 0.3 });
  });
});

describe("recency", () => {
  it("is 1 on the day of confirmation and halves at each half life", () => {
    expect(recency("fact", 0, halfLifeDays)).toBe(1);
    expect(recency("fact", 365, halfLifeDays)).toBeCloseTo(0.5, 12);
    expect(recency("preference", 730, halfLifeDays)).toBeCloseTo(0.5, 12);
    expect(recency("episode", 90, halfLifeDays)).toBeCloseTo(0.5, 12);
    expect(recency("episode", 180, halfLifeDays)).toBeCloseTo(0.25, 12);
    expect(recency("reference", 365, halfLifeDays)).toBeCloseTo(0.5, 12);
  });

  it("is always 1 for a procedure", () => {
    expect(recency("procedure", 0, halfLifeDays)).toBe(1);
    expect(recency("procedure", 100_000, halfLifeDays)).toBe(1);
  });

  it("follows a changed half life with no recompute", () => {
    expect(recency("episode", 30, { ...halfLifeDays, episode: 30 })).toBeCloseTo(0.5, 12);
  });

  it("never exceeds 1 for a confirmation in the future", () => {
    expect(daysSince(new Date(NOW.getTime() + 5 * DAY_MS), NOW)).toBe(0);
    expect(recency("fact", -10, halfLifeDays)).toBe(1);
  });

  it("counts fractional days", () => {
    expect(daysSince(new Date(NOW.getTime() - DAY_MS / 2), NOW)).toBeCloseTo(0.5, 12);
  });
});

describe("importance factor", () => {
  it("runs 0.7 to 1.1 over importance 1 to 5", () => {
    expect(importanceFactor(1)).toBeCloseTo(0.7, 12);
    expect(importanceFactor(3)).toBeCloseTo(0.9, 12);
    expect(importanceFactor(5)).toBeCloseTo(1.1, 12);
  });

  it("clamps outside 1 to 5", () => {
    expect(importanceFactor(0)).toBeCloseTo(0.7, 12);
    expect(importanceFactor(9)).toBeCloseTo(1.1, 12);
  });
});

describe("scoreMemory against hand computed numbers", () => {
  const context = { now: NOW, halfLifeDays };

  it("a stated fact one half life old: 1 * 0.75 * 0.9 * 1.0 = 0.675", () => {
    const result = scoreMemory(
      { relevance: 1, kind: "fact", importance: 3, trust: "stated", lastConfirmedAt: daysAgo(365) },
      context,
    );
    expect(result.score).toBeCloseTo(0.675, 12);
    expect(result.recency).toBeCloseTo(0.5, 12);
    expect(result.importance).toBeCloseTo(0.9, 12);
    expect(result.trustWeight).toBe(1);
    expect(result.relevance).toBe(1);
    expect(result.daysSinceConfirmed).toBeCloseTo(365, 9);
  });

  it("a confirmed episode two half lives old: 0.5 * 0.625 * 1.1 * 0.9 = 0.309375", () => {
    const result = scoreMemory(
      { relevance: 0.5, kind: "episode", importance: 5, trust: "confirmed", lastConfirmedAt: daysAgo(180) },
      context,
    );
    expect(result.recency).toBeCloseTo(0.25, 12);
    expect(result.score).toBeCloseTo(0.309375, 12);
  });

  it("an external procedure of any age: 1 * 1 * 0.7 * 0.3 = 0.21", () => {
    const result = scoreMemory(
      { relevance: 1, kind: "procedure", importance: 1, trust: "external", lastConfirmedAt: daysAgo(10_000) },
      context,
    );
    expect(result.recency).toBe(1);
    expect(result.score).toBeCloseTo(0.21, 12);
  });

  it("an inferred preference confirmed today: 0.8 * 1 * 1.0 * 0.6 = 0.48", () => {
    const result = scoreMemory(
      { relevance: 0.8, kind: "preference", importance: 4, trust: "inferred", lastConfirmedAt: NOW },
      context,
    );
    expect(result.score).toBeCloseTo(0.48, 12);
  });

  it("never lets recency take more than half the weight", () => {
    const ancient = scoreMemory(
      { relevance: 1, kind: "episode", importance: 3, trust: "stated", lastConfirmedAt: daysAgo(90 * 50) },
      context,
    );
    expect(ancient.score).toBeGreaterThan(0.45);
    expect(ancient.score).toBeLessThan(0.9 * 0.5 + 1e-9);
  });

  it("reads no clock: the same input and now give the same numbers", () => {
    const input = { relevance: 0.7, kind: "reference" as const, importance: 2, trust: "confirmed" as const, lastConfirmedAt: daysAgo(40) };
    expect(scoreMemory(input, context)).toEqual(scoreMemory(input, context));
    const later = scoreMemory(input, { ...context, now: new Date(NOW.getTime() + 100 * DAY_MS) });
    expect(later.score).toBeLessThan(scoreMemory(input, context).score);
  });
});
