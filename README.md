# Reverie

A local-first memory library for one person and the assistants that work for
them.

A reverie is being lost in memory. This is where that memory is kept: on
shelves, in order, findable by when it happened and by what it touches.

One user. No auth. No network. One SQLite file on your machine.

Sibling to [Fellowship](https://github.com/starside-io/fellowship). Fellowship
holds the people; Reverie holds what you keep of them and of everything else.

**Status: M3.** The silo, the domain, the 41 tools and the gate suite are in
`packages/core`. The mini-host in `packages/mini-host` serves them over
`POST /rpc` on 127.0.0.1 and over stdio MCP, and `apps/reverie` is the
`reverie` binary. An assistant can remember, browse, recall and forget with no
UI. There is no UI, no hook and no Fellowship link yet. The build spec is
[`docs/SPEC.md`](docs/SPEC.md), milestones M0 to M9. The commands and the skill
in this repo drive those tools; `/reverie:open` has no UI to open until M6.

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
| `/reverie:dream` | Consolidation pass: duplicates, contradictions, stale entries |
| `/reverie:setup` | Sections, shelves, projects, and what to bring in |
| `/reverie:open` | Start the host and open the library |
| `skills/reverie` | The procedure, including when to call Fellowship |

One file stays an example until the code it calls exists, because a plugin
that declares a hook which cannot run fails on every session start:

| File | Becomes | At |
| --- | --- | --- |
| `hooks/hooks.json.example` | `hooks/hooks.json` | M4, with the plugin bootstrap |

## Layout

```
.claude-plugin/        plugin.json and marketplace.json
commands/              the eight commands above
skills/reverie/        SKILL.md
hooks/                 hooks.json.example
module.json            the host contract manifest: id "memory", 41 tools
config.schema.json     the config the host stores
docs/SPEC.md           the build spec, M0 to M9
.mcp.json              the bundled MCP server
```

`packages/core` holds the module: storage, domain, tools and gates.
`packages/mini-host` is the host: ports, host.db, host.lock, `/rpc` and the
stdio MCP server. `apps/reverie` is the binary (`serve`, `restart`, `mcp`,
`status`, `tools`, `verify`, `import`, `export`, `reindex`, `dream`). Run
`pnpm install`, `pnpm test`, `pnpm build`, `pnpm db:check`. The rest of
`packages/` and `apps/` in the spec is not written yet.

## Two manifests, on purpose

`module.json` describes Reverie to an assistant host: ports, silo, tools,
events, permissions. `.claude-plugin/plugin.json` describes it to Claude Code:
commands, skills, hooks. Neither stands in for the other. They agree on the
tool names and must keep agreeing.

## License

Apache 2.0. See [`LICENSE`](LICENSE).
