import { createHash } from "node:crypto";

import { zodToJsonSchema } from "zod-to-json-schema";

import { readMigrations } from "./storage/migrate.js";
import { registry as defaultRegistry, type ToolRegistry } from "./tools/index.js";

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * A short hash of what a client can rely on: every tool's name, kind and
 * input schema, and every migration with its checksum. docs/SPEC.md section
 * 10, "Surface fingerprint". Lifted from Fellowship's fingerprint.ts.
 *
 * Two hosts with the same fingerprint answer the same calls against the same
 * schema, so a client built against one can talk to the other. A host still
 * running yesterday's code has a different one, which is how the desktop app
 * tells a host it can reuse from one it has to replace.
 */
export function surfaceFingerprint(
  registry: ToolRegistry = defaultRegistry,
  migrationsDir?: string,
): string {
  const tools = [...registry.tools]
    .map((tool) => ({
      name: tool.name,
      kind: tool.kind,
      input: zodToJsonSchema(tool.input, { $refStrategy: "relative" }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const migrations = readMigrations(migrationsDir).map(
    (migration) => `${migration.name}:${migration.checksum}`,
  );

  // A default computed at call time, such as now for a date, is not part of
  // the contract and would make every run hash differently.
  const stable = (key: string, value: unknown) =>
    key === "default" && typeof value === "string" && ISO_INSTANT.test(value) ? undefined : value;

  return createHash("sha256")
    .update(JSON.stringify({ tools, migrations }, stable))
    .digest("hex")
    .slice(0, 16);
}
