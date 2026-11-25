import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QUOTE_MAX_LENGTH } from "../../../src/schemas/source.js";
import type { AddSourceToolResult } from "../../../src/tools/write/add-source.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";
import { NOW, remember, versions } from "./helpers.js";

describe("memory.add_source", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  const addSource = (input: Record<string, unknown>) => host.invoke<AddSourceToolResult>("memory.add_source", input);

  it("cites a new source with a quote and writes an update version", async () => {
    const first = await remember(host, { body: "Deploys go out on Thursdays." });
    const result = await addSource({
      call: first.memory.call,
      quote: "Release train leaves every Thursday at noon.",
      source: { kind: "page", label: "Team handbook", uri: "https://example.com/handbook", trust: "external" },
    });

    expect(result).toMatchObject({ added: true, sourceCreated: true });
    expect(result.memory.sources).toHaveLength(2);
    expect(result.memory.sources.map((source) => source.kind).sort()).toEqual(["conversation", "page"]);
    const rows = await versions(host, first.memory.id);
    expect(rows.map((row) => row.operation)).toEqual(["create", "update"]);
    expect(rows[1]?.content?.sources).toHaveLength(2);
    expect(auditStrings(host).some((text) => text.includes("Release train"))).toBe(false);
  });

  it("reuses a source by id, and citing it twice writes nothing", async () => {
    const first = await remember(host, { body: "Deploys go out on Thursdays." });
    const second = await remember(host, { body: "Deploys are frozen in the last week of December." });
    const sourceId = first.memory.sources[0]?.sourceId as string;

    const cited = await addSource({ call: second.memory.call, sourceId, quote: "frozen over the holidays" });
    expect(cited).toMatchObject({ sourceId, added: true, sourceCreated: false });
    const again = await addSource({ call: second.memory.call, sourceId, quote: "something else" });
    expect(again.added).toBe(false);
    expect((await versions(host, second.memory.id)).map((row) => row.operation)).toEqual(["create", "update"]);
  });

  it("defaults to the owner's words in this session", async () => {
    const first = await remember(host, { body: "Deploys go out on Thursdays." });
    const result = await addSource({ call: first.memory.call, quote: "yes, still Thursdays" });
    // The same session and day: the same Source, already cited.
    expect(result.added).toBe(false);

    const later = await host.invoke<AddSourceToolResult>(
      "memory.add_source",
      { call: first.memory.call, quote: "yes, still Thursdays" },
      { now: new Date("2027-01-05T09:00:00.000Z"), session: { id: "session-2" } },
    );
    expect(later.added).toBe(true);
    expect(later.memory.sources.find((source) => source.uri === "session:session-2")).toMatchObject({
      kind: "conversation",
      trust: "stated",
      quote: "yes, still Thursdays",
    });
  });

  it("refuses a quote past 500 characters and a quote holding a secret", async () => {
    const first = await remember(host, { body: "Deploys go out on Thursdays." });
    await expect(addSource({ call: first.memory.call, quote: "x".repeat(QUOTE_MAX_LENGTH + 1) })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      addSource({ call: first.memory.call, quote: "deploy key: AKIAIOSFODNN7EXAMPLE in the vault" }),
    ).rejects.toMatchObject({
      code: "refused",
      detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "secret" })]) },
    });
    expect(await versions(host, first.memory.id)).toHaveLength(1);
  });

  it("refuses both a source and a sourceId, a superseded entry, and incognito", async () => {
    const first = await remember(host, { occurredOn: "2026-01-02", body: "Deploys go out on Thursdays." });
    const sourceId = first.memory.sources[0]?.sourceId as string;
    await expect(
      addSource({ call: first.memory.call, quote: "q", sourceId, source: { kind: "file", label: "notes.md", trust: "stated" } }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await host.invoke("memory.supersede", { call: first.memory.call, body: "Deploys go out on Mondays." });
    await expect(addSource({ call: first.memory.call, quote: "Thursdays it is" })).rejects.toMatchObject({ code: "refused" });

    host.setIncognito(true);
    await expect(addSource({ call: first.memory.call, quote: "Thursdays it is" })).rejects.toMatchObject({
      code: "refused",
      detail: { incognito: true },
    });
  });
});
