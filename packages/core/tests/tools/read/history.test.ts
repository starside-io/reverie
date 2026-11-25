import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { supersedeMemory, updateMemory } from "../../../src/domain/memories.js";
import { redactMemory } from "../../../src/domain/versions.js";
import { RECALL_NOTICE } from "../../../src/domain/recall/frame.js";
import type { HistoryResult } from "../../../src/tools/read/history.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";
import { NOW, seed, stated } from "./fixtures.js";

type Rows = Extract<HistoryResult, { mode: "history" }>;
type AsOf = Extract<HistoryResult, { mode: "asOf" }>;

describe("memory.history", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  async function dentist() {
    const old = await seed(host, {
      kind: "fact",
      shelf: "LIF/HLT",
      occurredOn: "2026-01-10",
      title: "Dentist",
      body: "The dentist is Dr Rivera.",
    }, new Date("2026-01-10T09:00:00.000Z"));
    await updateMemory(host.db, { id: old.id }, { body: "The dentist is Dr Rivera on Main Street." }, { actor: "user", at: new Date("2026-03-01T00:00:00.000Z") });
    const { replacement } = await supersedeMemory(
      host.db,
      { id: old.id },
      {
        shelf: "LIF/HLT",
        occurredOn: "2026-12-01",
        kind: "fact",
        title: "Dentist",
        body: "The dentist is now Dr Doe.",
        trust: "stated",
        validFrom: "2026-12-01T00:00:00.000Z",
        sources: stated("we switched dentists"),
      },
      { actor: "user", at: new Date("2026-12-01T00:00:00.000Z") },
    );
    return { old, replacement };
  }

  it("lists every version oldest first, the previous content readable", async () => {
    const { old } = await dentist();
    const result = await host.invoke<Rows>("memory.history", { call: old.callNumber });
    expect(result.notice).toBe(RECALL_NOTICE);
    expect(result.mode).toBe("history");
    expect(result.versions.map((row) => row.operation)).toEqual(["create", "update", "supersede"]);
    expect(result.versions[0]!.content?.body).toBe("The dentist is Dr Rivera.");
    expect(result.versions[1]!.content?.body).toBe("The dentist is Dr Rivera on Main Street.");
    expect(result.versions.every((row) => row.actor === "user" && !row.redacted)).toBe(true);
  });

  it("with asOf, answers what was valid then across the supersede chain", async () => {
    const { old, replacement } = await dentist();
    const february = await host.invoke<AsOf>("memory.history", { call: replacement.callNumber, asOf: "2026-02-01T00:00:00.000Z" });
    expect(february.valid).toMatchObject({ call: old.callNumber });
    expect(february.valid!.version.content?.body).toBe("The dentist is Dr Rivera.");

    const june = await host.invoke<AsOf>("memory.history", { call: old.callNumber, asOf: "2026-06-01T00:00:00.000Z" });
    expect(june.valid!.version.content?.body).toBe("The dentist is Dr Rivera on Main Street.");

    const now = await host.invoke<AsOf>("memory.history", { call: old.callNumber, asOf: NOW.toISOString() });
    expect(now.valid).toMatchObject({ call: replacement.callNumber });

    const before = await host.invoke<AsOf>("memory.history", { call: old.callNumber, asOf: "2025-01-01T00:00:00.000Z" });
    expect(before.valid).toBeNull();
  });

  it("keeps a redacted row's place with no content", async () => {
    const { old } = await dentist();
    await redactMemory(host.db, old.id, { actor: "user", at: NOW });
    const result = await host.invoke<Rows>("memory.history", { call: old.callNumber });
    const redacted = result.versions.filter((row) => row.redacted);
    expect(redacted.length).toBeGreaterThan(0);
    expect(redacted.every((row) => row.content === null && row.contentSha256 === null)).toBe(true);
    expect(result.versions.at(-1)!.operation).toBe("redact");
  });

  it("answers not_found for a forgotten number, and audits no text", async () => {
    const memory = await seed(host);
    await host.invoke("memory.forget", { call: memory.callNumber, confirmedByUser: true });
    await expect(host.invoke("memory.history", { call: memory.callNumber })).rejects.toMatchObject({
      code: "not_found",
      detail: { forgotten: true },
    });
    expect(auditStrings(host).some((text) => text.includes("pizza"))).toBe(false);
  });
});
