import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The arrow points one way (docs/SPEC.md section 21). The connector reaches
 * the filesystem and nothing of core's: it declares the port shape it
 * answers itself, so it imports no core module at all, not even the port
 * types. Core, for its part, never imports a connector: it reaches one only
 * through the optional `connectors` port the host hands it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const connectorSrc = join(here, "..", "src");
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

describe("the transcripts connector's imports", () => {
  const files = sourceFiles(connectorSrc);

  it("finds the source files to check", () => {
    expect(files.length).toBeGreaterThan(1);
  });

  it("imports node builtins and its own files, nothing of core's or anyone else's", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
        if (specifier.startsWith("node:") || specifier.startsWith("./")) continue;
        offenders.push(`${file.slice(connectorSrc.length + 1)} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("core and the connector", () => {
  it("core imports no connector, and reads no file to get a transcript", () => {
    const files = sourceFiles(coreSrc);
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const specifier of specifiersOf(source)) {
        if (specifier.includes("connector")) offenders.push(`${file.slice(coreSrc.length + 1)} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);

    // The extraction read path reaches transcripts through the port only.
    const extraction = readFileSync(join(coreSrc, "tools", "shared", "extraction.ts"), "utf8");
    expect(specifiersOf(extraction).filter((specifier) => specifier.startsWith("node:"))).toEqual([]);
    expect(extraction).toContain("connectors");
  });
});
