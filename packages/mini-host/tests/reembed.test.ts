import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { tools as coreTools, type ModelsPort } from "@reverie/core";

import type { MiniHost } from "../src/host.js";
import { remember, throwawayDir, throwawayHost } from "./harness.js";

/**
 * The re-embed hook on the mini-host (docs/SPEC.md section 17): a change of
 * embedding model or dim re-embeds every memory before it counts as applied,
 * recall stays on FTS alone and says so until then, a run cut off half way
 * resumes after a restart without mixing two models, and null drops to FTS
 * only. Also: snapshot and mirror carry no vectors, and a restored silo is
 * re-embedded. All data invented.
 */

type RecallAnswer =
  | { sufficient: true; items: Array<{ id: string; call: string; ranks: { fts: number | null; vector: number | null } }>; retrieval: { vectors: boolean; ftsOnlyReason?: string } }
  | { sufficient: false; items: [] };

const BODIES = [
  "Sam Rivera keeps the tent in his loft in Ashgrove.",
  "John Doe lends us the camping stove for the Kestrel Bay trip.",
  "Jane Doe packs the paper map of the Pinecrest trail.",
];

/** A stand-in model: [1, 0, 0] per text, a record of what it was asked, and a text it refuses when told to. */
function model(options: { refuse?: string } = {}): ModelsPort & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    embed: async (texts) => {
      calls.push(texts);
      // A vector of no values is refused by core as missing: that one memory fails, the rest are written.
      return texts.map((text) => (options.refuse && text.includes(options.refuse) ? [] : [1, 0, 0]));
    },
  };
}

async function recall(host: MiniHost, query: string): Promise<RecallAnswer> {
  return (await host.api.invoke("memory.recall", { query })) as RecallAnswer;
}

const reembedState = (host: MiniHost) => host.store.readValue(coreTools.shared.REEMBED_KEY) as coreTools.shared.ReembedState | null;

