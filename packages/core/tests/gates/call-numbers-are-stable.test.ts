import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExportResult } from "../../src/tools/read/export.js";
import type { GetResult } from "../../src/tools/read/get.js";
import type { BrowseResult } from "../../src/tools/read/browse.js";
import type { TestHost } from "../test-host.js";
import { candidate, extractAndConfirm, gateHost, remember, runEveryTool, turns } from "./harness.js";

/**
 * Gate: call numbers are stable (guardrail 6). Unique across the silo. The
 * sequence is always three digits, and entry 1000 on one shelf and day is
 * refused, never widened. Text order equals section, shelf, time, sequence.
 * An old number still resolves after a reshelve, a shelf merge or a memory
 * merge. A forgotten number is never reissued.
 */

const FORMAT = /^[A-Z]{3}\/[A-Z]{3}\/\d{4}-\d{2}-\d{2}\/\d{3}$/;

describe("call numbers are stable", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  const get = (call: string) => host.invoke<GetResult>("memory.get", { call });

  async function everyNumber(): Promise<string[]> {
    const rows = await host.db.memory.findMany({ select: { callNumber: true } });
    const aliases = await host.db.callNumberAlias.findMany({ select: { oldCallNumber: true } });
    return [...rows.map((row) => row.callNumber), ...aliases.map((row) => row.oldCallNumber)];
  }

  it("is unique across the silo and always three digits, over every write path", async () => {
    await runEveryTool(host);
    const numbers = await everyNumber();
    expect(numbers.length).toBeGreaterThan(8);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const number of numbers) expect(number).toMatch(FORMAT);
  });

  it("text order is section, shelf, time, then sequence", async () => {
    const entries: Array<[string, string]> = [
      ["LIF/TRV", "2026-08-14"],
      ["CRF/TLG", "2026-03-02"],
      ["LIF/GTH", "2026-12-24"],
      ["LIF/GTH", "2026-12-24"],
      ["LIF/GTH", "2026-01-31"],
      ["WRK/NST", "2025-11-09"],
      ["LIF/GTH", "2026-12-24"],
    ];
    const bodies = [
      "Took the night train to Vienna.",
      "The build uses pnpm and Node.",
      "Hosted Christmas with Jane Doe.",
      "The oven died mid afternoon.",
      "Skated on the frozen canal with John Doe.",
      "Agreed the pricing page copy with a client.",
      "Played charades after dinner with Sam Rivera.",
    ];
    for (const [index, [shelf, occurredOn]] of entries.entries()) {
      await remember(host, { shelf, occurredOn, body: bodies[index] });
    }
    const rows = await host.db.memory.findMany({ include: { shelf: { include: { section: true } } } });
    const byText = rows.map((row) => row.callNumber).sort();
    const byParts = [...rows]
      .sort(
        (a, b) =>
          a.shelf.section.code.localeCompare(b.shelf.section.code) ||
          a.shelf.code.localeCompare(b.shelf.code) ||
          a.occurredOn.getTime() - b.occurredOn.getTime() ||
          a.seq - b.seq,
      )
      .map((row) => row.callNumber);
    expect(byText).toEqual(byParts);
    expect(byText.filter((call) => call.startsWith("LIF/GTH/2026-12-24/"))).toEqual([
      "LIF/GTH/2026-12-24/001",
      "LIF/GTH/2026-12-24/002",
      "LIF/GTH/2026-12-24/003",
    ]);
    const browsed = await host.invoke<BrowseResult>("memory.browse", { prefix: "LIF", order: "asc", limit: 50 });
    expect(browsed.items.map((item) => item.call)).toEqual(byText.filter((call) => call.startsWith("LIF")));
  });

  it("refuses entry 1000 on one shelf and day, naming the shelf and the date, and never widens", async () => {
    const first = await remember(host, { kind: "episode", shelf: "LIF/GTH", occurredOn: "2026-12-24", body: "Entry one of the import." });
    const { snapshot } = await host.invoke<ExportResult>("memory.export", {});
    const file = JSON.parse(JSON.stringify(snapshot));
    const template = file.memories[0];
    for (let seq = 2; seq <= 999; seq += 1) {
      file.memories.push({
        ...template,
        id: randomUUID(),
        callNumber: `LIF/GTH/2026-12-24/${String(seq).padStart(3, "0")}`,
        seq,
        title: `Imported note ${seq}`,
        body: `Imported note number ${seq} from the old notebook.`,
      });
    }
    await host.invoke("memory.import", { snapshot: file, mode: "merge", confirmedByUser: true });
    expect(await host.db.memory.count()).toBe(999);
    expect(first.memory.call).toBe("LIF/GTH/2026-12-24/001");

    const error = await remember(host, { kind: "episode", shelf: "LIF/GTH", occurredOn: "2026-12-24", body: "One entry too many." }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "refused", detail: { shelf: "LIF/GTH", occurredOn: "2026-12-24", max: 999 } });
    expect(String((error as Error).message)).toMatch(/LIF\/GTH.*2026-12-24/);
    await expect(
      extractAndConfirm(host, turns("One entry too many."), candidate({ kind: "episode", shelf: "LIF/GTH", occurredOn: "2026-12-24", body: "One entry too many.", quote: "One entry too many." })),
    ).rejects.toMatchObject({ code: "refused" });
    expect(await host.db.memory.count()).toBe(999);
    expect(await host.db.memory.count({ where: { callNumber: { startsWith: "LIF/GTH/2026-12-24/1000" } } })).toBe(0);
    // The next day on the same shelf, and the same day on another shelf, still take entries.
    await expect(remember(host, { shelf: "LIF/GTH", occurredOn: "2026-12-25", body: "Boxing Day walk." })).resolves.toMatchObject({
      memory: { call: "LIF/GTH/2026-12-25/001" },
    });
  });

  it("an old number still resolves after a reshelve, a shelf merge and a memory merge", async () => {
    const moved = await remember(host, { shelf: "LIF/HOM", occurredOn: "2026-12-24", body: "Fixed the oven door." });
    const reshelved = await host.invoke<{ memory: { call: string } }>("memory.shelve", { action: "move", call: moved.memory.call, shelf: "LIF/GTH" });
    expect(reshelved.memory.call).not.toBe(moved.memory.call);
    expect(await get(moved.memory.call)).toMatchObject({ moved: true, memory: { call: reshelved.memory.call } });

    const a = await remember(host, { shelf: "LIF/TRV", occurredOn: "2026-08-14", body: "Took the night train to Vienna." });
    const b = await remember(host, { shelf: "LIF/TRV", occurredOn: "2026-08-14", body: "Walked the Ringstrasse at dawn." });
    // A reorder within a day swaps numbers, so an old number may now be another entry's
    // current one: the current number wins. Only reshelve and merges are checked here.

    const merged = await host.invoke<{ renumbered: Array<{ from: string; to: string }> }>("memory.set_shelves", {
      action: "merge_shelves",
      from: "LIF/TRV",
      into: "LIF/GTH",
    });
    expect(merged.renumbered.length).toBeGreaterThan(0);
    for (const call of [a.memory.call, b.memory.call, moved.memory.call]) {
      expect((await get(call)).memory.call).toMatch(/^LIF\/GTH\//);
    }
    expect((await get(a.memory.call)).memory.body).toBe("Took the night train to Vienna.");

    const survivor = await remember(host, { shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
    const absorbed = await remember(host, { shelf: "LIF/HOM", body: "Likes oat milk lattes with cinnamon." });
    await host.invoke("memory.merge", { survivor: survivor.memory.call, absorbed: absorbed.memory.call, confirmedByUser: true });
    expect(await get(absorbed.memory.call)).toMatchObject({ moved: true, memory: { call: survivor.memory.call } });
  });

  it("a forgotten number is never reissued and resolves to nothing", async () => {
    const gone = await remember(host, { shelf: "LIF/GTH", occurredOn: "2026-12-24", body: "Lent the ladder to Sam Rivera." });
    await host.invoke("memory.forget", { call: gone.memory.call, confirmedByUser: true });
    await expect(get(gone.memory.call)).rejects.toMatchObject({ code: "not_found" });
    const next = await remember(host, { shelf: "LIF/GTH", occurredOn: "2026-12-24", body: "Played charades after dinner." });
    expect(next.memory.call).toBe("LIF/GTH/2026-12-24/002");
    // Moving an entry onto that shelf and day skips it too.
    const other = await remember(host, { shelf: "LIF/HOM", occurredOn: "2026-12-24", body: "Fixed the oven door." });
    const moved = await host.invoke<{ memory: { call: string } }>("memory.shelve", { action: "move", call: other.memory.call, shelf: "LIF/GTH" });
    expect(moved.memory.call).toBe("LIF/GTH/2026-12-24/003");
    const numbers = await everyNumber();
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
