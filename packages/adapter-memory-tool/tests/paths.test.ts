import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PathRefused, resolvePath } from "../src/index.js";
import { remember, rig, type Rig } from "./harness.js";

/**
 * Path traversal. docs/SPEC.md section 19: paths resolve against the virtual
 * root, and anything that escapes it is refused, traversal and encoded forms
 * included. There is no real directory behind /memories at all, so these
 * also check that no refused path reaches the registry.
 */

const ESCAPES: Array<[string, string]> = [
  ["parent", "/memories/../etc/passwd"],
  ["parent at the end", "/memories/Life/.."],
  ["deep parent", "/memories/Life/Gatherings/../../../../secrets.env"],
  ["parent landing back inside", "/memories/Life/../Life/Gatherings"],
  ["current directory", "/memories/./Life"],
  ["relative parent", "../secrets.env"],
  ["bare parent", ".."],
  ["absolute outside", "/etc/passwd"],
  ["sibling prefix", "/memories-backup/notes.md"],
  ["longer prefix", "/memoriesx"],
  ["root itself", "/"],
  ["home", "/Users/jane.doe/.ssh/id_ed25519"],
  ["encoded dots", "/memories/%2e%2e/secrets.env"],
  ["encoded dots upper case", "/memories/%2E%2E/secrets.env"],
  ["encoded slash", "/memories/..%2fsecrets.env"],
  ["encoded backslash", "/memories/..%5csecrets.env"],
  ["encoded whole sequence", "%2e%2e%2f%2e%2e%2fetc%2fpasswd"],
  ["double encoded dots", "/memories/%252e%252e/secrets.env"],
  ["double encoded slash", "/memories/%252e%252e%252fsecrets.env"],
  ["triple encoded", "/memories/%25252e%25252e/secrets.env"],
  ["five times encoded", "/memories/%252525252e%252525252e/x"],
  ["malformed encoding", "/memories/%e0%a4%a/x"],
  ["backslash traversal", "/memories\\..\\secrets.env"],
  ["backslash in a name", "/memories/Life\\Gatherings"],
  ["windows absolute", "C:\\Windows\\system32"],
  ["unc path", "\\\\server\\share"],
  ["null byte", "/memories/notes.md\u0000.png"],
  ["encoded null byte", "/memories/notes.md%00.png"],
  ["newline", "/memories/notes\n.md"],
  ["tab", "/memories/\t../x"],
  ["delete character", "/memories/x\u007f"],
  ["c1 control", "/memories/x\u0085"],
  ["full width dots", "/memories/\uff0e\uff0e/secrets.env"],
  ["one dot leader pair", "/memories/\u2024\u2024/secrets.env"],
  ["two dot leader", "/memories/\u2025/secrets.env"],
  ["full width slash", "/memories/..\uff0fsecrets.env"],
  ["full width backslash", "/memories/..\uff3csecrets.env"],
  ["small reverse solidus", "/memories/..\ufe68secrets.env"],
  ["division slash", "/memories/..\u2215secrets.env"],
  ["fraction slash", "/memories/..\u2044secrets.env"],
  ["big solidus", "/memories/..\u29f8secrets.env"],
  ["set minus", "/memories/..\u2216secrets.env"],
  ["encoded division slash", "/memories/..%E2%88%95secrets.env"],
  ["zero width space", "/memories/.\u200b./secrets.env"],
  ["right to left override", "/memories/\u202eLife"],
  ["byte order mark", "\ufeff/memories/Life"],
  ["padded parent", "/memories/ .. /x"],
];

describe("resolvePath", () => {
  it.each(ESCAPES)("refuses %s", (_label, path) => {
    expect(() => resolvePath(path)).toThrow(PathRefused);
  });

  it("refuses an empty path, a non string and an overlong one", () => {
    expect(() => resolvePath("")).toThrow(PathRefused);
    expect(() => resolvePath("   ")).toThrow(PathRefused);
    expect(() => resolvePath(undefined)).toThrow(PathRefused);
    expect(() => resolvePath(42)).toThrow(PathRefused);
    expect(() => resolvePath(`/memories/${"a".repeat(1100)}`)).toThrow(PathRefused);
  });

  it("names the reason", () => {
    const reasonOf = (path: string) => {
      try {
        resolvePath(path);
        return null;
      } catch (error) {
        return (error as PathRefused).reason;
      }
    };
    expect(reasonOf("/memories/../x")).toBe("traversal");
    expect(reasonOf("/etc/passwd")).toBe("outside_root");
    expect(reasonOf("/memories/..%2fx")).toBe("encoded_separator");
    expect(reasonOf("/memories/x\u0000")).toBe("control_character");
    expect(reasonOf("/memories\\x")).toBe("backslash");
    expect(reasonOf("/memories/..\u2215x")).toBe("lookalike_separator");
    expect(reasonOf("/memories/\u200bx")).toBe("format_character");
    expect(reasonOf("/memories/%252525252e")).toBe("malformed_encoding");
  });

  it("resolves what stays inside", () => {
    expect(resolvePath("/memories")).toEqual({ segments: [], path: "/memories" });
    expect(resolvePath("/memories/")).toEqual({ segments: [], path: "/memories" });
    expect(resolvePath("//memories//Life/")).toEqual({ segments: ["Life"], path: "/memories/Life" });
    expect(resolvePath("Life/Gatherings").path).toBe("/memories/Life/Gatherings");
    expect(resolvePath("/memories/Life/Gatherings/2026-12-24-001.md").segments).toEqual(["Life", "Gatherings", "2026-12-24-001.md"]);
    expect(resolvePath("/memories/Front%20desk/Returns").path).toBe("/memories/Front desk/Returns");
    expect(resolvePath("/memories/Life/notes..md").segments).toEqual(["Life", "notes..md"]);
    expect(resolvePath("/memories/Caf\u00e9").path).toBe("/memories/Caf\u00e9");
  });
});

describe("every command refuses an escaping path, and nothing reaches the registry", () => {
  let r: Rig;
  const calls: Array<{ name: string; input: unknown }> = [];

  beforeAll(async () => {
    r = await rig();
    await remember(r.host, { body: "Jane Doe hosted the winter dinner in Lowmarsh.", shelf: "LIF/GTH", occurredOn: "2026-12-24" });
  });

  afterAll(async () => {
    await r.close();
  });

  const commands = (path: string): Array<Record<string, unknown>> => [
    { command: "view", path },
    { command: "create", path, file_text: "Sam Rivera prefers tea." },
    { command: "str_replace", path, old_str: "a", new_str: "b" },
    { command: "insert", path, insert_line: 0, insert_text: "x" },
    { command: "delete", path },
    { command: "rename", old_path: path, new_path: "/memories/Life/Travel/x.md" },
    { command: "rename", old_path: "/memories/Life/Gatherings/2026-12-24-001.md", new_path: path },
  ];

  it.each(ESCAPES)("%s", async (_label, path) => {
    const { createMemoryToolHandler } = await import("../src/index.js");
    calls.length = 0;
    const handle = createMemoryToolHandler({
      invoke: (name, input, options) => {
        calls.push({ name, input });
        return r.host.api.invoke(name, input, options);
      },
    });
    for (const input of commands(path)) {
      for (const owner of [false, true]) {
        const result = await handle(input, { owner });
        expect(result.isError, JSON.stringify(input)).toBe(true);
        expect(result.content).toMatch(/^Error: The path is refused\./);
      }
    }
    expect(calls).toEqual([]);
    // The memory the renames named is where it was.
    expect((await r.call({ command: "view", path: "/memories/Life/Gatherings/2026-12-24-001.md" })).isError).toBe(false);
  });
});