describe("the re-embed hook", () => {
  const open: MiniHost[] = [];
  afterEach(async () => {
    for (const host of open.splice(0)) await host.close();
  });
  async function start(options: Parameters<typeof throwawayHost>[0] = {}) {
    const host = await throwawayHost(options);
    open.push(host);
    return host;
  }

  it("turns the built-in embedder on: every memory gets a 512 value vector before the model counts as applied", async () => {
    const host = await start();
    for (const body of BODIES) await remember(host, { shelf: "LIF/TRV", body });
    expect((await recall(host, "tent")).sufficient && (await recall(host, "tent"))).toMatchObject({
      retrieval: { vectors: false, ftsOnlyReason: "no_embedding_model" },
    });

    const applied = await host.ports.settings.set({ embedding: { model: "reverie-lexical-v1", dim: null } });
    expect(applied.embedding).toEqual({ model: "reverie-lexical-v1", dim: 512 });
    expect(host.config().embedding).toEqual({ model: "reverie-lexical-v1", dim: 512 });
    const rows = await host.silo.embedding.findMany();
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.model === "reverie-lexical-v1" && row.dim === 512)).toBe(true);
    expect(reembedState(host)).toBeNull();

    const answer = await recall(host, "tent");
    expect(answer.sufficient && answer.retrieval).toEqual({ vectors: true });

    // From here a write embeds at commit, with no settings change.
    await remember(host, { shelf: "LIF/TRV", body: "Lena Ortiz brings the climbing rope." });
    expect(await host.silo.embedding.count({ where: { model: "reverie-lexical-v1" } })).toBe(4);

    // A dim change is a re-embed too.
    await host.ports.settings.set({ embedding: { model: "reverie-lexical-v1", dim: 128 } });
    expect(await host.silo.embedding.count({ where: { dim: 128 } })).toBe(4);
    expect(await host.silo.embedding.count({ where: { dim: { not: 128 } } })).toBe(0);
  });

  it("survives a restart half way: nothing applied, FTS only and saying so, then resumed without a second pass", async () => {
    const dir = throwawayDir();
    const first = await start({ dir, models: model({ refuse: "stove" }) });
    for (const body of BODIES) await remember(first, { shelf: "LIF/TRV", body });

    await expect(first.ports.settings.set({ embedding: { model: "test-model", dim: 3 } })).rejects.toThrow(
      /stopped with 1 memories still to do.*Nothing was applied/,
    );
    // Half done: two vectors of the new model, config still names none, the run is recorded.
    expect(first.config().embedding.model).toBeNull();
    expect(await first.silo.embedding.count({ where: { model: "test-model" } })).toBe(2);
    expect(reembedState(first)).toMatchObject({ model: "test-model", dim: 3, from: { model: null, dim: null }, remaining: 1 });
    const during = await recall(first, "tent");
    expect(during.sufficient && during.retrieval).toEqual({ vectors: false, ftsOnlyReason: "reembedding" });
    await first.close();
    open.splice(open.indexOf(first), 1);

    // The restart: a host on the same files, a model that works now.
    const working = model();
    const second = await start({ dir, models: working });
    const stillDuring = await recall(second, "tent");
    expect(stillDuring.sufficient && stillDuring.retrieval).toEqual({ vectors: false, ftsOnlyReason: "reembedding" });

    const report = await second.embedding.resume();
    expect(report).toMatchObject({ ran: "reembed", model: "test-model", dim: 3, embedded: 1, complete: true });
    expect(working.calls.flat()).toHaveLength(1);
    expect(working.calls.flat()[0]).toContain("stove");
    expect(second.config().embedding).toEqual({ model: "test-model", dim: 3 });
    expect(reembedState(second)).toBeNull();
    const after = await recall(second, "tent");
    expect(after.sufficient && after.retrieval).toEqual({ vectors: true });
  });

  it("never mixes two models in results while a change is under way, and setting the old model back resumes toward it", async () => {
    const host = await start({ models: model() });
    for (const body of BODIES) await remember(host, { shelf: "LIF/TRV", body });
    await host.ports.settings.set({ embedding: { model: "model-a", dim: 3 } });
    expect(await host.silo.embedding.count({ where: { model: "model-a" } })).toBe(3);

    // A model that refuses one text: a's and b's vectors now sit side by side.
    await expect(
      withModel(host, model({ refuse: "map" }), () => host.ports.settings.set({ embedding: { model: "model-b", dim: 3 } })),
    ).rejects.toThrow(/stopped/);
    expect(await host.silo.embedding.count({ where: { model: "model-a" } })).toBe(1);
    expect(await host.silo.embedding.count({ where: { model: "model-b" } })).toBe(2);
    expect(host.config().embedding.model).toBe("model-a");
    const during = await recall(host, "tent");
    expect(during.sufficient && during.retrieval).toEqual({ vectors: false, ftsOnlyReason: "reembedding" });
    expect(during.sufficient && during.items.every((item) => item.ranks.vector === null)).toBe(true);

    // Back to a: the two memories now holding b's vector are re-embedded with a, and b's rows go.
    await host.ports.settings.set({ embedding: { model: "model-a", dim: 3 } });
    expect(await host.silo.embedding.count({ where: { model: "model-a" } })).toBe(3);
    expect(await host.silo.embedding.count({ where: { model: { not: "model-a" } } })).toBe(0);
    expect(reembedState(host)).toBeNull();
    const back = await recall(host, "tent");
    expect(back.sufficient && back.retrieval).toEqual({ vectors: true });
  });

  it("setting the model to null drops every vector and the run under way: FTS only", async () => {
    const host = await start({ models: model({ refuse: "map" }) });
    for (const body of BODIES) await remember(host, { shelf: "LIF/TRV", body });
    await expect(host.ports.settings.set({ embedding: { model: "test-model", dim: 3 } })).rejects.toThrow(/stopped/);
    expect(reembedState(host)).not.toBeNull();

    await host.ports.settings.set({ embedding: { model: null, dim: null } });
    expect(await host.silo.embedding.count()).toBe(0);
    expect(reembedState(host)).toBeNull();
    const answer = await recall(host, "tent");
    expect(answer.sufficient && answer.retrieval).toEqual({ vectors: false, ftsOnlyReason: "no_embedding_model" });
  });

  it("fills a vector a write could not compute when it next runs, and status says what is missing", async () => {
    const host = await start();
    await host.ports.settings.set({ embedding: { model: "reverie-lexical-v1", dim: 64 } });
    const made = await remember(host, { shelf: "LIF/TRV", body: BODIES[0]! });
    await host.silo.embedding.deleteMany({ where: { memoryId: made.memory.id } });
    await remember(host, { shelf: "LIF/TRV", body: BODIES[1]! });
    expect(await host.embedding.status()).toMatchObject({ model: "reverie-lexical-v1", dim: 64, missing: 1, reembed: null });
    const partial = await recall(host, "tent stove");
    expect(partial.sufficient && partial.retrieval).toEqual({ vectors: false, ftsOnlyReason: "partial_embeddings", missingEmbeddings: 1 });

    const report = await host.embedding.resume();
    expect(report).toMatchObject({ ran: "fill", embedded: 1, complete: true });
    expect((await host.embedding.status()).missing).toBe(0);
    const whole = await recall(host, "tent stove");
    expect(whole.sufficient && whole.retrieval).toEqual({ vectors: true });
  });
});

