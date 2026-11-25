import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { startMiniHost } from "@reverie/mini-host";

/**
 * scripts/plugin-bootstrap.mjs in `hook` mode, against the built repo, as
 * hooks/hooks.json runs it. The repo is built first, so the hand over runs
 * the CLI as it is in source now, not whatever an earlier build left in
 * dist. Every name and place is invented.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "plugin-bootstrap.mjs");

beforeAll(() => {
  const build = spawnSync("corepack", ["pnpm", "-r", "build"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    encoding: "utf8",
  });
  if (build.status !== 0) throw new Error(`The build failed:\n${build.stdout}\n${build.stderr}`);
}, 240_000);

function bootstrapHook(event: string, stdin: string, cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, "hook", event], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

describe("plugin-bootstrap.mjs hook, on the built repo", () => {
  it("hands session-start to the CLI and returns valid SessionStart hook JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reverie-bootstrap-"));
    const project = join(dir, "harbour-lane");
    mkdirSync(project);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REVERIE_DB_PATH: join(dir, "reverie.db"),
      REVERIE_HOST_DB_PATH: join(dir, "host.db"),
    };

    const host = await startMiniHost({ env });
    try {
      await host.api.invoke("memory.remember", {
        kind: "fact",
        shelf: "LIF/HOM",
        title: "Spare key",
        body: "The spare key to the Harbour Lane flat hangs by the back door.",
      });
    } finally {
      await host.close();
    }

    const stdin = JSON.stringify({
      session_id: "5c4b3a29-1807-4f6e-8d5c-4b3a29180716",
      transcript_path: join(dir, "t.jsonl"),
      cwd: project,
      hook_event_name: "SessionStart",
      source: "startup",
    });
    const result = await bootstrapHook("session-start", stdin, project, env);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("## Library");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("LIF");

    // A malformed stdin through the same path: nothing, and still 0.
    expect(await bootstrapHook("session-start", "nope", project, env)).toEqual({ code: 0, stdout: "" });
  });
});
