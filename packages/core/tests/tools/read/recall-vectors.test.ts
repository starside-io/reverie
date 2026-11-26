import { afterEach, describe, expect, it } from "vitest";

import { encodeVector } from "../../../src/storage/embeddings.js";
import { RRF_K } from "../../../src/domain/recall/fuse.js";
import type { ExplainResult } from "../../../src/tools/read/explain.js";
import type { RecallResult } from "../../../src/tools/read/recall.js";
import { REEMBED_KEY } from "../../../src/tools/shared/host-values.js";
import type { RememberResult } from "../../../src/tools/write/remember.js";
import type { SupersedeToolResult } from "../../../src/tools/write/supersede.js";
import { testHost, type TestHost } from "../../test-host.js";

/**
 * The vector leg of memory.recall (docs/SPEC.md section 14, "Search twice"
 * and "Scoring"): cosine over the configured model's vectors, fused with FTS,
 * the same filters as FTS, rows of another model or dim never mixed in, and a
 * retrieval block that says why when vectors did not run. All data invented.
 *
 * The models port here maps a text to a fixed 2 value vector by a marker word
 * in it, so every rank below is known in advance.
 */

const NOW = new Date("2026-12-27T10:00:00.000Z");
const CONFIG = { embedding: { model: "test-model", dim: 2 } };

type Sufficient = Extract<RecallResult, { sufficient: true }>;

function vectorFor(text: string): number[] {
  const lower = text.toLowerCase();
  if (lower === "kettle") return [0, 1];
  if (lower.includes("alpha")) return [1, 0];
  if (lower.includes("beta")) return [0.6, 0.8];
  if (lower.includes("gamma")) return [0, 1];
  return [1, 0];
}

