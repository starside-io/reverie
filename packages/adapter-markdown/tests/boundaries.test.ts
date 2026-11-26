import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The arrow points one way (docs/SPEC.md section 21): adapters import the
 * registry and nothing below it. This adapter needs less than that: it is
 * the markdown connector behind the host's `connectors` port and declares
 * the port shape it answers itself, so it imports nothing of core's at all,
 * neither the registry nor anything below it (domain, storage, tools,
 * generated client). Core, for its part, never imports an adapter: the
 * mirror reaches it only through the port.
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

const CORE_INTERNALS = /^@reverie\/core\/|\/core\/(src|dist|generated)\//;

describe("the markdown adapter's imports", () => {
  const files = sourceFiles(adapterSrc);

  it("finds the source files to check", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it("imports node builtins and its own files: no part of core below the registry, no other package", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        if (specifier.startsWith("node:") || specifier.startsWith("./")) continue;
        offenders.push(`${file.slice(adapterSrc.length + 1)} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never reaches into core's domain, storage, tools or Prisma client", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        if (CORE_INTERNALS.test(specifier) || specifier.includes("generated/prisma") || specifier === "@prisma/client") {
          offenders.push(`${file.slice(adapterSrc.length + 1)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("core and the adapter", () => {
  it("core imports no adapter and opens no file to read or write a mirror", () => {
    const files = sourceFiles(coreSrc);
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        if (specifier.includes("adapter")) offenders.push(`${file.slice(coreSrc.length + 1)} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);

    // The mirror and the folder import reach files through the port only.
    for (const path of [
      ["domain", "transfer", "mirror.ts"],
      ["domain", "transfer", "claude-code.ts"],
      ["tools", "shared", "folder-import.ts"],
      ["tools", "confirm", "import.ts"],
      ["tools", "read", "export.ts"],
    ]) {
      const source = readFileSync(join(coreSrc, ...path), "utf8");
      const fsImports = specifiersOf(source).filter((specifier) => specifier === "node:fs" || specifier === "node:fs/promises" || specifier === "fs");
      expect(fsImports, path.join("/")).toEqual([]);
    }
  });
});
