import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The arrow points one way (docs/SPEC.md section 21): adapters import the
 * registry and nothing below it. This adapter reaches the library only
 * through the registry's invoke, and takes its types from @reverie/core's
 * entry, never from core's domain, storage, tools folder or Prisma client.
 * It imports no node builtin either: it never touches a real file, opens no
 * socket and spawns nothing. Core, for its part, never imports an adapter.
 */

const here = dirname(fileURLToPath(import.meta.url));
const adapterSrc = join(here, "..", "src");
const coreSrc = join(here, "..", "..", "core", "src");

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

interface Specifier {
  specifier: string;
  typeOnly: boolean;
}

function specifiersOf(source: string): Specifier[] {
  const code = stripComments(source);
  const found: Specifier[] = [];
  for (const match of code.matchAll(/(?:^|\n)\s*(import|export)(\s+type)?[\s\S]*?from\s+"([^"]+)"/g)) {
    found.push({ specifier: match[3] as string, typeOnly: Boolean(match[2]) });
  }
  for (const pattern of [/(?:^|\n)\s*import\s+"([^"]+)"/g, /\bimport\(\s*"([^"]+)"\s*\)/g, /\brequire\(\s*"([^"]+)"\s*\)/g]) {
    for (const match of code.matchAll(pattern)) found.push({ specifier: match[1] as string, typeOnly: false });
  }
  return found;
}

describe("the memory tool adapter's imports", () => {
  const files = sourceFiles(adapterSrc);

  it("finds the source files to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it("imports its own files, and @reverie/core's entry for types only: nothing else", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { specifier, typeOnly } of specifiersOf(readFileSync(file, "utf8"))) {
        if (specifier.startsWith("./")) continue;
        if (specifier === "@reverie/core" && typeOnly) continue;
        offenders.push(`${file.slice(adapterSrc.length + 1)} imports ${specifier}${typeOnly ? " (types)" : ""}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never reaches below the registry: no core subpath, no core source, no Prisma, no node builtin", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { specifier } of specifiersOf(readFileSync(file, "utf8"))) {
        if (
          specifier.startsWith("@reverie/core/") ||
          /\/core\/(src|dist|generated)\//.test(specifier) ||
          specifier.includes("prisma") ||
          specifier.startsWith("node:") ||
          ["fs", "fs/promises", "path", "child_process", "net", "http", "https"].includes(specifier)
        ) {
          offenders.push(`${file.slice(adapterSrc.length + 1)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names no forget or redact tool anywhere in its source", () => {
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code, file).not.toMatch(/memory\.(forget|redact|merge|import|decide)\b/);
    }
  });
});

describe("core and the adapter", () => {
  it("core imports no adapter", () => {
    const files = sourceFiles(coreSrc);
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      for (const { specifier } of specifiersOf(readFileSync(file, "utf8"))) {
        if (specifier.includes("adapter")) offenders.push(`${file.slice(coreSrc.length + 1)} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
