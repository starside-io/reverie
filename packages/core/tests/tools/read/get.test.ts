import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reshelveMemory } from "../../../src/domain/catalogue/shelving.js";
import { RECALL_NOTICE } from "../../../src/domain/recall/frame.js";
import type { GetResult } from "../../../src/tools/read/get.js";
import type { RememberResult } from "../../../src/tools/write/remember.js";
import { ToolError } from "../../../src/tools/registry.js";
import { auditStrings, PEOPLE, testHost, type TestHost } from "../../test-host.js";

const NOW = new Date("2026-12-27T10:00:00.000Z");

describe("memory.get", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  async function remember(overrides: Record<string, unknown> = {}) {
    return host.invoke<RememberResult>("memory.remember", {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas. The oven died mid afternoon, so we ordered pizza. #christmas",
      attendees: [PEOPLE.jane.uri, "Sam Rivera"],
      ...overrides,
    });
  }

  it("returns one memory by its current number, framed as data", async () => {
    const written = await remember();
    const result = await host.invoke<GetResult>("memory.get", { call: written.memory.call });

    expect(result.notice).toBe(RECALL_NOTICE);
    expect(result.moved).toBe(false);
    expect(result.memory.call).toBe("LIF/GTH/2026-12-24/001");
    expect(result.memory.body).toContain("ordered pizza");
    expect(result.memory.tags).toEqual(["christmas"]);
    expect(result.memory.sources).toHaveLength(1);
  });

  it("resolves an old number after a reshelve and gives the new one", async () => {
    const written = await remember();
    await reshelveMemory(host.db, written.memory.call, { shelf: "LIF/HOM" }, { actor: "user" });

    const result = await host.invoke<GetResult>("memory.get", { call: "LIF/GTH/2026-12-24/001" });
    expect(result.moved).toBe(true);
    expect(result.memory.call).toBe("LIF/HOM/2026-12-24/001");
    expect(result.memory.aliases).toEqual(["LIF/GTH/2026-12-24/001"]);
  });

  it("renders people refs as unavailable without the people module, and as resolved once primed", async () => {
    const written = await remember();

    const without = await host.invoke<GetResult>("memory.get", { call: written.memory.call });
    expect(without.memory.attendees).toEqual([
      { role: "attendee", uri: PEOPLE.jane.uri, label: PEOPLE.jane.uri, status: "unavailable" },
      { role: "attendee", uri: null, label: "Sam Rivera", status: "unresolved" },
    ]);

    host.primePeople([PEOPLE.jane]);
    const primed = await host.invoke<GetResult>("memory.get", { call: written.memory.call });
    expect(primed.memory.attendees[0]).toMatchObject({ label: "Jane Doe", status: "resolved" });
  });

  it("answers not_found for an unknown number and for a forgotten one, and tells them apart", async () => {
    await expect(host.invoke("memory.get", { call: "LIF/GTH/2026-12-24/009" })).rejects.toMatchObject({
      code: "not_found",
      detail: { forgotten: false },
    });

    const written = await remember();
    await host.invoke("memory.forget", { call: written.memory.call, confirmedByUser: true });
    await expect(host.invoke("memory.get", { call: written.memory.call })).rejects.toMatchObject({
      code: "not_found",
      detail: { forgotten: true },
    });
  });

  it("refuses a malformed number at validation", async () => {
    const error = await host.invoke("memory.get", { call: "LIF/GTH/2026-12" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe("invalid_input");
  });

  it("still answers while incognito is on", async () => {
    const written = await remember();
    host.setIncognito(true);
    const result = await host.invoke<GetResult>("memory.get", { call: written.memory.call });
    expect(result.memory.id).toBe(written.memory.id);
  });

  it("audits the call with ids and numbers only", async () => {
    const written = await remember();
    host.audit.length = 0;
    await host.invoke("memory.get", { call: written.memory.call });

    expect(host.audit).toHaveLength(1);
    expect(host.audit[0]).toMatchObject({
      tool: "memory.get",
      kind: "read",
      ids: { calls: [written.memory.call], memoryIds: [written.memory.id] },
      detail: { moved: false },
    });
    expect(auditStrings(host).some((text) => text.includes("pizza"))).toBe(false);
  });
});
