import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PinToolResult } from "../../../src/tools/write/pin.js";
import { testHost, type TestHost } from "../../test-host.js";
import { NOW, remember, versions } from "./helpers.js";

// Two different bodies of about 190 characters each: one fits a 100 token
// core block, two do not.
const LONG_A =
  "Jane Doe keeps her running notes in a plain text file on the desktop, sorted by week, with the oldest at the bottom and a short summary line at the top of every single entry she writes.";
const LONG_B =
  "John Doe plans every trip in a shared spreadsheet with one tab per city, listing trains, rooms and the restaurants Sam Rivera recommended, and he prints the whole thing before he leaves.";

describe("memory.pin", () => {
  let host: TestHost;

  beforeEach(async () => {
    // The smallest cap config allows, so a few long bodies reach it.
    host = await testHost({ now: NOW, config: { coreTokenCap: 100 } });
  });
  afterEach(async () => {
    await host.close();
  });

  const pin = (call: string, pinned = true) => host.invoke<PinToolResult>("memory.pin", { call, pinned });

  it("sets and clears pinned, one update version each", async () => {
    const first = await remember(host, { body: "Prefers oat milk in coffee." });
    const pinned = await pin(first.memory.call);
    expect(pinned).toMatchObject({ changed: true, entersCore: true, notice: null });
    expect(pinned.memory.pinned).toBe(true);

    const again = await pin(first.memory.call);
    expect(again.changed).toBe(false);

    const cleared = await pin(first.memory.call, false);
    expect(cleared.memory.pinned).toBe(false);
    const rows = await versions(host, first.memory.id);
    expect(rows.map((row) => row.operation)).toEqual(["create", "update", "update"]);
    expect(rows[1]?.content?.pinned).toBe(true);
    expect(rows[2]?.content?.pinned).toBe(false);
  });

  it("refuses pinning past the core cap until something is unpinned", async () => {
    const a = await remember(host, { body: LONG_A });
    const b = await remember(host, { body: LONG_B });
    await pin(a.memory.call);

    await expect(pin(b.memory.call)).rejects.toMatchObject({
      code: "refused",
      detail: { cap: 100, wouldDrop: expect.arrayContaining([expect.any(String)]) },
    });
    expect((await host.db.memory.findUniqueOrThrow({ where: { id: b.memory.id } })).pinned).toBe(false);

    await pin(a.memory.call, false);
    const ok = await pin(b.memory.call);
    expect(ok.entersCore).toBe(true);
  });

  it("pins an inferred or external memory in the row but says it never enters the core", async () => {
    const first = await remember(host, { body: "Reads the release notes on Fridays." });
    await host.db.memory.update({ where: { id: first.memory.id }, data: { trust: "external" } });
    const result = await pin(first.memory.call);
    expect(result.memory.pinned).toBe(true);
    expect(result.entersCore).toBe(false);
    expect(result.notice).toContain("external");
  });

  it("does not count an inferred pin against the cap", async () => {
    const big = await remember(host, { body: LONG_A });
    await host.db.memory.update({ where: { id: big.memory.id }, data: { trust: "inferred" } });
    await pin(big.memory.call);
    const small = await remember(host, { body: LONG_B });
    expect((await pin(small.memory.call)).entersCore).toBe(true);
  });

  it("refuses pinning a retired entry and always lets one be unpinned", async () => {
    const first = await remember(host, { body: "Keeps a bike in the shed." });
    await pin(first.memory.call);
    await host.invoke("memory.retire", { call: first.memory.call });
    const second = await remember(host, { body: "Keeps a kayak in the shed." });
    await host.invoke("memory.retire", { call: second.memory.call });
    await expect(pin(second.memory.call)).rejects.toMatchObject({ code: "refused" });
    expect((await pin(first.memory.call, false)).memory.pinned).toBe(false);
  });
});
