---
description: Start the Reverie host, or find the one already running, and open the library in the browser
argument-hint: [shelf or call number to open directly]
allowed-tools:
  - Read
  - Bash
---

Start Reverie, or find the host already running, and open the library UI in
the browser. With `$ARGUMENTS`, open that shelf or that memory directly.

## What this command does

1. Check whether a host is already up before starting a second one:
   `curl -s http://127.0.0.1:4329/health` (or the port in `REVERIE_PORT`). If
   it answers, reuse it.
2. Otherwise start it from the plugin checkout, in the background so it
   outlives this turn:
   `node "${CLAUDE_PLUGIN_ROOT}/apps/reverie/dist/cli.js" serve`.
   If that file, or `packages/ui/dist/index.html`, is missing, the checkout
   has not built yet: run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-bootstrap.mjs" build` first (a
   minute or two; it builds the UI too). `serve` listens on 127.0.0.1 only,
   on 4329 unless `REVERIE_PORT` says otherwise, serves the built UI from
   `packages/ui/dist` (or `REVERIE_UI_DIR`), and refuses while another host
   runs, naming it.
3. Check the UI is there: `curl -s -H 'accept: text/html' http://127.0.0.1:4329/`
   returns the page. If it returns the plain line saying the UI is not built,
   the running host predates the build: run the bootstrap build, then
   `node "${CLAUDE_PLUGIN_ROOT}/apps/reverie/dist/cli.js" restart`.
4. Open the page with the platform's opener (`open` on macOS, `xdg-open` on
   Linux, `start` on Windows):
   - no arguments: `http://127.0.0.1:4329/`, the library
   - a shelf such as `LIF/GTH`: `http://127.0.0.1:4329/library/LIF/GTH`
   - a call number such as `LIF/GTH/2026-12-24/001`:
     `http://127.0.0.1:4329/memory/LIF/GTH/2026-12-24/001`
   - `review`, `recall`, `timeline`, `tags` or `desk`: that screen, at
     `/review`, `/recall`, `/timeline`, `/tags` or `/desk`
   - anything else: open the library and offer `/reverie:browse` for
     `$ARGUMENTS`.
5. Report the URL opened, both file paths and the tool count, which
   `/health` returns.
6. To stop it, stop the process this command started, by its handle. To
   restart a host left running on older code:
   `node "${CLAUDE_PLUGIN_ROOT}/apps/reverie/dist/cli.js" restart`.

## Port and process rules

- The port is 4329, or `REVERIE_PORT`. Never 3000, and never a guess.
  Fellowship is on 4319; the two run side by side. The dev UI (Vite) is on
  4330 and proxies to a host started separately.
- To free a port, kill **only** the process LISTENing on it:
  `lsof -ti:PORT -sTCP:LISTEN | xargs kill`. Plain `lsof -ti:PORT` returns
  every PID with any connection to that port, browser tabs included.
- Confirm what is about to be killed first:
  `lsof -iTCP:PORT -sTCP:LISTEN -n -P`. If it is not the Reverie host, do not
  kill it, say what is there.
- One host at a time. It is the single writer to `reverie.db`, and it holds
  `host.lock` to say so.