/**
 * Runs `work` with the host's injected model behaving like `next`. The hook
 * calls the injected port it was built with, so its embed is swapped in place.
 */
async function withModel(host: MiniHost, next: ModelsPort, work: () => Promise<unknown>): Promise<unknown> {
  const injected = host.ports.models!;
  const embed = injected.embed;
  injected.embed = next.embed;
  try {
    return await work();
  } finally {
    injected.embed = embed;
  }
}

describe("vectors stay out of every file that leaves the silo", () => {
  const open: MiniHost[] = [];
  afterEach(async () => {
    for (const host of open.splice(0)) await host.close();
  });

  function filesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? filesUnder(full) : [full];
    });
  }

  it("snapshot and mirror hold no vector, and a silo restored from the snapshot is re-embedded", async () => {
    const host = await throwawayHost();
    open.push(host);
    await host.ports.settings.set({ embedding: { model: "reverie-lexical-v1", dim: 32 } });
    for (const body of BODIES) await remember(host, { shelf: "LIF/TRV", body });
    expect(await host.silo.embedding.count()).toBe(3);

    const { snapshot } = (await host.api.invoke("memory.export", {})) as { snapshot: Record<string, unknown> };
    const text = JSON.stringify(snapshot);
    expect(text).not.toMatch(/"embeddings?"\s*:/i);
    expect(text).not.toMatch(/"vector"\s*:/);
    expect(text).not.toContain("reverie-lexical-v1");

    const folder = join(throwawayDir(), "mirror");
    await host.api.invoke("memory.export", { to: "markdown", folder });
    const files = filesUnder(folder);
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toMatch(/embedding|"vector"/i);
      expect(content).not.toContain("reverie-lexical-v1");
    }

    // A fresh silo with vectors on: the replace import computes every vector.
    const restored = await throwawayHost();
    open.push(restored);
    await restored.ports.settings.set({ embedding: { model: "reverie-lexical-v1", dim: 32 } });
    const plan = (await restored.api.invoke("memory.import", { from: "snapshot", snapshot, mode: "replace", dryRun: true, confirmedByUser: true })) as {
      acknowledgement: string;
    };
    const result = (await restored.api.invoke("memory.import", {
      from: "snapshot",
      snapshot,
      mode: "replace",
      acknowledge: plan.acknowledgement,
      confirmedByUser: true,
    })) as { embedded?: number; needsEmbedding: number };
    expect(result).toMatchObject({ embedded: 3, needsEmbedding: 0 });
    const answer = await recall(restored, "tent");
    expect(answer.sufficient && answer.retrieval).toEqual({ vectors: true });

    // A fresh silo restored with vectors off, then turned on: the hook embeds what came in.
    const later = await throwawayHost();
    open.push(later);
    const plan2 = (await later.api.invoke("memory.import", { from: "snapshot", snapshot, mode: "replace", dryRun: true, confirmedByUser: true })) as {
      acknowledgement: string;
    };
    await later.api.invoke("memory.import", { from: "snapshot", snapshot, mode: "replace", acknowledge: plan2.acknowledgement, confirmedByUser: true });
    expect(await later.silo.embedding.count()).toBe(0);
    await later.ports.settings.set({ embedding: { model: "reverie-lexical-v1", dim: 32 } });
    expect(await later.silo.embedding.count({ where: { model: "reverie-lexical-v1", dim: 32 } })).toBe(3);
  });
});
