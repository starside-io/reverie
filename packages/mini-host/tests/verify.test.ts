import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatVerify, verifySnapshot } from "../src/verify.js";
import { remember, throwawayDir, throwawayHost } from "./harness.js";

/**
 * verify: a snapshot imported into a throwaway silo and exported back out
 * comes back identical, and nothing touches the live files.
 */

async function exportedLibrary(): Promise<{ file: string; memories: number }> {
  const dir = throwawayDir();
  const host = await throwawayHost({ dir });
  try {
    const christmas = await remember(host, {
      kind: "episode",
      shelf: "LIF/GTH",
      occurredOn: "2026-12-24",
      title: "Christmas at the cottage",
      body: "Hosted Christmas for Jane Doe and John Doe in Elmwood.",
      tags: ["christmas"],
      attendees: ["Jane Doe", "module://people/person/p_john"],
    });
    const key = await remember(host, { shelf: "LIF/HOM", body: "The spare key hangs by the back door." });
    await host.api.invoke("memory.update", { call: key.memory.call, body: "The spare key hangs by the side door." });
    await host.api.invoke("memory.link", { from: key.memory.call, to: christmas.memory.call, relation: "elaborates" });
    const gone = await remember(host, { shelf: "LIF/HOM", body: "Lent the ladder to Sam Rivera." });
    await host.api.invoke("memory.forget", { call: gone.memory.call, confirmedByUser: true });

    const exported = (await host.api.invoke("memory.export", {})) as { snapshot: unknown; memories: number };
    const file = join(dir, "library.snapshot.json");
    writeFileSync(file, JSON.stringify(exported.snapshot));
    return { file, memories: exported.memories };
  } finally {
    await host.close();
  }
}

describe("verifySnapshot", () => {
  it("round trips an export with nothing lost, and deletes its throwaway silo", async () => {
    const { file, memories } = await exportedLibrary();
    expect(memories).toBe(2);

    const result = await verifySnapshot(file);
    expect(result.diff.identical).toBe(true);
    expect(result.searchIntegrity).toEqual({ status: "ok" });
    expect(result.ok).toBe(true);
    expect(result.counts.memories).toBe(2);
    expect(existsSync(result.siloPath)).toBe(false);

    const report = formatVerify(result);
    expect(report).toContain("No data loss.");
    expect(report).not.toMatch(/[\u2013\u2014]/);
  });

  it("keeps the throwaway silo when asked, to look inside", async () => {
    const { file } = await exportedLibrary();
    const result = await verifySnapshot(file, { keep: true });
    try {
      expect(existsSync(result.siloPath)).toBe(true);
    } finally {
      rmSync(result.siloPath, { force: true });
    }
  });

  it("reports a file the round trip does not reproduce", async () => {
    const { file } = await exportedLibrary();
    // A field the exporter never writes, so the importer drops it and the export lacks it.
    const snapshot = JSON.parse(readFileSync(file, "utf8")) as { memories: Array<Record<string, unknown>> };
    snapshot.memories[0]!["notAColumn"] = "Sam Rivera";
    writeFileSync(file, JSON.stringify(snapshot));

    const result = await verifySnapshot(file);
    expect(result.ok).toBe(false);
    expect(formatVerify(result)).toContain("did not survive");
  });
});
