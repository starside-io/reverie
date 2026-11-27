import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { APP_NAME, REPO, desktopAppStatus, installDesktopApp, type AppInstallSeams } from "./desktop-app.js";

/**
 * Whether a newer release of the Claude Code plugin is out, and installing it.
 * Lifted from Fellowship's updates.ts.
 *
 * Off until the owner turns it on in Settings: the check is the one request
 * the Reverie host makes to the network by itself, so it does not happen
 * unasked. When it is on, it asks GitHub for the newest release of the repo
 * at most once a day, and sends nothing but that request: no memory, no
 * count, no path. module.json's `network: none` is about the memory module,
 * which never reaches the network; this is the host's, and opt-in.
 *
 * GitHub's releases/latest answers with the newest published release only,
 * so a prerelease or a draft is never offered.
 *
 * The installed version is the one Claude Code records for the plugin in its
 * own installed_plugins.json. Installing runs Claude Code's own
 * `claude plugin update`, so the plugin lands exactly the way /plugin would
 * put it there, and takes effect when Claude Code restarts.
 */

/** The plugin's name in Claude Code's records: reverie@<marketplace>. */
export const PLUGIN_NAME = "reverie";

/** The host.db setting that turns the check on. */
export const UPDATES_SETTING = "updates.check";

export const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** A failed check is retried sooner than a good one is repeated. */
const RETRY_FAILED_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 4_000;
/**
 * A plugin installed from a local folder is copied whole on every update,
 * node_modules and build output included: several gigabytes for a checkout
 * that has been built. That takes minutes, not seconds.
 */
const COMMAND_TIMEOUT_MS = 20 * 60_000;

export interface InstalledPlugin {
  /** The id Claude Code knows it by, such as reverie@reverie. */
  pluginId: string;
  marketplace: string;
  version: string;
  scope: string;
  /** Where Claude Code unpacked this version, under its plugin cache. */
  installPath: string | null;
}

export interface LatestRelease {
  version: string;
  tag: string;
  url: string;
  publishedAt: string | null;
}

interface UpdateCache {
  checkedAt: string;
  latest: LatestRelease | null;
  error: string | null;
}

export interface UpdateStatus {
  enabled: boolean;
  installed: InstalledPlugin | null;
  latest: LatestRelease | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
  /** What to run by hand, for anyone who would rather not press the button. */
  command: string | null;
}

export interface UpdateOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: Date;
}

/** Claude Code's own folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["CLAUDE_CONFIG_DIR"]?.trim() || join(homedir(), ".claude");
}

/** The Reverie plugin as Claude Code recorded it, or null when it is not installed. */
export function readInstalledPlugin(env: NodeJS.ProcessEnv = process.env): InstalledPlugin | null {
  const path = join(claudeConfigDir(env), "plugins", "installed_plugins.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const root = parsed as { plugins?: Record<string, unknown> } & Record<string, unknown>;
  const plugins = (root.plugins ?? root) as Record<string, unknown>;

  const found: InstalledPlugin[] = [];
  for (const [pluginId, value] of Object.entries(plugins)) {
    const [name, marketplace] = pluginId.split("@");
    if (name !== PLUGIN_NAME || !marketplace) continue;
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries as Array<Record<string, unknown>>) {
      if (typeof entry?.["version"] !== "string") continue;
      found.push({
        pluginId,
        marketplace,
        version: entry["version"],
        scope: typeof entry["scope"] === "string" ? entry["scope"] : "user",
        installPath: typeof entry["installPath"] === "string" ? entry["installPath"] : null,
      });
    }
  }
  return found.find((plugin) => plugin.scope === "user") ?? found[0] ?? null;
}

function parseVersion(value: string): { core: number[]; pre: string | null } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

