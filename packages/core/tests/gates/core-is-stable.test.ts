import { afterEach, describe, expect, it } from "vitest";

import type { CoreResult } from "../../src/tools/read/core.js";
import type { TestHost } from "../test-host.js";
import { gateHost, NOW, remember } from "./harness.js";

/**
 * Gate: core is stable. The same library yields the same bytes: ordered by
 * call number, no relative time, no build timestamp. Two hosts holding the
 * same library give the same block, and so does one host asked again later,
 * from another session.
 */

async function library(host: TestHost): Promise<void> {
  const write = async (shelf: string, occurredOn: string, body: string, pin = true) => {
    const made = await remember(host, { shelf, occurredOn, body });
    if (pin) await host.invoke("memory.pin", { call: made.memory.call, pinned: true });
  };
  // Written out of call number order on purpose.
  await write("LIF/HOM", "2026-12-20", "Spare light bulbs live in the drawer under the sink.");
  await write("CRF/TLG", "2026-03-02", "The build uses pnpm 10 and Node 22.");
  await write("LIF/GTH", "2026-12-24", "Hosted Christmas at home with Jane Doe.");
  await write("LIF/HOM", "2026-01-05", "The car insurance renews every March.");
  await write("LIF/TRV", "2026-08-14", "Took the night train to Vienna.", false);
  await host.invoke("memory.promote_procedure", {
    body: "Keep pull requests under four hundred changed lines.",
    why: "Reviews of huge diffs miss the bugs that matter.",
    howToApply: "Whenever a branch is opened for review.",
    shelf: "CRF/HOW",
    occurredOn: "2026-02-01",
    confirmedByUser: true,
  });
  await host.invoke("memory.promote_procedure", {
    body: "Name test files after the behaviour they pin down.",
    why: "A rename should not hide which behaviour lost its test.",
    howToApply: "Every new test file.",
    shelf: "CRF/HOW",
    occurredOn: "2026-01-15",
    confirmedByUser: true,
  });
}

describe("core is stable", () => {
  const hosts: TestHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
  });

  async function fresh(options: Parameters<typeof gateHost>[0] = {}) {
    const host = await gateHost(options);
    hosts.push(host);
    return host;
  }
  const core = (host: TestHost, options: { now?: Date; session?: Record<string, string> } = {}) =>
    host.invoke<CoreResult>("memory.core", {}, options);

  it("two hosts with the same library give the same bytes", async () => {
    const a = await fresh();
    const b = await fresh({ session: { id: "another-session" } });
    await library(a);
    await library(b);
    const left = await core(a);
    const right = await core(b);
    expect(Buffer.from(right.text, "utf8").equals(Buffer.from(left.text, "utf8"))).toBe(true);
    expect(right.tokens).toBe(left.tokens);
    expect(right.included).toEqual(left.included);
  });

  it("the same host gives the same bytes later, from another session", async () => {
    const host = await fresh();
    await library(host);
    const first = await core(host);
    const later = await core(host, { now: new Date(NOW.getTime() + 3 * 24 * 3600 * 1000), session: { id: "later" } });
    const muchLater = await core(host, { now: new Date("2027-06-01T08:00:00.000Z"), session: { id: "much-later", agent: "helper" } });
    expect(later.text).toBe(first.text);
    expect(muchLater.text).toBe(first.text);
  });

  it("orders memories by call number and carries no relative time or build timestamp", async () => {
    const host = await fresh();
    await library(host);
    const block = await core(host);
    for (const slot of ["procedures", "pinned"] as const) {
      const refs = block.included.filter((item) => item.slot === slot).map((item) => item.ref);
      expect(refs.length).toBeGreaterThan(0);
      expect(refs).toEqual([...refs].sort());
    }
    expect(block.text).not.toMatch(/\b\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/i);
    expect(block.text).not.toMatch(/\b(?:today|yesterday|just now|recently)\b/i);
    expect(block.text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(block.text).not.toContain(NOW.toISOString().slice(0, 16));
    // The status slot, the part most likely to change, comes last.
    expect(block.included.at(-1)?.slot).toBe("status");
  });

  it("changes when the library changes, and only then", async () => {
    const host = await fresh();
    await library(host);
    const before = await core(host);
    await host.invoke("memory.recall", { query: "pizza" });
    await host.invoke("memory.browse", { shelf: "LIF/HOM" });
    expect((await core(host)).text).toBe(before.text);
    const extra = await remember(host, { shelf: "LIF/HOM", body: "Batteries for the smoke alarm are in the desk." });
    await host.invoke("memory.pin", { call: extra.memory.call, pinned: true });
    expect((await core(host)).text).not.toBe(before.text);
  });
});
