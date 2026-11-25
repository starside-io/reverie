---
description: Go through what is waiting in Reverie's review queue
argument-hint: [session or event to review]
allowed-tools:
  - Read
---

Walk the owner through the proposals waiting in Reverie.

## If the tools are missing

This command drives the `memory_*` tools of the bundled MCP server. If they
are not available in this session: say so in one line and stop. Do not write
the memory to a file, a note, or anywhere else instead. A memory kept somewhere
Reverie cannot see is a memory that is never recalled, reviewed or forgotten.

## What this command does

1. `memory.review` for what is pending, grouped by the session or the event
   that produced it.
2. For each proposal show: the verb (add, refine, supersede, duplicate), the
   proposed shelf and tags, the body, the quote it was drafted from, and for
   refine or supersede the existing memory beside it.
3. Take the owner's decision and pass it to `memory.decide`, one proposal at
   a time or a whole group when they say so.

## Rules

- A group is a heading, not a transaction. Each proposal is confirmed or
  discarded on its own unless the owner says "all of these".
- Never confirm on the owner's behalf, and never because the queue is long.
- A proposal that pairs a memory with a Fellowship occasion commits the
  occasion first, so the memory can carry its reference.
- A new tag is shown as new. So is a new shelf. Vocabulary grows on purpose.
