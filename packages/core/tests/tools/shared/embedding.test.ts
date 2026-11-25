import { afterEach, describe, expect, it } from "vitest";

import { embeddingText, fillMissingEmbeddings, reembedAll } from "../../../src/domain/embeddings.js";
import { decodeVector } from "../../../src/domain/queries/vectors.js";
import type { ExportResult } from "../../../src/tools/read/export.js";
import type { RecallResult } from "../../../src/tools/read/recall.js";
import type { ImportWriteResult } from "../../../src/tools/confirm/import.js";
import type { MergeToolResult } from "../../../src/tools/confirm/merge.js";
import type { PromoteProcedureResult } from "../../../src/tools/confirm/promote-procedure.js";
import type { RememberResult } from "../../../src/tools/write/remember.js";
import type { SupersedeToolResult } from "../../../src/tools/write/supersede.js";
import type { UpdateToolResult } from "../../../src/tools/write/update.js";
import { candidate, extractAndConfirm, turns } from "../../gates/harness.js";
import { testHost, type TestHost, type TestHostOptions } from "../../test-host.js";

/**
 * The write side of the vector cache: every commit that creates a memory or
 * changes its title or body writes its Embedding row, computed before the
 * commit opens. The test host's models port embeds a text as
 * [length % 7, 1, 0] and records every call in embedCalls. All data is
 * invented.
 */

const NOW = new Date("2026-12-27T10:00:00.000Z");
const MODEL = { embedding: { model: "test-model", dim: 3 } };

/** The vector the test port gives a memory with this title and body. */
function fake(title: string, body: string): number[] {
  return [embeddingText({ title, body }).length % 7, 1, 0];
}

