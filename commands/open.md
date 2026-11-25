---
description: Start the Reverie host, or find the one already running
argument-hint: [shelf or call number to open directly]
allowed-tools:
  - Read
  - Bash
---

Start the Reverie host, or find the one already running. There is no library
page to open yet.

## State

The host exists and the UI does not: it arrives at **M6** in
[`docs/SPEC.md`](${CLAUDE_PLUGIN_ROOT}/docs/SPEC.md). Starting the host gives
`POST /rpc`, `/host/review`, `/host/config` and `/health`, and no page to look
at: `/` answers with a line saying so. When asked to open the library or a
shelf in a browser, say that in one line and offer `/reverie:browse` for
`$ARGUMENTS` instead.

## What this command does

1. Check whether a host is already up before starting a second one:
   `curl -s http://127.0.0.1:4329/health` (or the port in `REVERIE_PORT`). If
   it answers, reuse it.
2. Otherwise start it from the plugin checkout, in the background so it
   outlives this turn:
   `node "${CLAUDE_PLUGIN_ROOT}/apps/reverie/dist/cli.js" serve`.
   If that file is missing the checkout has not built yet: run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-bootstrap.mjs" build` first (a
   minute or two). `serve` listens on 127.0.0.1 only, on 4329 unless
   `REVERIE_PORT` says otherwise, and refuses while another host runs,
   naming it.
3. Report the URL, both file paths and the tool count, which `/health`
   returns.
4. To stop it, stop the process this command started, by its handle. To
   restart a host left running on older code:
   `node "${CLAUDE_PLUGIN_ROOT}/apps/reverie/dist/cli.js" restart`.

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
