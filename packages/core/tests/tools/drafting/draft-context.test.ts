import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemory } from "../../../src/domain/memories.js";
import { DISCIPLINE_RULES } from "../../../src/domain/drafting/prompts.js";
import { jsonSchemaFor } from "../../../src/domain/drafting/schemas.js";
import type { DraftContextResult } from "../../../src/tools/drafting/draft-context.js";
import type { RememberResult } from "../../../src/tools/write/remember.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";
import { christmasCandidate, TELLING, TURNS } from "./fixtures.js";

const NOW = new Date("2026-12-27T10:00:00.000Z");

describe("memory.draft_context", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  const context = (target: unknown) => host.invoke<DraftContextResult>("memory.draft_context", target);
  const remember = (input: Record<string, unknown>) =>
    host.invoke<RememberResult>("memory.remember", { kind: "fact", ...input });

  async function counts() {
    return {
      memories: await host.db.memory.count(),
      versions: await host.db.memoryVersion.count(),
      sources: await host.db.source.count(),
      tags: await host.db.tag.count(),
      proposals: host.proposals.length,
    };
  }

  describe("extract", () => {
    it("hands over the turns, the session date, the shelves with descriptions, the tags with counts, the rules and the schema", async () => {
      await remember({ body: "Hosting is a joy. #hosting" });
      const result = await context({ job: "extract", material: TURNS });

      expect(result.job).toBe("extract");
      expect(result.target).toEqual({ job: "extract", material: TURNS, sessionDate: "2026-12-27" });
      expect(result.material).toMatchObject({ sessionDate: "2026-12-27", turns: TURNS.kind === "turns" ? TURNS.turns : [] });
      const material = result.material as {
        shelves: Array<{ path: string; description: string }>;
        tags: Array<{ slug: string; count: number }>;
      };
      expect(material.shelves).toContainEqual(expect.objectContaining({ path: "LIF/GTH", description: expect.any(String) }));
      expect(material.shelves.find((shelf) => shelf.path === "DSK/RET")).toBeDefined();
      expect(material.tags).toEqual([{ slug: "hosting", count: 1 }]);
      expect(result.rules).toEqual(expect.arrayContaining([...DISCIPLINE_RULES]));
      expect(result.schema).toEqual(jsonSchemaFor("extract"));
      expect(result.prompt).toContain("Session date: 2026-12-27");
      expect(result.prompt).toContain(TELLING);
      expect(result.prompt).toContain("#hosting (1)");
      // The least trusted part: the assistant turn is not the owner speaking.
      expect(result.sourceTrust).toBe("inferred");
      expect(result.next).toContain("memory.propose_draft");
    });

    it("keeps the session date the caller gives, and carries a file's trust so external stays external", async () => {
      const result = await context({
        job: "extract",
        sessionDate: "2026-12-20",
        material: { kind: "file", name: "page.html", text: "The build takes ten minutes." },
      });
      expect(result.target).toMatchObject({ sessionDate: "2026-12-20", material: { trust: "external" } });
      expect(result.sourceTrust).toBe("external");
      expect(result.material).toMatchObject({ file: { name: "page.html", trust: "external" } });
    });

    it("writes nothing", async () => {
      await remember({ body: "Prefers oat milk in coffee." });
      const before = await counts();
      await context({ job: "extract", material: TURNS });
      expect(await counts()).toEqual(before);
      expect(host.events).toHaveLength(1);
    });
  });

  it("reconcile hands one candidate beside its nearest neighbours", async () => {
    const near = await remember({
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas at home and the oven died, pizza instead.",
    });
    await remember({ body: "Deploys go out on Thursdays." });

    const result = await context({ job: "reconcile", material: TURNS, candidate: christmasCandidate() });
    const material = result.material as { neighbours: Array<{ call: string; similarity: number }> };
    expect(material.neighbours[0]).toMatchObject({ call: near.memory.call });
    expect(material.neighbours.some((n) => n.call.startsWith("DSK/RET"))).toBe(false);
    expect(result.schema).toEqual(jsonSchemaFor("reconcile"));
    expect(result.target).toMatchObject({ job: "reconcile", sessionDate: "2026-12-27" });
  });

  it("consolidate hands a stretch with duplicate, contradiction and stale hints, pinned by call number", async () => {
    const a = await remember({ kind: "preference", shelf: "LIF/HOM", occurredOn: "2026-01-01", body: "Prefers oat milk in coffee." });
    const b = await remember({ kind: "preference", shelf: "LIF/HOM", occurredOn: "2026-01-02", body: "Prefers oat milk in coffee, always." });
    await host.db.memory.update({ where: { id: a.memory.id }, data: { lastConfirmedAt: new Date("2026-01-01T00:00:00Z") } });
    await host.db.memoryLink.create({ data: { fromId: a.memory.id, toId: b.memory.id, relation: "contradicts" } });
    await remember({ shelf: "WRK/NST", body: "Deploys go out on Thursdays." });

    const result = await context({ job: "consolidate", shelf: "LIF/HOM" });
    expect(result.target).toEqual({ job: "consolidate", shelf: "LIF/HOM", calls: [a.memory.call, b.memory.call] });
    expect(result.material).toMatchObject({
      hints: {
        duplicates: [expect.objectContaining({ a: a.memory.call, b: b.memory.call })],
        contradictions: [{ from: a.memory.call, to: b.memory.call }],
        stale: [a.memory.call],
      },
    });
    expect(result.counts).toMatchObject({ memories: 2, duplicates: 1, contradictions: 1, stale: 1 });
  });

  it("core hands the candidates and the token cap, never an external or inferred memory", async () => {
    const stated = await remember({ body: "Lives in Lisbon." });
    const external = await createMemory(
      host.db,
      {
        kind: "reference",
        occurredOn: "2026-12-01",
        title: "Docs",
        body: "The build docs are on a page.",
        trust: "external",
        sources: [{ source: { kind: "page", label: "docs", trust: "external" }, quote: "build docs" }],
      },
      { actor: "user" },
    );
    const inferred = await createMemory(
      host.db,
      {
        kind: "fact",
        occurredOn: "2026-12-01",
        title: "Guess",
        body: "Probably likes jazz.",
        trust: "confirmed",
        sources: [{ source: { kind: "conversation", label: "session", trust: "inferred" }, quote: "jazz" }],
      },
      { actor: "user" },
    );

    const result = await context({ job: "core" });
    const calls = (result.target as { calls: string[] }).calls;
    expect(calls).toContain(stated.memory.call);
    expect(calls).not.toContain(external.callNumber);
    expect(calls).not.toContain(inferred.callNumber);
    expect(result.material).toMatchObject({ tokenCap: 800 });
    expect(result.prompt).toContain("Token cap: 800");
  });

  it("answers while incognito is on, as a read", async () => {
    host.setIncognito(true);
    const result = await context({ job: "extract", material: TURNS });
    expect(result.job).toBe("extract");
    expect(host.audit.at(-1)).toMatchObject({ tool: "memory.draft_context", kind: "read" });
  });

  it("refuses a target it does not know, and audits no material", async () => {
    await expect(context({ job: "summarise", material: TURNS })).rejects.toMatchObject({ code: "invalid_input" });
    await context({ job: "extract", material: TURNS });
    expect(auditStrings(host).some((text) => text.includes("pizza"))).toBe(false);
  });
});
