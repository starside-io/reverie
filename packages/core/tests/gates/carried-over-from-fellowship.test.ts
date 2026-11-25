import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkSilo } from "../../src/storage/check.js";
import { migrateSilo } from "../../src/storage/migrate.js";
import { readPragma } from "../../src/storage/pragmas.js";
import { registry } from "../../src/tools/index.js";
import type { ExportResult } from "../../src/tools/read/export.js";
import type { RememberResult } from "../../src/tools/write/remember.js";
import { migrationFiles } from "../storage/throwaway.js";
import type { TestHost } from "../test-host.js";
import { gateHost, rowCounts, runEveryTool } from "./harness.js";

/**
 * Gate: carried over from Fellowship. Confirmation on every needs-ok tool;
 * snapshot round trip; silo isolation; pragmas; migrations; single writer;
 * manifest matches registry.
 *
 * Manifest matches registry is tests/gates/manifest.test.ts. Single writer
 * is the mini-host's to hold (host.lock, one process writing the silo) and
 * arrives with it at M3: core has no host to lock, so it is not faked here.
 */

const NEEDS_OK = [
  "memory.decide",
  "memory.forget",
  "memory.import",
  "memory.merge",
  "memory.promote_procedure",
  "memory.redact",
];

describe("confirmation on every needs-ok tool", () => {
  let host: TestHost;
  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  it("the needs-ok tools are exactly the six the spec names", () => {
    expect(registry.tools.filter((tool) => tool.kind === "needs-ok").map((tool) => tool.name).sort()).toEqual(NEEDS_OK);
  });

  it("each refuses confirmedByUser missing, false, or the string \"true\", and writes nothing", async () => {
    const a = await host.invoke<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
    const b = await host.invoke<RememberResult>("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "Likes oat milk lattes with cinnamon." });
    const { snapshot } = await host.invoke<ExportResult>("memory.export", {});
    const { id: proposalId } = await host.ports.review.propose({ tool: "memory.retire", payload: { call: a.memory.call } });
    const inputs: Record<string, Record<string, unknown>> = {
      "memory.decide": { proposalId, decision: "confirm" },
      "memory.forget": { call: a.memory.call },
      "memory.import": { snapshot, mode: "replace" },
      "memory.merge": { survivor: a.memory.call, absorbed: b.memory.call },
      "memory.promote_procedure": { body: "Reply briefly.", why: "Time is short.", howToApply: "Every reply." },
      "memory.redact": { call: a.memory.call },
    };
    expect(Object.keys(inputs).sort()).toEqual(NEEDS_OK);
    const before = await rowCounts(host);
    for (const [name, input] of Object.entries(inputs)) {
      for (const flag of [{}, { confirmedByUser: false }, { confirmedByUser: "true" }, { confirmedByUser: 1 }]) {
        await expect(host.invoke(name, { ...input, ...flag }), `${name} ${JSON.stringify(flag)}`).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
    }
    expect(await rowCounts(host)).toEqual(before);
    expect(host.proposals[0]?.state).toBe("pending");
  });
});

describe("snapshot round trip", () => {
  const hosts: TestHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
  });

  it("an export imported into an empty silo exports the same snapshot", async () => {
    const home = await gateHost();
    hosts.push(home);
    await runEveryTool(home);
    const first = await home.invoke<ExportResult>("memory.export", {});

    const away = await gateHost({ seed: false });
    hosts.push(away);
    const plan = await away.invoke<{ acknowledgement: string }>("memory.import", {
      snapshot: first.snapshot,
      mode: "replace",
      dryRun: true,
      confirmedByUser: true,
    });
    await away.invoke("memory.import", { snapshot: first.snapshot, mode: "replace", acknowledge: plan.acknowledgement, confirmedByUser: true });
    const second = await away.invoke<ExportResult>("memory.export", {});

    const { exportedAt: _a, ...left } = first.snapshot as unknown as Record<string, unknown>;
    const { exportedAt: _b, ...right } = second.snapshot as unknown as Record<string, unknown>;
    expect(right).toEqual(left);
    expect(second.memories).toBe(first.memories);
  });
});

describe("silo isolation", () => {
  const hosts: TestHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    vi.unstubAllGlobals();
  });

  it("reaches no network, whatever it is asked to do", async () => {
    const fetches: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      fetches.push(String(input));
      throw new Error("A tool reached the network.");
    });
    const host = await gateHost();
    hosts.push(host);
    await runEveryTool(host);
    expect(fetches).toEqual([]);
  });

  it("two silos never see each other's memories", async () => {
    const a = await gateHost();
    const b = await gateHost();
    hosts.push(a, b);
    await a.invoke("memory.remember", { kind: "fact", shelf: "LIF/HOM", body: "Prefers oat milk in coffee." });
    expect(await b.db.memory.count()).toBe(0);
    expect(await b.invoke("memory.recall", { query: "oat milk" })).toEqual({ items: [], sufficient: false });
  });
});

describe("pragmas and migrations", () => {
  let host: TestHost;
  beforeEach(async () => {
    host = await gateHost();
  });
  afterEach(async () => {
    await host.close();
  });

  it("the silo every tool runs on has the four pragmas asserted", async () => {
    expect(Number(await readPragma(host.db, "foreign_keys"))).toBe(1);
    expect(String(await readPragma(host.db, "journal_mode")).toLowerCase()).toBe("wal");
    expect(Number(await readPragma(host.db, "synchronous"))).toBe(1);
    expect(Number(await readPragma(host.db, "busy_timeout"))).toBe(5000);
  });

  it("migrations bring a new file to the schema the tools run on, once, and a second boot applies nothing", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "reverie-gate-")), "reverie.db");
    const names = migrationFiles().map((file) => basename(dirname(file)));
    expect(migrateSilo(path)).toMatchObject({ applied: names, unknown: [], changed: [] });
    expect(migrateSilo(path)).toMatchObject({ applied: [], alreadyApplied: names });
    const report = await checkSilo(path);
    expect(report).toMatchObject({ missingChecks: [], missingSearchTables: [] });
    // The test host's silo, built from the same files, has the same tables.
    const tables = await host.db.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations' ORDER BY name`,
    );
    expect(tables.map((row) => row.name)).toEqual(report.tables.filter((name) => name !== "_prisma_migrations"));
  });
});
