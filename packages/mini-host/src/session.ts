import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { SessionInfo } from "@reverie/core";

/**
 * Where an assistant attached over stdio is working, read once when the
 * server starts. Core uses it to resolve the project (docs/SPEC.md section 4)
 * and to scope session and agent memories.
 *
 *   folder     the server's working directory, which is the session's
 *   gitRemote  `git remote get-url origin` in that folder, when git answers
 *              within a moment; null otherwise. Core normalises it.
 *   id         REVERIE_SESSION_ID, else a fresh id per server process: an
 *              MCP client starts one server per session, so one process is
 *              one session
 *   agent      REVERIE_AGENT, else null. Section 24 leaves naming an agent to
 *              the caller, so nothing is guessed from the client's name.
 */

export const SESSION_ID_ENV = "REVERIE_SESSION_ID";
export const AGENT_ENV = "REVERIE_AGENT";

/** The remote of a folder, or null when there is none or git is slow or absent. */
export function gitRemoteOf(folder: string): string | null {
  try {
    const out = execFileSync("git", ["-C", folder, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function sessionFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): SessionInfo {
  return {
    id: env[SESSION_ID_ENV]?.trim() || randomUUID(),
    folder: cwd,
    gitRemote: gitRemoteOf(cwd),
    agent: env[AGENT_ENV]?.trim() || null,
  };
}
