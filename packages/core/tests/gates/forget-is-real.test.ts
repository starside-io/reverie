import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeVector } from "../../src/domain/queries/vectors.js";
import type { ExportResult } from "../../src/tools/read/export.js";
import type { HistoryResult } from "../../src/tools/read/history.js";
import type { RecallResult } from "../../src/tools/read/recall.js";
import type { SearchResult } from "../../src/tools/read/search.js";
import type { TagsResult } from "../../src/tools/read/tags.js";
import type { TestHost } from "../test-host.js";
import { fsViewText, gateHost, remember, siloText } from "./harness.js";

/**
 * Gate: forget is real. After memory.forget: no row, no FTS hit (through
 * search and recall), no vector, no version content, and the memory is
 * absent from the export and from the mirror (fs_view, which the markdown
 * mirror is built on), and a tag only it carried is gone from the vocabulary.
 *
 * The host here has no models port, so the write path computes no vector
 * and recall stays on FTS alone, which keeps the abstention check below
 * exact. The vector is seeded straight into the silo before the forget: what
 * is under test is that forget drops it. tests/tools/shared/embedding.test.ts
 * checks the same for a vector the write path computed.
 */

const BODY = "Lent the ladder to the neighbours on Elm Street after the storm.";
const QUOTE = "I lent our ladder to the Elm Street neighbours.";

describe("forget is real", () => {
  let host: TestHost;
  let call: string;
  let memoryId: string;
  let backup: unknown;

  beforeEach(async () => {
    host = await gateHost();
    const kept = await remember(host, {
      shelf: "LIF/HOM",
      body: "The garden hose is coiled behind the shed.",
      tags: ["storm"],
    });
    const made = await remember(host, {
      shelf: "LIF/HOM",
      title: "Ladder lent out",
      body: BODY,
      said: QUOTE,
      tags: ["ladder", "storm"],
      attendees: ["Jane Doe"],
    });
    call = made.memory.call;
    memoryId = made.memory.id;
    await host.invoke("memory.update", { call, body: `${BODY} They will return it in January.` });
    await host.invoke("memory.link", { from: call, to: kept.memory.call, relation: "elaborates" });
    await host.db.embedding.create({ data: { memoryId, model: "test-model", dim: 3, vector: encodeVector([1, 0, 0]) } });

    // Found before the forget, so the checks below are not vacuous.
    expect((await host.invoke<SearchResult>("memory.search", { query: "ladder" })).items).toHaveLength(1);
    expect((await host.invoke<RecallResult>("memory.recall", { query: "ladder neighbours" })).sufficient).toBe(true);

    backup = (await host.invoke<ExportResult>("memory.export", {})).snapshot;
    await host.invoke("memory.forget", { call, confirmedByUser: true });
  });
  afterEach(async () => {
    await host.close();
  });

  it("leaves no row, no tag join, no reference, no link, no citation and no vector", async () => {
    expect(await host.db.memory.findUnique({ where: { id: memoryId } })).toBeNull();
    expect(await host.db.memoryTag.count({ where: { memoryId } })).toBe(0);
    expect(await host.db.memoryRef.count({ where: { memoryId } })).toBe(0);
    expect(await host.db.memorySource.count({ where: { memoryId } })).toBe(0);
    expect(await host.db.memoryLink.count({ where: { OR: [{ fromId: memoryId }, { toId: memoryId }] } })).toBe(0);
    expect(await host.db.embedding.count({ where: { memoryId } })).toBe(0);
    await expect(host.invoke("memory.get", { call })).rejects.toMatchObject({ code: "not_found" });
  });

  it("drops a tag only the forgotten memory carried from memory.tags, and keeps one another memory carries", async () => {
    const { tags } = await host.invoke<TagsResult>("memory.tags", {});
    const slugs = tags.map((tag) => tag.slug);
    expect(slugs).not.toContain("ladder");
    expect(await host.db.tag.count({ where: { slug: "ladder" } })).toBe(0);
    expect(tags).toContainEqual(expect.objectContaining({ slug: "storm", count: 1 }));
  });

  it("gives no hit through search or recall, and none in the FTS index", async () => {
    expect((await host.invoke<SearchResult>("memory.search", { query: "ladder" })).items).toEqual([]);
    expect(await host.invoke<RecallResult>("memory.recall", { query: "ladder neighbours" })).toEqual({ items: [], sufficient: false });
    const hits = await host.db.$queryRawUnsafe<unknown[]>(`SELECT rowid FROM "memory_fts" WHERE "memory_fts" MATCH 'ladder'`);
    expect(hits).toEqual([]);
  });

  it("keeps every version's operation, actor and time, and none of its content", async () => {
    const versions = await host.db.memoryVersion.findMany({ where: { memoryId } });
    expect(versions.length).toBeGreaterThanOrEqual(3);
    for (const version of versions) {
      expect(version.body).toBeNull();
      expect(version.contentSha256).toBeNull();
    }
    expect(versions.map((version) => version.operation)).toContain("forget");
    await expect(host.invoke<HistoryResult>("memory.history", { call })).rejects.toMatchObject({ code: "not_found" });
  });

  it("is absent from the export, the mirror and every table of the silo", async () => {
    const { snapshot } = await host.invoke<ExportResult>("memory.export", {});
    const exported = JSON.stringify(snapshot);
    const mirror = await fsViewText(host);
    const silo = await siloText(host);
    for (const text of [BODY, "They will return it in January", QUOTE, "Ladder lent out"]) {
      expect(exported).not.toContain(text);
      expect(mirror).not.toContain(text);
      expect(silo).not.toContain(text);
    }
    // What stays is the redacted history (operation, actor, time) and the retired number.
    expect(snapshot.memories.map((memory) => memory.id)).not.toContain(memoryId);
    expect(snapshot.versions.filter((version) => version.memoryId === memoryId).every((version) => version.body === null)).toBe(true);
    expect(snapshot.aliases).toContainEqual(expect.objectContaining({ oldCallNumber: call, memoryId: null }));
    expect(mirror).toContain("The garden hose is coiled behind the shed.");
  });

  it("a backup taken before the forget never brings it back", async () => {
    expect(JSON.stringify(backup)).toContain(BODY);
    const result = await host.invoke<{ counts: { forgottenSkipped: number } }>("memory.import", {
      snapshot: backup,
      mode: "merge",
      confirmedByUser: true,
    });
    expect(result.counts.forgottenSkipped).toBe(1);
    expect(await host.db.memory.findUnique({ where: { id: memoryId } })).toBeNull();
    expect(await siloText(host)).not.toContain(BODY);
  });
});

