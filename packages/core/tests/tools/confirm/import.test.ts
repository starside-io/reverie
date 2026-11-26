import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildExportSnapshot } from "../../../src/domain/transfer/export.js";
import type { ImportDryRunResult, ImportWriteResult } from "../../../src/tools/confirm/import.js";
import type { RememberResult } from "../../../src/tools/write/remember.js";
import { ftsHits } from "../../domain/library.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";

const NOW = new Date("2026-12-27T10:00:00.000Z");

describe("memory.import", () => {
  let host: TestHost;
  let other: TestHost;

  beforeEach(async () => {
    host = await testHost({ now: NOW, session: { id: "session-1" } });
    other = await testHost({ now: NOW, session: { id: "session-2" } });
  });
  afterEach(async () => {
    await host.close();
    await other.close();
  });

  /** A snapshot of another library: two memories. */
  async function backup() {
    await other.invoke<RememberResult>("memory.remember", { kind: "fact", body: "Prefers oat milk in coffee." });
    await other.invoke<RememberResult>("memory.remember", {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      body: "Hosted Christmas with Jane Doe and Sam Rivera.",
    });
    return buildExportSnapshot(other.db, { now: NOW });
  }

  const run = <T>(input: Record<string, unknown>) =>
    host.invoke<T>("memory.import", { confirmedByUser: true, ...input });

  it("refuses without confirmedByUser: true, even a dry run", async () => {
    const snapshot = await backup();
    for (const input of [{ snapshot }, { snapshot, dryRun: true }, { snapshot, confirmedByUser: false }]) {
      await expect(host.invoke("memory.import", input)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(await host.db.memory.count()).toBe(0);
  });

  it("merges a snapshot, row by row, searchable after", async () => {
    await host.invoke("memory.remember", { kind: "fact", shelf: "WRK/NST", body: "Deploys go out on Thursdays." });
    const snapshot = await backup();
    const result = await run<ImportWriteResult>({ snapshot, mode: "merge" });
    expect(result).toMatchObject({ mode: "merge", written: true, destroyed: null, counts: { memories: 2 } });
    expect(await host.db.memory.count()).toBe(3);
    expect(await ftsHits(host.db, "oat")).toHaveLength(1);
  });

  it("a dry run plans and writes nothing; a replace names the row counts it will destroy", async () => {
    await host.invoke("memory.remember", { kind: "fact", body: "Deploys go out on Thursdays." });
    const snapshot = await backup();

    const merge = await run<ImportDryRunResult>({ snapshot, mode: "merge", dryRun: true });
    expect(merge).toMatchObject({ mode: "merge", written: false, wouldDestroy: null, acknowledgement: null });

    const replace = await run<ImportDryRunResult>({ snapshot, mode: "replace", dryRun: true });
    expect(replace).toMatchObject({ mode: "replace", written: false, wouldDestroy: { memories: 1, sources: 1 } });
    expect(replace.acknowledgement).toMatch(/^replace:v1:[0-9a-f]{32}$/);
    expect(replace.plan.collections.find((c) => c.collection === "memories")).toMatchObject({ add: 2, remove: 1 });

    expect(await host.db.memory.count()).toBe(1);
  });

  it("a replace runs only with the acknowledgement of the plan the owner saw", async () => {
    await host.invoke("memory.remember", { kind: "fact", body: "Deploys go out on Thursdays." });
    const snapshot = await backup();

    await expect(run({ snapshot, mode: "replace" })).rejects.toMatchObject({ code: "refused" });
    await expect(run({ snapshot, mode: "replace", acknowledge: "replace:v1:0000" })).rejects.toMatchObject({ code: "conflict" });
    expect(await host.db.memory.count()).toBe(1);

    const plan = await run<ImportDryRunResult>({ snapshot, mode: "replace", dryRun: true });
    const result = await run<ImportWriteResult>({ snapshot, mode: "replace", acknowledge: plan.acknowledgement });
    expect(result).toMatchObject({
      mode: "replace",
      written: true,
      destroyed: { destroys: { memories: 1 } },
      counts: { memories: 2 },
      needsEmbedding: 2,
    });
    expect(await host.db.memory.count()).toBe(2);
    expect(await ftsHits(host.db, "Thursdays")).toEqual([]);
  });

  it("emits memory.memory.written once per memory created or changed, door import, after the commit", async () => {
    const snapshot = await backup();
    const written = () => host.events.filter((event) => event.name === "memory.memory.written");
    let committedWhenEmitted = -1;
    const record = host.ports.bus.emit;
    host.ports.bus.emit = async (name, payload) => {
      committedWhenEmitted = await host.db.memory.count();
      await record(name, payload);
    };

    await run<ImportWriteResult>({ snapshot, mode: "merge" });
    const created = written();
    expect(created).toHaveLength(2);
    expect(committedWhenEmitted).toBe(2);
    const rows = await host.db.memory.findMany({ select: { id: true, callNumber: true, kind: true, trust: true } });
    expect(created.map((event) => event.payload)).toEqual(
      expect.arrayContaining(
        rows.map((row) => ({
          memoryId: row.id,
          call: row.callNumber,
          door: "import",
          operation: "create",
          kind: row.kind,
          trust: row.trust,
        })),
      ),
    );

    // The same file again changes nothing, so nothing is emitted.
    host.events.length = 0;
    await run<ImportWriteResult>({ snapshot, mode: "merge" });
    expect(written()).toEqual([]);

    // A file that changed one memory emits for that one, as an update.
    const changed = structuredClone(snapshot);
    const target = changed.memories.find((memory) => memory.kind === "fact")!;
    target.body = "Prefers oat milk in coffee, never dairy.";
    await run<ImportWriteResult>({ snapshot: changed, mode: "merge" });
    expect(written().map((event) => event.payload)).toEqual([
      expect.objectContaining({ memoryId: target.id, door: "import", operation: "update" }),
    ]);

    // A replace emits for what it changed: here, the fact put back as the first file had it.
    host.events.length = 0;
    const plan = await run<ImportDryRunResult>({ snapshot, mode: "replace", dryRun: true });
    await run<ImportWriteResult>({ snapshot, mode: "replace", acknowledge: plan.acknowledgement });
    expect(written().map((event) => event.payload)).toEqual([
      expect.objectContaining({ memoryId: target.id, door: "import", operation: "update" }),
    ]);
  });

  it("emits nothing for a dry run or a refused import", async () => {
    const snapshot = await backup();
    await run({ snapshot, mode: "merge", dryRun: true });
    await expect(run({ snapshot, mode: "replace" })).rejects.toMatchObject({ code: "refused" });
    expect(host.events).toEqual([]);
  });

  it("an acknowledgement goes stale when the library changes or the file differs", async () => {
    const snapshot = await backup();
    const plan = await run<ImportDryRunResult>({ snapshot, mode: "replace", dryRun: true });

    await host.invoke("memory.remember", { kind: "fact", body: "Written after the plan was read." });
    await expect(run({ snapshot, mode: "replace", acknowledge: plan.acknowledgement })).rejects.toMatchObject({
      code: "conflict",
      detail: { wouldDestroy: { memories: 1 } },
    });

    const fresh = await run<ImportDryRunResult>({ snapshot, mode: "replace", dryRun: true });
    const swapped = { ...snapshot, memories: snapshot.memories.slice(0, 1) };
    await expect(run({ snapshot: swapped, mode: "replace", acknowledge: fresh.acknowledgement })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await host.db.memory.count()).toBe(1);
  });

  it("refuses a markdown folder or a Claude Code directory on a host with no markdown connector, writing nothing", async () => {
    for (const from of ["markdown", "claude_code"]) {
      await expect(run({ from, folder: "/tmp/nowhere" })).rejects.toMatchObject({ code: "unavailable" });
      await expect(run({ from })).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(await host.db.memory.count()).toBe(0);
  });

  it("refuses a file that is not a snapshot", async () => {
    await expect(run({ snapshot: { version: 99 } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run({})).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses while incognito is on", async () => {
    const snapshot = await backup();
    host.setIncognito(true);
    await expect(run({ snapshot })).rejects.toMatchObject({ code: "refused", detail: { incognito: true } });
    expect(await host.db.memory.count()).toBe(0);
  });

  it("audits as needs-ok with counts, never memory text", async () => {
    const snapshot = await backup();
    await run({ snapshot });
    expect(host.audit.at(-1)).toMatchObject({ tool: "memory.import", kind: "needs-ok", detail: { written: true, needsEmbedding: 2 } });
    expect(auditStrings(host).some((text) => text.includes("oat milk"))).toBe(false);
  });
});