describe("embeddings on the write path", () => {
  let host: TestHost;

  async function open(options: TestHostOptions = {}) {
    host = await testHost({ now: NOW, session: { id: "session-1" }, ...options });
    return host;
  }
  afterEach(async () => {
    await host.close();
  });

  async function vectorOf(memoryId: string) {
    const row = await host.db.embedding.findUnique({ where: { memoryId } });
    return row ? { model: row.model, dim: row.dim, vector: decodeVector(row.vector, row.dim) } : null;
  }

  function remember(input: Record<string, unknown>) {
    return host.invoke<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/HOM", ...input });
  }

  it("does nothing and fails nothing with no models port", async () => {
    await open({ config: MODEL });
    const result = await remember({ body: "Jane Doe keeps the spare key under the blue pot." });
    expect(result).not.toHaveProperty("embedding");
    expect(await host.db.embedding.count()).toBe(0);
  });

  it("does nothing and calls no model with a models port but no model configured", async () => {
    await open({ models: true });
    const result = await remember({ body: "Jane Doe keeps the spare key under the blue pot." });
    expect(result).not.toHaveProperty("embedding");
    expect(host.embedCalls).toEqual([]);
    expect(await host.db.embedding.count()).toBe(0);
  });

  it("remember writes the vector of title and body, in the shared encoding", async () => {
    await open({ models: true, config: MODEL });
    const result = await remember({ title: "Spare key", body: "Jane Doe keeps the spare key under the blue pot." });
    expect(result.embedding).toEqual({ status: "written", model: "test-model" });
    expect(host.embedCalls).toEqual([[embeddingText({ title: "Spare key", body: "Jane Doe keeps the spare key under the blue pot." })]]);
    expect(await vectorOf(result.memory.id)).toEqual({
      model: "test-model",
      dim: 3,
      vector: fake("Spare key", "Jane Doe keeps the spare key under the blue pot."),
    });
  });

  it("never holds the writer across the model call", async () => {
    await open({ models: true, config: MODEL });
    // The model writes to the silo while it embeds. With a transaction held
    // open around the call, this write would wait on it and time out.
    host.ports.models = {
      embed: async (texts) => {
        await host.db.sessionNote.create({ data: { sessionId: "probe", body: "probe", expiresAt: NOW } });
        return texts.map(() => [1, 1, 0]);
      },
    };
    const result = await remember({ body: "John Doe waters the plants on Fridays." });
    expect(result.embedding).toEqual({ status: "written", model: "test-model" });
    expect(await host.db.sessionNote.count({ where: { sessionId: "probe" } })).toBe(1);
  });

  it("a failing model never fails the write: the memory commits and the result says the vector is missing", async () => {
    await open({ models: true, config: MODEL });
    const kept = await remember({ body: "Sam Rivera brings the folding table." });
    host.ports.models = {
      embed: async () => {
        throw new Error("The model is not loaded.");
      },
    };
    const result = await remember({ body: "John Doe waters the plants on Fridays." });
    expect(result.embedding).toEqual({ status: "missing", model: "test-model", reason: "The model is not loaded." });
    expect(await host.db.memory.count({ where: { id: result.memory.id } })).toBe(1);
    expect(await vectorOf(result.memory.id)).toBeNull();

    // A body change the model cannot embed leaves no stale vector behind.
    expect(await vectorOf(kept.memory.id)).not.toBeNull();
    const updated = await host.invoke<UpdateToolResult>("memory.update", {
      call: kept.memory.call,
      body: "Sam Rivera brings the folding table and six chairs.",
    });
    expect(updated.changed).toBe(true);
    expect(updated.embedding).toMatchObject({ status: "missing" });
    expect(await vectorOf(kept.memory.id)).toBeNull();
  });

  it("a vector of the wrong dimension is refused as missing, never stored", async () => {
    await open({ models: true, config: { embedding: { model: "test-model", dim: 4 } } });
    const result = await remember({ body: "Jane Doe keeps the spare key under the blue pot." });
    expect(result.embedding).toEqual({
      status: "missing",
      model: "test-model",
      reason: "The model returned 3 values; embedding.dim is 4.",
    });
    expect(await host.db.embedding.count()).toBe(0);
  });

  it("update re-embeds on a new title or body, and not on anything else", async () => {
    await open({ models: true, config: MODEL });
    const written = await remember({ title: "Plants", body: "John Doe waters the plants on Fridays." });
    host.embedCalls.length = 0;

    const importance = await host.invoke<UpdateToolResult>("memory.update", { call: written.memory.call, importance: 5 });
    expect(importance.changed).toBe(true);
    expect(importance).not.toHaveProperty("embedding");
    expect(host.embedCalls).toEqual([]);

    const body = "John Doe waters the plants on Fridays and Tuesdays.";
    const reworded = await host.invoke<UpdateToolResult>("memory.update", { call: written.memory.call, body });
    expect(reworded.embedding).toEqual({ status: "written", model: "test-model" });
    expect(host.embedCalls).toEqual([[embeddingText({ title: "Plants", body })]]);
    expect((await vectorOf(written.memory.id))?.vector).toEqual(fake("Plants", body));
  });

  it("supersede embeds the replacement and leaves the old entry's vector as it was", async () => {
    await open({ models: true, config: MODEL });
    const old = await remember({ title: "Address", body: "Sam Rivera lives on Oak Street." });
    const before = await vectorOf(old.memory.id);
    const result = await host.invoke<SupersedeToolResult>("memory.supersede", {
      call: old.memory.call,
      title: "Address",
      body: "Sam Rivera lives on Elm Street since 2026-12-20.",
    });
    expect(result.embedding).toEqual({ status: "written", model: "test-model" });
    expect((await vectorOf(result.replacement.id))?.vector).toEqual(fake("Address", "Sam Rivera lives on Elm Street since 2026-12-20."));
    expect(await vectorOf(old.memory.id)).toEqual(before);
  });

  it("promote_procedure embeds the new procedure", async () => {
    await open({ models: true, config: MODEL });
    const result = await host.invoke<PromoteProcedureResult>("memory.promote_procedure", {
      title: "Commit style",
      body: "Write commit messages in the imperative.",
      why: "The owner reads the log as a list of actions.",
      howToApply: "Every commit in every project.",
      confirmedByUser: true,
    });
    expect(result.embedding).toEqual({ status: "written", model: "test-model" });
    expect((await vectorOf(result.memory.id))?.vector).toEqual(fake("Commit style", "Write commit messages in the imperative."));
  });

  it("merge keeps the survivor's vector without a model call, and fills one it lacks", async () => {
    await open({ models: true, config: MODEL });
    const survivor = await remember({ kind: "preference", body: "Prefers oat milk in coffee." });
    const absorbed = await remember({ kind: "preference", body: "Likes oat milk lattes with cinnamon." });
    host.embedCalls.length = 0;
    const merged = await host.invoke<MergeToolResult>("memory.merge", {
      survivor: survivor.memory.call,
      absorbed: absorbed.memory.call,
      confirmedByUser: true,
    });
    expect(merged.embedding).toEqual({ status: "written", model: "test-model" });
    expect(host.embedCalls).toEqual([]);
    expect(await vectorOf(absorbed.memory.id)).toBeNull();

    const third = await remember({ kind: "preference", body: "Takes oat milk in tea too." });
    await host.db.embedding.delete({ where: { memoryId: survivor.memory.id } });
    await host.invoke("memory.merge", { survivor: survivor.memory.call, absorbed: third.memory.call, confirmedByUser: true });
    expect(host.embedCalls).toHaveLength(2);
    expect(await vectorOf(survivor.memory.id)).not.toBeNull();
  });

  it("a drafted memory confirmed through decide is embedded as it commits", async () => {
    await open({ models: true, config: MODEL });
    const text = "Prefers oat milk in coffee.";
    const { decided } = await extractAndConfirm(host, turns(text), candidate());
    const committed = decided.committed!;
    const row = await host.db.memory.findUniqueOrThrow({ where: { callNumber: committed.call } });
    expect(decided.result).toMatchObject({ embedding: { status: "written", model: "test-model" } });
    expect((await vectorOf(row.id))?.vector).toEqual(fake(row.title, row.body));
  });

  it("import embeds what it wrote before its transaction, and reports what the model failed", async () => {
    await open({ models: true, config: MODEL });
    const a = await remember({ body: "Jane Doe keeps the spare key under the blue pot." });
    const b = await remember({ body: "John Doe waters the plants on Fridays." });
    const { snapshot } = await host.invoke<ExportResult>("memory.export", {});
    await host.invoke("memory.forget", { call: b.memory.call, confirmedByUser: true });
    await host.db.embedding.deleteMany();
    host.embedCalls.length = 0;

    // A merge back in: a is unchanged, b is forgotten here and skipped. Neither is handed to the model.
    const merged = await host.invoke<ImportWriteResult>("memory.import", { snapshot, mode: "merge", confirmedByUser: true });
    expect(host.embedCalls).toEqual([]);
    expect(merged.embedded).toBe(0);

    // A replace writes every memory afresh: each is embedded.
    const plan = await host.invoke<{ acknowledgement: string }>("memory.import", {
      snapshot,
      mode: "replace",
      dryRun: true,
      confirmedByUser: true,
    });
    const replaced = await host.invoke<ImportWriteResult>("memory.import", {
      snapshot,
      mode: "replace",
      acknowledge: plan.acknowledgement,
      confirmedByUser: true,
    });
    expect(replaced.embedded).toBe(2);
    expect(replaced.needsEmbedding).toBe(0);
    expect(host.embedCalls.flat()).toHaveLength(2);
    expect(await vectorOf(a.memory.id)).not.toBeNull();

    host.ports.models = {
      embed: async () => {
        throw new Error("The model is not loaded.");
      },
    };
    const again = await host.invoke<{ acknowledgement: string }>("memory.import", {
      snapshot,
      mode: "replace",
      dryRun: true,
      confirmedByUser: true,
    });
    const failed = await host.invoke<ImportWriteResult>("memory.import", {
      snapshot,
      mode: "replace",
      acknowledge: again.acknowledgement,
      confirmedByUser: true,
    });
    expect(failed.counts.memories).toBe(2);
    expect(failed.embedded).toBe(0);
    expect(failed.needsEmbedding).toBe(2);
  });

  it("forget drops a vector the write path wrote", async () => {
    await open({ models: true, config: MODEL });
    const written = await remember({ body: "Lent the ladder to Sam Rivera." });
    expect(await vectorOf(written.memory.id)).not.toBeNull();
    await host.invoke("memory.forget", { call: written.memory.call, confirmedByUser: true });
    expect(await host.db.embedding.count()).toBe(0);
  });
});

