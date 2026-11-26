# Reverie

A local-first memory library for one person and the assistants that work for
them.

A reverie is being lost in memory. This is where that memory is kept: on
shelves, in order, findable by when it happened and by what it touches.

One user. No auth. No network. One SQLite file on your machine.

Sibling to [Fellowship](https://github.com/starside-io/fellowship). Fellowship
holds the people; Reverie holds what you keep of them and of everything else.

**Status: M5, the Fellowship link, Reverie side.** The silo, the domain, the
41 tools and the gate suite are in `packages/core`. The mini-host in
`packages/mini-host` serves them over `POST /rpc` on 127.0.0.1 and over stdio
MCP, and `apps/reverie` is the `reverie` binary. The Claude Code plugin is in
place: the commands, the skill and three hooks (core block at session start,
the session note reminder before compaction, and a finished session marked
ready for extraction). An episode points at its Fellowship occasion and its
attendees as people references with label snapshots, and hands back the call
that points the occasion back at the memory. A drafted episode carries its
occasion and any notes about one guest inside one proposal, shown in review
as one group whose parts are decided one by one; confirming it returns the
real `people.log_interaction` input with the reference back included. The
front desk lists occasion pending, occasions with no story yet and unresolved
names. The three people events are handled when a host delivers them, and the
assistant can report them through `memory_link_occasion` when the two run on
separate hosts. Reverie never calls Fellowship and stores no score about a
person. The standalone UI (M6) is in `packages/ui` and the host serves it on
the same 127.0.0.1 port: the library, a page per memory, review, the recall
inspector, the timeline, tags and the front desk, all through `POST /rpc`
and the host's review decision route.
The shared kit with Fellowship is not extracted yet. The build spec is
[`docs/SPEC.md`](docs/SPEC.md), milestones M0 to M9.

## What it does, once built

- **A library, not a pile.** Sections hold shelves, shelves hold memories. Each
  memory has one home.
- **A call number on every memory.** `LIF/GTH/2026-12-24/001` is section, shelf,
  the day it happened, and its order that day. Text order is time order, and a
  prefix is a query: `LIF/GTH/2026-12` is every gathering that December.
- **Tags for cross-reference.** `#work`, `#vacation`, `#nightstash`. One shelf,
  many tags.
- **Projects you define.** Set up from a GitHub link or a list in a README,
  each with its own shelf and tag. A session in a project's folder recalls
  that project's memories. Folder paths stay on your machine and never travel
  in an export.
- **Two ways to find things.** `recall` ranks by relevance and abstains when
  it holds nothing. `browse` walks a shelf, a date range or a tag in order.
- **Nothing is overwritten.** A changed fact supersedes the old one, which
  stays on the shelf, dated. Every edit is a version.
- **Tied to Fellowship.** Tell the story of a party and it becomes an episode
  here and an occasion there, each pointing at the other. The two never
  call each other: the assistant sees both tool sets and carries the id
  across. Install one, the other, or both.
- **You decide what is kept.** What you say is stored at once. What a model
  concludes waits in review. Forget is real, and only yours to call.

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

## Install as a Claude Code plugin

This repo is both a plugin and a single-plugin marketplace, so it installs from
a local path:

```bash
claude plugin marketplace add ~/Personal/reverie
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

## What the plugin gives you

| Surface | Does |
| --- | --- |
| `/reverie:remember <text> [#tags]` | Store something you said, in your words |
| `/reverie:recall <question>` | What is held that is relevant |
| `/reverie:browse <shelf, dates, #tag>` | Walk the library in order |
| `/reverie:review` | Go through what is waiting for your yes or no |
| `/reverie:forget <call number>` | Permanently forget one memory |
| `/reverie:dream` | Draft memories from finished sessions waiting for extraction, then a consolidation pass over duplicates, contradictions and stale entries. Both only propose: everything waits in review |
| `/reverie:setup` | Sections, shelves, projects, and what to bring in |
| `/reverie:open [shelf or call number]` | Start the host, or find the one running, and open the library UI |
| `skills/reverie` | The procedure, including when to call Fellowship |

## Bringing memories in and out

| Surface | Does |
| --- | --- |
| `reverie export <file>` | The whole library as one snapshot file, for your own backup |
| `reverie export <folder> --mirror` | The library as a markdown mirror: one folder per section, one per shelf, one file per memory named by call number (`Life/Gatherings/2026-12-24-001 christmas-at-home.md`), and `.reverie/library.json` beside them. Readable in Obsidian. Files the mirror did not write are never touched, and a forgotten memory is gone from it |
| `reverie import <folder>` | A mirror folder back in. An edited file comes back as a new version, an unchanged one is left alone, a note you wrote by hand in the folder is remembered, and nothing is deleted. `--replace --yes` takes the library from the folder, after naming what it destroys |
| `reverie import <folder> --claude-code [--project <slug>]` | A Claude Code memory directory, imported once and never written to. `user` memories land global; the rest are scoped to the project you name. Importing it again adds nothing |
| `memory_export`, `memory_import` | The same, for an assistant: `to: "markdown"` and `folder`, or `from: "markdown"` / `from: "claude_code"` and `folder` |

Every import takes a backup of the silo first, beside it in `backups/`.

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
the machine. Reverie downloads no model: pull one with your own tools first.

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
npx @starside/reverie mcp       # the 41 tools over stdio, for any MCP client
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
into a fresh project, checks `reverie tools` lists 41, scores the packaged
corpus with `reverie eval`, starts `reverie serve`
on a free port and reads `/health` and the UI, speaks MCP to `reverie mcp`
(initialize and tools/list), runs `npx --offline --package <tarball> reverie
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
[`packages/adapter-memory-tool/README.md`](packages/adapter-memory-tool/README.md).

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
macOS; a signed release bundle is not set up.

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
`scripts/pack-npm.mjs` packs the npm package. Run `pnpm install`, `pnpm test`,
`pnpm build`, `pnpm db:check`.

## Two manifests, on purpose

`module.json` describes Reverie to an assistant host: ports, silo, tools,
events, permissions. `.claude-plugin/plugin.json` describes it to Claude Code:
commands, skills, hooks. Neither stands in for the other. They agree on the
tool names and must keep agreeing.

## License

Apache 2.0. See [`LICENSE`](LICENSE).
