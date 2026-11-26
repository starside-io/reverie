#!/usr/bin/env node
// Packs Reverie as one npm package, @starside/reverie. Lifted from
// Fellowship's scripts/pack-npm.mjs.
//
//   node scripts/pack-npm.mjs            build, assemble .npm-package/, npm pack it
//   node scripts/pack-npm.mjs --no-build assemble from the dist folders as they are
//
// The workspace packages are not on npm, so they travel inside this one as
// bundled dependencies: node_modules/@reverie/{core,mini-host,adapter-markdown,
// adapter-memory-tool,connector-transcripts} with their compiled dist.
// Everything they import from npm is an ordinary dependency of the package,
// installed beside it, so it resolves for whatever machine installs it.
//
// The Prisma client is the one platform specific piece that is generated, not
// installed: postinstall runs `prisma generate` against the schema core ships,
// which writes the client and the query engine for the installing machine
// into node_modules/@reverie/core/generated/prisma, where core imports it.
//
// What else it carries: the built UI (ui/, which `reverie serve` hands out),
// the migrations and fts.sql inside core's dist, module.json (the host
// contract), and the recall eval corpus (eval/corpus.json), because
// `reverie eval` reads it by default.
//
// Publishing is a separate, deliberate step: `npm publish .npm-package`.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".npm-package");

const NAME = "@starside/reverie";

/** The workspace packages the CLI needs at runtime, bundled inside the package. */
const BUNDLED = [
  { name: "@reverie/core", dir: "packages/core" },
  { name: "@reverie/mini-host", dir: "packages/mini-host" },
  { name: "@reverie/adapter-markdown", dir: "packages/adapter-markdown" },
  { name: "@reverie/adapter-memory-tool", dir: "packages/adapter-memory-tool" },
  { name: "@reverie/connector-transcripts", dir: "packages/connector-transcripts" },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, cwd = root) {
  process.stdout.write(`> ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

if (!process.argv.includes("--no-build")) {
  run("pnpm", ["--filter", "@reverie/core", "db:generate"]);
  run("pnpm", ["build"]);
}

const rootPkg = readJson(join(root, "package.json"));

for (const path of [
  "apps/reverie/dist/cli.js",
  "packages/ui/dist/index.html",
  "packages/core/dist/storage/schema.prisma",
  "packages/core/dist/storage/migrations",
  "packages/core/dist/storage/fts.sql",
  ...BUNDLED.map((bundled) => `${bundled.dir}/dist/index.js`),
]) {
  if (!existsSync(join(root, path))) throw new Error(`Missing ${path}. Build first.`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The CLI, runnable as a bin. tsc keeps the shebang of src/cli.ts; it is
// added only if a build ever drops it.
cpSync(join(root, "apps/reverie/dist"), join(out, "dist"), { recursive: true });
const cli = join(out, "dist/cli.js");
const cliSource = readFileSync(cli, "utf8");
if (!cliSource.startsWith("#!")) writeFileSync(cli, `#!/usr/bin/env node\n${cliSource}`);
chmodSync(cli, 0o755);

// The UI the host serves; the CLI finds it at ../ui.
cpSync(join(root, "packages/ui/dist"), join(out, "ui"), { recursive: true });

// The host contract and the eval corpus. The CLI finds the corpus at ../eval.
cpSync(join(root, "module.json"), join(out, "module.json"));
mkdirSync(join(out, "eval"), { recursive: true });
cpSync(join(root, "eval/corpus.json"), join(out, "eval/corpus.json"));

// The workspace packages, with their npm dependencies lifted to the top so npm
// installs them beside the package rather than inside each bundled copy.
const dependencies = {};
for (const bundled of BUNDLED) {
  const pkg = readJson(join(root, bundled.dir, "package.json"));
  for (const [dep, version] of Object.entries(pkg.dependencies ?? {})) {
    if (!String(version).startsWith("workspace:")) dependencies[dep] = version;
  }
  const target = join(out, "node_modules", bundled.name);
  mkdirSync(target, { recursive: true });
  cpSync(join(root, bundled.dir, "dist"), join(target, "dist"), { recursive: true });
  const { scripts, devDependencies, dependencies: _deps, files, private: _private, ...kept } = pkg;
  writeFileSync(join(target, "package.json"), `${JSON.stringify({ ...kept, dependencies: {} }, null, 2)}\n`);
}
// The CLI's own npm dependencies, should it ever gain one.
for (const [dep, version] of Object.entries(readJson(join(root, "apps/reverie/package.json")).dependencies ?? {})) {
  if (!String(version).startsWith("workspace:")) dependencies[dep] = version;
}
// The Prisma CLI generates the client at install.
dependencies.prisma = readJson(join(root, "packages/core/package.json")).devDependencies.prisma;

// npm only packs a bundled dependency that is also listed as a dependency.
// The bundled copy is what installs; the version is never fetched.
for (const bundled of BUNDLED) {
  dependencies[bundled.name] = readJson(join(root, bundled.dir, "package.json")).version;
}

const sortedDependencies = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));

