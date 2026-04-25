#!/usr/bin/env bash
# oc-wrapper.sh
#
# Runs opencode directly from this git checkout (no build step) and pins
# it to the `aai` channel + database, so source runs share state with
# the released @rmk40/opencode@aai binary.
#
# Designed to be symlinked onto $PATH as `oc`:
#   ln -s "$REPO/script/oc-wrapper.sh" ~/.local/bin/oc
#
# `oc` is intentionally a separate command from `opencode` so the prebuilt
# release binary (e.g. /opt/homebrew/bin/opencode -> @rmk40/opencode) and
# the from-source dev build can coexist on PATH without ambiguity.
#
# Behavior mirrors a regular `opencode` invocation: project directory =
# $PWD, all CLI args pass through verbatim, exit code propagates, signals
# (Ctrl-C, SIGTERM, SIGWINCH) reach the bun process directly via exec.

set -euo pipefail

# Repo path is hardcoded for personal-machine convenience. If the repo
# moves, update this constant.
REPO="/Users/rmk/projects/oss/opencode"

# Resolve a short version indicator from git: 7-char SHA plus a +dirty
# marker if the working tree or index has uncommitted changes. Falls back
# to "unknown" if git fails for any reason — never blocks the launch.
SHA="$(git -C "$REPO" rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
if [ "$SHA" != "unknown" ]; then
  if ! git -C "$REPO" diff --quiet --ignore-submodules HEAD 2>/dev/null \
     || ! git -C "$REPO" diff --cached --quiet --ignore-submodules HEAD 2>/dev/null; then
    SHA="${SHA}+dirty"
  fi
fi

# Banner to stderr — visible for non-TUI commands, harmlessly cleared by
# the TUI on launch. Stdout is left clean for pipelines.
printf 'oc @ %s (channel=aai, repo=%s)\n' "$SHA" "$REPO" >&2

# Capture the user's actual working directory before bun's --cwd
# overrides it. The preload shim restores this as process.cwd() so
# opencode resolves the project from where the command was run.
export OPENCODE_USER_PWD="$PWD"

# Pin the database to opencode-aai.db. OPENCODE_CHANNEL is a build-time
# define (not read at runtime in source mode), so OPENCODE_DB is what
# actually steers the SQLite path. Setting OPENCODE_CHANNEL alongside is
# defensive — any future code that reads it via process.env will see the
# right value.
export OPENCODE_CHANNEL=aai
export OPENCODE_DB=opencode-aai.db

# Ensure the web UI bundle is current. Production binaries embed UI
# assets at build time via Bun.build's virtual `opencode-web-ui.gen.ts`
# module; source-runtime has no such module, so the catch-all UI route
# would otherwise serve a 503 fail-closed page.
#
# Strategy: stamp `packages/app/dist/.oc-source-stamp` with the current
# git HEAD plus the highest mtime in the UI source tree. If the stamp
# is missing or doesn't match, run `bun --cwd packages/app build`. Most
# invocations are stamp-hit and add zero latency.
APP_DIR="$REPO/packages/app"
DIST_DIR="$APP_DIR/dist"
STAMP_FILE="$DIST_DIR/.oc-source-stamp"

# Compute a fingerprint that changes when UI source or HEAD changes.
# Inputs:
#   - HEAD sha (catches `git checkout` that resets mtimes)
#   - dirty marker (catches `git stash pop`/local edits w/o commit)
#   - max mtime across all known Vite build inputs (catches local edits;
#     once the tree is dirty, HEAD/dirty bits stop changing and the mtime
#     scan is the only thing that catches further edits)
HEAD_REF="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
DIRTY_BIT="clean"
if ! git -C "$REPO" diff --quiet --ignore-submodules HEAD -- "$APP_DIR" 2>/dev/null \
   || ! git -C "$REPO" diff --cached --quiet --ignore-submodules HEAD -- "$APP_DIR" 2>/dev/null; then
  DIRTY_BIT="dirty"
fi
# Build the find input list dynamically so a missing optional file (e.g.
# vite.js renamed to .ts) does not abort the script under `set -e`.
SRC_INPUTS=()
for candidate in \
  "$APP_DIR/src" \
  "$APP_DIR/public" \
  "$APP_DIR/index.html" \
  "$APP_DIR/vite.config.ts" \
  "$APP_DIR/vite.js" \
  "$APP_DIR/package.json" \
  "$APP_DIR/bunfig.toml" \
  "$APP_DIR/tsconfig.json"; do
  [ -e "$candidate" ] && SRC_INPUTS+=("$candidate")
done
# `find -exec stat ... | sort -rn | head -1` may exit nonzero under `set -o
# pipefail` if `head` closes early; trailing `|| true` keeps the script alive.
SRC_MTIME="$(
  find "${SRC_INPUTS[@]}" -type f -exec stat -f '%m' {} \; 2>/dev/null \
    | sort -rn | head -1 || true
)"
WANT_STAMP="${HEAD_REF}|${DIRTY_BIT}|${SRC_MTIME}"
HAVE_STAMP=""
if [ -f "$STAMP_FILE" ]; then
  HAVE_STAMP="$(cat "$STAMP_FILE")"
fi

# Independent freshness check: if the bundled index.html is older than
# any tracked UI source file, force a rebuild even when the stamp
# matches. Defends against a stale dist/ paired with a stamp that was
# written manually or carried over from a different machine.
DIST_MTIME=""
if [ -f "$DIST_DIR/index.html" ]; then
  DIST_MTIME="$(stat -f '%m' "$DIST_DIR/index.html" 2>/dev/null || echo 0)"
fi
DIST_STALE="false"
if [ -z "$DIST_MTIME" ] || [ -z "$SRC_MTIME" ] || [ "$DIST_MTIME" -lt "$SRC_MTIME" ]; then
  DIST_STALE="true"
fi

if [ ! -f "$DIST_DIR/index.html" ] || [ "$WANT_STAMP" != "$HAVE_STAMP" ] || [ "$DIST_STALE" = "true" ]; then
  printf 'oc: rebuilding web UI...\n' >&2
  ( cd "$APP_DIR" && bun run build ) >&2
  printf '%s' "$WANT_STAMP" > "$STAMP_FILE"
fi

# Tell the source-mode UI route where to load assets from. ui.ts only
# consults this when the build-time embedded module is unavailable, so
# production binaries (which always have the embedded module) ignore it.
export OPENCODE_WEB_UI_DIR="$DIST_DIR"

# exec replaces this shell so bun owns the controlling terminal and
# receives signals directly. "$@" preserves every argument verbatim,
# including spaces, empty strings, and `--`.
#
# Use `bun` directly (not `bun run`): `bun run --preload` is silently
# ignored in this workspace setup, while `bun --preload` correctly
# loads the chdir shim that restores the user's $PWD as process.cwd().
exec bun \
  --cwd "$REPO/packages/opencode" \
  --conditions=browser \
  --preload "$REPO/script/opencode-dev-preload.ts" \
  "$REPO/packages/opencode/src/index.ts" \
  "$@"
