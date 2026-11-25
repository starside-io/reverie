---
description: Walk a shelf, a date range or a tag in Reverie, in order
argument-hint: <shelf, call number prefix, date range, or #tag>
allowed-tools:
  - Read
---

Browse Reverie by `$ARGUMENTS`, in order rather than by relevance.

## If the tools are missing

This command drives the `memory_*` tools of the bundled MCP server. If they
are not available in this session: say so in one line and stop. Do not write
the memory to a file, a note, or anywhere else instead. A memory kept somewhere
Reverie cannot see is a memory that is never recalled, reviewed or forgotten.

## What this command does

Read the argument as one of these and call `memory_browse`:

| Argument looks like | Call |
| --- | --- |
| A shelf name or code, `WRK/NST` | `memory_browse { shelf }` |
| A call number prefix, `LIF/GTH/2026-12` | `memory_browse { prefix }` |
| A full call number | `memory_browse { around, span: 5 }`: what sits either side of it |
| Dates, "December", "last summer" | `memory_browse { from, to }`, resolved to calendar dates |
| `#tag` | `memory_browse { tags }` |

With no argument, `memory_shelves`: the sections and shelves with their counts.

## Rules

- Browse is never ranked. It returns what is on the shelf in call number
  order, which is section, shelf, time, then sequence.
- Retired entries are left out unless asked for (`includeRetired: true`).
  Superseded ones are shown, marked, because the order of what was believed
  is part of the record.
- Page rather than dumping a long shelf: `limit`, then pass the returned
  `nextCursor` as `cursor` for the next page. Say when there are more.
