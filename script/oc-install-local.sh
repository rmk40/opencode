#!/usr/bin/env bash
# oc-install-local.sh
#
# Compile the fork CLI from this checkout (darwin-arm64) and install
# the resulting Mach-O at ~/.local/bin/opencode. After this runs,
# `opencode` on PATH is the locally-built binary from HEAD, with
# OPENCODE_VERSION baked in as `1.14.24-aai.local.<sha>` and the
# fork-shaped channel/repo/registry envs as build-time defines so
# `opencode upgrade` queries GitHub Packages and the binary continues
# to share opencode-aai.db with oc-wrapper.sh-mode runs.
#
# Iteration loop: edit source, run this, repeat. ~12s on warm rebuild.
#
# To revert: `rm ~/.local/bin/opencode`. There's no opencode binary
# on PATH after that; reinstall via this script or via
#   npm install -g @rmk40/opencode@aai \
#     --registry=https://npm.pkg.github.com
# if you want the published artifact back.
#
# AGENTS.md says docs/CI workflows should call `bun run release:fork
# ...` rather than invoking `script/build.ts` directly. This script is
# local-machine tooling, not docs/CI. Calling build.ts directly is the
# only way to skip the full-matrix validator inside `release:fork
# build`. Documented exception.
#
# See docs/plans/oc-install-local.md for the design rationale.

set -euo pipefail

REPO="/Users/rmk/projects/oss/opencode"
OPENCODE_DIR="$REPO/packages/opencode"
INSTALL_DIR="$HOME/.local/bin"
INSTALL_PATH="$INSTALL_DIR/opencode"
UPSTREAM_VERSION="1.14.24"

# ---------------------------------------------------------------- helpers ---

log() { printf '%s\n' "$*" >&2; }
err() { printf 'oc-install-local: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# -------------------------------------------------------------- preflight ---

command -v bun >/dev/null 2>&1 || die "bun not found on PATH"
[[ -d "$REPO/.git" ]] || die "REPO=$REPO is not a git checkout"
[[ -d "$OPENCODE_DIR" ]] || die "opencode dir missing: $OPENCODE_DIR"

# Ensure the install directory exists and is writable.
mkdir -p "$INSTALL_DIR"
[[ -w "$INSTALL_DIR" ]] || die "$INSTALL_DIR is not writable"

# Refuse to clobber a binary held open by a running process. macOS
# keeps the running inode in memory after a `mv`, but a freshly forked
# child reading from the new file mid-replace is a real corruption
# window. lsof rc=0 means holders, rc=1 means none, rc>1 is a tool
# failure (fail loud rather than silently fail open). Skip the check
# entirely if the install path doesn't yet exist.
if [[ -e "$INSTALL_PATH" && ! -L "$INSTALL_PATH" ]]; then
  LSOF_STDERR="$(mktemp)"
  trap 'rm -f "$LSOF_STDERR"' EXIT
  set +e
  HOLDERS="$(lsof -- "$INSTALL_PATH" 2>"$LSOF_STDERR")"
  LSOF_RC=$?
  set -e
  case "$LSOF_RC" in
    0) ;;                            # has holders, $HOLDERS is the table
    1) ;;                            # no holders, $HOLDERS is empty
    *)
      err "lsof failed (rc=$LSOF_RC) probing $INSTALL_PATH:"
      cat "$LSOF_STDERR" >&2 || true
      exit 1
      ;;
  esac
  rm -f "$LSOF_STDERR"
  trap - EXIT
  if [[ -n "$HOLDERS" ]]; then
    err "$INSTALL_PATH is currently held open by:"
    printf '%s\n' "$HOLDERS" >&2
    err "stop them (or wait until the session ends) before re-running"
    exit 1
  fi
fi

# Refuse to install if a different `opencode` shadows ours on PATH —
# overwriting the wrong one is silent. ~/.local/bin must precede any
# other location.
RESOLVED="$(command -v opencode 2>/dev/null || true)"
if [[ -n "$RESOLVED" && "$RESOLVED" != "$INSTALL_PATH" ]]; then
  die "\`which opencode\` returns '$RESOLVED', not '$INSTALL_PATH'; \
fix PATH so $INSTALL_DIR comes first, then re-run"
fi

# ---------------------------------------------------------------- version ---

SHA="$(git -C "$REPO" rev-parse --short=7 HEAD 2>/dev/null)"
[[ -n "$SHA" ]] || die "could not resolve git HEAD"

DIRTY=""
if ! git -C "$REPO" diff --quiet --ignore-submodules HEAD 2>/dev/null \
   || ! git -C "$REPO" diff --cached --quiet --ignore-submodules HEAD 2>/dev/null; then
  DIRTY=".dirty"
