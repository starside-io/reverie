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

1. **Read the building first.** `memory.shelves` and `memory.tags`, so the
   shelf and the tags come from what is already there.
2. **Pick the kind**: fact, preference, procedure, episode or reference. A
   procedure is how to work for the owner and needs a why and a how to apply.
3. **Resolve every date.** "Yesterday" and "last week" are refused. Turn them
   into a calendar date from today's date before writing. For an episode the
   date is when it happened, not today.
4. **Write** with `memory.remember`. Trust is `stated`, because the owner
   asking is the confirmation. Tags typed as `#tag` are attached as written.
5. **If people were there**, follow the Fellowship procedure in the skill
   before writing: the occasion is proposed alongside the memory, not after.
6. **Report the call number** it was shelved under, and the shelf by name.

## Rules

- `conflict` back from `memory.remember` means a near match already exists.
  Show the candidates and ask whether this refines one, supersedes one, or is
  new. Never write a second copy to get past it.
- No shelf fits: let it land on Returns and say so. Do not invent a shelf.
- A secret (a key, a token, a password) is refused. Say why, and do not retry
  with it reworded.
- A procedure goes through `memory.promote_procedure`, which needs the owner's
  yes to the exact wording, because it changes how every later session behaves.
