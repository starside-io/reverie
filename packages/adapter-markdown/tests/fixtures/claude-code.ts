import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An invented Claude Code memory directory, in both front matter shapes.
 * Never a real one: every name and fact here is made up (Jane Doe, John Doe,
 * Sam Rivera, invented places). The index separates each pointer from its
 * hook with a dash written as an escape, as the format does.
 */

const DASH = "\u2014";

export const CLAUDE_CODE_FILES: Record<string, string> = {
  "MEMORY.md": [
    "# Memory index",
    "",
    `- [Jane's role](user-role.md) ${DASH} who she is at work`,
    `- [Commit style](feedback-commits.md) ${DASH} how commits are written`,
    `- [Tabs or spaces](feedback-indent.md) ${DASH} indentation`,
    `- [Harbour launch](project-launch.md) ${DASH} the launch plan`,
    `- [Build board](reference-board.md) ${DASH} where builds are watched`,
    "",
  ].join("\n"),
  // The current shape: type under metadata.
  "user-role.md": [
    "---",
    "name: user-role",
    "description: Jane Doe is the lead engineer on the Harbour app",
    "metadata:",
    "  type: user",
    "---",
    "Jane Doe leads engineering on the Harbour app at Northwind Labs in Port Aster.",
    "",
  ].join("\n"),
  "feedback-commits.md": [
    "---",
    "name: feedback-commits",
    "description: Commit subjects are imperative and short",
    "metadata:",
    "  type: feedback",
    "---",
    "Write commit subjects in the imperative mood, under seventy two characters.",
    "",
    "**Why:** Jane reads the log as a list of changes, see [[project-launch]].",
    "**How to apply:** Every commit in the Harbour repository.",
    "",
  ].join("\n"),
  // The older flat shape: type at the top level.
  "feedback-indent.md": [
    "---",
    "name: feedback-indent",
    "description: Two spaces, never tabs",
    "type: feedback",
    "---",
    "Indent with two spaces in every file, never tabs.",
    "",
  ].join("\n"),
  "project-launch.md": [
    "---",
    "name: project-launch",
    "description: The Harbour launch is set for 2027-03-15",
    "type: project",
    "---",
    "The Harbour app launches on 2027-03-15 with Sam Rivera running the release.",
    "",
    "**Why:** The marketing week at Port Aster starts then.",
    "",
  ].join("\n"),
  "reference-board.md": [
    "---",
    "name: reference-board",
    'description: "Build board: builds.example.test"',
    "metadata:",
    "  type: reference",
    "---",
    "Harbour builds are watched on the board at https://builds.example.test/harbour.",
    "",
  ].join("\n"),
};

/** Writes the directory into `dir` and returns it. */
export function writeClaudeCodeFixture(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(CLAUDE_CODE_FILES)) writeFileSync(join(dir, name), content);
  return dir;
}
