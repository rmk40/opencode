#!/usr/bin/env bash
# oc-dev-wrapper.sh
#
# HMR-enabled source-mode dev wrapper for opencode.
#
# Spawns two foreground children:
#
#   - Backend: `bun ... src/index.ts serve --port 4096 --hostname 127.0.0.1`
#     from the local checkout, so backend code edits take effect on the
#     next launch.
#   - Vite:   `bun --cwd packages/app run dev -- --port <resolved>
#              --strictPort` so SPA edits hot-reload.
#
# The SPA at the Vite URL points its API calls back at :4096 via
# VITE_OPENCODE_SERVER_HOST / VITE_OPENCODE_SERVER_PORT. The shared
# OPENCODE_DB=opencode-aai.db keeps server-side session state in sync
# with the brew binary's `aai` channel.
#
# Companion to script/oc-wrapper.sh (production-shape, embedded UI).
# Symlink onto $PATH as `oc-dev`:
#
#   ln -s "$REPO/script/oc-dev-wrapper.sh" ~/.local/bin/oc-dev
#
# See docs/plans/oc-dev-hmr.md for the full design rationale,
# including reaper detection, port-collision policy, and grandchild
# reaping notes.

set -euo pipefail

REPO="/Users/rmk/projects/oss/opencode"
APP_DIR="$REPO/packages/app"
OPENCODE_DIR="$REPO/packages/opencode"
PRELOAD="$REPO/script/opencode-dev-preload.ts"

API_PORT=4096
DEFAULT_VITE_PORT=40960
MAX_VITE_PORT_SCAN=20

# ---------------------------------------------------------------- helpers ---

