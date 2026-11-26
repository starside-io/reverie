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

1. `memory_review` for what is pending. It lists proposals oldest first, and
   `groups`: each heading (the session or the event that produced it) with
   its numbered `steps`. An episode's proposal can carry an occasion and notes
   for Fellowship; each is a step of its own (`part: "occasion"`, `"memory"`,
   `"note"`). Show them under those headings, in step order.
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
   call for each proposal in the group. When the owner decided an occasion or
   a note step differently from its episode, say so in `pending: { occasion,
   notes: [...] }`, one entry per note in step order.
4. Then the front desk, from the same answer's `frontDesk`:
   `occasionPending` (confirmed episodes whose occasion was never logged and
   linked, each with the `followUp` to resume), `occasionsWithNoStory`
   (occasions Fellowship logged that nothing here tells yet; never invent
   one), and `unresolvedNames` (names kept while Fellowship could not resolve
   them).

## Rules

- A group is a heading, not a transaction. Each proposal is confirmed or
  rejected on its own, even when the owner says "all of these".
- Never confirm on the owner's behalf, and never because the queue is long.
- A confirm that was refused stays pending, with the error. Report it; do not
  retry it reworded.
- A confirmed episode whose occasion is still pending in Fellowship returns a
  `followUp`. With `people_*` present: look in Fellowship for an occasion on
  that day with those people first (`people_activity`), and link to it if
  there is one; otherwise run `people_log_interaction` with the `input` as
  given (its `refs` already point back at the memory), then
  `memory_link_occasion` with `then.call`, the occasion id it returned, and
  its participants. `noteFollowUps` are `people_add_note` calls; resolve a
  person still a name first. Without Fellowship, leave it: the memory is
  complete as it is.
- A new tag is shown as new. So is a new shelf. Vocabulary grows on purpose.
