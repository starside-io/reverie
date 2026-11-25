import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PromoteProcedureResult } from "../../../src/tools/confirm/promote-procedure.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";

const NOW = new Date("2026-12-27T10:00:00.000Z");

const RULE = {
  body: "Run the tests before every commit.",
  why: "CI is slow, so a failure found locally saves a round trip.",
  howToApply: "Before any git commit, in any project.",
  shelf: "CRF/HOW",
};

describe("memory.promote_procedure", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
  });
  afterEach(async () => {
    await host.close();
  });

  const promote = (input: Record<string, unknown>) =>
    host.invoke<PromoteProcedureResult>("memory.promote_procedure", { ...RULE, confirmedByUser: true, ...input });

  it("refuses without confirmedByUser: true, and nothing is written", async () => {
    for (const flag of [undefined, false]) {
      await expect(host.invoke("memory.promote_procedure", { ...RULE, confirmedByUser: flag })).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(await host.db.memory.count()).toBe(0);
  });

  it("writes a procedure with why and how to apply, at trust confirmed", async () => {
    const result = await promote({});
    expect(result.memory).toMatchObject({
      call: "CRF/HOW/2026-12-27/001",
      kind: "procedure",
      trust: "confirmed",
      title: "Run the tests before every commit",
      why: RULE.why,
      howToApply: RULE.howToApply,
    });
    expect(result.memory.sources).toEqual([
      expect.objectContaining({ kind: "conversation", trust: "stated", quote: RULE.body }),
    ]);
  });

  it("requires why and how to apply", async () => {
    for (const missing of ["why", "howToApply"]) {
      await expect(promote({ [missing]: undefined })).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("cites the drafted material's source when given one", async () => {
    const result = await promote({
      sources: [
        {
          source: { kind: "conversation", label: "session of 2026-12-26", trust: "stated" },
          quote: "always run the tests before you commit",
        },
      ],
    });
    expect(result.memory.sources).toEqual([
      expect.objectContaining({ label: "session of 2026-12-26", quote: "always run the tests before you commit" }),
    ]);
  });

  it("guardrail 4: refused for an external source, outright", async () => {
    await expect(
      promote({
        sources: [{ source: { kind: "page", label: "contributing.md", trust: "external" }, quote: "run the tests" }],
      }),
    ).rejects.toMatchObject({ code: "refused", detail: { externalSource: true } });
    expect(await host.db.memory.count()).toBe(0);
  });

  it("runs discipline: a secret in the rule or the quote, or a relative date, is refused", async () => {
    await expect(promote({ body: "Use the api_key = sk_live_abcdefghijklmnop1234 for deploys." })).rejects.toMatchObject({
      code: "refused",
      detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "secret" })]) },
    });
    await expect(promote({ said: "the password: hunter22 is fine" })).rejects.toMatchObject({ code: "refused" });
    await expect(
      promote({
        body: "Rebase before merging.",
        sources: [{ source: { kind: "conversation", label: "s", trust: "stated" }, quote: "password: hunter22" }],
      }),
    ).rejects.toMatchObject({ code: "refused" });
    await expect(promote({ body: "Starting next week, squash every merge." })).rejects.toMatchObject({
      code: "refused",
      detail: { findings: expect.arrayContaining([expect.objectContaining({ check: "relativeDate" })]) },
    });
  });

  it("runs the duplicate guard", async () => {
    const first = await promote({});
    await expect(promote({})).rejects.toMatchObject({ code: "conflict", detail: { call: first.memory.call } });
    expect(await host.db.memory.count()).toBe(1);
  });

  it("emits memory.memory.written after the commit, with ids only", async () => {
    const result = await promote({});
    expect(host.events).toEqual([
      {
        name: "memory.memory.written",
        payload: {
          memoryId: result.memory.id,
          call: result.memory.call,
          door: "direct",
          operation: "create",
          kind: "procedure",
          trust: "confirmed",
        },
      },
    ]);
  });

  it("refuses while incognito is on", async () => {
    host.setIncognito(true);
    await expect(promote({})).rejects.toMatchObject({ code: "refused", detail: { incognito: true } });
    expect(await host.db.memory.count()).toBe(0);
  });

  it("audits as needs-ok with ids, never the rule", async () => {
    const result = await promote({});
    expect(host.audit.at(-1)).toMatchObject({
      tool: "memory.promote_procedure",
      kind: "needs-ok",
      ids: { memoryIds: [result.memory.id], calls: [result.memory.call] },
    });
    expect(auditStrings(host).some((text) => text.includes("tests"))).toBe(false);
  });
});
