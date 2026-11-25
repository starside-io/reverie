import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reshelveMemory } from "../../../src/domain/catalogue/shelving.js";
import { updateMemory } from "../../../src/domain/memories.js";
import { history } from "../../../src/domain/versions.js";
import type { RedactToolResult } from "../../../src/tools/confirm/redact.js";
import type { RememberResult } from "../../../src/tools/write/remember.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";

const NOW = new Date("2026-12-27T10:00:00.000Z");

describe("memory.redact", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  async function rewritten() {
    const written = await host.invoke<RememberResult>("memory.remember", {
      kind: "fact",
      shelf: "LIF/HOM",
      body: "The spare key is under the blue flowerpot.",
    });
    await updateMemory(
      host.db,
      { id: written.memory.id },
      { body: "The spare key is with Jane Doe next door." },
      { actor: "user", at: new Date("2026-12-27T11:00:00.000Z") },
    );
    return written;
  }

  it("refuses without confirmedByUser: true, and nothing changes", async () => {
    const written = await rewritten();
    for (const input of [{ call: written.memory.call }, { call: written.memory.call, confirmedByUser: false }]) {
      await expect(host.invoke("memory.redact", input)).rejects.toMatchObject({ code: "invalid_input" });
    }
    const versions = await history(host.db, written.memory.id);
    expect(versions.every((version) => version.content !== null)).toBe(true);
  });

  it("clears past versions of a memory that stays, keeping operation, actor and time", async () => {
    const written = await rewritten();
    const result = await host.invoke<RedactToolResult>("memory.redact", { call: written.memory.call, confirmedByUser: true });

    expect(result.redacted).toEqual({ memoryId: written.memory.id, call: written.memory.call, versionsCleared: 1 });
    const memory = await host.db.memory.findUniqueOrThrow({ where: { id: written.memory.id } });
    expect(memory.body).toBe("The spare key is with Jane Doe next door.");

    const versions = await history(host.db, written.memory.id);
    expect(versions.map((v) => [v.operation, v.actor, v.content === null])).toEqual([
      ["create", "user", true],
      ["update", "user", false],
      ["redact", "user", true],
    ]);
    const stored = await host.db.memoryVersion.findMany({ where: { memoryId: written.memory.id } });
    // No version holds the old wording as its body. (The quote it was told in
    // is the source's, and stays on the memory as its citation.)
    expect(stored.some((row) => row.body !== null && JSON.parse(row.body).body.includes("flowerpot"))).toBe(false);
    expect(stored.filter((row) => row.contentSha256 === null)).toHaveLength(2);
  });

  it("takes an old number", async () => {
    const written = await rewritten();
    await reshelveMemory(host.db, written.memory.call, { shelf: "REF/ACC" }, { actor: "user" });
    const result = await host.invoke<RedactToolResult>("memory.redact", { call: written.memory.call, confirmedByUser: true });
    expect(result.redacted.call).toBe("REF/ACC/2026-12-27/001");
  });

  it("refuses a forgotten number with not_found", async () => {
    const written = await rewritten();
    await host.invoke("memory.forget", { call: written.memory.call, confirmedByUser: true });
    await expect(host.invoke("memory.redact", { call: written.memory.call, confirmedByUser: true })).rejects.toMatchObject({
      code: "not_found",
      detail: { forgotten: true },
    });
  });

  it("refuses while incognito is on", async () => {
    const written = await rewritten();
    host.setIncognito(true);
    await expect(host.invoke("memory.redact", { call: written.memory.call, confirmedByUser: true })).rejects.toMatchObject({
      code: "refused",
      detail: { incognito: true },
    });
  });

  it("audits as needs-ok with ids, never the body", async () => {
    const written = await rewritten();
    await host.invoke("memory.redact", { call: written.memory.call, confirmedByUser: true });
    expect(host.audit.at(-1)).toMatchObject({
      tool: "memory.redact",
      kind: "needs-ok",
      ids: { memoryIds: [written.memory.id], calls: [written.memory.call] },
    });
    expect(auditStrings(host).some((text) => text.includes("flowerpot"))).toBe(false);
  });
});
