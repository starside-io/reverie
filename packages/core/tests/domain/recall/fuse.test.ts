import { describe, expect, it } from "vitest";

import { RRF_K, bestPossible, fuse, rrfTerm } from "../../../src/domain/recall/fuse.js";

// docs/SPEC.md section 14:
//   fused     = 1/(60 + rankFts) + 1/(60 + rankVec)    vectors absent: the first term alone
//   relevance = fused / bestPossible(fused)            2/61 with vectors, 1/61 without

describe("constants", () => {
  it("uses k = 60", () => {
    expect(RRF_K).toBe(60);
    expect(rrfTerm(1)).toBe(1 / 61);
    expect(rrfTerm(3)).toBe(1 / 63);
  });

  it("puts the best possible at 1/61 per list that ran", () => {
    expect(bestPossible(1)).toBe(1 / 61);
    expect(bestPossible(2)).toBe(2 / 61);
  });
});

describe("FTS only", () => {
  it("gives the top rank a relevance of 1.0 and the rest 61 / (60 + rank)", () => {
    const hits = fuse({ fts: ["a", "b", "c"] });
    expect(hits.map((hit) => hit.id)).toEqual(["a", "b", "c"]);
    expect(hits[0]!.relevance).toBe(1);
    expect(hits[1]!.relevance).toBeCloseTo(61 / 62, 12);
    expect(hits[2]!.relevance).toBeCloseTo(61 / 63, 12);
    expect(hits[0]!.fused).toBeCloseTo(1 / 61, 12);
    expect(hits.every((hit) => hit.rankVec === null)).toBe(true);
  });

  it("treats a null vector list as not run", () => {
    expect(fuse({ fts: ["a"], vector: null })[0]!.relevance).toBe(1);
  });

  it("returns nothing for nothing", () => {
    expect(fuse({ fts: [] })).toEqual([]);
  });
});

describe("FTS plus vector", () => {
  it("matches hand computed values", () => {
    const hits = fuse({ fts: ["a", "b", "c"], vector: ["b", "d"] });

    // b: 1/62 + 1/61, a: 1/61, d: 1/62, c: 1/63, all over 2/61.
    expect(hits.map((hit) => hit.id)).toEqual(["b", "a", "d", "c"]);
    const byId = Object.fromEntries(hits.map((hit) => [hit.id, hit]));
    expect(byId["b"]!.fused).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(byId["b"]!.relevance).toBeCloseTo((61 / 62 + 1) / 2, 12);
    expect(byId["a"]!.relevance).toBeCloseTo(0.5, 12);
    expect(byId["d"]!.relevance).toBeCloseTo(61 / 124, 12);
    expect(byId["c"]!.relevance).toBeCloseTo(61 / 126, 12);
    expect(byId["b"]).toMatchObject({ rankFts: 2, rankVec: 1 });
    expect(byId["d"]).toMatchObject({ rankFts: null, rankVec: 2 });
  });

  it("gives 1.0 only to the item ranked first in both lists", () => {
    const hits = fuse({ fts: ["a", "b"], vector: ["a", "b"] });
    expect(hits[0]).toMatchObject({ id: "a", relevance: 1 });
    expect(hits[1]!.relevance).toBeCloseTo(61 / 62, 12);
  });

  it("counts a vector search that ran empty toward the best possible", () => {
    const hits = fuse({ fts: ["a"], vector: [] });
    expect(hits[0]!.relevance).toBeCloseTo(0.5, 12);
  });
});

describe("determinism", () => {
  it("breaks a fused tie on the FTS rank, then on the id", () => {
    // x is FTS rank 1 only, y is vector rank 1 only: equal fused values.
    const hits = fuse({ fts: ["x"], vector: ["y"] });
    expect(hits.map((hit) => hit.id)).toEqual(["x", "y"]);

    const vectorOnly = fuse({ fts: [], vector: ["n", "m"] });
    expect(vectorOnly.map((hit) => hit.id)).toEqual(["n", "m"]);

    const sameRank = fuse({ fts: ["q"], vector: ["p"] });
    expect(sameRank.map((hit) => hit.id)).toEqual(["q", "p"]);
  });

  it("keeps the best rank of a repeated id", () => {
    const hits = fuse({ fts: ["a", "b", "a"] });
    expect(hits.map((hit) => hit.id)).toEqual(["a", "b"]);
    expect(hits[0]!.rankFts).toBe(1);
  });

  it("gives the same output for the same input", () => {
    const input = { fts: ["c", "a", "b"], vector: ["b", "c", "e"] };
    expect(fuse(input)).toEqual(fuse(input));
  });
});
