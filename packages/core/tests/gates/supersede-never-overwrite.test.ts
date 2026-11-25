import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { VersionContent } from "../../src/domain/versions.js";
import type { ExportResult } from "../../src/tools/read/export.js";
import type { HistoryResult } from "../../src/tools/read/history.js";
import type { RememberResult } from "../../src/tools/write/remember.js";
import type { TestHost } from "../test-host.js";
import { candidate, gateHost, SESSION_DATE, turns } from "./harness.js";

/**
 * Gate: supersede, never overwrite. After any mutation the previous content
 * is readable through history, and `asOf` returns what was valid then.
 *
 * Each case writes a memory at T0, reads its content, mutates it at T2 by
 * one kind of mutation, then asks history for the content as it stood and
 * asks asOf T1, between the two, for what was valid then. Redact is the one
 * mutation whose purpose is to clear past content; forget-is-real covers it.
 */

const T0 = new Date("2026-12-20T09:00:00.000Z");
const T1 = new Date("2026-12-22T09:00:00.000Z");
const T2 = new Date("2026-12-24T09:00:00.000Z");

type History = Extract<HistoryResult, { mode: "history" }>;
type AsOf = Extract<HistoryResult, { mode: "asOf" }>;

describe("supersede, never overwrite", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  const at = (now: Date) => ({ now });
  const write = (input: Record<string, unknown>) =>
    host.invoke<RememberResult>("memory.remember", { kind: "episode", shelf: "LIF/GTH", occurredOn: "2026-12-19", ...input }, at(T0));
  const historyOf = (call: string) => host.invoke<History>("memory.history", { call }, at(T2));
  const asOf = (call: string, when: Date) => host.invoke<AsOf>("memory.history", { call, asOf: when.toISOString() }, at(T2));

  async function contentNow(call: string): Promise<VersionContent> {
    const versions = (await historyOf(call)).versions;
    return versions.at(-1)!.content!;
  }

  /** The earlier content is still in history, and asOf T1 returns it. */
  async function previousReadable(call: string, before: VersionContent, options: { chain?: boolean } = {}) {
    const result = await historyOf(call);
    const all = [...result.versions, ...result.absorbed.flatMap((entry) => entry.versions)];
    expect(all.map((version) => version.content)).toContainEqual(before);
    if (options.chain !== false) {
      const then = await asOf(call, T1);
      expect(then.valid?.version.content).toEqual(before);
    }
  }

  it.each([
    ["update", (call: string) => host.invoke("memory.update", { call, body: "Hosted Christmas for six." }, at(T2))],
    ["add_source", (call: string) => host.invoke("memory.add_source", { call, quote: "We were six at the table." }, at(T2))],
    ["pin", (call: string) => host.invoke("memory.pin", { call, pinned: true }, at(T2))],
    ["retire", (call: string) => host.invoke("memory.retire", { call }, at(T2))],
    ["set_tags", (call: string) => host.invoke("memory.set_tags", { action: "memory", call, attach: ["hosting"] }, at(T2))],
    [
      "link_occasion",
      (call: string) => host.invoke("memory.link_occasion", { call, occasion: "module://people/event/e_1", label: "Christmas" }, at(T2)),
    ],
  ] as const)("%s keeps the previous content in history, and asOf returns it", async (_name, mutate) => {
    const made = await write({ body: "Hosted Christmas for four." });
    const before = await contentNow(made.memory.call);
    await mutate(made.memory.call);
    const after = await contentNow(made.memory.call);
    expect(after).not.toEqual(before);
    await previousReadable(made.memory.call, before);
  });

  it("shelve and a shelf merge keep the content under the old number, which still resolves", async () => {
    const moved = await write({ body: "Hosted Christmas for four." });
    const before = await contentNow(moved.memory.call);
    const result = await host.invoke<{ memory: { call: string } }>(
      "memory.shelve",
      { action: "move", call: moved.memory.call, shelf: "LIF/HOM" },
      at(T2),
    );
    expect(result.memory.call).not.toBe(moved.memory.call);
    await previousReadable(moved.memory.call, before);
    await previousReadable(result.memory.call, before);

    const merged = await write({ shelf: "LIF/TRV", body: "Took the night train to Vienna." });
    const beforeMerge = await contentNow(merged.memory.call);
    await host.invoke("memory.set_shelves", { action: "merge_shelves", from: "LIF/TRV", into: "LIF/GTH" }, at(T2));
    await previousReadable(merged.memory.call, beforeMerge);
  });

  it("supersede closes the old entry, which keeps its content, and asOf walks the chain", async () => {
    const old = await write({ kind: "fact", shelf: "LIF/HOM", body: "Lives on Oak Street." });
    const before = await contentNow(old.memory.call);
    const result = await host.invoke<{ replacement: { call: string } }>(
      "memory.supersede",
      { call: old.memory.call, body: "Lives on Elm Street since 2026-12-23.", occurredOn: "2026-12-23" },
      at(T2),
    );
    await previousReadable(old.memory.call, before);
    // From the replacement's number too: what was valid at T1 is the old entry.
    const then = await asOf(result.replacement.call, T1);
    expect(then.valid).toMatchObject({ call: old.memory.call });
    expect(then.valid?.version.content?.body).toBe("Lives on Oak Street.");
    const now = await asOf(result.replacement.call, new Date(T2.getTime() + 1000));
    expect(now.valid?.version.content?.body).toBe("Lives on Elm Street since 2026-12-23.");
  });

  it("merge keeps the absorbed memory's content in the survivor's history, and the survivor's own", async () => {
    const survivor = await write({ shelf: "LIF/HOM", kind: "preference", body: "Prefers oat milk in coffee." });
    const absorbed = await write({ shelf: "LIF/HOM", kind: "preference", body: "Likes oat milk lattes with cinnamon." });
    const survivorBefore = await contentNow(survivor.memory.call);
    const absorbedBefore = await contentNow(absorbed.memory.call);
    await host.invoke("memory.merge", { survivor: survivor.memory.call, absorbed: absorbed.memory.call, confirmedByUser: true }, at(T2));
    await previousReadable(survivor.memory.call, survivorBefore);
    const result = await historyOf(absorbed.memory.call);
    expect(result.call).toBe(survivor.memory.call);
    expect(result.absorbed.map((entry) => entry.call)).toEqual([absorbed.memory.call]);
    expect(result.absorbed[0]?.versions.map((version) => version.content)).toContainEqual(absorbedBefore);
  });

  it("a refine confirmed through decide keeps the previous wording", async () => {
    const own = await write({ kind: "preference", shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
    const before = await contentNow(own.memory.call);
    const text = "I take oat milk in my coffee, never dairy.";
    const proposed = await host.invoke<{ queued: Array<{ id: string }> }>(
      "memory.propose_draft",
      {
        target: {
          job: "reconcile",
          material: turns(text),
          sessionDate: SESSION_DATE,
          candidate: candidate({ kind: "preference", body: "Prefers oat milk in coffee, never dairy.", quote: text }),
        },
        draft: { verb: "refine", target: own.memory.call, reason: "Sharper." },
      },
      at(T2),
    );
    await host.invoke("memory.decide", { proposalId: proposed.queued[0]!.id, decision: "confirm", confirmedByUser: true }, at(T2));
    expect((await contentNow(own.memory.call)).body).toBe("Prefers oat milk in coffee, never dairy.");
    await previousReadable(own.memory.call, before);
  });

  it("an import that changes a memory appends a version and keeps the previous content", async () => {
    const own = await write({ kind: "fact", shelf: "LIF/HOM", body: "The boiler is serviced every autumn." });
    const before = await contentNow(own.memory.call);
    const { snapshot } = await host.invoke<ExportResult>("memory.export", {}, at(T0));
    const file = JSON.parse(JSON.stringify(snapshot));
    file.memories[0].body = "The boiler is serviced every October.";
    file.memories[0].updatedAt = T2.toISOString();
    await host.invoke("memory.import", { snapshot: file, mode: "merge", confirmedByUser: true }, at(T2));
    expect((await contentNow(own.memory.call)).body).toBe("The boiler is serviced every October.");
    await previousReadable(own.memory.call, before);
  });
});
