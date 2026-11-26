import { describe, expect, it } from "vitest";

import {
  readClaudeCodeIndex,
  readClaudeCodeMemory,
  splitWhyAndHow,
  wikiLinks,
} from "../../src/domain/transfer/claude-code.js";
import type { MirrorReadFile } from "../../src/domain/transfer/mirror.js";

/** Invented memory files, as the markdown connector hands them over. */
function file(path: string, data: Record<string, unknown> | null, body: string): MirrorReadFile {
  return { path, format: "markdown", data, body, owned: false, unchanged: false, sha256: null, modifiedAt: "2026-11-03T08:00:00.000Z", error: null };
}

describe("reading a Claude Code memory file", () => {
  it("maps each type to a kind, in both front matter shapes", () => {
    const cases: Array<[Record<string, unknown>, string, string, boolean]> = [
      [{ name: "a", description: "Jane Doe leads Harbour", metadata: { type: "user" } }, "Jane leads it.", "fact", false],
      [{ name: "b", description: "Two spaces", type: "feedback" }, "Indent with two spaces.", "preference", true],
      [{ name: "c", description: "Commits", metadata: { type: "feedback" } }, "Imperative.\n**Why:** A log.\n**How to apply:** Always.", "procedure", true],
      [{ name: "d", description: "Launch", type: "project" }, "Launches 2027-03-15.", "fact", true],
      [{ name: "e", description: "Board", metadata: { type: "reference" } }, "https://builds.example.test", "reference", true],
      [{ name: "f", description: "No type" }, "Untyped.", "fact", true],
    ];
    for (const [data, body, kind, projectScoped] of cases) {
      const read = readClaudeCodeMemory(file(`${String(data["name"])}.md`, data, body));
      expect("memory" in read, String(data["name"])).toBe(true);
      if ("memory" in read) expect([read.memory.kind, read.memory.projectScoped]).toEqual([kind, projectScoped]);
    }
  });

  it("carries Why and How to apply into their own fields, and keeps links in the body", () => {
    const read = readClaudeCodeMemory(
      file(
        "feedback-commits.md",
        { name: "feedback-commits", description: "Commit subjects are imperative", metadata: { type: "feedback" } },
        "Write commit subjects in the imperative.\n\n**Why:** Jane reads the log,\nsee [[project-launch]].\n\n**How to apply:** Every commit.\n",
      ),
    );
    if (!("memory" in read)) throw new Error("expected a memory");
    expect(read.memory).toMatchObject({
      name: "feedback-commits",
      title: "Commit subjects are imperative",
      body: "Write commit subjects in the imperative.",
      why: "Jane reads the log, see [[project-launch]].",
      howToApply: "Every commit.",
      links: ["project-launch"],
      quote: "Commit subjects are imperative",
      kind: "procedure",
    });
  });

  it("never reads the index as a memory, and reports a bad file on its own", () => {
    expect(readClaudeCodeMemory(file("MEMORY.md", null, "- [A](a.md)"))).toEqual({ problem: { file: "MEMORY.md", message: expect.any(String) } });
    expect(readClaudeCodeMemory(file("x.md", { type: "diary" }, "x"))).toMatchObject({ problem: { message: expect.stringMatching(/diary/) } });
    expect(readClaudeCodeMemory(file("y.md", {}, ""))).toMatchObject({ problem: { message: expect.stringMatching(/no fact/) } });
    expect(readClaudeCodeMemory({ ...file("z.md", null, ""), error: "unreadable" })).toMatchObject({ problem: { message: "unreadable" } });
  });

  it("falls back to the index title, then the name, when there is no description", () => {
    const index = readClaudeCodeIndex(`# Index\n- [Harbour launch](project-launch.md) \u2014 the plan\n* [Other](./other.md)\nnot a pointer\n`);
    expect([...index]).toEqual([
      ["project-launch.md", "Harbour launch"],
      ["other.md", "Other"],
    ]);
    const fromIndex = readClaudeCodeMemory(file("project-launch.md", { type: "project" }, "Launches 2027-03-15."), index);
    const fromName = readClaudeCodeMemory(file("sam-rivera-role.md", { type: "user" }, "Sam Rivera runs releases."));
    expect("memory" in fromIndex && fromIndex.memory.title).toBe("Harbour launch");
    expect("memory" in fromName && fromName.memory.title).toBe("Sam rivera role");
  });

  it("splits the parts and finds the links the way the format writes them", () => {
    expect(splitWhyAndHow("Fact.\n- **Why**: because.\n**How to apply:**\nwhen asked.")).toEqual({
      body: "Fact.",
      why: "because.",
      howToApply: "when asked.",
    });
    expect(wikiLinks("See [[a]], [[b|label]], [[a]] and [[c.md]].")).toEqual(["a", "b", "c"]);
  });
});
