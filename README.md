<p align="center">
  <img src="docs/logo.svg" alt="Reverie" width="460" />
</p>

# Reverie

[![GitHub](https://img.shields.io/badge/GitHub-starside--io%2Freverie-181717?logo=github)](https://github.com/starside-io/reverie)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/powered%20by-SQLite-003B57?logo=sqlite)](https://sqlite.org)
[![MCP](https://img.shields.io/badge/works%20with-MCP-000000)](https://modelcontextprotocol.io)

**What you want kept, on shelves, on your own machine.**

Built by [starside.io](https://starside.io). A local-first memory library for
one person and the assistants that work for them: what happened, what you
decided, what you prefer and how you like things done, findable by when it
happened and by what it touches.

---

### Why *Reverie*?

A reverie is being lost in memory, drifting back through what happened. Every
assistant you talk to starts from nothing, and what you told the last one is
gone: the decision you made in March, the way you like a commit written, the
story of the party in December.

Reverie keeps that in one SQLite file on your machine, arranged like a library
rather than a pile. Nothing is sent anywhere. It works on its own as a desktop
app, and any AI assistant can read and draft into the same library through MCP,
with everything a model concludes waiting for your yes before it is kept.

Sibling to [Fellowship](https://github.com/starside-io/fellowship). Fellowship
holds the people; Reverie holds what you keep of them and of everything else.

## Features

| | |
| --- | --- |
| **A library, not a pile** | Sections hold shelves, shelves hold memories. Each memory has one home. |
| **Call numbers** | `LIF/GTH/2026-12-24/001` is section, shelf, the day it happened and its order that day. Text order is time order, and a prefix is a query: `LIF/GTH/2026-12` is every gathering that December. |
| **Tags** | `#work`, `#vacation`, `#hosting`. One shelf, many tags, with merge and rename across the vocabulary. |
| **Projects** | Set up from a repository link, each with its own shelf and tag. A session in a project's folder recalls that project's memories. Folder paths never leave your machine. |
| **Recall and browse** | Recall ranks by relevance, shows the numbers behind each result, and says so when it holds nothing. Browse walks a shelf, a date range or a tag in order. |
| **Nothing overwritten** | A changed fact supersedes the old one, which stays on the shelf, dated. Every edit is a version. |
| **Review** | What you say is stored at once. What a model concludes waits in Review, grouped by session, each draft with its source and a quote. |
| **Forget is real** | Forgetting removes the memory, its history, its search entry and its place in every export. Only you can call it. |
| **Sessions that remember** | A new Claude Code session opens with what matters for the project in front of it. Finished sessions are drafted into memories for you to confirm. |
| **Tied to Fellowship** | Tell the story of a party and it becomes an episode here and an occasion there, each pointing at the other. Install one, the other, or both. |
| **Markdown mirror** | The whole library as a folder of markdown files, one per memory, readable in Obsidian. Edit a file and it comes back as a new version. |
| **Import** | Bring in a Claude Code memory directory once, and take over from there. |
| **Backups** | Export and import the whole library as a snapshot, verified round trip, with a backup taken before every import. |

## Use cases

| You want to | Reverie gives you |
| --- | --- |
| Stop repeating yourself to an assistant | Your preferences and procedures, loaded at the start of every session |
| Pick up a project after a month away | Every decision on that project's shelf, in the order you made them |
| Remember what happened at a gathering | The episode, who was there, and the occasion it links to in Fellowship |
| Check what a model would be told | The recall inspector: the exact result, and why each item ranked where it did |
| Correct something that is no longer true | A new version or a superseding entry, with the old one kept and dated |
| Keep your notes in plain files | The markdown mirror, two way, beside your own notes |

> **Privacy:** Reverie listens on 127.0.0.1 only, and a memory never leaves the
> machine. It never calls an AI model: an assistant you choose does the
> reasoning, and nothing it drafts is kept until you confirm it. The host
> reaches the network in two cases only, both yours to start: the plugin update
> check, off until you turn it on in Settings, and the desktop app download,
> made only when you ask for it. Secrets such as keys, tokens and passwords are
> refused at write.

## Use it from an AI assistant

Reverie ships as a Claude Code plugin with a bundled MCP server, and the same
tools work over MCP from any assistant and any model.

This repo is both a plugin and a single plugin marketplace:

```bash
claude plugin marketplace add /path/to/reverie
```

```bash
/plugin install reverie@reverie
```

The first session after installing builds Reverie in the background, which
takes a minute or two and needs Node 22 or later. The tools appear once it is
done; `/mcp` reconnects them without starting a new session.

| Command | Does |
| --- | --- |
| `/reverie:setup` | Sections, shelves, projects, and what to bring in |
| `/reverie:remember <text> [#tags]` | Store something you said, in your words |
| `/reverie:recall <question>` | What is held that is relevant |
| `/reverie:browse <shelf, dates, #tag>` | Walk the library in order |
| `/reverie:review` | Go through what is waiting for your yes or no |
| `/reverie:dream` | Draft memories from finished sessions, then propose merges for duplicates, contradictions and stale entries |
| `/reverie:forget <call number>` | Permanently forget one memory |
| `/reverie:open [shelf or call number]` | Open Reverie and say where it is |

The assistant gets 41 typed tools: remembering, recalling, browsing, shelving,
tagging, linking and drafting. Three rules hold whatever model is driving:

- **Your yes is required.** What a model concludes goes to Review. Forgetting,
  importing and promoting a procedure need your explicit confirmation.
- **No source, no memory.** Every memory carries where it came from and a short
  quote.
- **Outside content is never an instruction.** Text read from a page, a file or
  a tool result can be remembered as something read. It never becomes a
  standing rule.

## Installation

### 1. Prerequisites

```bash
# Node 22 or later, and pnpm
corepack enable
```

For the desktop app you also need Rust and the Tauri CLI:

```bash
# macOS
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli
```

### 2. Reverie

```bash
git clone https://github.com/starside-io/reverie.git
cd reverie
pnpm install
pnpm build
```

### 3. The desktop app (optional)

```bash
pnpm desktop
```

This builds `Reverie.app` under `apps/desktop/src-tauri/target/release/bundle/macos/`.
Move it to Applications and open it like any other app.

## Quick start

```bash
# Start Reverie in the browser at http://localhost:4329
pnpm --filter reverie start serve

# Or open the desktop app you built
open apps/desktop/src-tauri/target/release/bundle/macos/Reverie.app

# See where your library lives and what is in it
pnpm --filter reverie start status
```

Then:

1. **Lay out the library.** With an assistant, run `/reverie:setup`. It walks
   through sections, shelves and projects, and offers to bring in a Claude Code
   memory directory.
2. **Remember something.** "Remember" on the Library page, or tell your
   assistant `/reverie:remember I prefer tea in the afternoon #home`.
3. **Ask for it back.** `/reverie:recall what do I drink in the afternoon`, or
   type the question into the recall inspector to see what a model would get.
4. **Let an assistant draft.** After a few sessions, run `/reverie:dream`, then
   confirm what is true in Review.

## Before you rely on it

1. **One person, one machine.** There are no accounts and no sync. Copy the
   file yourself if you want it elsewhere.
2. **The desktop app is built and tested on macOS.** The browser version runs
   wherever Node does.
3. **Recall is full text by default.** Vectors are optional and need a local
   embedding model of your own; without one, a question that shares no words
   with its answer can miss.
4. **Recall only abstains when it finds nothing.** A loosely related memory can
   come back for a question the library cannot answer. Each result carries its
   score, age and source so you can judge it.
5. **Drafts are drafts.** What a model proposes describes what it read in a
   session, and it is not kept until you confirm it.
6. **Keep backups.** `pnpm --filter reverie start export <file>` writes the
   whole library to a file.

## Documentation

| | |
| --- | --- |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Releases and the update check, the desktop app, vectors, recall evals, the npm package, the memory tool adapter, layout, design rules |
| [`docs/SPEC.md`](docs/SPEC.md) | The full build spec |

## Contributing

Contributions are welcome. [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) covers
the layout and the conventions a change is held to. Commits use
[gitmoji](https://gitmoji.dev) with [conventional commits](https://www.conventionalcommits.org),
for example `✨ feat(ui): add the recall inspector`. Test data is always invented.

## License

Apache 2.0. See [LICENSE](LICENSE).

---

Made with ❤ by [starside.io](https://starside.io) · [github.com/starside-io/reverie](https://github.com/starside-io/reverie)
