import { afterEach, describe, expect, it } from "vitest";

import { retireMemory, supersedeMemory } from "../../../src/domain/memories.js";
import { encodeVector } from "../../../src/domain/queries/vectors.js";
import { RECALL_NOTICE } from "../../../src/domain/recall/frame.js";
import type { RecallResult } from "../../../src/tools/read/recall.js";
import { auditStrings, PEOPLE, testHost, type TestHost, type TestHostOptions } from "../../test-host.js";
import { external, NOW, project, seed, stated } from "./fixtures.js";

type Sufficient = Extract<RecallResult, { sufficient: true }>;

describe("memory.recall", () => {
  let host: TestHost;

  async function open(options: TestHostOptions = {}) {
    host = await testHost({ now: NOW, session: { id: "session-1" }, ...options });
    return host;
  }
  afterEach(async () => {
    await host.close();
  });

  it("returns framed items with the notice, call number, age, trust, source and score", async () => {
    await open();
    const memory = await seed(host, { tags: ["christmas"], refs: [{ role: "attendee", uri: PEOPLE.jane.uri, label: "Jane Doe" }] });

    const result = await host.invoke<Sufficient>("memory.recall", { query: "what happened with the oven at christmas" });
    expect(result.sufficient).toBe(true);
    expect(result.notice).toBe(RECALL_NOTICE);
    expect(result.retrieval).toEqual({ vectors: false, ftsOnlyReason: "no_models_port" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: memory.id,
      call: "LIF/GTH/2026-12-24/001",
      kind: "episode",
      trust: "stated",
      ageDays: 3,
      tags: ["christmas"],
      attendees: [PEOPLE.jane.uri],
      source: { kind: "conversation", label: "session of 2026-12-27" },
    });
    expect(result.items[0]!.score).toBeGreaterThanOrEqual(host.config.recall.floor);
    expect(result.recallId).toEqual(expect.any(String));
  });

  it("abstains with exactly { items: [], sufficient: false } when nothing matches", async () => {
    await open();
    await seed(host);
    const result = await host.invoke("memory.recall", { query: "kayak paddles in norway" });
    expect(result).toEqual({ items: [], sufficient: false });

    const logs = await host.db.recallLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.memoryIds).toEqual([]);
  });

  it("never pads from below the floor", async () => {
    await open({ config: { recall: { floor: 0.5 } } });
    // External trust weighs 0.3, so even the top rank scores under 0.5.
    await seed(host, { trust: "external", sources: external("the oven died, so pizza was ordered") });
    const result = await host.invoke("memory.recall", { query: "oven pizza" });
    expect(result).toEqual({ items: [], sufficient: false });
  });

  it("isolates scopes: global plus this project, agent and session, never another's", async () => {
    await open({
      session: { id: "session-1", agent: "agent-a", folder: "/work/alpha" },
      localPaths: [{ project: "alpha", path: "/work/alpha" }],
    });
    await project(host, "alpha");
    await project(host, "beta");
    const make = (title: string, scope: "global" | "project" | "agent" | "session", scopeRef?: string) =>
      seed(host, { title, body: `${title}: the release checklist lives in the wiki.`, scope, ...(scopeRef ? { scopeRef } : {}) });
    await make("Global note", "global");
    await make("Alpha note", "project", "alpha");
    await make("Beta note", "project", "beta");
    await make("Agent A note", "agent", "agent-a");
    await make("Agent B note", "agent", "agent-b");
    await make("Session one note", "session", "session-1");
    await make("Session two note", "session", "session-2");

    const result = await host.invoke<Sufficient>("memory.recall", { query: "release checklist", maxItems: 20, budget: 20000 });
    const bodies = result.items.map((item) => item.body.split(":")[0]).sort();
    expect(bodies).toEqual(["Agent A note", "Alpha note", "Global note", "Session one note"]);

    const log = await host.db.recallLog.findFirstOrThrow();
    expect(log).toMatchObject({ scope: "session", scopeRef: "session-1" });
  });

  it("recalls no project memory when the session resolves to no project", async () => {
    await open({ session: { id: "session-1", folder: "/somewhere/else" } });
    await project(host, "alpha");
    await seed(host, { title: "Alpha", body: "Alpha deploys on Fridays.", scope: "project", scopeRef: "alpha" });
    expect(await host.invoke("memory.recall", { query: "deploys fridays" })).toEqual({ items: [], sufficient: false });
  });

  it("recalls only active entries, and with asOf what was valid then", async () => {
    await open();
    const old = await seed(host, {
      title: "Dentist",
      body: "The dentist is Dr Rivera on Main Street.",
      kind: "fact",
      shelf: "LIF/HLT",
      occurredOn: "2026-01-10",
    });
    await supersedeMemory(
      host.db,
      { id: old.id },
      {
        shelf: "LIF/HLT",
        occurredOn: "2026-12-01",
        kind: "fact",
        title: "Dentist",
        body: "The dentist is now Dr Doe on High Street.",
        trust: "stated",
        validFrom: "2026-12-01T00:00:00.000Z",
        sources: stated("we switched dentists"),
      },
      { actor: "user", at: NOW },
    );
    const retired = await seed(host, { title: "Old dentist card", body: "The dentist card is in the drawer.", kind: "fact" });
    await retireMemory(host.db, { id: retired.id }, { actor: "user", at: NOW });

    const now = await host.invoke<Sufficient>("memory.recall", { query: "dentist" });
    expect(now.items.map((item) => item.body)).toEqual(["The dentist is now Dr Doe on High Street."]);

    const then = await host.invoke<Sufficient>("memory.recall", { query: "dentist", asOf: "2026-06-01T00:00:00.000Z" });
    expect(then.items.map((item) => item.body)).toEqual(["The dentist is Dr Rivera on Main Street."]);
  });

  it("filters by shelf or call prefix, and by tags to include or exclude", async () => {
    await open();
    await seed(host, { title: "Pizza at Christmas", body: "We ordered pizza at Christmas.", tags: ["christmas"] });
    await seed(host, { title: "Pizza in Rome", body: "The best pizza was in Rome.", shelf: "LIF/TRV", occurredOn: "2026-05-02", tags: ["vacation"] });

    const shelf = await host.invoke<Sufficient>("memory.recall", { query: "pizza", shelf: "LIF/TRV" });
    expect(shelf.items.map((item) => item.call)).toEqual(["LIF/TRV/2026-05-02/001"]);
    const prefix = await host.invoke<Sufficient>("memory.recall", { query: "pizza", shelf: "LIF/GTH/2026-12" });
    expect(prefix.items.map((item) => item.call)).toEqual(["LIF/GTH/2026-12-24/001"]);
    const include = await host.invoke<Sufficient>("memory.recall", { query: "pizza", tags: ["#Vacation"] });
    expect(include.items.map((item) => item.call)).toEqual(["LIF/TRV/2026-05-02/001"]);
    const exclude = await host.invoke<Sufficient>("memory.recall", { query: "pizza", excludeTags: ["vacation"] });
    expect(exclude.items.map((item) => item.call)).toEqual(["LIF/GTH/2026-12-24/001"]);
  });

  it("packs by score within maxItems and the token budget", async () => {
    await open();
    for (let index = 0; index < 5; index += 1) {
      await seed(host, { title: `Board game night ${index}`, body: `Board game night number ${index} with Sam Rivera.` });
    }
    const capped = await host.invoke<Sufficient>("memory.recall", { query: "board game night", maxItems: 2 });
    expect(capped.items).toHaveLength(2);
    const scores = capped.items.map((item) => item.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    const full = await host.invoke<Sufficient>("memory.recall", { query: "board game night" });
    const tight = await host.invoke<Sufficient>("memory.recall", { query: "board game night", budget: 100 });
    expect(full.items).toHaveLength(5);
    expect(tight.items.length).toBeGreaterThan(0);
    expect(tight.items.length).toBeLessThan(full.items.length);
    const { id: _id, ...framed } = tight.items[0]!;
    expect(Math.ceil(JSON.stringify(framed).length / 4) * tight.items.length).toBeLessThanOrEqual(100);
  });

  it("writes one RecallLog row of ids and scores and bumps only the recall bookkeeping", async () => {
    await open();
    const memory = await seed(host);
    const before = await host.db.memory.findUniqueOrThrow({ where: { id: memory.id } });
    const versionsBefore = await host.db.memoryVersion.count();

    const result = await host.invoke<Sufficient>("memory.recall", { query: "oven pizza secretword" });
    const logs = await host.db.recallLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ id: result.recallId, memoryIds: [memory.id], budget: 1200 });
    expect((logs[0]!.scores as number[])[0]).toBeCloseTo(result.items[0]!.score, 2);
    expect(JSON.stringify(logs)).not.toContain("secretword");

    const after = await host.db.memory.findUniqueOrThrow({ where: { id: memory.id } });
    expect(after.recallCount).toBe(before.recallCount + 1);
    expect(after.lastRecalledAt?.toISOString()).toBe(NOW.toISOString());
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.lastConfirmedAt.getTime()).toBe(before.lastConfirmedAt.getTime());
    expect(await host.db.memoryVersion.count()).toBe(versionsBefore);
  });

  it("fuses vectors when a model is configured and embeddings exist, and says FTS only otherwise", async () => {
    await open({ models: true });
    const memory = await seed(host, { title: "Sourdough", body: "Feed the sourdough starter every morning." });
    const noModel = await host.invoke<Sufficient>("memory.recall", { query: "sourdough" });
    expect(noModel.retrieval).toEqual({ vectors: false, ftsOnlyReason: "no_embedding_model" });

    await host.ports.settings.set({ embedding: { model: "test-model", dim: 3 } });
    const noRows = await host.invoke<Sufficient>("memory.recall", { query: "sourdough" });
    expect(noRows.retrieval).toEqual({ vectors: false, ftsOnlyReason: "no_embeddings" });

    // The test port embeds a text as [length % 7, 1, 0]: "starter care" is 12 long.
    await host.db.embedding.create({
      data: { memoryId: memory.id, model: "test-model", dim: 3, vector: encodeVector([5, 1, 0]) },
    });
    const hybrid = await host.invoke<Sufficient>("memory.recall", { query: "starter care" });
    expect(hybrid.retrieval).toEqual({ vectors: true });
    expect(hybrid.items.map((item) => item.id)).toEqual([memory.id]);
    expect(host.embedCalls.at(-1)).toEqual(["starter care"]);

    // A memory no word of the query matches is still found by its vector.
    const bike = await seed(host, { title: "Bike", body: "Pump the bike tyres to four bar." });
    await host.db.embedding.create({
      data: { memoryId: bike.id, model: "test-model", dim: 3, vector: encodeVector([0, 1, 0]) },
    });
    const vectorOnly = await host.invoke<Sufficient>("memory.recall", { query: "qqqqqqq" });
    expect(vectorOnly.items[0]!.id).toBe(bike.id);
  });

  it("works with the people module absent: names and URIs come back as they are stored", async () => {
    await open();
    await seed(host, {
      refs: [
        { role: "attendee", uri: PEOPLE.sam.uri, label: "Sam Rivera" },
        { role: "attendee", label: "John Doe" },
      ],
    });
    const result = await host.invoke<Sufficient>("memory.recall", { query: "pizza" });
    expect(result.items[0]!.attendees).toEqual(["John Doe", PEOPLE.sam.uri]);
  });

  it("still answers while incognito is on", async () => {
    await open();
    await seed(host);
    host.setIncognito(true);
    const result = await host.invoke<Sufficient>("memory.recall", { query: "pizza" });
    expect(result.sufficient).toBe(true);
  });

  it("audits ids and numbers only, never the query or the text", async () => {
    await open();
    const memory = await seed(host);
    host.audit.length = 0;
    await host.invoke("memory.recall", { query: "pizza secretword" });
    expect(host.audit).toHaveLength(1);
    expect(host.audit[0]).toMatchObject({
      tool: "memory.recall",
      kind: "read",
      ids: { memoryIds: [memory.id], calls: [memory.callNumber] },
      detail: { sufficient: true, itemsCount: 1 },
    });
    const strings = auditStrings(host);
    expect(strings.some((text) => text.includes("secretword") || text.includes("pizza"))).toBe(false);
  });
});
