import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AboutResult } from "../../src/tools/read/about.js";
import type { BrowseResult } from "../../src/tools/read/browse.js";
import type { GetResult } from "../../src/tools/read/get.js";
import type { RecallResult } from "../../src/tools/read/recall.js";
import type { RelatedResult } from "../../src/tools/read/related.js";
import type { TestHost } from "../test-host.js";
import { candidate, extractAndConfirm, gateHost, turns } from "./harness.js";

/**
 * Gate: follow up is optional. A confirmed episode with an unrun followUp is
 * a complete memory with named attendees, and no tool fails for want of the
 * people module. Nothing here runs people.log_interaction or
 * memory.link_occasion.
 */

const TELLING = "Hosted Christmas on 2026-12-24 with Jane Doe, John Doe and Sam Rivera. The oven died so we ordered pizza.";

describe("follow up is optional", () => {
  let host: TestHost;
  let call: string;

  beforeEach(async () => {
    host = await gateHost();
    const { decided } = await extractAndConfirm(
      host,
      turns(TELLING),
      candidate({
        kind: "episode",
        title: "Christmas at home",
        body: "Hosted Christmas. The oven died, so we ordered pizza.",
        shelf: "LIF/GTH",
        occurredOn: "2026-12-24",
        tags: ["christmas"],
        people: [{ name: "Jane Doe" }, { name: "John Doe" }, { name: "Sam Rivera" }],
        occasion: { title: "Christmas at home", type: "PARTY" },
        quote: "The oven died so we ordered pizza.",
      }),
    );
    expect(decided.followUp?.tool).toBe("people.log_interaction");
    call = decided.committed!.call;
  });
  afterEach(async () => {
    await host.close();
  });

  it("is a complete, active memory with its attendees named and no occasion", async () => {
    const got = await host.invoke<GetResult>("memory.get", { call });
    expect(got.memory).toMatchObject({ state: "active", kind: "episode", trust: "confirmed", occasion: null, tags: ["christmas"] });
    expect(got.memory.attendees.map((ref) => [ref.label, ref.status])).toEqual([
      ["Jane Doe", "unresolved"],
      ["John Doe", "unresolved"],
      ["Sam Rivera", "unresolved"],
    ]);
    expect(got.memory.sources).toHaveLength(1);
  });

  it("is found by recall, browse, about and related without the people module", async () => {
    const recalled = await host.invoke<RecallResult>("memory.recall", { query: "oven pizza" });
    expect(recalled.items.map((item) => item.call)).toEqual([call]);
    const browsed = await host.invoke<BrowseResult>("memory.browse", { shelf: "LIF/GTH" });
    expect(browsed.items.map((item) => item.call)).toEqual([call]);
    const about = await host.invoke<AboutResult>("memory.about", { person: "Sam Rivera" });
    expect(about.items.map((item) => item.call)).toEqual([call]);
    await expect(host.invoke<RelatedResult>("memory.related", { call })).resolves.toBeDefined();
    await expect(host.invoke("memory.fs_view", { path: "/memories/Life/Gatherings" })).resolves.toBeDefined();
  });

  it("can still be updated, tagged and retired, with the occasion never logged", async () => {
    await host.invoke("memory.update", { call, body: "Hosted Christmas for four. The oven died, so we ordered pizza." });
    await host.invoke("memory.set_tags", { action: "memory", call, attach: ["hosting"] });
    await host.invoke("memory.retire", { call });
    expect(await host.db.memoryRef.count({ where: { role: "occasion" } })).toBe(0);
    expect(host.audit.some((line) => line.tool === "memory.link_occasion")).toBe(false);
  });
});
