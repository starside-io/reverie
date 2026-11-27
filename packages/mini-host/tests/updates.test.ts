import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/server.js";
import {
  RELEASES_URL,
  UPDATES_SETTING,
  checkForUpdates,
  commandRunner,
  compareVersions,
  installUpdate,
  pruneOldVersions,
  readInstalledPlugin,
  readUpdatesEnabled,
  type CommandRunner,
} from "../src/updates.js";
import { throwawayHost } from "./harness.js";

/**
 * The plugin update check. Lifted from Fellowship's updates.test.ts. Nothing
 * here reaches GitHub or the claude CLI: the fetch and the command runner are
 * stand ins, and Claude Code's config folder is a throwaway one. The
 * repository named in RELEASES_URL is never contacted.
 */

function claudeDir(plugins: Record<string, unknown> | null): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "reverie-claude-"));
  if (plugins) {
    mkdirSync(join(dir, "plugins"));
    writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
  }
  return { CLAUDE_CONFIG_DIR: dir, REVERIE_APP_DIR: join(dir, "Applications"), PATH: "" };
}

const INSTALLED = {
  "reverie@reverie": [{ scope: "user", version: "0.0.1", installPath: "/x" }],
  "fellowship@fellowship": [{ scope: "user", version: "9.9.9", installPath: "/y" }],
};

function release(tag: string) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        tag_name: tag,
        html_url: `https://github.com/starside-io/reverie/releases/tag/${tag}`,
        published_at: "2026-11-20T10:00:00Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function hostDbIn(): string {
  return join(mkdtempSync(join(tmpdir(), "reverie-updates-")), "host.db");
}

const JSON_POST = { method: "POST", headers: { "content-type": "application/json" } } as const;

