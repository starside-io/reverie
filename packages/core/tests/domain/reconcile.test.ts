import { afterEach, describe, expect, it } from "vitest";

import { createMemory, retireMemory } from "../../src/domain/memories.js";
import {
  applyVerdict,
  bodySimilarity,
  DUPLICATE_SIMILARITY,
  duplicateGuard,
  findNeighbours,
  normaliseBody,
  reconcileVerdictSchema,
  visibleScopes,
} from "../../src/domain/reconcile.js";
import { history } from "../../src/domain/versions.js";
import type { MemoryCreateInput } from "../../src/schemas/memory.js";
import type { Silo } from "../../src/storage/client.js";
import { episode, ftsHits, openLibrary, USER } from "./library.js";

let db: Silo | undefined;

afterEach(async () => {
  await db?.$disconnect();
  db = undefined;
});

async function open(): Promise<Silo> {
  db = await openLibrary();
  return db;
}

const AT = { actor: "user", at: new Date("2027-01-05T12:00:00Z") };

function fact(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    shelf: "CRF/TLG",
    occurredOn: "2026-11-02",
    kind: "fact",
    title: "Editor setup",
    body: "Jane Doe writes in Helix with the gruvbox theme and soft wrap on.",
    trust: "stated",
    sources: [
      {
        source: { kind: "conversation", label: "session of 2026-11-02", trust: "stated" },
        quote: "I use Helix with gruvbox",
      },
    ],
    ...overrides,
  };
}

function laterSource(label = "session of 2027-01-05") {
  return [
    {
      source: { kind: "conversation" as const, label, trust: "stated" as const },
      quote: "still Helix, still gruvbox",
    },
  ];
}

describe("normaliseBody and bodySimilarity", () => {
  it("reads case, accents, punctuation, spacing and tag marks as the same text", () => {
    expect(normaliseBody("  Café   with #Jane-Doe, at 7!  ")).toBe("cafe with jane doe at 7");
    expect(bodySimilarity("Jane Doe likes oat milk.", "jane doe LIKES oat-milk")).toBe(1);
  });

  it("puts a one character typo above the threshold and a rewording below it", () => {
    const body = "Jane Doe writes in Helix with the gruvbox theme and soft wrap on.";
    expect(bodySimilarity(body, body.replace("gruvbox", "gruvbix"))).toBeGreaterThanOrEqual(DUPLICATE_SIMILARITY);
    expect(bodySimilarity(body, "Jane Doe moved to Zed and turned soft wrap off.")).toBeLessThan(DUPLICATE_SIMILARITY);
    expect(bodySimilarity("anything", "")).toBe(0);
  });
});

describe("visibleScopes", () => {
  it("lets a scoped candidate see global and its own scope, and a global one only global", () => {
    expect(visibleScopes({})).toEqual([{ scope: "global", scopeRef: null }]);
    expect(visibleScopes({ scope: "project", scopeRef: "nightstash" })).toEqual([
      { scope: "global", scopeRef: null },
      { scope: "project", scopeRef: "nightstash" },
    ]);
    expect(() => visibleScopes({ scope: "agent" })).toThrow(/scopeRef/);
  });
});