describe("recall with vectors", () => {
  let host: TestHost;
  afterEach(async () => {
    await host.close();
  });

  async function library(options: { failQuery?: boolean } = {}) {
    host = await testHost({ now: NOW, session: { id: "session-1" }, models: true, config: CONFIG });
    host.ports.models = {
      embed: async (texts) => {
        if (options.failQuery && texts.length === 1 && texts[0] === "kettle") throw new Error("The model went away.");
        return texts.map(vectorFor);
      },
    };
    const remember = async (input: Record<string, unknown>) =>
      (await host.invoke<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/HOM", ...input })).memory;
    const a = await remember({ title: "Kettle alpha", body: "The kettle descaler is under the sink, next to the kettle filter." });
    const b = await remember({ title: "Lamp beta", body: "The reading lamp bulb is the same size as the kettle light." });
    const c = await remember({ title: "Gamma rug", body: "Jane Doe gave us the blue rug for the hall.", shelf: "LIF/GTH" });
    return { a, b, c };
  }

  it("fuses both lists and scores against hand computed values", async () => {
    const { a, b, c } = await library();
    const result = await host.invoke<Sufficient>("memory.recall", { query: "kettle" });

    // FTS: a (kettle twice, once in the title), then b. Vector, query [0, 1]:
    // c (cosine 1), b (0.8); a is orthogonal (0) and left out.
    // fused(b) = 2/62, fused(a) = fused(c) = 1/61; bestPossible = 2/61.
    // A tie breaks on the FTS rank, so a comes before c.
    expect(result.retrieval).toEqual({ vectors: true });
    expect(result.items.map((item) => item.id)).toEqual([b.id, a.id, c.id]);
    expect(result.items.map((item) => item.ranks)).toEqual([
      { fts: 2, vector: 2 },
      { fts: 1, vector: null },
      { fts: null, vector: 1 },
    ]);

    // Written now, so recency is 1; importance 3 weighs 0.9; stated weighs 1.
    const best = 2 / (RRF_K + 1);
    const expected = [(2 / (RRF_K + 2) / best) * 0.9, (1 / (RRF_K + 1) / best) * 0.9, (1 / (RRF_K + 1) / best) * 0.9];
    expect(expected[0]).toBeCloseTo(0.8855, 4);
    expect(expected[1]).toBeCloseTo(0.45, 4);
    result.items.forEach((item, index) => expect(item.score).toBeCloseTo(expected[index]!, 2));
  });

  it("logs both ranks, and memory.explain shows them", async () => {
    const { c } = await library();
    const result = await host.invoke<Sufficient>("memory.recall", { query: "kettle" });

    const log = await host.db.recallLog.findUniqueOrThrow({ where: { id: result.recallId! } });
    const scores = log.scores as number[];
    expect(scores).toHaveLength(9);
    expect(scores.slice(3)).toEqual([2, 1, 0, 2, 0, 1]);

    const explained = await host.invoke<ExplainResult>("memory.explain", { recallId: result.recallId });
    expect(explained.recalls[0]!.vectors).toBe(true);
    expect(explained.recalls[0]!.ranks).toEqual([
      { fts: 2, vector: 2 },
      { fts: 1, vector: null },
      { fts: null, vector: 1 },
    ]);
    const byCall = await host.invoke<ExplainResult>("memory.explain", { call: c.call });
    expect(byCall.recalls[0]!.matchRanks).toEqual({ fts: null, vector: 1 });
    expect(byCall.recalls[0]!.match).toEqual({ rank: 3, score: expect.any(Number) });
  });

  it("logs a vector rank of -1 and explains vectors false when the vector search did not run", async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
    await host.invoke("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "The kettle descaler is under the sink." });
    const result = await host.invoke<Sufficient>("memory.recall", { query: "kettle" });
    const log = await host.db.recallLog.findUniqueOrThrow({ where: { id: result.recallId! } });
    expect(log.scores as number[]).toEqual([expect.any(Number), 1, -1]);
    const explained = await host.invoke<ExplainResult>("memory.explain", { recallId: result.recallId });
    expect(explained.recalls[0]!.vectors).toBe(false);
    expect(explained.recalls[0]!.ranks).toEqual([{ fts: 1, vector: null }]);
  });

  it("applies the shelf filter to the vector leg exactly as to FTS", async () => {
    const { a, b, c } = await library();
    const result = await host.invoke<Sufficient>("memory.recall", { query: "kettle", shelf: "LIF/HOM" });
    expect(result.retrieval).toEqual({ vectors: true });
    expect(result.items.map((item) => item.id).sort()).toEqual([a.id, b.id].sort());
    expect(result.items.map((item) => item.id)).not.toContain(c.id);
  });

  it("applies tags, and asOf finds a superseded entry by its vector", async () => {
    const { c } = await library();
    const tagged = await host.invoke<Sufficient>("memory.recall", { query: "kettle", tags: ["nothing-has-this"] });
    expect(tagged).toEqual({ items: [], sufficient: false });

    const later = new Date("2027-01-10T10:00:00.000Z");
    const replaced = await host.invoke<SupersedeToolResult>(
      "memory.supersede",
      { call: c.call, body: "The blue gamma rug went to Sam Rivera; the hall is bare now." },
      { now: later },
    );
    // Now: only the replacement is active. Then: only the old entry was valid.
    const now = await host.invoke<Sufficient>("memory.recall", { query: "kettle" }, { now: later });
    expect(now.items.map((item) => item.id)).toContain(replaced.replacement.id);
    expect(now.items.map((item) => item.id)).not.toContain(c.id);
    const then = await host.invoke<Sufficient>("memory.recall", { query: "kettle", asOf: "2026-12-28T00:00:00.000Z" }, { now: later });
    expect(then.retrieval).toEqual({ vectors: true });
    expect(then.items.map((item) => item.id)).toContain(c.id);
    expect(then.items.map((item) => item.id)).not.toContain(replaced.replacement.id);
  });

  it("never mixes in a vector of another model: a candidate holding one makes recall FTS only", async () => {
    const { a } = await library();
    await host.db.embedding.update({ where: { memoryId: a.id }, data: { model: "old-model" } });
    const result = await host.invoke<Sufficient>("memory.recall", { query: "kettle" });
    expect(result.retrieval).toEqual({ vectors: false, ftsOnlyReason: "partial_embeddings", missingEmbeddings: 1 });
    expect(result.items.every((item) => item.ranks.vector === null)).toBe(true);
  });

  it("never compares a vector of another dim, with dim configured or left open", async () => {
    const { a } = await library();
    await host.db.embedding.update({ where: { memoryId: a.id }, data: { dim: 3, vector: encodeVector([1, 0, 0]) } });
    const configured = await host.invoke<Sufficient>("memory.recall", { query: "kettle" });
    expect(configured.retrieval).toEqual({ vectors: false, ftsOnlyReason: "partial_embeddings", missingEmbeddings: 1 });

    host.config.embedding.dim = null;
    const open = await host.invoke<Sufficient>("memory.recall", { query: "kettle" });
    expect(open.retrieval).toEqual({ vectors: false, ftsOnlyReason: "partial_embeddings", missingEmbeddings: 1 });
  });

  it("runs on FTS alone and says reembedding while the host's re-embed is under way", async () => {
    await library();
    host.values.set(REEMBED_KEY, {
      model: "test-model-2",
      dim: 2,
      from: { model: "test-model", dim: 2 },
      startedAt: NOW.toISOString(),
    });
    const during = await host.invoke<Sufficient>("memory.recall", { query: "kettle" });
    expect(during.retrieval).toEqual({ vectors: false, ftsOnlyReason: "reembedding" });
    expect(during.items.length).toBeGreaterThan(0);

    host.values.delete(REEMBED_KEY);
    expect((await host.invoke<Sufficient>("memory.recall", { query: "kettle" })).retrieval).toEqual({ vectors: true });
  });

  it("answers on FTS alone and says so when the model fails on the query", async () => {
    const { a } = await library({ failQuery: true });
    const result = await host.invoke<Sufficient>("memory.recall", { query: "kettle" });
    expect(result.retrieval).toEqual({ vectors: false, ftsOnlyReason: "query_embed_failed" });
    expect(result.items[0]!.id).toBe(a.id);
  });
});
