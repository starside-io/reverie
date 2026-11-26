#!/bin/sh
# Builds Reverie.app once, or again if another commit lands mid-build, then
# brings whatever was running back up on the new code: Reverie.app is quit
# and reopened, and a `reverie serve` left running is restarted. One host at
# a time throughout: the app stops its own host when it quits.
# Called by post-commit; safe to run by hand: .githooks/rebuild-app.sh

root=${1:-$(git rev-parse --show-toplevel)}
git_dir=${2:-$(git -C "$root" rev-parse --absolute-git-dir)}
lock="$git_dir/rebuild-app.lock"
pending="$git_dir/rebuild-app.pending"
log="$git_dir/rebuild-app.log"

# A build is already running: ask it to go round once more, and leave.
if ! mkdir "$lock" 2>/dev/null; then
  touch "$pending"
  exit 0
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT INT TERM

# A GUI git client runs hooks with a thin PATH; the build needs node, pnpm
# and cargo. The caller's own PATH stays first, these are fallbacks.
for dir in "$HOME"/.nvm/versions/node/*/bin; do
  [ -d "$dir" ] && PATH="$PATH:$dir"
done
PATH="$PATH:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin"
export PATH

cd "$root" || exit 1
built=0
while :; do
  rm -f "$pending"
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') rebuilding at $(git rev-parse --short HEAD)" >>"$log"
  if pnpm desktop >>"$log" 2>&1; then
    built=1
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') built" >>"$log"
  else
    built=0
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') build FAILED" >>"$log"
  fi
  [ -e "$pending" ] || break
done

# A failed build leaves everything running as it was.
[ "$built" = 1 ] || exit 0

{
  # The app, if open: where it was opened from, so the same bundle reopens.
  app_pid=$(pgrep -f '/Reverie.app/Contents/MacOS/reverie-desktop' | head -n 1)
  app_path=""
  if [ -n "$app_pid" ]; then
    app_path=$(ps -o command= -p "$app_pid" | sed 's#/Contents/MacOS/reverie-desktop.*##')
    echo "=== quitting Reverie.app (pid $app_pid)"
    osascript -e 'tell application id "dev.reverie.desktop" to quit' || kill "$app_pid"
    waited=0
    while kill -0 "$app_pid" 2>/dev/null && [ "$waited" -lt 40 ]; do
      sleep 0.5
      waited=$((waited + 1))
    done
  fi

  # A host started with `reverie serve` keeps running across the quit;
  # restart brings it back on the new code. It does nothing when none runs.
  echo "=== restarting a running host, if any"
  pnpm --filter ./apps/reverie start restart

  if [ -n "$app_path" ]; then
    echo "=== reopening $app_path"
    open "$app_path"
  fi
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') done"
} >>"$log" 2>&1
