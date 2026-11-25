---
description: Walk a shelf, a date range or a tag in Reverie, in order
argument-hint: <shelf, call number prefix, date range, or #tag>
allowed-tools:
  - Read
---

Browse Reverie by `$ARGUMENTS`, in order rather than by relevance.

## Scaffold state

The tools this command drives do not exist yet. They arrive at **M2** in
[`docs/SPEC.md`](../docs/SPEC.md) and become reachable from a session at
**M3**, when `.mcp.json.example` is renamed to `.mcp.json`. Until then: say so
in one line and stop. Do not write the memory to a file, a note, or anywhere
else instead. A memory kept somewhere Reverie cannot see is a memory that is
never recalled, reviewed or forgotten.

## What this command does once the tools exist

Read the argument as one of these and call `memory.browse`:

| Argument looks like | Call |
| --- | --- |
| A shelf name or code, `WRK/NST` | `browse { shelf }` |
| A call number prefix, `LIF/GTH/2026-12` | `browse { prefix }` |
| A full call number | `browse { around, span: 5 }`: what sits either side of it |
| Dates, "December", "last summer" | `browse { from, to }`, resolved to calendar dates |
| `#tag` | `browse { tags }` |

With no argument, `memory.shelves`: the sections and shelves with their counts.

## Rules

- Browse is never ranked. It returns what is on the shelf in call number
  order, which is section, shelf, time, then sequence.
- Retired entries are left out unless asked for. Superseded ones are shown,
  marked, because the order of what was believed is part of the record.
- Page rather than dumping a long shelf. Say how many more there are.
