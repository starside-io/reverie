import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BrowseResult } from "../../src/tools/read/browse.js";
import type { RecallResult } from "../../src/tools/read/recall.js";
import type { TestHost } from "../test-host.js";
import { candidate, extractAndConfirm, gateHost, remember, turns } from "./harness.js";

/**
 * Gate: tags are one vocabulary. `#NightStash`, `#nightstash` and
 * `nightstash` are the same tag at every write path, and a merge leaves no
 * row on the old slug and rewrites nothing in the bodies.
 */

describe("tags are one vocabulary", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  const slugs = async () => (await host.db.tag.findMany({ orderBy: { slug: "asc" } })).map((tag) => tag.slug);

  it("one tag, however it is written, at every write path", async () => {
    const a = await remember(host, { shelf: "WRK/NST", body: "Agreed the pricing page copy.", tags: ["#NightStash"] });
    await remember(host, { shelf: "WRK/NST", body: "Shipped the export button.", tags: ["nightstash"] });
    await remember(host, { shelf: "WRK/NST", body: "Pricing for #NightStash goes up in 2027-03." });
    await host.invoke("memory.set_tags", { action: "memory", call: a.memory.call, attach: ["#NIGHTSTASH", "#Pricing"] });
    await host.invoke("memory.supersede", { call: a.memory.call, body: "Agreed the new pricing page copy.", tags: ["#nightStash"] });
    await host.invoke("memory.promote_procedure", {
      body: "Check the changelog before a release.",
      why: "Releases broke twice.",
      howToApply: "Before every release.",
      tags: ["#NightStash"],
      confirmedByUser: true,
    });
    await extractAndConfirm(
      host,
      turns("The NightStash beta has forty users."),
      candidate({ shelf: "WRK/NST", body: "The NightStash beta has forty users.", tags: ["#NightStash"], quote: "The NightStash beta has forty users." }),
    );
    expect(await slugs()).toEqual(["nightstash", "pricing"]);
    const tagged = await host.db.memoryTag.count({ where: { tag: { slug: "nightstash" } } });
    expect(tagged).toBe(await host.db.memory.count());
  });

  it("recall and browse take a tag however it is written", async () => {
    await remember(host, { shelf: "WRK/NST", body: "Agreed the pricing page copy.", tags: ["nightstash"] });
    const browsed = await host.invoke<BrowseResult>("memory.browse", { tags: ["#NightStash"] });
    expect(browsed.items).toHaveLength(1);
    const recalled = await host.invoke<RecallResult>("memory.recall", { query: "pricing page", tags: ["#NIGHTSTASH"] });
    expect(recalled.items).toHaveLength(1);
  });

  it("a merge leaves no row on the old slug and rewrites nothing in the bodies", async () => {
    const a = await remember(host, { shelf: "WRK/NST", body: "Shipped the #ns export button.", tags: ["ns"] });
    const b = await remember(host, { shelf: "WRK/NST", body: "Agreed the pricing page copy.", tags: ["nightstash", "ns"] });
    await host.invoke("memory.set_tags", { action: "merge", from: "#NS", into: "#NightStash" });
    expect(await slugs()).toEqual(["nightstash"]);
    expect(await host.db.memoryTag.count({ where: { tag: { slug: "ns" } } })).toBe(0);
    expect(await host.db.memoryTag.count()).toBe(2);
    const bodies = (await host.db.memory.findMany({ orderBy: { callNumber: "asc" } })).map((row) => row.body);
    expect(bodies).toEqual([a.memory.body, b.memory.body]);

    await host.invoke("memory.set_tags", { action: "rename", from: "nightstash", to: "#Night-Stash" });
    expect(await slugs()).toEqual(["night-stash"]);
  });
});
