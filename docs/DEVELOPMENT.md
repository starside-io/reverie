# Developing Reverie

How a release is cut, what the plugin's update check does, how the desktop app
reaches a machine without being compiled there, and how to install the plugin
from a checkout. The design itself is in [`SPEC.md`](SPEC.md); everyday commands
are in the [README](../README.md).

## The network stance

The memory module declares `network: none` in `module.json` and never reaches
the network. The host makes exactly two kinds of request, both started by the
owner:

- **The update check.** Off until the owner turns it on in Settings. When on,
  one `GET https://api.github.com/repos/starside-io/reverie/releases/latest` at
  most once a day (once an hour after a failure). Nothing from the library is
  sent: no memory, no count, no path.
- **The desktop app download.** Only when the owner asks for it: `reverie app
  install`, the Settings button, `/reverie:open` after a yes, the
  `app_install` MCP tool with `confirmedByUser: true`, or the update button
  when an app is already installed.

Embedders are separate: they reach a local endpoint on loopback only, as the
README says.

## Releases and the update check

The update check is off until the owner turns it on in Settings (the host.db
setting `updates.check`). When it is on, the host asks GitHub for the newest
release of `starside-io/reverie` at most once a day, caches the answer in
`update-check.json` beside `host.db`, and compares the release tag with the
plugin version Claude Code recorded in `~/.claude/plugins/installed_plugins.json`
(or under `CLAUDE_CONFIG_DIR`). A newer release shows one line and an Install
button at the foot of the app's rail and on the Settings screen, and the
SessionStart hook offers it once per session (on `startup`, not on the resume,
clear and compact runs that bring the core block back). Install runs
`claude plugin marketplace update` and then `claude plugin update`, then
removes the older copies Claude Code keeps in its plugin cache, and the new
version loads when Claude Code restarts. An installed Reverie.app is brought
to the same version. GitHub's `releases/latest` never answers with a
prerelease or a draft, so neither is ever offered.

The routes behind it sit under `/host`, behind the owner guard like the rest:
`GET /host/updates`, and JSON posts to `/host/updates/check` (ask now, past the
cache), `/host/updates/settings` and `/host/updates/install`.

### Cutting a release

The version is bumped by hand; there is no script for it. Every one of these
carries it, and all of them move together:

| File | Field |
| --- | --- |
| `.claude-plugin/plugin.json` | `version`: what the release script and Claude Code read |
| `package.json` | `version`: what `scripts/pack-npm.mjs` stamps on `@starside/reverie` |
| `module.json` | `version` |
| `apps/reverie/package.json` | `version` |
| `apps/desktop/package.json` | `version` |
| `apps/desktop/src-tauri/tauri.conf.json` | `version`: Reverie.app's `CFBundleShortVersionString` |
| `apps/desktop/src-tauri/Cargo.toml` | `[package] version` |
| `apps/desktop/src-tauri/Cargo.lock` | the `reverie-desktop` entry's `version`: edit it, or run `pnpm desktop:check`, whose `cargo check` rewrites it, and commit it with the rest. Left out, the release build rewrites it and the working tree is no longer the tagged code |
| `packages/core/package.json` | `version` |
| `packages/mini-host/package.json` | `version`: `REVERIE_VERSION` in `src/version.ts` reads it, so it is the MCP server's version and the app version an install fetches |
| `packages/ui/package.json` | `version` |
| `packages/adapter-markdown/package.json` | `version` |
| `packages/adapter-memory-tool/package.json` | `version` |
| `packages/connector-transcripts/package.json` | `version` |

`.claude-plugin/marketplace.json` carries no version. Nothing else holds one:
the MCP server and the npm pack read theirs from the files above.

Then, in order:

1. Commit the bump. The post-commit hook (`git config core.hooksPath
   .githooks`) starts rebuilding Reverie.app in the background.
2. Tag the commit `v<version>`, and push the commit and the tag.
3. Publish a GitHub release on that tag. Not a draft and not a prerelease: the
   update check only ever sees the latest published release.
4. Attach the desktop app:

```bash
pnpm release:app
```

