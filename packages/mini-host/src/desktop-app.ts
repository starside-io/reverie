import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Reverie.app, as the plugin installs it. Lifted from Fellowship's
 * desktop-app.ts.
 *
 * The app is built on the maintainer's machine and attached to each GitHub
 * release as a zip, with its SHA-256 beside it. Nothing is compiled here: the
 * host downloads the build that matches its own version, checks the hash,
 * and puts it in ~/Applications. It is only ever fetched because the owner
 * asked for it, from /reverie:open, `reverie app install`, the Settings
 * button or the app_install MCP tool after a yes, never at session start.
 *
 * This is host code, not module code: module.json's `network: none` is about
 * the memory module, which never reaches the network. The download is the
 * host's, and happens only on the owner's request.
 *
 * Apple Silicon only for now. The build is ad hoc signed, which is all an
 * arm64 Mac needs to run it once it is on disk.
 */

export const APP_DIR_ENV = "REVERIE_APP_DIR";
export const APP_NAME = "Reverie.app";
export const REPO = "starside-io/reverie";
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

const run = promisify(execFile);

/** The release asset for one version. */
export function appAssetName(version: string): string {
  return `Reverie-${version}-macos-arm64.zip`;
}

/** Where the app goes: ~/Applications/Reverie.app, or REVERIE_APP_DIR. */
export function desktopAppPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env[APP_DIR_ENV]?.trim() || join(homedir(), "Applications");
  return join(dir, APP_NAME);
}

/** The version of the app at that path, or null when there is none. */
export function installedAppVersion(appPath: string): string | null {
  try {
    const plist = readFileSync(join(appPath, "Contents", "Info.plist"), "utf8");
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function appSupported(platform: string = process.platform, arch: string = process.arch): boolean {
  return platform === "darwin" && arch === "arm64";
}

export interface DesktopAppStatus {
  supported: boolean;
  path: string;
  /** Null when the app is not there. */
  version: string | null;
}

export function desktopAppStatus(env: NodeJS.ProcessEnv = process.env): DesktopAppStatus {
  const path = desktopAppPath(env);
  return { supported: appSupported(), path, version: installedAppVersion(path) };
}

export interface AppInstallResult {
  ok: boolean;
  message: string;
  path: string;
  version: string | null;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

/** Seams for a test, so nothing is downloaded and no real app is touched. */
export interface AppInstallSeams {
  fetch?: typeof fetch;
  /** Unpacks a zip into a folder. ditto by default, which keeps the bundle's signature. */
  unzip?: (zip: string, into: string) => Promise<void>;
  supported?: boolean;
}

/**
 * Downloads the app built for this version, checks it against the published
 * hash, and swaps it in. The old app stays until the new one is unpacked and
 * checked, so a failure leaves whatever was there.
 */
export async function installDesktopApp(
  options: AppInstallSeams & { version: string; env?: NodeJS.ProcessEnv },
): Promise<AppInstallResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const path = desktopAppPath(env);
  const version = options.version.replace(/^v/, "");

  if (!(options.supported ?? appSupported())) {
    return {
      ok: false,
      message:
        "The desktop app is built for Apple Silicon Macs only. Run reverie serve and use the library in a browser instead.",
      path,
      version: installedAppVersion(path),
    };
  }

  const fail = (message: string): AppInstallResult => ({
    ok: false,
    message,
    path,
    version: installedAppVersion(path),
  });

  let assets: ReleaseAsset[];
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "reverie-app-install" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return fail(`There is no ${version} release on GitHub.`);
    if (!response.ok) return fail(`GitHub answered ${response.status} for the ${version} release.`);
    assets = ((await response.json()) as { assets?: ReleaseAsset[] }).assets ?? [];
  } catch (error) {
    return fail(`Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`);
  }

  const name = appAssetName(version);
  const zipAsset = assets.find((asset) => asset.name === name);
  const hashAsset = assets.find((asset) => asset.name === `${name}.sha256`);
  if (!zipAsset || !hashAsset) {
    return fail(`The ${version} release has no desktop app attached yet.`);
  }

  const work = mkdtempSync(join(tmpdir(), "reverie-app-"));
  try {
    const expected = (await download(fetchImpl, hashAsset.browser_download_url))
      .toString("utf8")
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase();
    const zip = await download(fetchImpl, zipAsset.browser_download_url);
    const actual = createHash("sha256").update(zip).digest("hex");
    if (!expected || actual !== expected) {
      return fail("The downloaded app does not match the hash published with the release, so it was not installed.");
    }

    const zipPath = join(work, name);
    writeFileSync(zipPath, zip);
    const unpacked = join(work, "unpacked");
    await (options.unzip ?? dittoUnzip)(zipPath, unpacked);
    const fresh = join(unpacked, APP_NAME);
    if (installedAppVersion(fresh) !== version) {
      return fail(`The zip on the ${version} release does not hold Reverie ${version}.`);
    }

    // Swap: the new bundle is checked before the old one goes.
    await run("mkdir", ["-p", join(path, "..")]);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    await run("ditto", [fresh, path]);

    return {
      ok: true,
      message: `Reverie ${version} is installed in ${path}.`,
      path,
      version,
    };
  } catch (error) {
    return fail(`The app could not be installed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function download(fetchImpl: typeof fetch, url: string): Promise<Buffer> {
  const response = await fetchImpl(url, {
    headers: { "user-agent": "reverie-app-install" },
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the download answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function dittoUnzip(zip: string, into: string): Promise<void> {
  await run("ditto", ["-x", "-k", zip, into]);
}

/** Opens the installed app. */
export async function openDesktopApp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await run("open", [desktopAppPath(env)]);
}
