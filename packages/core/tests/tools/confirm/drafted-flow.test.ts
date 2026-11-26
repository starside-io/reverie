import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registry } from "../../../src/tools/index.js";
import { splitPayload } from "../../../src/tools/shared/confirm-proposals.js";
import type { LinkOccasionToolResult } from "../../../src/tools/write/link-occasion.js";
import type { SupersedeToolResult } from "../../../src/tools/write/supersede.js";
import { PEOPLE, type TestHost } from "../../test-host.js";
import {
  candidate,
  confirm,
  draft,
  extractAndConfirm,
  gateHost,
  NOW,
  reconcileAndConfirm,
  remember,
  SESSION_DATE,
  turns,
} from "../../gates/harness.js";

/**
 * draft_context, then propose_draft, then decide confirm, end to end, for
 * every tool a draft can name. Each payload propose_draft queues must be
 * valid input for the real tool it names, and a drafted memory must commit
 * once, at the trust a draft earns, citing the material with the drafted
 * quote.
 */

describe("a draft, confirmed, runs the real tool it names", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    // Every payload queued in the test parses as the named tool's input.
    for (const proposal of host.proposals) {
      const tool = registry.byName(proposal.tool);
      expect(tool, proposal.tool).toBeDefined();
      const { input } = splitPayload(proposal.payload);
      const parsed = tool!.input.safeParse({ ...input, confirmedByUser: true });
      expect(parsed.success, `${proposal.tool}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
    }
    await host.close();
  });

  const writtenEvents = () => host.events.filter((event) => event.name === "memory.memory.written");

  async function citations(call: string) {
    const row = await host.db.memory.findUniqueOrThrow({
      where: { callNumber: call },
      include: { sources: { include: { source: true } } },
    });
    const versions = await host.db.memoryVersion.findMany({ where: { memoryId: row.id }, orderBy: { at: "asc" } });
    return { ...row, versions };
  }

  describe("extract", () => {
    it("a fact lands confirmed, citing the material, in one commit with one event", async () => {
      const text = "Prefers oat milk in coffee.";
      const { decided } = await extractAndConfirm(host, turns(text), candidate());
      expect(decided).toMatchObject({ tool: "memory.remember", committed: { call: "LIF/HOM/2026-12-27/001" } });

      const row = await citations("LIF/HOM/2026-12-27/001");
      expect(row.trust).toBe("confirmed");
      expect(row.sources).toHaveLength(1);
      expect(row.sources[0]).toMatchObject({
        quote: text,
        source: { kind: "conversation", label: `session of ${SESSION_DATE}`, uri: "session:session-1", trust: "stated" },
      });
      expect(row.versions.map((version) => version.operation)).toEqual(["create"]);
      expect(writtenEvents()).toEqual([
        {
          name: "memory.memory.written",
          payload: expect.objectContaining({ memoryId: row.id, door: "review", operation: "create", trust: "confirmed" }),
        },
      ]);
    });

    it("an episode with a pending occasion returns the followUp, and the follow up links it back", async () => {
      const text = "Hosted Christmas on 2026-12-24 with Jane Doe and Sam Rivera. The oven died so we ordered pizza.";
      const { proposed, decided } = await extractAndConfirm(
        host,
        turns(text),
        candidate({
          kind: "episode",
          title: "Christmas at home",
          body: "Hosted Christmas. The oven died, so we ordered pizza.",
          shelf: "LIF/GTH",
          occurredOn: "2026-12-24",
          people: [{ name: "Jane Doe" }, { name: "Sam Rivera" }],
          occasion: { title: "Christmas at home", type: "PARTY" },
          quote: "The oven died so we ordered pizza.",
        }),
      );
      expect(proposed.groups[0]?.title).toBe("Christmas at home, 2026-12-24");
      expect(decided.followUp).toEqual({
        tool: "people.log_interaction",
        input: {
          title: "Christmas at home",
          type: "PARTY",
          occurredAt: "2026-12-24",
          participants: [{ name: "Jane Doe" }, { name: "Sam Rivera" }],
          refs: [{ uri: "module://memory/memory/LIF/GTH/2026-12-24/001", label: "Christmas at home" }],
        },
        then: { tool: "memory.link_occasion", call: "LIF/GTH/2026-12-24/001" },
      });

      // Whoever confirmed runs the people module's call, then the link back.
      const occasion = "module://people/event/e_8812";
      host.primeRef(occasion, "Christmas at home", {
        participants: [
          { uri: PEOPLE.jane.uri, label: PEOPLE.jane.name },
          { uri: PEOPLE.sam.uri, label: PEOPLE.sam.name },
        ],
      });
      const linked = await host.invoke<LinkOccasionToolResult>(decided.followUp!.then!.tool, {
        call: decided.followUp!.then!.call,
        occasion,
      });
      expect(linked.memory.call).toBe("LIF/GTH/2026-12-24/001");
      const refs = await host.db.memoryRef.findMany({ where: { role: "occasion" } });
      expect(refs.map((ref) => ref.uri)).toEqual([occasion]);
    });

    it("a procedure goes through memory.promote_procedure at trust confirmed", async () => {
      const text = "Always run the tests before you commit, because CI is slow.";
      const { decided } = await extractAndConfirm(
        host,
        turns(text),
        candidate({
          kind: "procedure",
          title: "Run the tests before a commit",
          body: "Run the tests before every commit.",
          shelf: "CRF/HOW",
          why: "CI is slow.",
          howToApply: "Before any commit.",
          quote: text,
        }),
      );
      expect(decided.tool).toBe("memory.promote_procedure");
      const row = await citations(decided.committed!.call);
      expect(row).toMatchObject({ kind: "procedure", trust: "confirmed" });
      expect(row.sources[0]?.quote).toBe(text);
    });

    it("carries the people a draft mentions onto the memory as mentions", async () => {
      const text = "Jane Doe says the bakery on Elm Street opens at seven.";
      await extractAndConfirm(
        host,
        turns(text),
        candidate({
          title: "Bakery hours",
          body: "The bakery on Elm Street opens at seven.",
          people: [{ name: "Jane Doe", role: "mentions" }],
          quote: text,
        }),
      );
      const refs = await host.db.memoryRef.findMany();
      expect(refs.map((ref) => [ref.role, ref.label, ref.uri])).toEqual([["mentions", "Jane Doe", null]]);
    });
  });

  describe("reconcile", () => {
    it("add queues memory.remember", async () => {
      await remember(host, { shelf: "LIF/HOM", body: "Waters the plants on Sundays." });
      const text = "Prefers oat milk in coffee.";
      const { decided } = await reconcileAndConfirm(host, turns(text), candidate(), { verb: "add", target: null });
      expect(decided.tool).toBe("memory.remember");
      expect((await citations(decided.committed!.call)).trust).toBe("confirmed");
    });

    it("refine updates the same memory, same number, citing the draft's source and quote in one refine version", async () => {
      const old = await remember(host, { shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
      const text = "I take oat milk in my coffee, never dairy.";
      const { proposed, decided } = await reconcileAndConfirm(
        host,
        turns(text),
        candidate({ body: "Prefers oat milk in coffee, never dairy.", quote: text }),
        { verb: "refine", target: old.memory.call },
      );
      expect(host.proposals[0]?.tool).toBe("memory.update");
      expect(proposed.queued[0]?.tool).toBe("memory.update");
      expect(decided.committed).toEqual({ call: old.memory.call });

      const row = await citations(old.memory.call);
      expect(row.body).toBe("Prefers oat milk in coffee, never dairy.");
      expect(row.trust).toBe("confirmed");
      expect(row.sources.map((entry) => entry.quote).sort()).toEqual(["I take oat milk in my coffee, never dairy.", "Prefers oat milk in coffee."]);
      expect(row.versions.map((version) => version.operation)).toEqual(["create", "refine"]);
    });

    it("refine from external material drops the memory to external, so it never enters the core block", async () => {
      const old = await remember(host, { shelf: "LIF/HOM", body: "The boiler is serviced every autumn." });
      const text = "The boiler is serviced every October by the landlord.";
      await reconcileAndConfirm(
        host,
        { kind: "file", name: "lease.html", text, trust: "external" },
        candidate({ body: "The boiler is serviced every October.", quote: text }),
        { verb: "refine", target: old.memory.call },
      );
      expect((await citations(old.memory.call)).trust).toBe("external");
    });

    it("supersede closes the old entry and shelves the replacement at trust confirmed with the drafted source", async () => {
      const old = await remember(host, { shelf: "LIF/HOM", body: "Lives on Oak Street.", occurredOn: "2026-01-10" });
      const text = "We moved to Elm Street on 2026-12-20.";
      const { decided } = await reconcileAndConfirm(
        host,
        turns(text),
        candidate({ title: "Moved to Elm Street", body: "Lives on Elm Street since 2026-12-20.", occurredOn: "2026-12-20", quote: text }),
        { verb: "supersede", target: old.memory.call },
      );
      expect(decided.tool).toBe("memory.supersede");
      const result = decided.result as SupersedeToolResult;
      expect(result.old).toMatchObject({ call: old.memory.call, state: "superseded" });
      expect(decided.committed).toEqual({ call: result.replacement.call });

      const replacement = await citations(result.replacement.call);
      expect(replacement.trust).toBe("confirmed");
      expect(replacement.sources).toHaveLength(1);
      expect(replacement.sources[0]).toMatchObject({ quote: text, source: { kind: "conversation", trust: "stated" } });
      expect(writtenEvents().at(-1)?.payload).toMatchObject({ door: "review", operation: "supersede", trust: "confirmed" });
    });

    it("duplicate adds the draft as a source and moves lastConfirmedAt", async () => {
      const earlier = new Date("2026-06-01T09:00:00.000Z");
      const old = await host.invoke<Awaited<ReturnType<typeof remember>>>(
        "memory.remember",
        { kind: "fact", shelf: "LIF/HOM", body: "Prefers oat milk in coffee." },
        { now: earlier },
      );
      const text = "Oat milk in my coffee, as always.";
      const { decided } = await reconcileAndConfirm(host, turns(text), candidate({ quote: text }), {
        verb: "duplicate",
        target: old.memory.call,
      });
      expect(decided.tool).toBe("memory.add_source");
      const row = await citations(old.memory.call);
      expect(row.sources).toHaveLength(2);
      expect(row.lastConfirmedAt.toISOString()).toBe(NOW.toISOString());
      expect(await host.db.memory.count()).toBe(1);
    });
  });

  describe("consolidate", () => {
    async function stretch() {
      const a = await remember(host, { shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
      const b = await remember(host, { shelf: "LIF/HOM", body: "Likes oat milk, every morning." });
      const c = await remember(host, { shelf: "LIF/HOM", body: "Takes coffee black on Mondays." });
      return { a: a.memory.call, b: b.memory.call, c: c.memory.call };
    }

    it("merge, retire and link each run their tool", async () => {
      const { a, b, c } = await stretch();
      const proposed = await draft(
        host,
        { job: "consolidate", shelf: "LIF/HOM" },
        {
          actions: [
            { action: "link", from: c, to: a, relation: "contradicts", reason: "Black or oat milk." },
            { action: "retire", call: c, reason: "No longer true." },
            { action: "merge", survivor: a, absorbed: b, reason: "Same preference." },
          ],
        },
      );
      expect(proposed.rejected).toEqual([]);
      expect(proposed.queued.map((entry) => entry.tool)).toEqual(["memory.link", "memory.retire", "memory.merge"]);
      for (const entry of proposed.queued) await confirm(host, entry.id);

      expect(await host.db.memoryLink.count({ where: { relation: "contradicts" } })).toBe(1);
      expect((await host.db.memory.findUniqueOrThrow({ where: { callNumber: c } })).state).toBe("retired");
      expect(await host.db.memory.findUnique({ where: { callNumber: b } })).toBeNull();
      expect(host.proposals.every((proposal) => proposal.state === "confirmed")).toBe(true);
    });
  });

  describe("core", () => {
    it("pin runs memory.pin", async () => {
      const kept = await remember(host, { shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
      const proposed = await draft(host, { job: "core" }, { pin: [{ call: kept.memory.call, reason: "Asked often." }] });
      expect(proposed.queued.map((entry) => entry.tool)).toEqual(["memory.pin"]);
      await confirm(host, proposed.queued[0]!.id);
      expect((await host.db.memory.findUniqueOrThrow({ where: { callNumber: kept.memory.call } })).pinned).toBe(true);
    });
  });

  it("the public doors take no trust and no drafted source: whatever a caller passes, remember stays stated, citing the owner", async () => {
    const smuggled = {
      trust: "confirmed",
      sourceTrust: "external",
      draft: {
        job: "extract",
        trust: "external",
        source: { kind: "page", label: "a page", trust: "external" },
        quote: "Prefers oat milk in coffee.",
      },
    };
    const made = await host.invoke<{ memory: { call: string; trust: string; sources: Array<{ kind: string; trust: string }> } }>(
      "memory.remember",
      { kind: "fact", shelf: "LIF/HOM", body: "Prefers oat milk in coffee.", ...smuggled },
    );
    expect(made.memory.trust).toBe("stated");
    expect(made.memory.sources).toEqual([expect.objectContaining({ kind: "conversation", trust: "stated" })]);
    const replaced = await host.invoke<{ replacement: { trust: string; sources: Array<{ trust: string }> } }>("memory.supersede", {
      call: made.memory.call,
      body: "Prefers soy milk in coffee since 2026-12-20.",
      ...smuggled,
    });
    expect(replaced.replacement.trust).toBe("stated");
    expect(replaced.replacement.sources).toEqual([expect.objectContaining({ trust: "stated" })]);
    expect(writtenEvents().every((event) => event.payload.door === "direct" && event.payload.trust === "stated")).toBe(true);
  });
});
