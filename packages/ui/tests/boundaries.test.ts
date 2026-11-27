import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The UI imports no database (docs/SPEC.md section 21). It talks to the core
 * through POST /rpc and nothing else, so it may not reach @reverie/core, its
 * storage or a database driver at all, nor the host. As in core's and the
 * mini-host's boundaries tests, this lists what the UI may reach rather than
 * what it may not.
 */

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const ALLOWED_PACKAGES = [
  "react",
  "react-dom",
  "radix-ui",
  "lucide-react",
  "class-variance-authority",
  "clsx",
  "tailwind-merge",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && /\.(ts|tsx|css)$/.test(entry.name) ? [full] : [];
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
    /\brequire\(\s*"([^"]+)"\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) found.push(match[1]);
    }
  }
  return found;
}

const reaches = (specifier: string, name: string) => specifier === name || specifier.startsWith(`${name}/`);

describe("the UI's imports", () => {
  const files = sourceFiles(srcRoot).filter((file) => !file.endsWith(".css"));

  it("finds the source files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("reaches nothing but its own files and its UI libraries", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        if (specifier.startsWith("@/") || specifier.startsWith("./") || specifier.startsWith("../")) {
          if (specifier.includes("packages/") || specifier.includes("/core/") || specifier.includes("mini-host")) {
            offenders.push(`${file.slice(srcRoot.length + 1)} imports ${specifier}`);
          }
          continue;
        }
        if (ALLOWED_PACKAGES.some((name) => reaches(specifier, name))) continue;
        offenders.push(`${file.slice(srcRoot.length + 1)} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names no database, no core storage and no host anywhere in its source", () => {
    const banned = [
      "@reverie/core",
      "@reverie/mini-host",
      "@prisma/client",
      "prisma",
      "better-sqlite3",
      "node:sqlite",
      "sqlite3",
      "hono",
      "@hono/node-server",
      "node:fs",
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const specifier of specifiersOf(code)) {
        if (banned.some((name) => reaches(specifier, name))) offenders.push(`${file.slice(srcRoot.length + 1)} imports ${specifier}`);
      }
      // No SQL is built here either.
      if (/\b(SELECT|INSERT INTO|DELETE FROM|UPDATE\s+"?\w+"?\s+SET)\b/.test(code)) {
        offenders.push(`${file.slice(srcRoot.length + 1)} holds SQL`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reaches the host only through /rpc, the review decision route, and the host's update and app routes", () => {
    const paths = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(/`\$\{BASE\}(\/[a-z]+)/g)) paths.add(match[1] as string);
    }
    expect([...paths].sort()).toEqual(["/host", "/rpc"]);
    // Code only, comments stripped: the /host routes client.ts actually calls.
    const client = stripComments(readFileSync(join(srcRoot, "client.ts"), "utf8"));
    expect([...new Set(client.match(/\/host\/[a-z]+/g))].sort()).toEqual(["/host/app", "/host/review", "/host/updates"]);
  });
});

describe("the UI's copy", () => {
  it("carries no em-dash or en-dash anywhere", () => {
    const offenders = sourceFiles(srcRoot).filter((file) => /[\u2013\u2014]/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
