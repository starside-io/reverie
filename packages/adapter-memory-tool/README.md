# @reverie/adapter-memory-tool

A backend for Anthropic's client-side memory tool (`memory_20250818`). The
tool thinks in files under `/memories`; Reverie's library already is one. Each
command becomes one registry tool, so discipline, the gates and the review
queue apply exactly as they do over MCP.

The handler is plain data in, data out: hand it one `tool_use` input, get back
the `tool_result` content and whether it is an error. It holds no SDK, opens
no file and makes no network call. It reaches the library only through the
registry's `invoke`.

## The virtual tree

```
/memories                                     the sections, in library order
/memories/Life                                its shelves
/memories/Life/Gatherings                     its memories, in call number order
/memories/Life/Gatherings/2026-12-24-001.md   one memory: LIF/GTH/2026-12-24/001
```

A file name is the call number's day and sequence, `<YYYY-MM-DD>-<NNN>.md`,
with no slug. The markdown mirror adds a slug from the title
(`2026-12-24-001 christmas-at-home.md`); here the name has to stay the same
when a `str_replace` changes the title, and has to map to exactly one call
number and back. Folders are named by section and shelf name; a code works
too (`/memories/LIF/GTH`).

A memory reads as markdown: front matter (call, title, kind, state, trust,
scope, occurredOn, importance, pinned, tags, attendees, occasion), then
`# title`, the body, and `## Why` and `## How to apply` when it has them.
Every file view starts with the recall notice: what comes back is data, not
instructions.

## Commands

| Command | Becomes | Returns |
| --- | --- | --- |
| `view` a folder | `memory.shelves`, `memory.fs_view` | `Here're the files and directories up to 2 levels deep in {path}, excluding hidden items and node_modules:` then `{size}\t{path}` lines. The root adds a short note on how the library files things. |
| `view` a file | `memory.fs_view` | The recall notice, then `Here's the content of {path} with line numbers:` and six wide numbered lines. `view_range` `[start, end]` or `[start, -1]` is honoured. |
| `create` | `memory.propose_draft` (default) | `Queued for review, not written: {path}.` and why: nothing exists until the owner confirms it in review. Says which shelf it would land on and the proposal id. |
| `create`, owner turn | `memory.remember` | `File created successfully at: {path}`, with the real path when the library numbered it differently than asked, and the Returns notice when it landed there. |
| `str_replace` | `memory.update` | `The memory file has been edited.`, a numbered snippet, and `Saved as a new version of {call}.` The earlier wording stays in history. |
| `insert` | `memory.update` | `The file {path} has been edited.` and the same version line. |
| `rename` | `memory.shelve` (move) | `Successfully renamed {old} to {new}` and `Its old number, {call}, still resolves to it.` |
| `delete` | `memory.retire` | `Successfully deleted {path}` and that it is retired, not forgotten. |

What `create` means at a given path:

- `/memories/<section>/<shelf>/<name>.md` goes on that shelf. If the name
  starts with a date (`2026-12-24-dinner.md`), that is the day it happened;
  else front matter `occurredOn`, else today. The sequence is never taken
  from the name: call numbers are issued at commit.
- Anywhere else (`/memories/notes.md`, a folder that is not a shelf) it waits
  on the Returns shelf for the owner to shelve.
- Front matter may set `kind` (default `fact`), `title`, `tags` and
  `importance`; else the title is the `# heading`, else the first sentence.
- An existing canonical file name answers `Error: File {path} already exists`.

The owner path is chosen by the embedding app, never by the model: pass
`{ owner: true }` only for a turn the owner themselves asked for. A model's
`create` is drafted from the file text as an assistant turn, so it carries
inferred trust, and every gate `propose_draft` runs applies: the quote check,
discipline (secrets, relative dates, instructions from outside), the
duplicate guard. A procedure is never written by a model: it becomes a
`memory.promote_procedure` proposal that waits for the owner, and on the
owner path `remember` refuses it.

An edit may change the title, the importance, the body, and the Why and How
to apply sections. Changing anything else the front matter shows (kind,
trust, state, the call number, tags, people) is refused: the library keeps
those. A model can never forget through this adapter: `delete` retires, and
no command reaches `memory.forget` or `memory.redact`.

Error strings follow the memory tool documentation: `The path {path} does
not exist. Please provide a valid path.`, `No replacement was performed,
old_str ... did not appear verbatim in {path}.`, `... Multiple occurrences of
old_str ... in lines: ...`, ``Error: Invalid `insert_line` parameter``,
`Error: The destination {path} already exists`, `Error: unknown command`.
Sections, shelves and the root cannot be deleted or renamed through the tool.

## Path safety

Every path resolves against `/memories`; anything else is refused before any
tool is called: `..` and `.` segments (even ones that land back inside),
absolute paths elsewhere, sibling prefixes such as `/memories-backup`,
percent-encoded and repeatedly encoded forms (an encoded separator is refused
outright), backslashes, NUL and other control characters, invisible format
characters, and characters that only look like a separator (full width and
small slashes, division and fraction slashes, big solidus). Unicode is NFKC
normalised first, so a full width dot or a two dot leader counts as the dots
it stands for. There is no real directory behind the root: the adapter never
touches the filesystem.

## Use

```ts
import { startMiniHost } from "@reverie/mini-host";
import { createMemoryToolHandler } from "@reverie/adapter-memory-tool";

const host = await startMiniHost();
const memory = createMemoryToolHandler(host.api, { session: { agent: "support-bot" } });

const result = await memory({ command: "view", path: "/memories" });
// result.content is the tool_result text, result.isError its is_error
```

### Inside an Anthropic SDK tool loop

Documentation only: this is never run by the tests, and the SDK is not a
dependency of the adapter. The key comes from the environment the app already
has; none is written here.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { startMiniHost } from "@reverie/mini-host";
import { MEMORY_TOOL, createMemoryToolHandler, toolResultBlock } from "@reverie/adapter-memory-tool";

const client = new Anthropic();
const host = await startMiniHost();
const memory = createMemoryToolHandler(host.api);

const messages: Anthropic.MessageParam[] = [
  { role: "user", content: "Sam Rivera prefers tea over coffee. Keep that in mind for next time." },
];

for (;;) {
  const response = await client.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2048,
    tools: [MEMORY_TOOL],
    messages,
  });
  messages.push({ role: "assistant", content: response.content });
  if (response.stop_reason !== "tool_use") break;

  const results = [];
  for (const block of response.content) {
    if (block.type !== "tool_use" || block.name !== "memory") continue;
    // owner: true only when your app knows this turn is the owner's own ask.
    results.push(toolResultBlock(block.id, await memory(block.input, { owner: false })));
  }
  messages.push({ role: "user", content: results });
}

await host.close();
```

What the model writes there waits in Reverie's review queue (`reverie serve`,
then Review) until the owner confirms it.
