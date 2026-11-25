import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registry } from "../../src/tools/index.js";
import { auditStrings, type TestHost } from "../test-host.js";
import { gateHost, runEveryTool, SCRIPT_STRINGS } from "./harness.js";

/**
 * Guardrail 9: audit lines and RecallLog rows hold ids and numbers, never
 * memory text or query text (docs/SPEC.md section 15).
 *
 * A scripted session calls every one of the 41 tools. Afterwards no audit
 * line, and no RecallLog row, holds any body, title, quote, note, procedure
 * text or query the session used, whole or in part.
 */

/** Three word runs of a text, for catching a fragment as well as the whole. */
function fragments(text: string): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length <= 3) return [text];
  const out: string[] = [];
  for (let at = 0; at + 3 <= words.length; at += 1) out.push(words.slice(at, at + 3).join(" "));
  return out;
}

describe("after a session that touched every tool", () => {
  let host: TestHost;

  beforeEach(async () => {
    host = await gateHost();
    await runEveryTool(host);
  });
  afterEach(async () => {
    await host.close();
  });

  it("wrote an audit line for every tool", () => {
    expect(new Set(host.audit.map((line) => line.tool))).toEqual(new Set(registry.names()));
  });

  it("no audit line holds memory text or query text", () => {
    const logged = auditStrings(host).join("\n");
    for (const text of SCRIPT_STRINGS) {
      for (const fragment of fragments(text)) expect(logged, fragment).not.toContain(fragment);
    }
    // What an audit line may hold: tool names, kinds, ids, call numbers, refusal codes.
    for (const value of auditStrings(host)) {
      expect(value, value).toMatch(/^[A-Za-z0-9_.:/-]{1,128}$/);
    }
  });

  it("no RecallLog row holds memory text or query text", async () => {
    const rows = await host.db.recallLog.findMany();
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    for (const value of SCRIPT_STRINGS) {
      for (const fragment of fragments(value)) expect(text, fragment).not.toContain(fragment);
    }
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["at", "budget", "id", "memoryIds", "scope", "scopeRef", "scores"]);
    }
  });
});
