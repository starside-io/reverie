---
description: Start the Reverie host and open the library
argument-hint: [shelf or call number to open directly]
allowed-tools:
  - Read
  - Bash
---

Start Reverie and open it in the browser, at `$ARGUMENTS` when given.

## Scaffold state

There is no app to start yet. The host arrives at **M3** and the UI at **M6**
in [`docs/SPEC.md`](../docs/SPEC.md). Until then: say so in one line and
stop. Do not run a package manager and do not start a server on a guessed port.

## What this command does once the app exists

1. Check whether a host is already up before starting a second one:
   `curl -s localhost:4329/health`. If it answers, reuse it.
2. Otherwise start it from the repo root. It listens on 4329 unless
   `REVERIE_PORT` says otherwise, on 127.0.0.1 only.
3. Report the URL, both file paths and the tool count, which `/health` returns.

## Port and process rules

- The port is 4329, or `REVERIE_PORT`. Never 3000, and never a guess.
  Fellowship is on 4319; the two run side by side.
- To free a port, kill **only** the process LISTENing on it:
  `lsof -ti:PORT -sTCP:LISTEN | xargs kill`. Plain `lsof -ti:PORT` returns
  every PID with any connection to that port, browser tabs included.
- Confirm what is about to be killed first:
  `lsof -iTCP:PORT -sTCP:LISTEN -n -P`. If it is not the Reverie host, do not
  kill it, say what is there.
- One host at a time. It is the single writer to `reverie.db`, and it holds
  `host.lock` to say so.
