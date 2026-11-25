import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../../src/config/index.js";
import { CHARS_PER_TOKEN, estimateJsonTokens, estimateTokens, pack } from "../../../src/domain/recall/budget.js";

const limits = DEFAULT_CONFIG.recall;

function candidate(id: string, score: number, tokens = 10) {
  return { id, score, tokens };
}

describe("estimateTokens", () => {
  it("is ceil(length / 4)", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });

  it("estimates serialised JSON", () => {
    expect(estimateJsonTokens({ a: 1 })).toBe(estimateTokens('{"a":1}'));
  });
});

describe("pack", () => {
  it("drops everything under the floor and sorts by score", () => {
    const result = pack(
      [candidate("low", 0.2), candidate("mid", 0.5), candidate("edge", 0.35), candidate("top", 0.9)],
      limits,
    );
    expect(result.items.map((item) => item.id)).toEqual(["top", "mid", "edge"]);
    expect(result.belowFloor).toBe(1);
    expect(result.sufficient).toBe(true);
  });

  it("keeps an item exactly on the floor", () => {
    expect(pack([candidate("edge", 0.35)], limits).items).toHaveLength(1);
  });

  it("abstains when nothing clears the floor, and never pads", () => {
    const result = pack([candidate("a", 0.34), candidate("b", 0.1)], limits);
    expect(result.items).toEqual([]);
    expect(result.sufficient).toBe(false);
    expect(result.belowFloor).toBe(2);
  });

  it("abstains on no candidates", () => {
    expect(pack([], limits)).toMatchObject({ items: [], sufficient: false, tokens: 0 });
  });

  it("stops at maxItems", () => {
    const many = Array.from({ length: 12 }, (_, i) => candidate(`m${i}`, 0.9 - i * 0.01, 1));
    const result = pack(many, limits);
    expect(result.items).toHaveLength(8);
    expect(result.overLimit).toBe(4);
  });

  it("stops at the token budget when it is hit first", () => {
    const result = pack(
      [candidate("a", 0.9, 500), candidate("b", 0.8, 500), candidate("c", 0.7, 500), candidate("d", 0.6, 10)],
      limits,
    );
    // a + b = 1000; c would make 1500 > 1200 and stops the pack, so d is not reached.
    expect(result.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.tokens).toBe(1000);
    expect(result.overLimit).toBe(2);
  });

  it("fills the budget exactly", () => {
    const result = pack([candidate("a", 0.9, 600), candidate("b", 0.8, 600)], limits);
    expect(result.tokens).toBe(1200);
    expect(result.items).toHaveLength(2);
  });

  it("returns nothing when the best item alone is over the budget", () => {
    const result = pack([candidate("huge", 0.9, 5000), candidate("small", 0.8, 5)], limits);
    expect(result).toMatchObject({ items: [], sufficient: false, overLimit: 2 });
  });

  it("keeps input order between equal scores", () => {
    const result = pack([candidate("b", 0.5), candidate("a", 0.5), candidate("c", 0.5)], limits);
    expect(result.items.map((item) => item.id)).toEqual(["b", "a", "c"]);
  });

  it("does not reorder or mutate its input", () => {
    const input = [candidate("a", 0.4), candidate("b", 0.9)];
    pack(input, limits);
    expect(input.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
