---
description: Draft memories from finished sessions, run a consolidation pass over Reverie, and queue what both propose
argument-hint: [shelf, or a date range, to limit the consolidation pass]
allowed-tools:
  - Read
---

Two passes over Reverie. First, draft the memories worth keeping from every
finished session still waiting for extraction. Then consolidate: find
duplicates, contradictions and stale entries, and propose what to do about
each, limited to the shelf or the dates in `$ARGUMENTS` when given.

## If the tools are missing

This command drives the `memory_*` tools of the bundled MCP server. If they
are not available in this session: say so in one line and stop. Do not write
the memory to a file, a note, or anywhere else instead. A memory kept somewhere
Reverie cannot see is a memory that is never recalled, reviewed or forgotten.

## Extraction: what finished sessions left behind

A session that ended is marked ready for extraction, with a pointer to its
transcript. Its session notes and its transcript turns are what to draft from.

1. `memory_draft_context { job: "extract" }`, with no material and no
   session, lists the sessions waiting: each with its id, how many session
   notes it holds, and whether a transcript is there. An empty list means
   there is nothing to extract: go on to consolidation.
2. For each one, `memory_draft_context { job: "extract", session: "<id>" }`.
   It hands over the session's notes (marked `note`, the assistant's words,
   not the owner's) and its transcript turns, a page at a time. `session.notice`
   says what the page holds, and says so when there is no transcript and the
   notes are all there is.
3. Draft the memories worth keeping from that page, each with a quote copied
   exactly from it, and hand the answer to `memory_propose_draft` with the
   `target` exactly as returned. A quote that is not on that page is refused.
4. When the answer to step 2 carried a `continuation`, call
   `memory_draft_context` with it for the next page and repeat step 3. The
   session stops waiting once its last page is proposed. If every candidate
   of the last page was refused, it keeps waiting: fix the draft and propose
   again. A page with nothing worth keeping is proposed with no candidates.
5. Nothing is read while incognito is on. Say so and skip this part.

## Consolidation

1. `memory_draft_context { job: "consolidate" }` for the material, the rules
   and the schema. To limit the pass, add `shelf` (`WRK/NST`), `from` and
   `to` (calendar dates), or `limit`. There is no tag filter.
2. Reason over it. The schema allows three actions per finding: `merge` two
   entries that say the same thing, `retire` one that no longer holds, or
   `link` two entries as `contradicts` or `elaborates`. Anything else (a
   supersede, a reshelve) is not a consolidation action: name it in the
   report for the owner to do by hand.
3. Hand the answer to `memory_propose_draft` with the `target` exactly as
   `memory_draft_context` returned it. It is validated and queued; each
   refused action comes back with its reason.
4. Report what both passes queued and point the owner at `/reverie:review`.

## Rules

- **Both passes propose. Neither applies.** What is drafted from a session
  waits in review like anything else a model concludes.
- **Consolidation proposes. It never applies.** Nothing changes until the
  owner decides in review. A pass that rewrites what is known unseen is how
  trust in a memory ends.
- A contradiction is surfaced as a `contradicts` link, not resolved by picking
  the newer one. Which is true is the owner's call.
- Never propose forgetting. Retire at most.
- Leave anything pinned alone unless it is contradicted.