It refuses to run off an Apple Silicon Mac, without a `v<version>` tag on
`HEAD`, with uncommitted changes, or before the GitHub release exists. It waits
for the post-commit build (`.git/rebuild-app.lock`, held by
`.githooks/rebuild-app.sh`, which logs to `.git/rebuild-app.log`), builds again
with `pnpm desktop` if the app is missing, older than the commit or not the
tagged version (or with `--build`), and refuses when the built app's
`CFBundleShortVersionString` is not the tagged version. It then signs a copy of
the bundle ad hoc, zips it with `ditto` into `.release/`, and uploads
`Reverie-<version>-macos-arm64.zip` and its `.sha256` to the release.

## The desktop app from the plugin

The plugin never builds Reverie.app. `reverie app install` (and the Settings
button, `/reverie:open` after the owner says yes, and the `app_install` MCP
tool) downloads the zip attached to the release matching the running version
(`REVERIE_VERSION`), refuses it unless its SHA-256 matches the published one,
and puts it in `~/Applications`, or the folder `REVERIE_APP_DIR` names. The old
app stays until the new one is unpacked and checked. A plugin update from the
update button brings an installed app to the same version, and installs none
where there was none. Apple Silicon only.

The MCP server adds three tools of its own beside the module's 41. They are not
in `module.json` and do not pass through the registry, so they leave no audit
line:

| Tool | Does |
| --- | --- |
| `app_status` | Whether Reverie.app is installed, where, its version, the version an install would bring, and whether it is behind. Reads no network. |
| `app_install` | The download above. Refuses without `confirmedByUser: true`, which an assistant sets only after the owner said yes. |
| `app_open` | Opens the installed app. When there is none, or on a machine it is not built for, says so and what to do instead. |

`reverie app status`, `reverie app install` and `reverie app open` do the same
from a terminal.

## Install the plugin from a checkout

This repo is both a Claude Code plugin and a single plugin marketplace:

```bash
claude plugin marketplace add /path/to/reverie
```

```bash
/plugin install reverie@reverie
```

To list it in a marketplace file you already maintain, add this to its
`plugins` array, with `source` pointing at a checkout or a git URL:

```json
{
  "name": "reverie",
  "description": "Remember, recall and browse memories on shelves, in time order, cross-referenced by tag and linked to Fellowship.",
  "source": "/path/to/reverie",
  "category": "productivity"
}
```

A checkout installed this way is copied whole into Claude Code's plugin cache
on every update, `node_modules` and build output included, which is why the
update can take minutes and why older copies are removed after it.

## Design rules that are not obvious

- **The library never calls a model.** An assistant asks for the material, the
  rules and a schema, reasons over them, and proposes an answer that is
  validated and queued. Extraction, shelving and consolidation all work this
  way, whichever model is driving.
- **No source, no memory.** Every memory carries where it came from and a
  short quote.
- **Outside content is never an instruction.** Text read from a page, a file
  or a tool result can be remembered as something read. It can never become a
  standing rule, and it never enters the always-on core block.
- **Secrets are refused at write.** Keys, tokens, passwords.
- **Recalled memories are records.** Each comes back with its age, its trust
  tier and its source, marked as data.
- **Consolidation proposes and never applies.**
- **The story lives here, the attendance lives in Fellowship.** Reverie never
  stores a score or a sentiment about a person.
- **No em-dashes or en-dashes anywhere**: code, comments, UI copy, docs, commit
  messages.

## Vectors, optional

Recall searches twice when an embedding model is configured: full text (FTS5,
BM25) and cosine over stored vectors, fused by rank. With no model it runs on
full text alone, says so in every result's `retrieval` block, and nothing
below runs. Off by default (`embedding.model: null`).

Turn vectors on through the running host's config, which is the settings
port, so the re-embed hook runs: every memory is embedded before the new model
counts as applied, and until then recall stays on full text and says
`reembedding`.

```bash
curl -s -X POST http://127.0.0.1:4329/host/config \
  -H 'content-type: application/json' \
  -d '{"embedding": {"model": "reverie-lexical-v1", "dim": null}}'
```

| `embedding.model` | What computes the vectors |
| --- | --- |
| `null` | Nothing. Full text only, and every stored vector is dropped. |
| `reverie-lexical-v1` | The built-in embedder. Pure TypeScript, no network, no download, no weights; `dim` 16 to 4096, 512 when left null. |
| `ollama/<model>` | An Ollama server on this machine (`/api/embed`), such as `ollama/nomic-embed-text`. |
| `openai/<model>` | Any server on this machine that speaks the OpenAI embeddings shape (`/v1/embeddings`): llama.cpp, LM Studio, vLLM. |