/**
 * The same gate with vectors on (M8): a models port and an embedding model
 * configured, so the write path computed the vector itself. After the forget
 * no vector of it is left, the vector leg of recall cannot find it, and a
 * re-embed of the library does not bring it back.
 */
describe("forget is real, with vectors on", () => {
  let host: TestHost;
  afterEach(async () => {
    await host.close();
  });

  it("leaves no vector, gives no vector hit, and a re-embed never brings it back", async () => {
    host = await gateHost({ models: true, config: { embedding: { model: "test-model", dim: 3 } } });
    await remember(host, { shelf: "LIF/HOM", body: "The garden hose is coiled behind the shed." });
    const made = await remember(host, { shelf: "LIF/HOM", title: "Ladder lent out", body: BODY, said: QUOTE });
    expect(made.embedding).toEqual({ status: "written", model: "test-model" });
    const before = await host.invoke<RecallResult>("memory.recall", { query: "ladder neighbours" });
    expect(before.sufficient && before.retrieval.vectors).toBe(true);

    await host.invoke("memory.forget", { call: made.memory.call, confirmedByUser: true });
    expect(await host.db.embedding.count({ where: { memoryId: made.memory.id } })).toBe(0);
    expect(await host.db.embedding.count()).toBe(1);

    // The test port gives every text of the same length the same vector, so a
    // query that long would rank the forgotten memory first if its row were left.
    const probe = "x".repeat(embeddingTextLength(made.memory.title, BODY));
    const after = await host.invoke<RecallResult>("memory.recall", { query: probe });
    const ids = after.sufficient ? after.items.map((item) => item.id) : [];
    expect(ids).not.toContain(made.memory.id);

    const { runReembed } = await import("../../src/domain/embeddings.js");
    await runReembed(host.db, (texts) => host.ports.models!.embed(texts), { model: "test-model-2", dim: 3 });
    expect(await host.db.embedding.count({ where: { memoryId: made.memory.id } })).toBe(0);
    expect(await host.db.memory.count({ where: { id: made.memory.id } })).toBe(0);
  });
});

function embeddingTextLength(title: string, body: string): number {
  return `${title}\n\n${body}`.length;
}
