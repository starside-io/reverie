import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createRegistry, defineTool, invokeTool, type AnyTool } from "../../src/tools/index.js";
import { NOT_PROPOSABLE, queueProposal } from "../../src/tools/shared/confirm-proposals.js";
import type { TestHost } from "../test-host.js";
import { confirm, gateHost, runEveryTool } from "./harness.js";

/**
 * Guardrail 8: a proposal may not name memory.decide or
 * memory.propose_draft, so a draft can never confirm or propose another
 * draft. Held at propose time, by the one function every proposal this
 * module queues goes through, and again at decide time for a proposal that
 * reached the queue by any other door.
 */

const FORBIDDEN = ["memory.decide", "memory.propose_draft"];

describe("a proposal never names decide or propose_draft", () => {
  let host: TestHost;
  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  it("names exactly the two tools", () => {
    expect([...NOT_PROPOSABLE].sort()).toEqual(FORBIDDEN);
  });

  it("is refused at propose time by the queue door every proposal goes through", async () => {
    const probe = createRegistry([
      defineTool<{ tool: string }, unknown>({
        name: "memory.probe",
        title: "Probe",
        kind: "write",
        summary: "Queues one proposal through the module's queue door.",
        input: z.object({ tool: z.string() }),
        handler: (ctx, input) => queueProposal(ctx, { tool: input.tool, payload: { proposalId: "proposal-9", decision: "confirm" } }),
      }) as unknown as AnyTool,
    ]);
    for (const tool of FORBIDDEN) {
      await expect(invokeTool(probe, host.ports, "memory.probe", { tool }), tool).rejects.toMatchObject({
        code: "refused",
        detail: { tool },
      });
    }
    expect(host.proposals).toEqual([]);
    await expect(invokeTool(probe, host.ports, "memory.probe", { tool: "memory.retire" })).resolves.toMatchObject({ id: "proposal-1" });
  });

  it("propose_draft, over every job, queues neither", async () => {
    await runEveryTool(host);
    expect(host.proposals.length).toBeGreaterThan(0);
    for (const proposal of host.proposals) expect(FORBIDDEN).not.toContain(proposal.tool);
  });

  it("is refused at decide time, stays pending, and may still be rejected", async () => {
    for (const tool of FORBIDDEN) {
      const { id } = await host.ports.review.propose({ tool, payload: { proposalId: "proposal-9", decision: "confirm" } });
      await expect(confirm(host, id), tool).rejects.toMatchObject({ code: "refused" });
      expect(host.proposals.find((proposal) => proposal.id === id)?.state).toBe("pending");
      await expect(
        host.invoke("memory.decide", { proposalId: id, decision: "reject", confirmedByUser: true }),
      ).resolves.toMatchObject({ state: "discarded", written: false });
    }
    expect(host.audit.filter((line) => line.tool === "memory.propose_draft")).toEqual([]);
  });
});
