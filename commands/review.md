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

1. `memory_review` for what is pending. It lists proposals oldest first, each
   with its `group` heading (the session or the event that produced it) when
   it has one. Show them under those headings.
2. For each proposal show what it would do, read from the `tool` it names and
   its `payload`: `memory_remember` (add), `memory_update` (refine),
   `memory_supersede`, `memory_add_source` (a duplicate gaining a source),
   `memory_promote_procedure`, `memory_merge`, `memory_retire`, `memory_link`
   or `memory_pin`. Show the proposed shelf and tags, the body, and the quote
   it was drafted from. When it names an existing memory (`call`), show that
   memory beside it with `memory_get`.
3. Take the owner's decision and pass it to `memory_decide` with the
   `proposalId`, `decision: "confirm"` or `"reject"`, and
   `confirmedByUser: true`. One call per proposal; for "all of these", one
   call for each proposal in the group.

## Rules

- A group is a heading, not a transaction. Each proposal is confirmed or
  rejected on its own, even when the owner says "all of these".
- Never confirm on the owner's behalf, and never because the queue is long.
- A confirm that was refused stays pending, with the error. Report it; do not
  retry it reworded.
- A confirmed episode whose occasion is still pending in Fellowship returns a
  `followUp`: run the people call it names, then `memory_link_occasion` with
  the occasion id it returned. Without Fellowship, leave it: the memory is
  complete as it is.
- A new tag is shown as new. So is a new shelf. Vocabulary grows on purpose.