describe("findNeighbours", () => {
  it("ranks the memory sharing the most words first, with the drafter's signals", async () => {
    const silo = await open();
    const editor = await createMemory(silo, fact({ tags: ["tooling"] }), USER);
    await createMemory(
      silo,
      fact({ title: "Terminal", body: "Jane Doe runs the gruvbox theme in her terminal too.", shelf: "CRF/HOW" }),
      USER,
    );
    const christmas = await createMemory(silo, episode(), USER);

    const neighbours = await findNeighbours(silo, {
      title: "Editor",
      body: "Jane Doe writes in Helix, gruvbox theme, soft wrap on.",
      kind: "fact",
      shelf: "CRF/TLG",
      tags: ["#Tooling"],
    });
    // The Christmas episode shares only "Jane Doe", so it comes last.
    expect(neighbours.length).toBe(3);
    expect(neighbours[2]!.memoryId).toBe(christmas.id);
    expect(neighbours[0]).toMatchObject({
      memoryId: editor.id,
      callNumber: editor.callNumber,
      shelf: "CRF/TLG",
      rankFts: 1,
      rankVec: null,
      relevance: 1,
      sameShelf: true,
      sameKind: true,
      sharedTags: ["tooling"],
    });
    expect(neighbours[0]!.similarity).toBeGreaterThan(0.8);
    expect(neighbours[1]!.sameShelf).toBe(false);
  });

  it("never returns a retired or superseded entry", async () => {
    const silo = await open();
    const editor = await createMemory(silo, fact(), USER);
    await retireMemory(silo, editor, USER);
    expect(await findNeighbours(silo, { body: "Helix gruvbox soft wrap" })).toEqual([]);
  });

  it("only sees what the candidate could be recalled with", async () => {
    const silo = await open();
    const global = await createMemory(silo, fact({ title: "Global" }), USER);
    const mine = await createMemory(silo, fact({ title: "Mine", scope: "project", scopeRef: "nightstash" }), USER);
    const theirs = await createMemory(silo, fact({ title: "Theirs", scope: "project", scopeRef: "fellowship" }), USER);
    const agent = await createMemory(silo, fact({ title: "Agent", scope: "agent", scopeRef: "reviewer" }), USER);
    const body = "Helix gruvbox soft wrap";

    const ids = async (candidate: Parameters<typeof findNeighbours>[1]) =>
      (await findNeighbours(silo, candidate, { limit: 10 })).map((n) => n.memoryId).sort();

    expect(await ids({ body, scope: "project", scopeRef: "nightstash" })).toEqual([global.id, mine.id].sort());
    expect(await ids({ body })).toEqual([global.id]);
    expect(await ids({ body, scope: "agent", scopeRef: "reviewer" })).toEqual([global.id, agent.id].sort());
    expect(await ids({ body, scope: "session", scopeRef: "s-1" })).toEqual([global.id]);
    expect(theirs.id).not.toBe(mine.id);
  });

  it("fuses a vector list when one is given, and drops ids outside the scope", async () => {
    const silo = await open();
    const editor = await createMemory(silo, fact(), USER);
    const unrelated = await createMemory(silo, episode(), USER);
    const elsewhere = await createMemory(silo, fact({ title: "Theirs", scope: "project", scopeRef: "fellowship" }), USER);

    const neighbours = await findNeighbours(silo, { body: "Helix gruvbox" }, { vector: [unrelated.id, elsewhere.id, editor.id] });
    expect(neighbours.map((n) => n.memoryId)).toEqual([editor.id, unrelated.id]);
    expect(neighbours[0]).toMatchObject({ rankFts: 1, rankVec: 3 });
    expect(neighbours[1]).toMatchObject({ rankFts: null, rankVec: 1 });
  });

  it("treats FTS operators and quotes in the text as words", async () => {
    const silo = await open();
    await createMemory(silo, fact(), USER);
    await expect(findNeighbours(silo, { body: 'title:"Helix" NEAR(gruvbox) AND OR * ^' })).resolves.toHaveLength(1);
    await expect(findNeighbours(silo, { body: "the and of" })).resolves.toEqual([]);
  });
});

describe("duplicateGuard", () => {
  it("reports an exact match on the normalised body", async () => {
    const silo = await open();
    const editor = await createMemory(silo, fact(), USER);
    const check = await duplicateGuard(silo, {
      body: "jane doe writes in HELIX with the gruvbox theme, and soft-wrap on",
    });
    expect(check).toMatchObject({ duplicate: true, match: "exact", similarity: 1, memoryId: editor.id, callNumber: editor.callNumber });
  });

  it("reports a near match above the threshold and lets a real difference through", async () => {
    const silo = await open();
    await createMemory(silo, fact(), USER);
    const near = await duplicateGuard(silo, { body: "Jane Doe writes in Helix with the gruvbox theme and soft wrap on" + "s." });
    expect(near).toMatchObject({ duplicate: true, match: "near" });
    const different = await duplicateGuard(silo, { body: "Jane Doe switched from Helix to Zed in December." });
    expect(different.duplicate).toBe(false);
  });

  it("stays inside the candidate's scope", async () => {
    const silo = await open();
    await createMemory(silo, fact({ scope: "project", scopeRef: "fellowship" }), USER);
    expect((await duplicateGuard(silo, { body: fact().body as string })).duplicate).toBe(false);
    expect(
      (await duplicateGuard(silo, { body: fact().body as string, scope: "project", scopeRef: "fellowship" })).duplicate,
    ).toBe(true);
  });

  it("catches a verbatim body FTS has no words for", async () => {
    const silo = await open();
    const memory = await createMemory(silo, fact({ body: "It is what it is." }), USER);
    expect(await duplicateGuard(silo, { body: "It is what it is." })).toMatchObject({ duplicate: true, memoryId: memory.id });
  });
});

describe("reconcileVerdictSchema", () => {
  it("takes the four verbs, a target on all but add, and nothing else", () => {
    expect(reconcileVerdictSchema.parse({ verb: "add" })).toEqual({ verb: "add" });
    expect(reconcileVerdictSchema.parse({ verb: "refine", target: "CRF/TLG/2026-11-02/001", reason: "same fact" })).toMatchObject({
      verb: "refine",
    });
    expect(reconcileVerdictSchema.safeParse({ verb: "add", target: "x" }).success).toBe(false);
    expect(reconcileVerdictSchema.safeParse({ verb: "duplicate" }).success).toBe(false);
    expect(reconcileVerdictSchema.safeParse({ verb: "merge", target: "x" }).success).toBe(false);
  });
});