describe("re-embed and fill", () => {
  let host: TestHost;

  afterEach(async () => {
    await host.close();
  });

  const embed = (texts: string[]) => host.ports.models!.embed(texts);

  async function library() {
    host = await testHost({ now: NOW, session: { id: "session-1" }, models: true, config: MODEL });
    const bodies = [
      "Jane Doe keeps the spare key under the blue pot.",
      "John Doe waters the plants on Fridays.",
      "Sam Rivera brings the folding table.",
    ];
    const ids: string[] = [];
    for (const body of bodies) {
      ids.push((await host.invoke<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/HOM", body })).memory.id);
    }
    return ids;
  }

  const recall = (query: string) => host.invoke<RecallResult>("memory.recall", { query });
  const retrieval = async (query: string) => {
    const result = await recall(query);
    return result.sufficient ? result.retrieval : null;
  };

  it("recall uses vectors once every active memory has one", async () => {
    await library();
    expect(await retrieval("spare key")).toEqual({ vectors: true });
  });

  it("replaces every vector with the new model's and removes the old model's rows", async () => {
    const ids = await library();
    const result = await reembedAll(host.db, embed, { model: "test-model-2", dim: null });
    expect(result).toMatchObject({ model: "test-model-2", dim: 3, failed: [], removed: 0 });
    expect([...result.embedded].sort()).toEqual([...ids].sort());
    expect(await host.db.embedding.count({ where: { model: "test-model-2" } })).toBe(3);
    expect(await host.db.embedding.count({ where: { model: { not: "test-model-2" } } })).toBe(0);
  });

  it("until a re-embed finishes, recall runs on FTS alone and says how many vectors are missing", async () => {
    const ids = await library();
    let calls = 0;
    const flaky = async (texts: string[]) => {
      calls += 1;
      if (calls === 2) throw new Error("The model went away.");
      return embed(texts);
    };
    // The settings hook re-embeds before the new value counts as applied, so
    // config still names the old model while this runs.
    const result = await reembedAll(host.db, flaky, { model: "test-model-2", dim: 3 }, { batchSize: 1 });
    expect(result.embedded).toHaveLength(2);
    expect(result.failed).toEqual([{ memoryId: expect.any(String), reason: "The model went away." }]);

    // The old model's rows are gone and the new model is not applied yet.
    expect(await retrieval("spare key")).toEqual({ vectors: false, ftsOnlyReason: "no_embeddings" });

    // Applied with one vector still missing: FTS alone, and it says so.
    await host.ports.settings.set({ embedding: { model: "test-model-2", dim: 3 } });
    expect(await retrieval("spare key")).toEqual({
      vectors: false,
      ftsOnlyReason: "partial_embeddings",
      missingEmbeddings: 1,
    });

    // Filling the missing one brings vectors back.
    const filled = await fillMissingEmbeddings(host.db, embed, { model: "test-model-2", dim: 3 });
    expect(filled.embedded).toEqual([result.failed[0]!.memoryId]);
    expect(ids).toContain(filled.embedded[0]);
    expect(await retrieval("spare key")).toEqual({ vectors: true });
  });

  it("fills only the memories named, and never embeds one twice", async () => {
    const ids = await library();
    await host.db.embedding.deleteMany({ where: { memoryId: { in: [ids[0]!, ids[1]!] } } });
    host.embedCalls.length = 0;
    const first = await fillMissingEmbeddings(host.db, embed, { model: "test-model", dim: 3 }, { memoryIds: [ids[0]!, ids[2]!] });
    expect(first.embedded).toEqual([ids[0]]);
    expect(host.embedCalls.flat()).toHaveLength(1);

    const rest = await fillMissingEmbeddings(host.db, embed, { model: "test-model", dim: 3 });
    expect(rest.embedded).toEqual([ids[1]]);
    const none = await fillMissingEmbeddings(host.db, embed, { model: "test-model", dim: 3 });
    expect(none.embedded).toEqual([]);
  });
});
