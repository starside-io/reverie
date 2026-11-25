import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SNAPSHOT_VERSION } from "../../../src/domain/transfer/snapshot.js";
import type { ExportResult } from "../../../src/tools/read/export.js";
import { auditStrings, testHost, type TestHost } from "../../test-host.js";
import { NOW, project, seed } from "./fixtures.js";

describe("memory.export", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await testHost({
      now: NOW,
      localPaths: [{ project: "nightstash", path: "/Users/jane-doe/code/nightstash" }],
    });
  });
  afterEach(async () => {
    await host.close();
  });

  it("returns the full snapshot with counts", async () => {
    await seed(host);
    const result = await host.invoke<ExportResult>("memory.export");
    expect(result.snapshot.version).toBe(SNAPSHOT_VERSION);
    expect(result.snapshot.exportedAt).toBe(NOW.toISOString());
    expect(result.memories).toBe(1);
    expect(result.snapshot.memories[0]!.body).toContain("ordered pizza");
    expect(result.versions).toBe(1);
    expect(result.snapshot.sections).toHaveLength(5);
  });

  it("never holds a local folder path: a project travels by slug and repository", async () => {
    await project(host, "nightstash", { repoUrl: "github.com/jane-doe/nightstash", shelf: "WRK/NST" });
    const result = await host.invoke<ExportResult>("memory.export");
    const text = JSON.stringify(result);
    expect(text).toContain("github.com/jane-doe/nightstash");
    expect(text).not.toContain("/Users/jane-doe");
    expect(Object.keys(result.snapshot.projects[0]!).some((key) => /path/i.test(key))).toBe(false);
  });

  it("leaves out a forgotten memory, and the audit line holds counts only", async () => {
    const memory = await seed(host);
    await host.invoke("memory.forget", { call: memory.callNumber, confirmedByUser: true });
    host.audit.length = 0;
    const result = await host.invoke<ExportResult>("memory.export");
    expect(result.memories).toBe(0);
    expect(JSON.stringify(result)).not.toContain("pizza");
    expect(result.snapshot.aliases.map((alias) => [alias.oldCallNumber, alias.memoryId])).toEqual([[memory.callNumber, null]]);
    expect(host.audit[0]).toMatchObject({ tool: "memory.export", detail: { memories: 0 } });
    expect(auditStrings(host)).toEqual(["memory.export", "read"]);
  });
});