/** Positive when a is newer than b. Versions that do not parse compare equal. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index++) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** The newest published release, or null when the repo has none yet. */
export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<LatestRelease | null> {
  const response = await fetchImpl(RELEASES_URL, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "reverie-update-check",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);

  const body = (await response.json()) as {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
  };
  if (typeof body.tag_name !== "string") throw new Error("GitHub's answer had no release tag");
  return {
    version: body.tag_name.replace(/^v/, ""),
    tag: body.tag_name,
    url: typeof body.html_url === "string" ? body.html_url : `https://github.com/${REPO}/releases`,
    publishedAt: typeof body.published_at === "string" ? body.published_at : null,
  };
}

/** The last answer, beside host.db, shared by the host and the session start hook. */
export function updateCachePath(hostDbPath: string): string {
  return join(dirname(hostDbPath), "update-check.json");
}

function readCache(path: string): UpdateCache | null {
  try {
    const cache = JSON.parse(readFileSync(path, "utf8")) as UpdateCache;
    return typeof cache.checkedAt === "string" ? cache : null;
  } catch {
    return null;
  }
}

function writeCache(path: string, cache: UpdateCache): void {
  try {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`);
    renameSync(temporary, path);
  } catch {
    // A cache that cannot be written only means the next check asks again.
  }
}

/**
 * Reads the setting straight from host.db, read only, for the session start
 * hook, which runs beside a live host rather than inside one. A host.db that
 * is not there yet reads as off, and is not created.
 */
export function readUpdatesEnabled(hostDbPath: string): boolean {
  if (!existsSync(hostDbPath)) return false;
  try {
    const db = new DatabaseSync(hostDbPath, { readOnly: true });
    try {
      const row = db
        .prepare(`SELECT "value" FROM "setting" WHERE "key" = ?`)
        .get(UPDATES_SETTING) as { value?: string } | undefined;
      return row?.value !== undefined && JSON.parse(row.value) === true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function updateCommand(installed: InstalledPlugin): string {
  return `claude plugin marketplace update ${installed.marketplace} && claude plugin update ${installed.pluginId}`;
}

/**
 * Where things stand. Reaches the network only when the check is on, the
 * plugin is installed, and the cached answer is stale or a refresh was asked
 * for.
 */
export async function checkForUpdates(
  options: UpdateOptions & { enabled: boolean; hostDbPath: string; force?: boolean },
): Promise<UpdateStatus> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const installed = readInstalledPlugin(env);
  const base = {
    enabled: options.enabled,
    installed,
    command: installed ? updateCommand(installed) : null,
  };

  if (!options.enabled || !installed) {
    return { ...base, latest: null, updateAvailable: false, checkedAt: null, error: null };
  }

  const cachePath = updateCachePath(options.hostDbPath);
  let cache = readCache(cachePath);
  const age = cache ? now.getTime() - Date.parse(cache.checkedAt) : Infinity;
  const stale = !cache || age < 0 || age > (cache.error ? RETRY_FAILED_MS : CHECK_EVERY_MS);

  if (options.force || stale) {
    try {
      const latest = await fetchLatestRelease(options.fetch ?? fetch);
      cache = { checkedAt: now.toISOString(), latest, error: null };
    } catch (error) {
      cache = {
        checkedAt: now.toISOString(),
        latest: cache?.latest ?? null,
        error: `Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    writeCache(cachePath, cache);
  }

  const latest = cache?.latest ?? null;
  return {
    ...base,
    latest,
    updateAvailable: latest !== null && compareVersions(latest.version, installed.version) > 0,
    checkedAt: cache?.checkedAt ?? null,
    error: cache?.error ?? null,
  };
}

export type CommandRunner = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number; output: string }>;

/** Runs a command with no terminal attached, and says so plainly when it runs out of time. */
export function commandRunner(timeoutMs: number = COMMAND_TIMEOUT_MS): CommandRunner {
  return (file, args, env) =>
    new Promise((resolve) => {
      const child = execFile(
        file,
        args,
        { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          let output = `${stdout}${stderr}`.trim();
          if (error && (error.killed || error.signal)) {
            const minutes = Math.round(timeoutMs / 60_000);
            output = `${output}\nStopped after ${minutes > 0 ? `${minutes} minutes` : `${timeoutMs} ms`} with no answer.`.trim();
          }
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ code, output: output || (error?.message ?? "") });
        },
      );
      // No terminal to answer a prompt from. Anything that would ask is refused instead.
      child.stdin?.end();
    });
}