log() { printf '%s\n' "$*" >&2; }
err() { printf 'oc-dev: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# Test whether a TCP port has a LISTENing socket on this host. Return
# 0 if free, 1 if taken. Stdout is suppressed; stderr from lsof is
# discarded so a missing tool or denied lookup does not pollute output.
port_free() {
  local port="$1"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

# Print a one-line description of whatever currently holds a port.
# Best-effort; some processes may resist lsof inspection. Used only
# for fail-loud diagnostics, never on the success path.
port_holder() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -n 5 || true
}

# Validate that a string is a TCP port in [1024, 65535]. Reject empty
# strings, non-integers, and reserved ranges. Used to gate
# OC_DEV_VITE_PORT before any probe.
valid_port() {
  local p="$1"
  [[ "$p" =~ ^[0-9]+$ ]] || return 1
  # Force base-10 parsing so leading-zero values (e.g. "08") don't
  # trip bash's octal arithmetic and emit diagnostics.
  (( 10#$p >= 1024 && 10#$p <= 65535 )) || return 1
  return 0
}

# Resolve a Vite port. Honors OC_DEV_VITE_PORT as a pin (fail loud if
# taken); otherwise scans up from DEFAULT_VITE_PORT until a free port
# is found, capped at MAX_VITE_PORT_SCAN attempts.
resolve_vite_port() {
  if [[ -n "${OC_DEV_VITE_PORT:-}" ]]; then
    valid_port "$OC_DEV_VITE_PORT" \
      || die "OC_DEV_VITE_PORT='$OC_DEV_VITE_PORT' is not a valid port (1024-65535)"
    # Reject collision with the API port up front so the user gets a
    # specific diagnostic instead of a misleading Vite bind failure
    # that surfaces ~100ms after the API has already grabbed :4096.
    (( 10#$OC_DEV_VITE_PORT != API_PORT )) \
      || die "OC_DEV_VITE_PORT=$OC_DEV_VITE_PORT collides with API_PORT=$API_PORT"
    if port_free "$OC_DEV_VITE_PORT"; then
      printf '%s' "$OC_DEV_VITE_PORT"
      return
    fi
    err "OC_DEV_VITE_PORT=$OC_DEV_VITE_PORT is already in use:"
    port_holder "$OC_DEV_VITE_PORT" >&2
    exit 1
  fi
  local p=$DEFAULT_VITE_PORT
  local attempts=0
  while (( attempts < MAX_VITE_PORT_SCAN )); do
    if port_free "$p"; then
      printf '%s' "$p"
      return
    fi
    p=$((p + 1))
    attempts=$((attempts + 1))
  done
  die "no free Vite port in [$DEFAULT_VITE_PORT, $((DEFAULT_VITE_PORT + MAX_VITE_PORT_SCAN - 1))]"
}

# -------------------------------------------------------------- preflight ---

command -v bun >/dev/null 2>&1 || die "bun not found on PATH"
[[ -d "$REPO/.git" ]] || die "REPO=$REPO is not a git checkout"
[[ -f "$PRELOAD" ]]   || die "preload shim missing: $PRELOAD"
[[ -d "$APP_DIR" ]]   || die "app dir missing: $APP_DIR"
[[ -d "$OPENCODE_DIR" ]] || die "opencode dir missing: $OPENCODE_DIR"

# Pre-spawn probe of API port. Most likely real-world failure is the
# user's own long-running backend already holding :4096; fail loud
# rather than letting Bun's HTTP server emit an opaque EADDRINUSE
# panic that races with Vite startup logs.
if ! port_free "$API_PORT"; then
  err "API port $API_PORT is already in use:"
  port_holder "$API_PORT" >&2
  err "stop the existing listener (e.g. another oc/opencode/oc-dev) before launching."
  exit 1
fi

VITE_PORT="$(resolve_vite_port)"

# --------------------------------------------------------------- versions ---

SHA="$(git -C "$REPO" rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
if [[ "$SHA" != "unknown" ]]; then
  if ! git -C "$REPO" diff --quiet --ignore-submodules HEAD 2>/dev/null \
     || ! git -C "$REPO" diff --cached --quiet --ignore-submodules HEAD 2>/dev/null; then
    SHA="${SHA}+dirty"
  fi
fi

# ------------------------------------------------------------------ banner ---

API_URL="http://127.0.0.1:$API_PORT"
UI_URL="http://127.0.0.1:$VITE_PORT"

log ""
log "oc-dev @ $SHA"
log "  API   $API_URL  (channel=local at runtime; OPENCODE_CHANNEL is build-time)"
log "  UI    $UI_URL   (HMR via vite; VITE_OPENCODE_CHANNEL=dev for SPA badges)"
log "  DB    opencode-aai.db (shared with brew @rmk40/opencode@aai)"
log "  PWD   $PWD"
log "  Ctrl-C stops both children."
log ""

# --------------------------------------------------------------- env exports ---

# Backend-side. OPENCODE_CHANNEL has no effect on InstallationChannel
# at runtime (build-time define), but exporting it costs nothing and
# matches oc-wrapper.sh in case any future code reads process.env.
export OPENCODE_CHANNEL=aai
export OPENCODE_DB=opencode-aai.db
export OPENCODE_USER_PWD="$PWD"

# Defensively clear OPENCODE_WEB_UI_DIR — if the user's shell rc
# leaves it exported, the source-mode backend on :4096 would serve a
# stale dist for any UI route accidentally hit there, violating the
# "UI traffic only goes to Vite" invariant the dev mode depends on.
unset OPENCODE_WEB_UI_DIR

# SPA-side. Vite's define plugin reads VITE_*-prefixed env at build
# time and inlines them as import.meta.env.*.
export VITE_OPENCODE_SERVER_HOST=127.0.0.1
export VITE_OPENCODE_SERVER_PORT="$API_PORT"
export VITE_OPENCODE_CHANNEL=dev

# --------------------------------------------------------------- reaper ---

# macOS ships bash 3.2, which has no `wait -n`. We avoid blocking
# builtins (read/wait) in the main loop because their signal-handling
# behavior is fragile in 3.2: a SIGINT delivered during `read` can be
# discarded if the read is on a FIFO that the parent shell holds open
# r/w. Instead, the main loop polls `kill -0` on each child PID at a
# fixed cadence. Latency is one poll interval; trivial compared to
# Vite startup.
POLL_INTERVAL_S=0.2

API_PID=""
VITE_PID=""
SHUTDOWN=0

# Idempotent cleanup. Clears its own trap so re-entry through EXIT
# after SIGINT-handled cleanup cannot double-kill or double-print.
shutdown() {
  if (( SHUTDOWN )); then return; fi
  SHUTDOWN=1
  trap - INT TERM EXIT

  log ""
  log "oc-dev: shutting down children..."

  if [[ -n "$VITE_PID" ]] && kill -0 "$VITE_PID" 2>/dev/null; then
    # Reap Vite grandchildren first: esbuild service, dep optimizer
    # workers, etc. macOS has no setsid(1) so these aren't in a
    # process group we own.
    pkill -P "$VITE_PID" 2>/dev/null || true
    kill -TERM "$VITE_PID" 2>/dev/null || true
  fi
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill -TERM "$API_PID" 2>/dev/null || true
  fi

  # Give children a moment to exit cleanly, then SIGKILL stragglers.
  sleep 1
  [[ -n "$VITE_PID" ]] && kill -KILL "$VITE_PID" 2>/dev/null || true
  [[ -n "$API_PID"  ]] && kill -KILL "$API_PID"  2>/dev/null || true

  # Catch any remaining esbuild workers scoped to this repo. Pattern
  # ordering matters: a typical cmdline looks like
  # `/.../opencode/packages/app/node_modules/@esbuild/.../esbuild
  # --service=...`, so the repo path appears *before* the binary
  # name. `${REPO}/.*esbuild` matches that shape and stays anchored
  # inside this checkout (so a sibling path under .../opencode-fork/
  # cannot match). `.` chars in $REPO are still regex metachars, but
  # for a hardcoded literal repo path that's a no-op concern.
  # In practice the `pkill -P "$VITE_PID"` above usually catches all
  # of them; this is the safety net.
  pkill -f "${REPO}/.*esbuild" 2>/dev/null || true

  # Drain `wait` so the shell does not exit while reaping.
  wait 2>/dev/null || true
}

# SIGINT/SIGTERM trigger immediate shutdown then exit non-zero so the
# main poll loop never resumes. EXIT trap is the safety net for any
# other exit path.
on_signal() {
  shutdown
  exit 130
}
trap on_signal INT TERM
trap shutdown EXIT

# ------------------------------------------------------------- spawn API ---

# Backend child. Inherits all OPENCODE_* and OPENCODE_USER_PWD env.
# Bun's --preload runs the chdir shim before src/index.ts evaluates,
# restoring the user's $PWD as process.cwd() so config discovery and
# MCP server cwd both walk up from the launch directory.
bun \
  --cwd "$OPENCODE_DIR" \
  --conditions=browser \
  --preload "$PRELOAD" \
  "$OPENCODE_DIR/src/index.ts" serve \
  --port "$API_PORT" \
  --hostname 127.0.0.1 \
  &
API_PID=$!

# ------------------------------------------------------------ spawn Vite ---

# Vite child. `bun run dev` invokes the workspace-pinned vite
# (devDependency of @opencode-ai/app). NOTE: bun 1.3.13 has a parser
# bug where `bun --cwd <path> run <script> --some-flag` consumes
# `--some-flag` as a top-level bun flag rather than forwarding it to
# the script. Even `--` doesn't fix it. Workaround: `cd` in a
# subshell instead of using `--cwd`.
# --strictPort makes Vite exit non-zero on bind collision instead of
# silently hopping ports, so the URL printed in the banner above
# stays accurate.
( cd "$APP_DIR" && exec bun run dev --port "$VITE_PORT" --strictPort ) &
VITE_PID=$!

# --------------------------------------------------------------- main loop ---

# Poll-based reaper: check both PIDs every POLL_INTERVAL_S until one
# dies. `kill -0` returns 0 if the process exists, non-zero otherwise.
# Once a child is dead, capture its exit code via `wait` (which
# returns immediately for already-exited children) and trigger
# shutdown.
DEAD=""
DEAD_CODE=0
# Under `set -e`, a `wait` whose target exited non-zero would abort
# the script before `$?` is captured. Use the `cmd || var=$?` idiom
# to short-circuit the failure into DEAD_CODE without tripping -e.
while :; do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    DEAD=api
    wait "$API_PID" 2>/dev/null || DEAD_CODE=$?
    break
  fi
  if ! kill -0 "$VITE_PID" 2>/dev/null; then
    DEAD=vite
    wait "$VITE_PID" 2>/dev/null || DEAD_CODE=$?
    break
  fi
  sleep "$POLL_INTERVAL_S"
done

log ""
log "oc-dev: $DEAD child exited (code=$DEAD_CODE); shutting down sibling."

shutdown
exit "$DEAD_CODE"
