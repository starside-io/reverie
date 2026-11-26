// Assembles what the Tauri bundle carries, from the workspace build. Lifted
// from Fellowship's apps/desktop/scripts/bundle.mjs.
//
//   src-tauri/binaries/node-<triple>   the Node runtime, as a Tauri sidecar
//   src-tauri/resources/server/        the reverie CLI and its production
//                                      dependencies, the Prisma client and
//                                      engine and the migrations included
//   src-tauri/resources/ui/            the built SPA the host serves
//   src-tauri/fingerprint              the surface fingerprint build.rs compiles in
//
// The desktop app is a window over the same one process host `reverie serve`
// runs. Nothing in it is a second implementation: it starts that process,
// points a webview at it, and stops it on quit. This script opens no silo.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const root = resolve(desktop, "..", "..");
const tauri = join(desktop, "src-tauri");

function run(command, args, cwd = root) {
  process.stdout.write(`> ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function targetTriple() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = output.split("\n").find((entry) => entry.startsWith("host:"));
  if (!line) throw new Error("rustc -vV did not report a host triple");
  return line.slice("host:".length).trim();
}

// 1. Build every package, so dist is current.
run("pnpm", ["-r", "--filter", "!@reverie/desktop", "build"]);

// The fingerprint of the host being bundled, compiled into the app by
// build.rs. The app reuses a host already on its port only when that host
// reports the same one.
const core = await import(pathToFileURL(join(root, "packages", "core", "dist", "index.js")).href);
const fingerprint = core.surfaceFingerprint();
writeFileSync(join(tauri, "fingerprint"), `${fingerprint}\n`);

// 2. The server: the CLI with production dependencies only, workspace packages
//    copied in rather than linked, so the bundle stands on its own.
const server = join(tauri, "resources", "server");
rmSync(server, { recursive: true, force: true });
// By path: the workspace root is also called "reverie", and a name filter
// would match both.
// Hoisted: plain directories, no symlinks. Tauri's resource copier drops
// symlinks, and a pnpm layout is made of them.
run("pnpm", ["--filter", "./apps/reverie", "deploy", "--prod", "--legacy", "--config.node-linker=hoisted", server]);

// The .bin shims are symlinks, and the app runs cli.js directly, so they go.
for (const bin of execFileSync("find", [server, "-type", "d", "-name", ".bin"], { encoding: "utf8" })
  .split("\n")
  .filter((line) => line.trim().length > 0)) {
  rmSync(bin, { recursive: true, force: true });
}

const links = execFileSync("find", [server, "-type", "l"], { encoding: "utf8" })
  .split("\n")
  .filter((line) => line.trim().length > 0);
if (links.length > 0) {
  throw new Error(
    `The server bundle still has ${links.length} symlinks, which the app bundle would drop: ${links.slice(0, 3).join(", ")}`,
  );
}

// core's package.json lists "generated" in files, so deploy carries the
// client generated for this machine, engine included.
const engine = join(server, "node_modules", "@reverie", "core", "generated", "prisma");
if (!existsSync(engine)) {
  throw new Error(`No generated Prisma client at ${engine}. core's package.json must list "generated" in files.`);
}

// 3. The UI the host serves.
const ui = join(tauri, "resources", "ui");
rmSync(ui, { recursive: true, force: true });
cpSync(join(root, "packages", "ui", "dist"), ui, { recursive: true });

// 4. The runtime: this machine's Node, named the way Tauri finds a sidecar.
const binaries = join(tauri, "binaries");
mkdirSync(binaries, { recursive: true });
const node = join(binaries, `node-${targetTriple()}`);
copyFileSync(process.execPath, node);
chmodSync(node, 0o755);

process.stdout.write(
  [
    "",
    "Bundle assembled:",
    `  runtime  ${node} (Node ${process.version})`,
    `  server   ${server}`,
    `  ui       ${ui}`,
    `  surface  ${fingerprint}`,
    "",
  ].join("\n"),
);