describe("applyVerdict", () => {
  it("add: a new active memory with a new call number", async () => {
    const silo = await open();
    await createMemory(silo, fact(), USER);
    const outcome = await applyVerdict(silo, { verb: "add" }, fact({ title: "Second" }), AT);
    expect(outcome.verb).toBe("add");
    if (outcome.verb !== "add") return;
    expect(outcome.memory.callNumber).toBe("CRF/TLG/2026-11-02/002");
    expect(await silo.memory.count()).toBe(2);
  });

  it("refine: same memory, same call number, one refine version with the new source", async () => {
    const silo = await open();
    const original = await createMemory(silo, fact({ importance: 4 }), USER);
    const outcome = await applyVerdict(
      silo,
      { verb: "refine", target: original.callNumber },
      fact({ body: "Jane Doe writes in Helix: gruvbox theme, soft wrap on, line numbers relative.", sources: laterSource(), tags: ["tooling"] }),
      AT,
    );
    expect(outcome).toMatchObject({ verb: "refine", changed: true, sourcesAdded: 1, tagsAdded: ["tooling"] });
    if (outcome.verb !== "refine") return;
    expect(outcome.memory).toMatchObject({ id: original.id, callNumber: original.callNumber, importance: 4 });
    expect(outcome.memory.body).toContain("line numbers relative");
    expect(await silo.memory.count()).toBe(1);

    const versions = await history(silo, original.id);
    expect(versions.map((v) => v.operation)).toEqual(["create", "refine"]);
    expect(versions[1]?.content?.sources).toHaveLength(2);
    expect(versions[1]?.content?.tags).toEqual(["tooling"]);
    expect(versions[0]?.content?.body).toBe(original.body);
    expect(await ftsHits(silo, "relative")).toHaveLength(1);
  });

  it("supersede: the old entry closes and stays, the new one has its own number", async () => {
    const silo = await open();
    const original = await createMemory(silo, fact(), USER);
    const outcome = await applyVerdict(
      silo,
      { verb: "supersede", target: original.id },
      fact({ occurredOn: "2027-01-05", body: "Jane Doe moved to Zed in January.", sources: laterSource() }),
      AT,
    );
    expect(outcome.verb).toBe("supersede");
    if (outcome.verb !== "supersede") return;
    expect(outcome.old).toMatchObject({ state: "superseded", supersededById: outcome.replacement.id, callNumber: original.callNumber });
    expect(outcome.old.validTo?.toISOString()).toBe(AT.at.toISOString());
    expect(outcome.replacement.callNumber).toBe("CRF/TLG/2027-01-05/001");
  });

  it("duplicate: nothing new, the source is gained and lastConfirmedAt moves", async () => {
    const silo = await open();
    const original = await createMemory(silo, fact(), { actor: "user", at: new Date("2026-11-02T10:00:00Z") });
    const outcome = await applyVerdict(silo, { verb: "duplicate", target: original.callNumber }, fact({ sources: laterSource() }), AT);
    expect(outcome).toMatchObject({ verb: "duplicate", sourcesAdded: 1 });
    if (outcome.verb !== "duplicate") return;
    expect(outcome.memory.lastConfirmedAt.toISOString()).toBe(AT.at.toISOString());
    expect(outcome.memory.body).toBe(original.body);
    expect(await silo.memory.count()).toBe(1);
    expect(await silo.memorySource.count({ where: { memoryId: original.id } })).toBe(2);
    expect((await history(silo, original.id)).map((v) => v.operation)).toEqual(["create", "update"]);

    // The same source again strengthens nothing twice and writes no version.
    const again = await applyVerdict(silo, { verb: "duplicate", target: original.id }, fact({ sources: laterSource() }), AT);
    expect(again).toMatchObject({ verb: "duplicate", sourcesAdded: 0 });
    expect((await history(silo, original.id)).map((v) => v.operation)).toEqual(["create", "update"]);
  });

  it("refuses a target that is missing, not active, or outside the candidate's scope", async () => {
    const silo = await open();
    const retired = await createMemory(silo, fact(), USER);
    await retireMemory(silo, retired, USER);
    const theirs = await createMemory(silo, fact({ title: "Theirs", scope: "project", scopeRef: "fellowship" }), USER);

    await expect(applyVerdict(silo, { verb: "refine", target: retired.id }, fact(), AT)).rejects.toMatchObject({ code: "refused" });
    await expect(applyVerdict(silo, { verb: "duplicate", target: theirs.callNumber }, fact(), AT)).rejects.toMatchObject({
      code: "refused",
    });
    await expect(
      applyVerdict(silo, { verb: "supersede", target: "CRF/TLG/2026-11-02/099" }, fact(), AT),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(applyVerdict(silo, { verb: "add", target: retired.id } as never, fact(), AT)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(applyVerdict(silo, { verb: "add" }, fact({ sources: [] }), AT)).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("No source, no memory"),
    });
  });

  it("rolls the whole verb back when one part fails", async () => {
    const silo = await open();
    const original = await createMemory(silo, fact(), USER);
    const sources = [
      ...laterSource(),
      { sourceId: "00000000-0000-4000-8000-000000000000", quote: "no such source" },
    ];
    await expect(
      applyVerdict(silo, { verb: "refine", target: original.id }, fact({ body: "Reworded entirely.", sources }), AT),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await silo.memory.findUniqueOrThrow({ where: { id: original.id } })).body).toBe(original.body);
    expect(await silo.memorySource.count()).toBe(1);
    expect(await silo.source.count()).toBe(1);
    expect((await history(silo, original.id)).map((v) => v.operation)).toEqual(["create"]);
  });
});
