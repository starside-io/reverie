import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReviewResult } from "../../../src/tools/read/review.js";
import { testHost, type TestHost } from "../../test-host.js";
import { NOW, seed } from "./fixtures.js";

describe("memory.review", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW });
  });
  afterEach(async () => {
    await host.close();
  });

  it("is empty when nothing waits", async () => {
    expect(await host.invoke("memory.review")).toEqual({ state: "pending", proposals: [] });
  });

  it("lists the proposals waiting, each naming its tool and payload, with the memory's number", async () => {
    const memory = await seed(host);
    const group = { id: "g1", title: "Session of 2026-12-27" };
    const first = await host.ports.review.propose({
      tool: "memory.remember",
      payload: { kind: "episode", body: "Boxing Day walk with Sam Rivera." },
      summary: "An episode on LIF/GTH",
      group,
    });
    const second = await host.ports.review.propose({
      tool: "memory.update",
      memoryId: memory.id,
      payload: { call: memory.callNumber, body: "Hosted Christmas." },
    });
    const third = await host.ports.review.propose({ tool: "memory.retire", payload: { call: memory.callNumber } });
    await host.ports.review.decide(third.id, "discarded");

    const result = await host.invoke<ReviewResult>("memory.review");
    expect(result.proposals.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(result.proposals[0]).toMatchObject({
      tool: "memory.remember",
      payload: { kind: "episode", body: "Boxing Day walk with Sam Rivera." },
      summary: "An episode on LIF/GTH",
      group,
      state: "pending",
      memoryId: null,
      call: null,
    });
    expect(result.proposals[1]).toMatchObject({ tool: "memory.update", memoryId: memory.id, call: memory.callNumber });

    const all = await host.invoke<ReviewResult>("memory.review", { state: "all" });
    expect(all.proposals).toHaveLength(3);
    const discarded = await host.invoke<ReviewResult>("memory.review", { state: "discarded" });
    expect(discarded.proposals.map((row) => row.id)).toEqual([third.id]);

    host.audit.length = 0;
    await host.invoke("memory.review");
    expect(host.audit[0]).toMatchObject({ ids: { proposalIds: [first.id, second.id] }, detail: { proposalsCount: 2 } });
  });
});