**What the built-in embedder is, and is not.** It hashes a text's words, word
pairs, word prefixes and character trigrams into a fixed number of buckets and
scales the result to unit length. Two texts are close when they share words or
fragments of words ("garden" and "gardening"). It knows no synonyms and no
meaning: "heating" is not near "boiler". It is a lexical baseline that lets
the vector path, the re-embed hook and the evals run anywhere and give the
same numbers on every machine. For recall that understands paraphrase, use a
real local model.

**Local endpoints only.** The endpoint is `REVERIE_EMBED_URL`, else
`http://127.0.0.1:11434` for Ollama and `http://127.0.0.1:8080` for the OpenAI
shape. It must be 127.0.0.1, localhost or ::1: any other host is refused before
a request is made, redirects are not followed, and there are no API keys and no
remote providers. Reverie declares `network: none`, and a memory never leaves
the machine. The memory module never reaches the network; the host does in two
cases only, both yours to start: the plugin update check, off until you turn it
on in Settings (one request a day to GitHub's releases API, carrying nothing
from the library), and the desktop app download, made only when you ask for it.
See the network stance above. Reverie downloads no model: pull one with your own tools first.

A write never waits on the model for more than 5 seconds and never fails
because of it: the memory commits, its vector is missing, and recall runs on
full text until it is filled. `reverie reindex` fills missing vectors,
refreshes stale ones and finishes a re-embed that a stopped host left half
done; `reverie serve` does the same in the background when it starts.
`reverie status` says which of these applies. Snapshots and the markdown
mirror never carry vectors; a restored silo is re-embedded.

## Recall evals

`eval/corpus.json` is a fixture library of invented people and places (76
memories, 57 questions) covering the five abilities LongMemEval names:
extraction, multi-session reasoning, temporal reasoning, knowledge updates and
abstention. `reverie eval` builds a throwaway silo from it in a temp folder,
asks every question with full text alone and again with each embedder, and
reports recall at 1, 3 and 5, MRR, and abstention precision and recall, per
ability and overall. The live silo is never opened. Evals are scores, not
gates: nothing fails on a number.

```bash
pnpm --filter reverie start eval --out "$PWD/eval"
pnpm --filter reverie start eval --embedder reverie-lexical-v1 --embedder ollama/nomic-embed-text --out "$PWD/eval"
```

The first writes `eval/RESULTS.md` and `eval/results.json` for full text and
the built-in embedder, with the corpus hash, model, dim and date. The second
adds a column for a local Ollama model already pulled (`--endpoint <url>` when
it is not on its default port).

## The npm package

`pnpm pack:npm` builds everything and packs one publishable package,
`@starside/reverie`, into `.npm-package/`. It is not published: that is a
separate, deliberate `npm publish .npm-package`.

```bash
npx @starside/reverie mcp       # the 41 memory tools, plus app_open, app_install and app_status, over stdio
npx @starside/reverie serve     # the UI and POST /rpc on 127.0.0.1:4329
npx @starside/reverie status
```

The package carries the `reverie` binary, the built UI, `module.json`, the
recall eval corpus (`reverie eval` reads it by default), and the workspace
packages as bundled dependencies: core with its migrations and `fts.sql`, the
mini-host, the markdown mirror, the transcripts connector and the memory tool
adapter. Its npm dependencies install beside it. The Prisma client is
generated at install (`postinstall` runs `prisma generate` against the schema
core ships), so the query engine is the one for the machine it lands on; with
pnpm, allow that build with `pnpm approve-builds`. Node 22.5 or later.

`pnpm smoke:npm` proves it from the tarball, outside the workspace, in one
temp folder with its own silo, host.db and npm cache: it installs the tarball
into a fresh project, checks `reverie tools` lists the 41 module tools, scores the packaged
corpus with `reverie eval`, starts `reverie serve`
on a free port and reads `/health` and the UI, speaks MCP to `reverie mcp`
(initialize, and tools/list with the 41 module tools plus the 3 host tools), runs `npx --offline --package <tarball> reverie
status`, then removes the folder. The first install fetches the declared
dependencies from the registry; nothing else touches the network. It is not
part of `pnpm test`.

