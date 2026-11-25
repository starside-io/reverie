import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The dependency arrow points one way: core imports no UI and no host.
 * docs/SPEC.md section 21.
 *
 * Rather than list what is forbidden and wait for something new to slip
 * through, this asserts the whole of what core is allowed to reach: its own
 * files, the Node standard library, zod, and the Prisma client generated from
 * its own schema. Anything else is a bug in the import, not in this test.
 */

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const ALLOWED_PACKAGES = new Set(["zod"]);
const GENERATED_CLIENT = /^(\.\.\/)+generated\/prisma\/index\.js$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Comments go first. A prose comment that happens to contain the word "from"
 * and a quoted phrase otherwise reads as an import.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

/** Every module specifier in a file: static imports, re-exports, dynamic. */
function specifiersOf(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+"([^"]+)"/g,
    /(?:^|\n)\s*import\s+"([^"]+)"/g,
    /\bimport\(\s*"([^"]+)"\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) found.push(match[1]);
    }
  }
  return found;
}

describe("core's imports", () => {
  const files = sourceFiles(srcRoot);

  it("finds the source files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("reaches nothing but its own files, node, zod and its own Prisma client", () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        if (specifier.startsWith(".")) {
          if (GENERATED_CLIENT.test(specifier) || !specifier.includes("generated/")) continue;
        }
        if (specifier.startsWith("node:")) continue;
        if (ALLOWED_PACKAGES.has(specifier)) continue;
        if (specifier.startsWith(".")) continue;
        offenders.push(`${file.slice(srcRoot.length + 1)} imports ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("names no UI or host package anywhere in its source", () => {
    const banned = [
      "react",
      "react-dom",
      "lucide-react",
      "next",
      "@reverie/ui",
      "@reverie/mini-host",
      "@reverie/adapter-memory-tool",
      "@reverie/adapter-markdown",
      "@fellowship/ui",
      "@fellowship/mini-host",
      "@fellowship/core",
      "tiptap",
      "sharp",
      "hono",
      "@modelcontextprotocol/sdk",
    ];
    const offenders: string[] = [];

    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        if (banned.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
          offenders.push(`${file.slice(srcRoot.length + 1)} imports ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
