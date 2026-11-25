---
description: Remember something in Reverie, in your own words
argument-hint: <what to remember> [#tags]
allowed-tools:
  - Read
---

Store `$ARGUMENTS` in Reverie as a memory the owner stated.

## If the tools are missing

This command drives the `memory_*` tools of the bundled MCP server. If they
are not available in this session: say so in one line and stop. Do not write
the memory to a file, a note, or anywhere else instead. A memory kept somewhere
Reverie cannot see is a memory that is never recalled, reviewed or forgotten.

## What this command does

1. **Read the building first.** `memory_shelves` and `memory_tags`, so the
   shelf and the tags come from what is already there.
2. **Pick the kind**: fact, preference, episode or reference. A procedure (how
   to work for the owner) is not written here: see the rules.
3. **Resolve every date.** "Yesterday" and "last week" are refused. Turn them
   into a calendar date from today's date before writing. For an episode the
   date is when it happened (`occurredOn`), not today.
4. **Write** with `memory_remember`: `kind`, `body`, and `shelf` (`LIF/GTH`),
   `occurredOn`, `tags`, `title` when known. Pass the owner's own words as
   `said` when the body restates them. In a session that belongs to a
   project, `scope: "project"` keeps it with that project. Trust is `stated`,
   because the owner asking is the confirmation. Tags typed as `#tag` are
   attached as written.
5. **If people were there**, follow the Fellowship procedure in the skill
   before writing: names go in `attendees`, the occasion in `occasion`.
6. **Report the call number** it was shelved under, and the shelf by name.

## Rules

- `conflict` back from `memory_remember` means it is already remembered: the
  answer names that call number, and nothing was written. Show it. If this
  adds evidence, `memory_add_source` or `memory_touch`; if it changes the
  wording, `memory_update`; if the world changed, `memory_supersede`. Never
  reword it to get a second copy past the guard.
- No shelf fits: leave `shelf` out, it lands on Returns, and say so. Do not
  invent a shelf.
- A secret (a key, a token, a password) is refused. Say why, and do not retry
  with it reworded.
- Health, money, politics, religion or sexuality is kept only when the owner
  explicitly asked for it to be kept: then `explicitAsk: true`.
- A procedure goes through `memory_promote_procedure` with `why`,
  `howToApply` and `confirmedByUser: true`, set only after the owner said yes
  to the exact wording, because it changes how every later session behaves.
  `memory_remember` refuses one.
