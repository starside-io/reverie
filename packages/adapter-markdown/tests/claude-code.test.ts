import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readClaudeCodeDirectory } from "../src/claude-code.js";
import { createMarkdownConnector } from "../src/connector.js";
import { CLAUDE_CODE_FILES, writeClaudeCodeFixture } from "./fixtures/claude-code.js";

/** An invented directory in a temp folder, never a real one. */
function fixture(): string {
  return writeClaudeCodeFixture(join(mkdtempSync(join(tmpdir(), "reverie-cc-")), "memory"));
}

describe("reading a Claude Code memory directory", () => {
  it("hands over the index and every memory file, both front matter shapes", () => {
    const dir = fixture();
    const files = readClaudeCodeDirectory(dir);
    expect(files.map((file) => file.path)).toEqual(Object.keys(CLAUDE_CODE_FILES).sort());
    const byPath = new Map(files.map((file) => [file.path, file]));
    expect(byPath.get("user-role.md")).toMatchObject({ data: { name: "user-role", metadata: { type: "user" } }, error: null });
    expect(byPath.get("feedback-indent.md")).toMatchObject({ data: { name: "feedback-indent", type: "feedback" } });
    expect(byPath.get("reference-board.md")?.data).toMatchObject({ description: "Build board: builds.example.test" });
    expect(byPath.get("MEMORY.md")?.body).toContain("\u2014 who she is at work");
    for (const file of files) expect(file.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reads only: no file is changed, added or touched", () => {
    const dir = fixture();
    const before = readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8"), statSync(join(dir, name)).mtimeMs]);
    readClaudeCodeDirectory(dir);
    const after = readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8"), statSync(join(dir, name)).mtimeMs]);
    expect(after).toEqual(before);
  });

  it("reads no subfolder and follows no symlink, and reports a broken file on its own", async () => {
    const dir = fixture();
    const elsewhere = mkdtempSync(join(tmpdir(), "reverie-cc-out-"));
    writeFileSync(join(elsewhere, "outside.md"), "---\nname: outside\n---\nnot in the directory\n");
    symlinkSync(join(elsewhere, "outside.md"), join(dir, "linked.md"));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "deeper.md"), "---\nname: deeper\n---\nbelow\n");
    writeFileSync(join(dir, "broken.md"), "---\nname: [unclosed\n---\nbody\n");

    const files = readClaudeCodeDirectory(dir);
    expect(files.map((file) => file.path)).not.toContain("linked.md");
    expect(files.map((file) => file.path)).not.toContain("nested/deeper.md");
    expect(files.find((file) => file.path === "broken.md")?.error).toMatch(/front matter/);

    const pulled = await createMarkdownConnector().pull(JSON.stringify({ op: "read_claude_code", folder: dir }));
    expect(pulled.items).toHaveLength(files.length);
  });
});