The Claude Code plugin does not use the npm package: `.mcp.json` and the hooks
run `scripts/plugin-bootstrap.mjs` from the checkout, which builds it on first
run.

## The memory tool, for apps on the Anthropic API

`packages/adapter-memory-tool` is a backend for the client-side memory tool
(`{"type": "memory_20250818", "name": "memory"}`). The tool sees the library
as files: `/memories/Life/Gatherings/2026-12-24-001.md` is
`LIF/GTH/2026-12-24/001`. `view` reads through `memory.fs_view`; `create`
queues a draft for review, or remembers at once when the app marks the turn as
the owner's; `str_replace` and `insert` write a new version; `rename`
reshelves and keeps the old number as an alias; `delete` retires. A model can
never forget through it, every gate still applies, and every path that
escapes `/memories` is refused before any tool runs. The handler takes one
`tool_use` input and returns the `tool_result` text; it has no SDK dependency.
The mapping, the file names and an SDK tool loop example are in
[`packages/adapter-memory-tool/README.md`](../packages/adapter-memory-tool/README.md).

## The desktop app

`apps/desktop` is a Tauri window over the same one process host `reverie
serve` runs, lifted from Fellowship's. It starts the host with a bundled Node
runtime, shows a splash until `/health` answers, then opens the UI on
127.0.0.1. On quit it stops the host it started, by that process alone. A host
already running the same code on port 4329 is reused; one running other code
is named in the window and left alone. The window is granted no Tauri
commands. The icons are generated from the UI's logo (`pnpm --filter
@reverie/desktop icons`).

You need Rust and the Tauri CLI (`cargo install tauri-cli`).

```bash
pnpm desktop:check   # assemble the bundle, then cargo check the shell
pnpm desktop         # build Reverie.app under apps/desktop/src-tauri/target/release/bundle/macos/
```

The app opens the default silo, like `reverie serve`. Built and checked on
macOS. A release carries an ad hoc signed zip of it, which `reverie app
install`, the Settings screen, `/reverie:open` and the `app_install` MCP tool
download on request: see the sections above.

`.githooks/post-commit` rebuilds the app in the background after any commit
that changes app code, then reopens the app if it was open and restarts a
running `reverie serve`. Turn it on once per checkout with
`git config core.hooksPath .githooks`. The log is `.git/rebuild-app.log`.

## Layout

```
.claude-plugin/        plugin.json and marketplace.json
commands/              the eight commands above
skills/reverie/        SKILL.md
hooks/                 hooks.json: SessionStart, PreCompact, SessionEnd
module.json            the host contract manifest: id "memory", 41 tools
config.schema.json     the config the host stores
docs/SPEC.md           the build spec, M0 to M9
docs/DEVELOPMENT.md    releases, the update check, the desktop app from the plugin
.mcp.json              the bundled MCP server
```

`packages/core` holds the module: storage, domain, tools and gates.
`packages/mini-host` is the host: ports, host.db, host.lock, `/rpc` and the
stdio MCP server, and serves the built UI. `packages/ui` is the UI, a React
app that talks to the host through `POST /rpc` and imports no database.
`packages/connector-transcripts` reads a session transcript
off disk as turns, behind the host's `connectors` port, and
`packages/adapter-markdown` reads and writes the markdown mirror and reads a
Claude Code memory directory, behind the same port. `apps/reverie` is the binary (`serve`, `restart`, `mcp`,
`status`, `tools`, `verify`, `import`, `export`, `reindex`, `dream`, `eval`, and
`hook` for the plugin hooks). `packages/adapter-memory-tool` is the backend
for Anthropic's memory tool, `apps/desktop` the Tauri shell, and
`scripts/pack-npm.mjs` packs the npm package, and `scripts/release-app.mjs`
attaches the app to a GitHub release. Run `pnpm install`, `pnpm test`,
`pnpm build`, `pnpm db:check`.

## Two manifests, on purpose

`module.json` describes Reverie to an assistant host: ports, silo, tools,
events, permissions. `.claude-plugin/plugin.json` describes it to Claude Code:
commands, skills, hooks. Neither stands in for the other. They agree on the
tool names and must keep agreeing.
