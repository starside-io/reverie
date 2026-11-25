import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MODULE_EVENTS } from "../../src/ports.js";
import { registry, type ToolKind } from "../../src/tools/index.js";

/**
 * Gate, carried over from Fellowship: manifest matches registry. module.json
 * describes this module to a host kernel. It is written by hand and read by
 * something else, so the one thing it has to keep agreeing on with the code
 * gets a test: the tool names, under the right kind, and the events.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "module.json"), "utf8")) as {
  tools: { read: string[]; write: string[]; needsOk: string[] };
  events: { emits: string[] };
};

const namesOf = (kind: ToolKind) =>
  registry.tools
    .filter((tool) => tool.kind === kind)
    .map((tool) => tool.name)
    .sort();

describe("module.json", () => {
  it("lists the 41 tools: 20 read, 15 write, 6 needs-ok", () => {
    expect(manifest.tools.read).toHaveLength(20);
    expect(manifest.tools.write).toHaveLength(15);
    expect(manifest.tools.needsOk).toHaveLength(6);
    expect(registry.names()).toHaveLength(41);
  });

  it("files every tool under the kind the registry gives it", () => {
    expect([...manifest.tools.read].sort()).toEqual(namesOf("read"));
    expect([...manifest.tools.write].sort()).toEqual(namesOf("write"));
    expect([...manifest.tools.needsOk].sort()).toEqual(namesOf("needs-ok"));
  });

  it("files draft_context under read and propose_draft under write (section 2)", () => {
    expect(registry.byName("memory.draft_context")?.kind).toBe("read");
    expect(registry.byName("memory.propose_draft")?.kind).toBe("write");
  });

  it("names the events the ports declare", () => {
    expect(manifest.events.emits).toEqual([...MODULE_EVENTS]);
  });
});
