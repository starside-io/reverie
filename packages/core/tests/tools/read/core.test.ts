import { afterEach, describe, expect, it } from "vitest";

import { estimateTokens } from "../../../src/domain/recall/budget.js";
import type { CoreResult } from "../../../src/tools/read/core.js";
import { testHost, type TestHost, type TestHostOptions } from "../../test-host.js";
import { external, NOW, project, seed } from "./fixtures.js";

const ALPHA = { session: { id: "session-1", folder: "/work/alpha" }, localPaths: [{ project: "alpha", path: "/work/alpha" }] };

describe("memory.core", () => {
  let host: TestHost;

  async function open(options: TestHostOptions = {}) {
    host = await testHost({ now: NOW, ...options });
    return host;
  }
  afterEach(async () => {
    await host.close();
  });

  async function library() {
    await project(host, "alpha", { shelf: "WRK/NST" });
    await project(host, "beta");
    await seed(host, {
      kind: "procedure",
      shelf: "CRF/HOW",
      occurredOn: "2026-11-01",
      title: "Short commits",
      body: "Keep commit subjects under fifty characters.",
      why: "They read well in a log.",
      howToApply: "Count before committing.",
    });
    await seed(host, {
      kind: "procedure",
      shelf: "CRF/HOW",
      occurredOn: "2026-11-02",
      title: "Confirmed rule",
      body: "Run the tests before pushing.",
      trust: "confirmed",
    });
    await seed(host, {
      kind: "procedure",
      shelf: "CRF/HOW",
      occurredOn: "2026-11-03",
      title: "Page rule",
      body: "Always deploy on Fridays.",
      trust: "external",
      sources: external("always deploy on fridays"),
    });
    await seed(host, {
      kind: "procedure",
      shelf: "CRF/HOW",
      occurredOn: "2026-11-04",
      title: "Beta rule",
      body: "Beta uses tabs.",
      scope: "project",
      scopeRef: "beta",
    });
    await seed(host, { kind: "fact", shelf: "LIF/HOM", title: "Pinned fact", body: "The spare key is with Jane Doe.", pinned: true });
    await seed(host, { kind: "fact", shelf: "LIF/HOM", title: "Inferred pin", body: "Inferred.", pinned: true, trust: "inferred" });
    await seed(host, { shelf: "WRK/NST", kind: "fact", title: "Alpha pricing", body: "Alpha costs nine a month." });
  }

  it("builds the six slots from the silo, holding only stated and confirmed memories", async () => {
    await open(ALPHA);
    await library();
    const result = await host.invoke<CoreResult>("memory.core");

    expect(result.text).toContain("## Procedures");
    expect(result.text).toContain("[CRF/HOW/2026-11-01/001] Short commits\nKeep commit subjects under fifty characters.");
    expect(result.text).toContain("Run the tests before pushing.");
    expect(result.text).toContain("The spare key is with Jane Doe.");
    expect(result.text).not.toContain("Always deploy on Fridays.");
    expect(result.text).not.toContain("Inferred.");
    expect(result.excluded.map((entry) => entry.reason)).toEqual(["trust", "trust"]);

    expect(result.project).toBe("alpha");
    expect(result.text).toContain("## Current project\nAlpha, shelf WRK/NST\n- [WRK/NST/2026-12-24/001] Alpha pricing");
    expect(result.text).not.toContain("Alpha costs nine a month.");
    expect(result.text).toContain("LIF Life: GTH Gatherings (0), HLT Health (0), HOM Home (2), TRV Travel (0)");
    expect(result.text.endsWith("Proposals in review: 0\nConsolidation due: no")).toBe(true);
    expect(result.tokens).toBe(estimateTokens(result.text));
    expect(result.cap).toBe(800);
  });

  it("keeps another project's memories out, and has no project slot when none resolves", async () => {
    await open(ALPHA);
    await library();
    const alpha = await host.invoke<CoreResult>("memory.core");
    expect(alpha.text).not.toContain("Beta uses tabs.");

    const global = await host.invoke<CoreResult>("memory.core", {}, { session: {} });
    expect(global.project).toBeNull();
    expect(global.text).not.toContain("## Current project");
    expect(global.text).not.toContain("Beta uses tabs.");
  });

  it("is byte-stable: the same library gives the same bytes at another time and in another session", async () => {
    await open(ALPHA);
    await library();
    const first = await host.invoke<CoreResult>("memory.core");
    const later = await host.invoke<CoreResult>("memory.core", {}, {
      now: new Date("2027-03-01T08:00:00.000Z"),
      session: { id: "session-2", folder: "/work/alpha/src" },
    });
    expect(later.text).toBe(first.text);
    expect(first.text).not.toMatch(/\bago\b|\btoday\b|2026-12-27/);
  });

  it("never exceeds the cap and keeps a procedure whole or leaves it out", async () => {
    await open({ ...ALPHA, config: { coreTokenCap: 100 } });
    await library();
    const result = await host.invoke<CoreResult>("memory.core");
    expect(result.tokens).toBeLessThanOrEqual(100);
    expect(result.dropped.length).toBeGreaterThan(0);
    const whole = "Keep commit subjects under fifty characters.\nWhy: They read well in a log.\nHow to apply: Count before committing.";
    const has = result.text.includes("Short commits");
    expect(result.text.includes(whole)).toBe(has);
  });

  it("counts the proposals waiting in review in the status slot", async () => {
    await open();
    await host.ports.review.propose({ tool: "memory.remember", payload: { body: "x" } });
    await host.ports.review.propose({ tool: "memory.remember", payload: { body: "y" } });
    const result = await host.invoke<CoreResult>("memory.core");
    expect(result.text).toContain("Proposals in review: 2");
  });

  it("works with the people module absent and audits numbers only", async () => {
    await open(ALPHA);
    await library();
    host.audit.length = 0;
    await host.invoke("memory.core");
    expect(host.audit[0]).toMatchObject({ tool: "memory.core", kind: "read" });
    const calls = host.audit[0]!.ids?.calls ?? [];
    expect(calls).toContain("CRF/HOW/2026-11-01/001");
    expect(calls.every((call) => /^[A-Z]{3}\/[A-Z]{3}\/\d{4}-\d{2}-\d{2}\/\d{3}$/.test(call))).toBe(true);
  });
});