fi

VERSION="${UPSTREAM_VERSION}-aai.local.${SHA}${DIRTY}"

BEFORE_VERSION="(none)"
if [[ -x "$INSTALL_PATH" ]]; then
  BEFORE_VERSION="$("$INSTALL_PATH" --version 2>/dev/null | head -1 || echo unknown)"
fi

# ----------------------------------------------------------------- banner ---

log ""
log "oc-install-local"
log "  repo     $REPO"
log "  version  $VERSION  (was: $BEFORE_VERSION)"
log "  target   $INSTALL_PATH"
log ""
log "building (this takes ~30s, ~12s on warm rebuild)..."
log ""

# -------------------------------------------------------------- env exports ---

# Defensive unsets so a stray export from a prior CI/release shell
# can't change build behavior. OPENCODE_RELEASE in particular gates
# whether build.ts attempts a `gh release upload`.
unset OPENCODE_BUMP OPENCODE_RELEASE GH_REPO

# Match the env-set the fork release pipeline uses, minus the
# release-only ones. These all become build-time defines via Bun.build's
# `define:` map; the binary will report this version, advertise the
# fork repo for upgrade-channel discovery, and use the GitHub Packages
# registry for any npm-resolution path.
export OPENCODE_VERSION="$VERSION"
export OPENCODE_CHANNEL="aai"
export OPENCODE_REPO="rmk40/opencode"
export OPENCODE_NPM_PACKAGE="@rmk40/opencode"
export OPENCODE_NPM_REGISTRY="https://npm.pkg.github.com"

# ------------------------------------------------------------------ build ---

# `--single` filters allTargets to the host platform and skips the
# baseline (avx2: false) variant; result is one entry: darwin-arm64.
# build.ts wipes packages/opencode/dist before running.
( cd "$OPENCODE_DIR" && exec bun run script/build.ts --single ) >&2

BUILT_BIN="$OPENCODE_DIR/dist/opencode-darwin-arm64/bin/opencode"
[[ -f "$BUILT_BIN" ]] || die "build did not produce $BUILT_BIN"

FILE_INFO="$(file -b "$BUILT_BIN" 2>/dev/null || echo unknown)"
if [[ "$FILE_INFO" != *"Mach-O"* ]] || [[ "$FILE_INFO" != *"arm64"* ]]; then
  die "$BUILT_BIN is not a Mach-O arm64 binary: $FILE_INFO"
fi

# Pre-clobber smoke: confirm the freshly-built binary self-reports the
# expected version BEFORE we install it. Catches the case where build.ts
# succeeded structurally but OPENCODE_VERSION was not properly baked in.
PRE_VERSION="$("$BUILT_BIN" --version 2>/dev/null | head -1 || echo unknown)"
if [[ "$PRE_VERSION" != *"$VERSION"* ]]; then
  die "pre-install smoke: built binary --version returned '$PRE_VERSION', expected '$VERSION' (refusing to install broken binary)"
fi

# ---------------------------------------------------------------- install ---

# Stage in the same directory as the target so the final mv is atomic
# (rename(2) on the same filesystem). The EXIT trap removes any
# leftover .new file if the script aborts between cp and mv.
TMP_INSTALL="${INSTALL_PATH}.new.$$"
trap 'rm -f "$TMP_INSTALL"' EXIT

cp "$BUILT_BIN" "$TMP_INSTALL"
chmod +x "$TMP_INSTALL"

# If $INSTALL_PATH is currently a symlink (e.g. legacy `opencode ->
# script/oc-wrapper.sh`), `mv -f` replaces it correctly — rename(2)
# treats the symlink as the entry being replaced, not its target.
mv -f "$TMP_INSTALL" "$INSTALL_PATH"
trap - EXIT

# --------------------------------------------------------------- post-smoke ---

AFTER_VERSION="$("$INSTALL_PATH" --version 2>/dev/null | head -1 || echo unknown)"
if [[ "$AFTER_VERSION" != *"$VERSION"* ]]; then
  die "post-install smoke: --version returned '$AFTER_VERSION', expected '$VERSION'"
fi

"$INSTALL_PATH" --help >/dev/null 2>&1 \
  || die "post-install smoke: --help exited non-zero"

# --------------------------------------------------------------- guidance ---

log ""
log "installed."
log "  before:  $BEFORE_VERSION"
log "  after:   $AFTER_VERSION"
log ""
log "iterate: edit source, re-run this script. ~12s warm rebuild."
log ""
