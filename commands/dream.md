---
description: Run a consolidation pass over Reverie and queue what it proposes
argument-hint: [shelf, or a date range, to limit the pass]
allowed-tools:
  - Read
---

Consolidate Reverie: find duplicates, contradictions and stale entries, and
propose what to do about each. Limited to the shelf or the dates in
`$ARGUMENTS` when given.

## If the tools are missing

This command drives the `memory_*` tools of the bundled MCP server. If they
are not available in this session: say so in one line and stop. Do not write
the memory to a file, a note, or anywhere else instead. A memory kept somewhere
Reverie cannot see is a memory that is never recalled, reviewed or forgotten.

## What this command does

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
4. Report what was queued and point the owner at `/reverie:review`.

## Rules

- **Consolidation proposes. It never applies.** Nothing changes until the
  owner decides in review. A pass that rewrites what is known unseen is how
  trust in a memory ends.
- A contradiction is surfaced as a `contradicts` link, not resolved by picking
  the newer one. Which is true is the owner's call.
- Never propose forgetting. Retire at most.
- Leave anything pinned alone unless it is contradicted.
