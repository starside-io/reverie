#!/usr/bin/env node
// Attaches Reverie.app to the GitHub release for the current version, so the
// plugin can install the desktop app without anyone compiling it. Lifted from
// Fellowship's scripts/release-app.mjs.
//
//   node scripts/release-app.mjs            zip the app built at HEAD and upload it
//   node scripts/release-app.mjs --build    build it first, even if a build is there
//
// The app is the one .githooks/post-commit already builds. This waits for that
// build to finish (.git/rebuild-app.lock, the lock .githooks/rebuild-app.sh
// holds), checks it is the version being released and was built from the
// tagged commit, zips it with ditto (which keeps the bundle's signature),
// writes its SHA-256 beside it, and uploads both to release v<version> of
// starside-io/reverie. The host refuses a download whose hash does not match.
//
// It refuses to run off an Apple Silicon Mac, without a v<version> tag on
// HEAD, with uncommitted changes, without the GitHub release, or when the
// built app is not <version>.
//
// Order: bump the version everywhere (docs/DEVELOPMENT.md lists the files)
// and commit, tag v<version>, push, create the GitHub release, then run this.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "starside-io/reverie";
const APP = join(root, "apps/desktop/src-tauri/target/release/bundle/macos/Reverie.app");
const OUT = join(root, ".release");

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function appVersion() {
  try {
    const plist = readFileSync(join(APP, "Contents/Info.plist"), "utf8");
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail("The app is built and released from an Apple Silicon Mac.");
}

const version = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8")).version;
const tag = `v${version}`;

// The build has to be the code the release names.
const head = git("rev-parse", "HEAD");
let tagged;
try {
  tagged = git("rev-parse", "--verify", "--quiet", `${tag}^{commit}`);
} catch {
  fail(`There is no ${tag} tag. Tag the release commit first.`);
}
if (!tagged) fail(`There is no ${tag} tag. Tag the release commit first.`);
if (tagged !== head) fail(`${tag} is ${tagged.slice(0, 7)}, but HEAD is ${head.slice(0, 7)}. Check out the tag.`);
if (git("status", "--porcelain", "--untracked-files=no") !== "") {
  fail("The working tree has uncommitted changes, so a build here is not the tagged code.");
}

try {
  execFileSync("gh", ["release", "view", tag, "--repo", REPO], { stdio: "ignore" });
} catch {
  fail(`There is no ${tag} release on GitHub yet. Create it, then run this again.`);
}

// The post-commit hook may still be building.
const lock = join(git("rev-parse", "--absolute-git-dir"), "rebuild-app.lock");
if (existsSync(lock)) {
  process.stdout.write("Waiting for the post-commit build to finish");
  const until = Date.now() + 30 * 60_000;
  while (existsSync(lock) && Date.now() < until) {
    execFileSync("sleep", ["5"]);
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  if (existsSync(lock)) fail("The post-commit build is still running after 30 minutes.");
}

const committedAt = Number(git("show", "-s", "--format=%ct", "HEAD")) * 1000;
const stale =
  process.argv.includes("--build") ||
  appVersion() !== version ||
  !existsSync(APP) ||
  statSync(join(APP, "Contents/Info.plist")).mtimeMs < committedAt;

if (stale) {
  process.stdout.write(`Building Reverie.app ${version}\n`);
  execFileSync("pnpm", ["desktop"], { cwd: root, stdio: "inherit" });
}
if (appVersion() !== version) fail(`The built app says ${appVersion()}, not ${version}.`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// Tauri signs the executable alone, which leaves the bundle unsealed. A staged
// copy gets an ad hoc signature over the whole bundle, resources included, so
// it verifies wherever it lands. The build output itself is left as built.
const staged = join(OUT, "stage", "Reverie.app");
execFileSync("ditto", [APP, staged]);
execFileSync("codesign", ["--force", "--deep", "--sign", "-", staged], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", staged], { stdio: "inherit" });

const name = `Reverie-${version}-macos-arm64.zip`;
const zip = join(OUT, name);
execFileSync("ditto", ["-c", "-k", "--keepParent", staged, zip]);
const hash = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(`${zip}.sha256`, `${hash}  ${name}\n`);

process.stdout.write(`Uploading ${name} (${(statSync(zip).size / 1e6).toFixed(0)} MB) to ${tag}\n`);
execFileSync("gh", ["release", "upload", tag, zip, `${zip}.sha256`, "--clobber", "--repo", REPO], {
  stdio: "inherit",
});
process.stdout.write(`Done. sha256 ${hash}\n`);