const manifest = {
  name: NAME,
  version: rootPkg.version,
  description:
    "Reverie: a local-first memory library for one person and the assistants that work for them. The host, the UI and the MCP server in one package. Run `reverie serve` for the app, `reverie mcp` for an assistant.",
  license: "Apache-2.0",
  author: "starside.io (https://starside.io)",
  homepage: "https://starside.io",
  keywords: ["memory", "recall", "local-first", "sqlite", "mcp", "memory-tool"],
  type: "module",
  engines: { node: ">=22.5" },
  bin: { reverie: "dist/cli.js" },
  files: ["dist", "ui", "eval", "module.json", "node_modules/@reverie", "LICENSE", "README.md"],
  scripts: {
    postinstall: "prisma generate --schema node_modules/@reverie/core/dist/storage/schema.prisma",
  },
  dependencies: sortedDependencies,
  bundleDependencies: BUNDLED.map((bundled) => bundled.name),
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// No manifest in the package may still point into the workspace.
const manifests = [join(out, "package.json"), ...BUNDLED.map((bundled) => join(out, "node_modules", bundled.name, "package.json"))];
for (const path of manifests) {
  if (readFileSync(path, "utf8").includes("workspace:")) throw new Error(`${path} still has a workspace: reference.`);
}

cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
writeFileSync(
  join(out, "README.md"),
  `# Reverie

A local-first memory library for one person and the assistants that work for
them. Memories sit on shelves with a call number that places them in time,
cross-reference by tag, and wait in review when a model drafted them. One
SQLite file on your machine, no network.

\`\`\`bash
npx @starside/reverie serve     # the app, at http://127.0.0.1:4329
npx @starside/reverie mcp       # the MCP server, on stdio: 41 tools
npx @starside/reverie status    # where the files are and what is in them
\`\`\`

As an MCP server for any client:

\`\`\`json
{ "command": "npx", "args": ["-y", "@starside/reverie", "mcp"] }
\`\`\`

The silo lives in \`~/Library/Application Support/reverie\` on macOS and
\`\${XDG_DATA_HOME:-~/.local/share}/reverie\` on Linux. \`REVERIE_DB_PATH\` and
\`REVERIE_HOST_DB_PATH\` point it elsewhere.

Needs Node 22.5 or later. Install runs \`prisma generate\` once, for the
database client of the machine it lands on; with pnpm, allow that build
(\`pnpm approve-builds\`). Everything else, including the Claude Code plugin,
is in the repository.

Built by [starside.io](https://starside.io). Apache 2.0.
`,
);

run("npm", ["pack", "--pack-destination", out], out);
const tarball = readdirSync(out).find((entry) => entry.endsWith(".tgz"));
process.stdout.write(`\nPacked ${NAME}@${rootPkg.version} into ${join(out, tarball ?? "")}\n`);
