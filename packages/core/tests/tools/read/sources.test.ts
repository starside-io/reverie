import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addSource } from "../../../src/domain/memories.js";
import type { SourcesResult } from "../../../src/tools/read/sources.js";
import type { RememberResult } from "../../../src/tools/write/remember.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";
import { NOW, seed } from "./fixtures.js";

describe("memory.sources", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  it("lists the stated source the direct door writes, with its quote", async () => {
    const written = await host.invoke<RememberResult>("memory.remember", {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas. The oven died, so we ordered pizza.",
    });
    const result = await host.invoke<SourcesResult>("memory.sources", { call: written.memory.call });
    expect(result.call).toBe(written.memory.call);
    expect(result.sources).toEqual([
      {
        sourceId: expect.any(String),
        kind: "conversation",
        label: "session of 2026-12-27",
        uri: "session:session-1",
        trust: "stated",
        occurredAt: NOW.toISOString(),
        createdAt: expect.any(String),
        quote: "Hosted Christmas. The oven died, so we ordered pizza.",
        citedBy: 1,
      },
    ]);
  });

  it("lists every source oldest first and counts who else cites each", async () => {
    const one = await seed(host);
    const two = await seed(host, { title: "Two", body: "Another evening." });
    const shared = await host.db.memorySource.findFirstOrThrow({ where: { memoryId: one.id } });
    await addSource(host.db, { id: two.id }, { sourceId: shared.sourceId, quote: "the same session" }, { actor: "user", at: NOW });
    await addSource(
      host.db,
      { id: two.id },
      { source: { kind: "file", label: "notes.md", trust: "stated" }, quote: "from my notes" },
      { actor: "user", at: NOW },
    );
    const result = await host.invoke<SourcesResult>("memory.sources", { call: two.callNumber });
    expect(result.sources.map((source) => [source.label, source.citedBy])).toEqual(
      expect.arrayContaining([
        ["session of 2026-12-27", 2],
        ["notes.md", 1],
      ]),
    );
    expect(result.sources).toHaveLength(3);
  });

  it("answers not_found for an unknown number and audits no quote", async () => {
    await expect(host.invoke("memory.sources", { call: "LIF/GTH/2026-12-24/001" })).rejects.toMatchObject({ code: "not_found" });
    const memory = await seed(host);
    await host.invoke("memory.sources", { call: memory.callNumber });
    expect(auditStrings(host).some((text) => text.includes("pizza"))).toBe(false);
  });
});