describe("compareVersions", () => {
  it("orders by major, minor, patch, with a prerelease below its release", () => {
    expect(compareVersions("0.0.2", "0.0.1")).toBeGreaterThan(0);
    expect(compareVersions("v0.1.0", "0.0.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("0.0.1", "0.0.2")).toBeLessThan(0);
    expect(compareVersions("nightly", "0.0.1")).toBe(0);
  });
});

describe("readInstalledPlugin", () => {
  it("finds Reverie in Claude Code's record and ignores other plugins", () => {
    expect(readInstalledPlugin(claudeDir(INSTALLED))).toEqual({
      pluginId: "reverie@reverie",
      marketplace: "reverie",
      version: "0.0.1",
      scope: "user",
      installPath: "/x",
    });
  });

  it("is null when the plugin, or Claude Code itself, is not there", () => {
    expect(readInstalledPlugin(claudeDir(null))).toBeNull();
    expect(readInstalledPlugin(claudeDir({ "fellowship@fellowship": INSTALLED["fellowship@fellowship"] }))).toBeNull();
  });
});

describe("checkForUpdates", () => {
  it("asks the starside-io/reverie releases, and only that URL", () => {
    expect(RELEASES_URL).toBe("https://api.github.com/repos/starside-io/reverie/releases/latest");
  });

  it("makes no request while the check is off", async () => {
    const fetch = release("v0.0.2");
    const status = await checkForUpdates({ enabled: false, hostDbPath: hostDbIn(), env: claudeDir(INSTALLED), fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(status).toMatchObject({ enabled: false, updateAvailable: false, latest: null });
    expect(status.installed?.version).toBe("0.0.1");
  });

  it("makes no request when the plugin is not installed", async () => {
    const fetch = release("v0.0.2");
    await checkForUpdates({ enabled: true, hostDbPath: hostDbIn(), env: claudeDir(null), fetch });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offers a newer release, then answers from the cache for a day", async () => {
    const fetch = release("v0.0.2");
    const options = { enabled: true, hostDbPath: hostDbIn(), env: claudeDir(INSTALLED), fetch };

    const first = await checkForUpdates({ ...options, now: new Date("2026-11-26T09:00:00Z") });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(RELEASES_URL);
    expect(first).toMatchObject({
      updateAvailable: true,
      latest: { version: "0.0.2", tag: "v0.0.2" },
      command: "claude plugin marketplace update reverie && claude plugin update reverie@reverie",
    });

    await checkForUpdates({ ...options, now: new Date("2026-11-26T20:00:00Z") });
    expect(fetch).toHaveBeenCalledTimes(1);

    await checkForUpdates({ ...options, now: new Date("2026-11-27T10:00:00Z") });
    expect(fetch).toHaveBeenCalledTimes(2);

    await checkForUpdates({ ...options, now: new Date("2026-11-27T10:01:00Z"), force: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("offers nothing when the installed version is current, or there is no release", async () => {
    const env = claudeDir(INSTALLED);
    const same = await checkForUpdates({ enabled: true, hostDbPath: hostDbIn(), env, fetch: release("v0.0.1") });
    expect(same.updateAvailable).toBe(false);

    const none = await checkForUpdates({
      enabled: true,
      hostDbPath: hostDbIn(),
      env,
      fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch,
    });
    expect(none).toMatchObject({ updateAvailable: false, latest: null, error: null });
  });

  it("reports a failed check and tries again within the hour", async () => {
    const failing = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const options = { enabled: true, hostDbPath: hostDbIn(), env: claudeDir(INSTALLED), fetch: failing };

    const status = await checkForUpdates({ ...options, now: new Date("2026-11-26T09:00:00Z") });
    expect(status.error).toMatch(/offline/);
    expect(status.updateAvailable).toBe(false);

    await checkForUpdates({ ...options, now: new Date("2026-11-26T09:30:00Z") });
    expect(failing).toHaveBeenCalledTimes(1);
    await checkForUpdates({ ...options, now: new Date("2026-11-26T10:30:00Z") });
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("installUpdate", () => {
  it("refreshes the marketplace, then updates the plugin in its own scope", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (_file, args) => {
      calls.push(args);
      return { code: 0, output: "ok" };
    };
    const result = await installUpdate({ env: claudeDir(INSTALLED), run, claudePath: "/bin/claude" });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      ["plugin", "marketplace", "update", "reverie"],
      ["plugin", "update", "reverie@reverie", "--scope", "user"],
    ]);
  });

  it("stops at the first failure and says what to run instead", async () => {
    const run: CommandRunner = async (_file, args) =>
      args[1] === "update" ? { code: 1, output: "needs a yes" } : { code: 0, output: "" };
    const result = await installUpdate({ env: claudeDir(INSTALLED), run, claudePath: "/bin/claude" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("needs a yes");
    expect(result.message).toContain("claude plugin update reverie@reverie");
  });

  it("refuses when claude cannot be found or the plugin is not installed", async () => {
    const run = vi.fn() as unknown as CommandRunner;
    expect(await installUpdate({ env: claudeDir(INSTALLED), run, claudePath: null })).toMatchObject({
      ok: false,
      command: expect.stringContaining("claude plugin update"),
    });
    expect((await installUpdate({ env: claudeDir(null), run, claudePath: "/bin/claude" })).ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("pruneOldVersions", () => {
  function cacheWith(installed: string, others: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "reverie-claude-"));
    const versions = join(dir, "plugins", "cache", "reverie", "reverie");
    for (const name of [installed, ...others]) {
      mkdirSync(join(versions, name, "node_modules"), { recursive: true });
      writeFileSync(join(versions, name, "package.json"), "{}");
    }
    writeFileSync(
      join(dir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "reverie@reverie": [{ scope: "user", version: installed, installPath: join(versions, installed) }],
        },
      }),
    );
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: dir, REVERIE_APP_DIR: join(dir, "Applications"), PATH: "" };
    return { env, versions };
  }

  it("runs after a good install and keeps only the installed version", async () => {
    const { env, versions } = cacheWith("0.0.3", ["0.0.1", "0.0.2", "0.0.3.tmp~735c74d2"]);
    const run: CommandRunner = async () => ({ code: 0, output: "" });

    const result = await installUpdate({ env, run, claudePath: "/bin/claude" });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Removed 3 older copies");
    expect(readdirSync(versions)).toEqual(["0.0.3"]);
  });

  it("leaves everything alone after a failed install", async () => {
    const { env, versions } = cacheWith("0.0.3", ["0.0.2"]);
    const run: CommandRunner = async () => ({ code: 1, output: "no" });

    await installUpdate({ env, run, claudePath: "/bin/claude" });
    expect(readdirSync(versions).sort()).toEqual(["0.0.2", "0.0.3"]);
  });

  it("touches nothing outside Claude Code's cache for this plugin", () => {
    const outside = mkdtempSync(join(tmpdir(), "reverie-checkout-"));
    mkdirSync(join(outside, "reverie", "0.0.3"), { recursive: true });
    mkdirSync(join(outside, "reverie", "keep-me"), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "reverie-claude-"));
    mkdirSync(join(dir, "plugins"));
    writeFileSync(
      join(dir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "reverie@local": [{ scope: "user", version: "0.0.3", installPath: join(outside, "reverie", "0.0.3") }],
        },
      }),
    );

    expect(pruneOldVersions({ CLAUDE_CONFIG_DIR: dir })).toEqual([]);
    expect(readdirSync(join(outside, "reverie")).sort()).toEqual(["0.0.3", "keep-me"]);
  });
});

describe("commandRunner", () => {
  it("says it ran out of time rather than failing with no reason", async () => {
    const run = commandRunner(200);
    const result = await run("/bin/sh", ["-c", "echo Checking; sleep 5"], process.env);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("Checking");
    expect(result.output).toMatch(/Stopped after 200 ms with no answer/);
  });

  it("hands back what a finished command printed", async () => {
    const result = await commandRunner()("/bin/sh", ["-c", "echo done"], process.env);
    expect(result).toEqual({ code: 0, output: "done" });
  });
});

describe("the /host/updates routes", () => {
  it("start off, turn on with a JSON post, and the hook can read the switch", async () => {
    const host = await throwawayHost();
    try {
      const fetch = release("v0.0.2");
      const app = createApp(host, { updates: { env: claudeDir(INSTALLED), fetch } });

      const off = (await (await app.request("/host/updates")).json()) as { enabled: boolean };
      expect(off.enabled).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(readUpdatesEnabled(host.hostPath)).toBe(false);

      const form = await app.request("/host/updates/settings", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(form.status).toBe(415);
      expect(host.store.readSetting(UPDATES_SETTING)).toBeUndefined();

      const on = await app.request("/host/updates/settings", { ...JSON_POST, body: JSON.stringify({ enabled: true }) });
      expect(await on.json()).toMatchObject({ enabled: true, updateAvailable: true });
      expect(host.store.readSetting(UPDATES_SETTING)).toBe(true);
      expect(readUpdatesEnabled(host.hostPath)).toBe(true);
    } finally {
      await host.close();
    }
  });

  it("refresh past the cache only on a JSON post, never on a GET", async () => {
    const host = await throwawayHost();
    try {
      const fetch = release("v0.0.2");
      const app = createApp(host, { updates: { env: claudeDir(INSTALLED), fetch } });
      await app.request("/host/updates/settings", { ...JSON_POST, body: JSON.stringify({ enabled: true }) });
      expect(fetch).toHaveBeenCalledTimes(1);

      // A GET answers from the day old cache, whatever its query says.
      await app.request("/host/updates?refresh=1");
      expect(fetch).toHaveBeenCalledTimes(1);

      expect((await app.request("/host/updates/check", { method: "POST" })).status).toBe(415);
      expect(fetch).toHaveBeenCalledTimes(1);

      const checked = await app.request("/host/updates/check", { ...JSON_POST, body: "{}" });
      expect(await checked.json()).toMatchObject({ updateAvailable: true });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await host.close();
    }
  });

  it("installs only on a JSON post", async () => {
    const host = await throwawayHost();
    try {
      const run = vi.fn(async () => ({ code: 0, output: "" })) as unknown as CommandRunner;
      const app = createApp(host, { updates: { env: claudeDir(INSTALLED), run, claudePath: "/bin/claude" } });

      const form = await app.request("/host/updates/install", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      });
      expect(form.status).toBe(415);
      expect(run).not.toHaveBeenCalled();

      const json = await app.request("/host/updates/install", { ...JSON_POST, body: "{}" });
      expect(await json.json()).toMatchObject({ ok: true });
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      await host.close();
    }
  });

  it("sit behind the owner guard: another origin, or another host name, is refused before anything runs", async () => {
    const host = await throwawayHost();
    try {
      const run = vi.fn(async () => ({ code: 0, output: "" })) as unknown as CommandRunner;
      const fetch = release("v0.0.2");
      const app = createApp(host, { updates: { env: claudeDir(INSTALLED), run, claudePath: "/bin/claude", fetch } });

      for (const path of ["/host/updates/install", "/host/updates/settings", "/host/updates/check", "/host/app/install"]) {
        const crossOrigin = await app.request(`http://127.0.0.1:59999${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://example.test" },
          body: JSON.stringify({ enabled: true }),
        });
        expect(crossOrigin.status, path).toBe(403);
      }
      const rebound = await app.request("http://rebind.example.test:59999/host/updates");
      expect(rebound.status).toBe(403);

      expect(run).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(host.store.readSetting(UPDATES_SETTING)).toBeUndefined();
    } finally {
      await host.close();
    }
  });
});