/**
 * Claude Code's CLI. A host started by the desktop app inherits a short PATH,
 * so the usual install locations are tried after it.
 */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = homedir();
  const candidates = [
    ...(env["PATH"] ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "claude")),
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

export interface InstallResult {
  ok: boolean;
  message: string;
  output: string;
  command: string | null;
}

/**
 * Refreshes the plugin's marketplace, then updates the plugin, the same two
 * steps /plugin takes. Nothing is accepted on the owner's behalf: if the
 * marketplace declares an install command that needs a yes, the update stops
 * and says so.
 */
export async function installUpdate(
  options: {
    env?: NodeJS.ProcessEnv;
    run?: CommandRunner;
    claudePath?: string | null;
    /** Seams for the desktop app half, so a test downloads nothing. */
    app?: AppInstallSeams;
  } = {},
): Promise<InstallResult> {
  const env = options.env ?? process.env;
  const installed = readInstalledPlugin(env);
  if (!installed) {
    return {
      ok: false,
      message: "Reverie is not installed as a Claude Code plugin here, so there is nothing to update.",
      output: "",
      command: null,
    };
  }

  const command = updateCommand(installed);
  const claude = options.claudePath === undefined ? findClaude(env) : options.claudePath;
  if (!claude) {
    return {
      ok: false,
      message: `Could not find the claude command. Run this in a terminal instead: ${command}`,
      output: "",
      command,
    };
  }

  const run = options.run ?? commandRunner();
  const steps: string[][] = [
    ["plugin", "marketplace", "update", installed.marketplace],
    ["plugin", "update", installed.pluginId, "--scope", installed.scope],
  ];
  const outputs: string[] = [];
  for (const args of steps) {
    const result = await run(claude, args, env);
    outputs.push(`$ claude ${args.join(" ")}\n${result.output}`.trim());
    if (result.code !== 0) {
      return {
        ok: false,
        message: `claude ${args.slice(0, 3).join(" ")} failed. Run this in a terminal to see why: ${command}`,
        output: outputs.join("\n\n"),
        command,
      };
    }
  }

  const removed = pruneOldVersions(env);
  const notes = ["Updated. Restart Claude Code to load the new version."];
  if (removed.length > 0) {
    notes.push(`Removed ${removed.length} older ${removed.length === 1 ? "copy" : "copies"} of the plugin.`);
  }

  // The desktop app follows the plugin, but only where the owner installed it.
  const updated = readInstalledPlugin(env);
  if (updated && desktopAppStatus(env).version !== null) {
    const app = await installDesktopApp({ ...options.app, version: updated.version, env });
    notes.push(app.ok ? `${APP_NAME} is now ${updated.version}; reopen it to load it.` : app.message);
  }

  return {
    ok: true,
    message: notes.join(" "),
    output: outputs.join("\n\n"),
    command,
  };
}

/**
 * Claude Code keeps every version it ever unpacked, each a full copy, and a
 * plugin installed from a local folder copies node_modules and build output
 * along with it. Once the new version is in place, the others go: the older
 * versions and any half finished copy an interrupted update left behind.
 *
 * Only folders beside the installed one, inside Claude Code's own plugin
 * cache, under a folder named after this plugin, are touched.
 */
export function pruneOldVersions(env: NodeJS.ProcessEnv = process.env): string[] {
  const installed = readInstalledPlugin(env);
  if (!installed?.installPath) return [];

  const cacheRoot = resolve(claudeConfigDir(env), "plugins", "cache");
  const current = resolve(installed.installPath);
  const versionsDir = dirname(current);
  if (basename(versionsDir) !== PLUGIN_NAME || !versionsDir.startsWith(cacheRoot + sep)) return [];
  if (!existsSync(current)) return [];

  const removed: string[] = [];
  for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
    const path = join(versionsDir, entry.name);
    if (!entry.isDirectory() || path === current) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // In use or not ours to remove: it stays, and the next update tries again.
    }
  }
  return removed;
}
