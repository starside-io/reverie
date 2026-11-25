import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { domain, storage } from "@reverie/core";
import type { Silo } from "@reverie/core";

/**
 * The round trip, as a command rather than as a shell history. Lifted from
 * Fellowship's verify.ts.
 *
 * Import a snapshot into a throwaway silo, export it back out, and compare the
 * two row by row. This is how a snapshot is checked before it goes anywhere
 * near the live file. The rule it makes bite: a table or a column added to the
 * schema goes into the snapshot, the exporter and the importer in the same
 * commit.
 *
 * Fellowship's version classifies a list of known normalizations, because it
 * imports another app's export. Reverie only reads its own snapshots, and
 * core's round trip gate says those come back identical, so any difference
 * here counts as loss. The search index of the throwaway copy is checked
 * against its rows too.
 */

export interface VerifyResult {
  file: string;
  version: number;
  siloPath: string;
  importMs: number;
  exportMs: number;
  counts: domain.transfer.ImportCounts;
  diff: domain.transfer.SnapshotDiff;
  searchIntegrity: storage.SearchIntegrity;
  /** True when the export equals the file and the search index matches its rows. */
  ok: boolean;
}

export interface VerifyOptions {
  /** Keep the throwaway silo instead of deleting it, to look inside. */
  keep?: boolean;
}

export async function verifySnapshot(
  file: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const source = JSON.parse(readFileSync(file, "utf8")) as domain.transfer.ExportSnapshot;
  const dir = mkdtempSync(join(tmpdir(), "reverie-verify-"));
  const siloPath = join(dir, "reverie.db");

  storage.migrateSilo(siloPath);
  const db: Silo = await storage.openSilo({ path: siloPath });

  try {
    const importStarted = Date.now();
    const imported = await domain.transfer.importSnapshot(db, source, "replace");
    const importMs = Date.now() - importStarted;

    const exportStarted = Date.now();
    const exported = await domain.transfer.buildExportSnapshot(db);
    const exportMs = Date.now() - exportStarted;

    const diff = domain.transfer.diffSnapshots(source, exported);
    const searchIntegrity = await storage.searchIntegrity(db);

    return {
      file,
      version: source.version,
      siloPath,
      importMs,
      exportMs,
      counts: imported.counts,
      diff,
      searchIntegrity,
      ok: diff.identical && searchIntegrity.status === "ok",
    };
  } finally {
    await db.$disconnect();
    if (!options.keep) rmSync(dir, { recursive: true, force: true });
  }
}

/** The report the CLI prints. */
export function formatVerify(result: VerifyResult): string {
  const counts = Object.entries(result.counts)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([name, value]) => `  ${name.padEnd(14)} ${value}`);
  return [
    `file            ${result.file}`,
    `version         ${result.version}`,
    `import          ${result.importMs}ms`,
    `export          ${result.exportMs}ms`,
    "imported",
    ...counts,
    "",
    domain.transfer.formatDiff(result.diff),
    "",
    `search index    ${result.searchIntegrity.status === "ok" ? "matches its rows" : `drifted: ${result.searchIntegrity.detail}`}`,
    "",
    result.ok
      ? "No data loss. The export equals the file."
      : "Something did not survive the round trip. See the lines above.",
    "",
  ].join("\n");
}
