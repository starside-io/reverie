import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExportResult } from "../../src/tools/read/export.js";
import type { TestHost } from "../test-host.js";
import {
  candidate,
  confirm,
  draft,
  extractAndConfirm,
  gateHost,
  reconcileAndConfirm,
  remember,
  runEveryTool,
  SESSION_DATE,
  turns,
} from "./harness.js";

/**
 * Gate: no source, no memory (guardrail 2). Every write path refuses a
 * memory with no Source, and a draft's quote must appear in the material it
 * was drafted from.
 *
 * The write paths: the direct door (remember), update, supersede,
 * add_source, promote_procedure, propose_draft then decide, import and
 * merge. A path that makes a memory from the owner's own words cites them;
 * one that is handed content cites what it was handed; none lands a row
 * without a citation.
 */

async function uncited(host: TestHost): Promise<string[]> {
  const rows = await host.db.memory.findMany({ where: { sources: { none: {} } }, select: { callNumber: true } });
  return rows.map((row) => row.callNumber);
}

describe("no source, no memory", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  it("after a session over every write path, every memory cites at least one source", async () => {
    await runEveryTool(host);
    expect(await host.db.memory.count()).toBeGreaterThan(5);
    expect(await uncited(host)).toEqual([]);
  });

  it("the direct door cites the owner's words, quoted from `said` or the body", async () => {
    const plain = await remember(host, { shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
    const said = await remember(host, {
      shelf: "LIF/HOM",
      body: "Waters the plants on 2026-12-27.",
      said: "I watered the plants today.",
    });
    expect(plain.memory.sources).toEqual([
      expect.objectContaining({ kind: "conversation", trust: "stated", quote: "Prefers oat milk in coffee." }),
    ]);
    expect(said.memory.sources[0]?.quote).toBe("I watered the plants today.");
  });

  it("supersede cites the owner's words on the replacement", async () => {
    const old = await remember(host, { shelf: "LIF/HOM", body: "Lives on Oak Street.", occurredOn: "2026-01-10" });
    const result = await host.invoke<{ replacement: { sources: unknown[] } }>("memory.supersede", {
      call: old.memory.call,
      body: "Lives on Elm Street since 2026-12-20.",
    });
    expect(result.replacement.sources).toHaveLength(1);
  });

  it("promote_procedure refuses an empty source list and cites the owner otherwise", async () => {
    const base = { body: "Run the tests before every commit.", why: "CI is slow.", howToApply: "Before any commit.", confirmedByUser: true };
    await expect(host.invoke("memory.promote_procedure", { ...base, sources: [] })).rejects.toMatchObject({ code: "invalid_input" });
    const made = await host.invoke<{ memory: { sources: unknown[] } }>("memory.promote_procedure", base);
    expect(made.memory.sources).toHaveLength(1);
  });

  it("add_source and update never leave a memory without its citations", async () => {
    const kept = await remember(host, { shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
    await expect(host.invoke("memory.add_source", { call: kept.memory.call })).rejects.toMatchObject({ code: "invalid_input" });
    await host.invoke("memory.update", { call: kept.memory.call, body: "Prefers oat milk in coffee, never dairy." });
    expect(await uncited(host)).toEqual([]);
  });

  it("merge keeps both sets of sources on the survivor", async () => {
    const a = await remember(host, { shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
    const b = await remember(host, { shelf: "LIF/HOM", body: "Likes oat milk lattes with cinnamon." });
    const merged = await host.invoke<{ memory: { sources: Array<{ quote: string }> } }>("memory.merge", {
      survivor: a.memory.call,
      absorbed: b.memory.call,
      confirmedByUser: true,
    });
    expect(merged.memory.sources.map((source) => source.quote).sort()).toEqual([
      "Likes oat milk lattes with cinnamon.",
      "Prefers oat milk in coffee.",
    ]);
  });

  it("import refuses a memory with no source, and writes nothing", async () => {
    await remember(host, { shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
    const { snapshot } = await host.invoke<ExportResult>("memory.export", {});
    const file = JSON.parse(JSON.stringify(snapshot));
    file.memories[0].sources = [];
    file.memories[0].body = "Prefers soy milk in coffee.";
    await expect(
      host.invoke("memory.import", { snapshot: file, mode: "merge", confirmedByUser: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect((await host.db.memory.findFirstOrThrow()).body).toBe("Prefers oat milk in coffee.");
  });

  describe("a draft", () => {
    it("is rejected when its quote is not in the material, and nothing is queued", async () => {
      const proposed = await draft(
        host,
        { job: "extract", material: turns("Prefers oat milk in coffee."), sessionDate: SESSION_DATE },
        { candidates: [candidate({ quote: "Prefers soy milk in coffee." })] },
      );
      expect(proposed.queued).toEqual([]);
      expect(proposed.rejected).toEqual([expect.objectContaining({ code: "quote-not-in-material" })]);
      expect(host.proposals).toEqual([]);
    });

    it("is rejected for a reconcile verb when its quote is not in the material", async () => {
      const old = await remember(host, { shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
      for (const verb of ["add", "refine", "supersede", "duplicate"] as const) {
        const proposed = await draft(
          host,
          {
            job: "reconcile",
            material: turns("Something else entirely."),
            sessionDate: SESSION_DATE,
            candidate: candidate({ quote: "Prefers oat milk in coffee, never dairy." }),
          },
          { verb, target: verb === "add" ? null : old.memory.call, reason: "Test." },
        );
        expect(proposed.queued, verb).toEqual([]);
        expect(proposed.rejected[0]?.code, verb).toBe("quote-not-in-material");
      }
    });

    it("lands citing the material, with the drafted quote, for every verb that makes or changes a memory", async () => {
      const added = await extractAndConfirm(host, turns("Prefers oat milk in coffee."), candidate());
      const addedRow = await host.db.memory.findUniqueOrThrow({
        where: { callNumber: added.decided.committed!.call },
        include: { sources: true },
      });
      expect(addedRow.sources.map((source) => source.quote)).toEqual(["Prefers oat milk in coffee."]);

      const text = "Lives on Elm Street since 2026-12-20, we moved.";
      const old = await remember(host, { shelf: "LIF/TRV", body: "Lives on Oak Street.", occurredOn: "2026-01-10" });
      const superseded = await reconcileAndConfirm(
        host,
        turns(text),
        candidate({ title: "Elm Street", body: "Lives on Elm Street since 2026-12-20.", shelf: "LIF/TRV", quote: text }),
        { verb: "supersede", target: old.memory.call },
      );
      const replacement = await host.db.memory.findUniqueOrThrow({
        where: { callNumber: superseded.decided.committed!.call },
        include: { sources: true },
      });
      expect(replacement.sources.map((source) => source.quote)).toEqual([text]);
      expect(await uncited(host)).toEqual([]);
    });

    it("is refused at decide when it names no material: a proposal is never the owner's own words", async () => {
      for (const tool of ["memory.remember", "memory.supersede"]) {
        const { id } = await host.ports.review.propose({
          tool,
          payload: { call: "LIF/HOM/2026-12-27/001", kind: "fact", body: "Prefers oat milk in coffee." },
        });
        await expect(confirm(host, id)).rejects.toMatchObject({ code: "refused", detail: { state: "pending" } });
      }
      expect(await host.db.memory.count()).toBe(0);
    });
  });
});
