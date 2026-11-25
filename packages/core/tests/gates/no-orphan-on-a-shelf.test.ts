import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TestHost } from "../test-host.js";
import { candidate, extractAndConfirm, gateHost, remember, runEveryTool, turns } from "./harness.js";

/**
 * Gate: no orphan on a shelf. Deleting a shelf with entries is refused; it
 * must be merged or emptied. Nothing is ever without a home, Returns
 * included: a write given no shelf, or a shelf the library does not have,
 * waits on Returns, and Returns itself can never go.
 */

describe("no orphan on a shelf", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  async function homeless(): Promise<number> {
    const shelves = new Set((await host.db.shelf.findMany({ select: { id: true } })).map((row) => row.id));
    const rows = await host.db.memory.findMany({ select: { shelfId: true } });
    return rows.filter((row) => !shelves.has(row.shelfId)).length;
  }

  it("refuses to delete a shelf that holds entries, and deletes it once emptied", async () => {
    const kept = await remember(host, { shelf: "LIF/TRV", body: "Took the night train to Vienna." });
    await expect(host.invoke("memory.set_shelves", { action: "delete_shelf", shelf: "LIF/TRV" })).rejects.toMatchObject({ code: "refused" });
    expect(await host.db.memory.count()).toBe(1);

    await host.invoke("memory.shelve", { action: "move", call: kept.memory.call, shelf: "LIF/GTH" });
    await expect(host.invoke("memory.set_shelves", { action: "delete_shelf", shelf: "LIF/TRV" })).resolves.toMatchObject({ deleted: "LIF/TRV" });
    expect(await homeless()).toBe(0);
  });

  it("a retired or superseded entry still holds its shelf", async () => {
    const retired = await remember(host, { shelf: "LIF/TRV", body: "Took the night train to Vienna." });
    await host.invoke("memory.retire", { call: retired.memory.call });
    await expect(host.invoke("memory.set_shelves", { action: "delete_shelf", shelf: "LIF/TRV" })).rejects.toMatchObject({ code: "refused" });

    const old = await remember(host, { shelf: "CRF/TLG", body: "The build uses pnpm 9.", occurredOn: "2026-01-10" });
    await host.invoke("memory.supersede", { call: old.memory.call, shelf: "CRF/WRT", body: "The build uses pnpm 10 since 2026-12-01." });
    await expect(host.invoke("memory.set_shelves", { action: "delete_shelf", shelf: "CRF/TLG" })).rejects.toMatchObject({ code: "refused" });
  });

  it("merging shelves or sections rehomes every entry", async () => {
    await remember(host, { shelf: "LIF/TRV", body: "Took the night train to Vienna." });
    await remember(host, { shelf: "LIF/HLT", body: "Booked the yearly check up for 2027-02-03.", explicitAsk: true });
    await host.invoke("memory.set_shelves", { action: "merge_shelves", from: "LIF/TRV", into: "LIF/GTH" });
    expect(await host.db.shelf.findFirst({ where: { code: "TRV" } })).toBeNull();
    await host.invoke("memory.set_shelves", { action: "create_section", code: "ARC", name: "Archive" });
    await host.invoke("memory.set_shelves", {
      action: "create_shelf",
      section: "ARC",
      code: "OLD",
      name: "Old",
      description: "Whatever is kept but no longer current.",
    });
    await host.invoke("memory.set_shelves", { action: "merge_sections", from: "LIF", into: "ARC" });
    expect(await homeless()).toBe(0);
    expect(await host.db.memory.count()).toBe(2);
  });

  it("Returns can never be deleted, even empty, and takes whatever has no home", async () => {
    await expect(host.invoke("memory.set_shelves", { action: "delete_shelf", shelf: "DSK/RET" })).rejects.toMatchObject({ code: "refused" });
    await expect(host.invoke("memory.set_shelves", { action: "merge_shelves", from: "DSK/RET", into: "LIF/GTH" })).rejects.toMatchObject({
      code: "refused",
    });
    const plain = await remember(host, { body: "The bicycle pump hangs by the back door." });
    expect(plain).toMatchObject({ landedOnReturns: true, memory: { shelf: "DSK/RET" } });
    const unknown = await extractAndConfirm(
      host,
      turns("The spare keys are in the blue bowl."),
      candidate({ shelf: "ZZZ/ZZZ", body: "The spare keys are in the blue bowl.", quote: "The spare keys are in the blue bowl." }),
    );
    expect(unknown.decided.committed?.call).toMatch(/^DSK\/RET\//);
  });

  it("after a session over every tool, every memory has a home", async () => {
    await runEveryTool(host);
    expect(await homeless()).toBe(0);
  });
});
