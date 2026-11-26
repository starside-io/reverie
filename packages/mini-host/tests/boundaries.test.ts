import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The dependency arrow points one way (docs/SPEC.md section 21): the
 * mini-host imports core through its package name and no UI at all. As in
 * core's boundaries test, this asserts the whole of what the host is allowed
 * to reach rather than listing what is forbidden.
 */

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const ALLOWED_PACKAGES = [
  "@reverie/core",
  "@reverie/connector-transcripts",
  "@hono/node-server",
  "@modelcontextprotocol/sdk",
  "hono",
  "zod",
  "zod-to-json-schema",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

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

const reaches = (specifier: string, name: string) => specifier === name || specifier.startsWith(`${name}/`);

describe("the mini-host's imports", () => {
  const files = sourceFiles(srcRoot);

  it("finds the source files to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("reaches nothing but its own files, node, core and its transports", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          // Its own files only: never a path into another package's source.
          if (specifier.includes("/core/") || specifier.includes("packages/")) {
            offenders.push(`${file.slice(srcRoot.length + 1)} imports ${specifier}`);
          }
          continue;
        }
        if (specifier.startsWith("node:")) continue;
        if (ALLOWED_PACKAGES.some((name) => reaches(specifier, name))) continue;
        offenders.push(`${file.slice(srcRoot.length + 1)} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names no UI package anywhere in its source", () => {
    const banned = [
      "react",
      "react-dom",
      "lucide-react",
      "vite",
      "tailwindcss",
      "@reverie/ui",
      "@fellowship/ui",
      "@fellowship/mini-host",
      "@fellowship/core",
      "sharp",
    ];
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        if (banned.some((name) => reaches(specifier, name))) {
          offenders.push(`${file.slice(srcRoot.length + 1)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
