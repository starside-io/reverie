import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { appAssetName, desktopAppPath, installDesktopApp, installedAppVersion } from "../src/desktop-app.js";
import { createApp } from "../src/server.js";
import { installUpdate, type CommandRunner } from "../src/updates.js";
import { REVERIE_VERSION } from "../src/version.js";
import { throwawayHost } from "./harness.js";

/**
 * Reverie.app from a release. Lifted from Fellowship's desktop-app.test.ts.
 * GitHub is a stand in serving a fake zip, and the "unzip" writes a bundle
 * with the version the test says, so nothing is downloaded and no real app
 * is touched: every app folder is a throwaway REVERIE_APP_DIR.
 */

function plist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict></plist>`;
}

function writeBundle(at: string, version: string) {
  mkdirSync(join(at, "Contents"), { recursive: true });
  writeFileSync(join(at, "Contents", "Info.plist"), plist(version));
}

/** An unzip that unpacks a Reverie.app of the given version. */
function unzipTo(version: string) {
  return async (_zip: string, into: string) => writeBundle(join(into, "Reverie.app"), version);
}

function appDir(): NodeJS.ProcessEnv {
  return { REVERIE_APP_DIR: mkdtempSync(join(tmpdir(), "reverie-apps-")) };
}

/** GitHub as far as the installer sees it: one release with the zip and its hash. */
function github(version: string, options: { hash?: string; withZip?: boolean } = {}) {
  const zip = Buffer.from(`zip for ${version}`);
  const hash = options.hash ?? createHash("sha256").update(zip).digest("hex");
  const name = appAssetName(version);
  const assets = [
    ...(options.withZip === false ? [] : [{ name, browser_download_url: "https://dl.test/zip", size: zip.length }]),
    { name: `${name}.sha256`, browser_download_url: "https://dl.test/sha", size: 80 },
  ];
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href === `https://api.github.com/repos/starside-io/reverie/releases/tags/v${version}`) {
      return new Response(JSON.stringify({ assets }), { status: 200 });
    }
    if (href.includes("/releases/tags/")) return new Response("{}", { status: 404 });
    if (href === "https://dl.test/zip") return new Response(zip, { status: 200 });
    if (href === "https://dl.test/sha") return new Response(`${hash}  ${name}\n`, { status: 200 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("the app's names", () => {
  it("are Reverie's, in the folder REVERIE_APP_DIR names", () => {
    expect(appAssetName("0.0.5")).toBe("Reverie-0.0.5-macos-arm64.zip");
    expect(desktopAppPath({ REVERIE_APP_DIR: "/tmp/somewhere" })).toBe("/tmp/somewhere/Reverie.app");
  });
});

describe("installDesktopApp", () => {
  it("installs the build attached to the release, replacing an older app", async () => {
    const env = appDir();
    writeBundle(desktopAppPath(env), "0.0.3");

    const result = await installDesktopApp({
      version: "0.0.5",
      env,
      fetch: github("0.0.5"),
      unzip: unzipTo("0.0.5"),
      supported: true,
    });

    expect(result).toMatchObject({ ok: true, version: "0.0.5" });
    expect(installedAppVersion(desktopAppPath(env))).toBe("0.0.5");
  });

  it("refuses a download that does not match the published hash, and keeps the old app", async () => {
    const env = appDir();
    writeBundle(desktopAppPath(env), "0.0.3");

    const result = await installDesktopApp({
      version: "0.0.5",
      env,
      fetch: github("0.0.5", { hash: "0".repeat(64) }),
      unzip: unzipTo("0.0.5"),
      supported: true,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not match the hash/);
    expect(installedAppVersion(desktopAppPath(env))).toBe("0.0.3");
  });

  it("refuses a zip that holds another version", async () => {
    const env = appDir();
    const result = await installDesktopApp({
      version: "0.0.5",
      env,
      fetch: github("0.0.5"),
      unzip: unzipTo("0.0.4"),
      supported: true,
    });
    expect(result.ok).toBe(false);
    expect(installedAppVersion(desktopAppPath(env))).toBeNull();
  });

  it("says so when the release has no app, or there is no such release", async () => {
    const env = appDir();
    const noZip = await installDesktopApp({ version: "0.0.5", env, fetch: github("0.0.5", { withZip: false }), supported: true });
    expect(noZip.message).toMatch(/no desktop app attached/);

    const noRelease = await installDesktopApp({ version: "9.9.9", env, fetch: github("0.0.5"), supported: true });
    expect(noRelease.message).toMatch(/no 9\.9\.9 release/);
  });

  it("downloads nothing on a machine the app is not built for", async () => {
    const fetch = github("0.0.5");
    const result = await installDesktopApp({ version: "0.0.5", env: appDir(), fetch, supported: false });
    expect(result.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the plugin update and the app", () => {
  function claude(version: string): NodeJS.ProcessEnv {
    const dir = mkdtempSync(join(tmpdir(), "reverie-claude-"));
    mkdirSync(join(dir, "plugins"));
    writeFileSync(
      join(dir, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "reverie@reverie": [{ scope: "user", version, installPath: "/x" }] } }),
    );
    return { CLAUDE_CONFIG_DIR: dir, PATH: "" };
  }
  const run: CommandRunner = async () => ({ code: 0, output: "" });

  it("brings an installed app up to the new plugin version", async () => {
    const env = { ...claude("0.0.5"), ...appDir() };
    writeBundle(desktopAppPath(env), "0.0.4");

    const result = await installUpdate({
      env,
      run,
      claudePath: "/bin/claude",
      app: { fetch: github("0.0.5"), unzip: unzipTo("0.0.5"), supported: true },
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Reverie.app is now 0.0.5");
    expect(installedAppVersion(desktopAppPath(env))).toBe("0.0.5");
  });

  it("does not install an app nobody asked for", async () => {
    const env = { ...claude("0.0.5"), ...appDir() };
    const fetch = github("0.0.5");
    await installUpdate({ env, run, claudePath: "/bin/claude", app: { fetch, unzip: unzipTo("0.0.5"), supported: true } });
    expect(fetch).not.toHaveBeenCalled();
    expect(installedAppVersion(desktopAppPath(env))).toBeNull();
  });
});

describe("the /host/app routes", () => {
  it("report the app, and install the build for this host's version only on a JSON post", async () => {
    const host = await throwawayHost();
    try {
      const env = appDir();
      const fetch = github(REVERIE_VERSION);
      const app = createApp(host, {
        updates: { env, fetch, app: { unzip: unzipTo(REVERIE_VERSION), supported: true } },
      });

      const before = (await (await app.request("/host/app")).json()) as Record<string, unknown>;
      expect(before).toMatchObject({ version: null, supported: true, available: REVERIE_VERSION });

      const form = await app.request("/host/app/install", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      });
      expect(form.status).toBe(415);
      expect(fetch).not.toHaveBeenCalled();

      const json = await app.request("/host/app/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(await json.json()).toMatchObject({ ok: true, version: REVERIE_VERSION });
      expect(installedAppVersion(desktopAppPath(env))).toBe(REVERIE_VERSION);
    } finally {
      await host.close();
    }
  });
});
