import { afterEach, describe, expect, it } from "vitest";

import {
  decodeVector,
  deleteEmbedding,
  deleteOtherEmbeddings,
  encodeVector,
  loadEmbeddings,
  missingEmbeddingWhere,
  upsertEmbedding,
} from "../../src/storage/embeddings.js";
import type { RememberResult } from "../../src/tools/write/remember.js";
import { testHost, type TestHost } from "../test-host.js";

/**
 * The Embedding table in storage terms (docs/SPEC.md section 11): float32,
 * little endian, `dim` values, one row per memory, keyed to model and dim.
 * All data invented.
 */

describe("vector encoding", () => {
  it("round trips float32 values, little endian, four bytes each", () => {
    const vector = [0.25, -1.5, 3, 0];
    const bytes = encodeVector(vector);
    expect(bytes.byteLength).toBe(16);
    // 0.25 as float32 is 0x3e800000: little endian puts 0x00 first and 0x3e last.
    expect([...bytes.slice(0, 4)]).toEqual([0x00, 0x00, 0x80, 0x3e]);
    expect(decodeVector(bytes, 4)).toEqual(vector);
  });

  it("keeps float32 precision, not float64", () => {
    const decoded = decodeVector(encodeVector([0.1]), 1)!;
    expect(decoded[0]).toBeCloseTo(0.1, 6);
    expect(decoded[0]).not.toBe(0.1);
  });

  it("refuses bytes whose length does not match the dim, rather than guess", () => {
    const bytes = encodeVector([1, 2, 3]);
    expect(decodeVector(bytes, 4)).toBeNull();
    expect(decodeVector(bytes, 0)).toBeNull();
    expect(decodeVector(bytes.slice(0, 11), 3)).toBeNull();
  });

  it("decodes a view into a larger buffer at an offset", () => {
    const whole = new Uint8Array(20);
    whole.set(encodeVector([7, 8]), 4);
    expect(decodeVector(whole.subarray(4, 12), 2)).toEqual([7, 8]);
  });
});

describe("the Embedding table", () => {
  let host: TestHost;
  afterEach(async () => {
    await host.close();
  });

  async function memories(count: number): Promise<string[]> {
    host = await testHost({ now: new Date("2026-12-27T10:00:00.000Z") });
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const body = ["Sam Rivera keeps the tent.", "John Doe has the stove.", "Jane Doe packs the map."][index]!;
      ids.push((await host.invoke<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/TRV", body })).memory.id);
    }
    return ids;
  }

  it("upserts one row per memory, replacing model, dim and vector", async () => {
    const [id] = await memories(1);
    await upsertEmbedding(host.db, { memoryId: id!, model: "m1", dim: 2, vector: [1, 0] });
    await upsertEmbedding(host.db, { memoryId: id!, model: "m2", dim: 3, vector: [0, 1, 0] });
    const rows = await host.db.embedding.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memoryId: id, model: "m2", dim: 3 });
    expect(decodeVector(rows[0]!.vector, rows[0]!.dim)).toEqual([0, 1, 0]);
  });

  it("refuses a vector whose length is not its dim", async () => {
    const [id] = await memories(1);
    await expect(upsertEmbedding(host.db, { memoryId: id!, model: "m1", dim: 3, vector: [1, 0] })).rejects.toThrow(/dim 3/);
    expect(await host.db.embedding.count()).toBe(0);
  });

  it("loads only the vectors of one model and dim, and deletes by memory or by model", async () => {
    const [a, b, c] = await memories(3);
    await upsertEmbedding(host.db, { memoryId: a!, model: "m1", dim: 2, vector: [1, 0] });
    await upsertEmbedding(host.db, { memoryId: b!, model: "m1", dim: 3, vector: [1, 0, 0] });
    await upsertEmbedding(host.db, { memoryId: c!, model: "m2", dim: 2, vector: [0, 1] });

    expect((await loadEmbeddings(host.db, { model: "m1", dim: 2 })).map((row) => row.id)).toEqual([a]);
    expect((await loadEmbeddings(host.db, { model: "m1" })).map((row) => row.id).sort()).toEqual([a, b].sort());
    expect(await loadEmbeddings(host.db, { model: "m3" })).toEqual([]);

    const missing = await host.db.memory.findMany({ where: missingEmbeddingWhere("m1", 2), select: { id: true } });
    expect(missing.map((row) => row.id).sort()).toEqual([b, c].sort());

    expect(await deleteOtherEmbeddings(host.db, { model: "m1", dim: 2 })).toBe(2);
    await deleteEmbedding(host.db, a!);
    expect(await host.db.embedding.count()).toBe(0);
  });

  it("cascades a vector away with its memory row", async () => {
    const [id] = await memories(1);
    await upsertEmbedding(host.db, { memoryId: id!, model: "m1", dim: 2, vector: [1, 0] });
    const found = await host.db.memory.findUniqueOrThrow({ where: { id: id! } });
    await host.invoke("memory.forget", { call: found.callNumber, confirmedByUser: true });
    expect(await host.db.embedding.count()).toBe(0);
  });
});
