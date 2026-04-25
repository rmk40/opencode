#!/usr/bin/env bash
# oc-install-local.sh
#
# Compile the fork CLI from this checkout (darwin-arm64) and overwrite
# /opt/homebrew/bin/opencode with the result. Replaces the npm-managed
# symlink left over from `npm install -g @rmk40/opencode@aai` with a
# locally-built Mach-O binary versioned `1.14.24-aai.local.<sha>`.
#
# To revert: re-run
#   npm install -g @rmk40/opencode@aai \
#     --registry=https://npm.pkg.github.com
# which re-creates the symlink and pulls back the published artifact.
#
# AGENTS.md says docs/CI workflows should call `bun run release:fork
# ...` rather than invoking `script/build.ts` directly. This script is
# local-machine tooling, not docs/CI. Calling build.ts directly is the
# only way to skip the full-matrix validator inside `release:fork
# build`. Documented exception.
#
# See docs/plans/oc-install-local.md for the full design rationale.

set -euo pipefail

REPO="/Users/rmk/projects/oss/opencode"
OPENCODE_DIR="$REPO/packages/opencode"
INSTALL_PATH="/opt/homebrew/bin/opencode"
UPSTREAM_VERSION="1.14.24"

# ---------------------------------------------------------------- helpers ---

log() { printf '%s\n' "$*" >&2; }
err() { printf 'oc-install-local: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

# -------------------------------------------------------------- preflight ---

command -v bun >/dev/null 2>&1 || die "bun not found on PATH"
[[ -d "$REPO/.git" ]] || die "REPO=$REPO is not a git checkout"
[[ -d "$OPENCODE_DIR" ]] || die "opencode dir missing: $OPENCODE_DIR"

[[ -e "$INSTALL_PATH" ]] || die "$INSTALL_PATH does not exist; install \
@rmk40/opencode@aai via npm first, then re-run this script"

# Writability check. -w on a symlink follows to the target; the symlink's
# target lives in a user-owned npm tree under /opt/homebrew, so this
# should be true for the invoking user without sudo.
[[ -w "$INSTALL_PATH" ]] || die "$INSTALL_PATH is not writable; check ownership"

# Confirm `opencode` on PATH actually resolves to the file we plan to
# replace. If a different copy shadows it, replacing this one is a
# silent no-op.
RESOLVED="$(command -v opencode 2>/dev/null || true)"
if [[ "$RESOLVED" != "$INSTALL_PATH" ]]; then
  die "\`which opencode\` returns '$RESOLVED', not '$INSTALL_PATH'; PATH \
ordering means this install would have no effect"
fi

# Refuse to clobber a binary held open by a running process. `lsof`
# returns 0 with a list when the file has holders, 1 with empty stdout
# when there are none, and >1 only on tool failure (missing flag,
# permission error, etc.). Treat tool failure as fail-loud rather than
# silently fail-open — the preflight loses its purpose otherwise.
LSOF_STDERR="$(mktemp)"
trap 'rm -f "$LSOF_STDERR"' EXIT
# Single observation: capture both stdout and rc atomically. Splitting
# this into two calls would open a TOCTOU window where a holder
# appearing/disappearing between the two probes could mask a real
# conflict. `set +e` around the substitution is required because a
# top-level command substitution that returns non-zero (rc=1 on "no
# holders" is normal for lsof) would otherwise abort under `set -e`.
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

# ---------------------------------------------------------------- version ---

SHA="$(git -C "$REPO" rev-parse --short=7 HEAD 2>/dev/null)"
[[ -n "$SHA" ]] || die "could not resolve git HEAD"

DIRTY=""
if ! git -C "$REPO" diff --quiet --ignore-submodules HEAD 2>/dev/null \
   || ! git -C "$REPO" diff --cached --quiet --ignore-submodules HEAD 2>/dev/null; then
  DIRTY=".dirty"
fi

VERSION="${UPSTREAM_VERSION}-aai.local.${SHA}${DIRTY}"

# Show the current installed version *before* we overwrite it, so the
# banner can present a real before/after.
BEFORE_VERSION="$("$INSTALL_PATH" --version 2>/dev/null | head -1 || echo unknown)"

# ----------------------------------------------------------------- banner ---

log ""
log "oc-install-local"
log "  repo     $REPO"
log "  version  $VERSION  (was: $BEFORE_VERSION)"
log "  target   $INSTALL_PATH"
log ""
log "building (this takes ~30s)..."
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
# build.ts wipes packages/opencode/dist before running, so the previous
# matrix outputs are not preserved across local builds.
( cd "$OPENCODE_DIR" && exec bun run script/build.ts --single ) >&2

BUILT_BIN="$OPENCODE_DIR/dist/opencode-darwin-arm64/bin/opencode"
[[ -f "$BUILT_BIN" ]] || die "build did not produce $BUILT_BIN"

FILE_INFO="$(file -b "$BUILT_BIN" 2>/dev/null || echo unknown)"
if [[ "$FILE_INFO" != *"Mach-O"* ]] || [[ "$FILE_INFO" != *"arm64"* ]]; then
  die "$BUILT_BIN is not a Mach-O arm64 binary: $FILE_INFO"
fi

# Pre-clobber smoke: confirm the freshly-built binary self-reports the
# expected version BEFORE we overwrite the installed one. Catches the
# case where build.ts succeeded structurally but OPENCODE_VERSION was
# not properly baked in — without this, we'd replace the working
# install with a broken one and only fail the post-install smoke.
PRE_VERSION="$("$BUILT_BIN" --version 2>/dev/null | head -1 || echo unknown)"
if [[ "$PRE_VERSION" != *"$VERSION"* ]]; then
  die "pre-install smoke: built binary --version returned '$PRE_VERSION', expected '$VERSION' (refusing to overwrite working install)"
fi

# ---------------------------------------------------------------- install ---

# Stage in the same directory as the target so the final mv is atomic
# (rename(2) on the same filesystem). Falls back gracefully if a stale
# .new from a prior aborted run is present.
TMP_INSTALL="${INSTALL_PATH}.new.$$"
trap 'rm -f "$TMP_INSTALL"' EXIT

cp "$BUILT_BIN" "$TMP_INSTALL"
chmod +x "$TMP_INSTALL"
mv -f "$TMP_INSTALL" "$INSTALL_PATH"
trap - EXIT

# --------------------------------------------------------------- post-smoke ---

AFTER_VERSION="$("$INSTALL_PATH" --version 2>/dev/null | head -1 || echo unknown)"
if [[ "$AFTER_VERSION" != *"$VERSION"* ]]; then
  die "post-install smoke: --version returned '$AFTER_VERSION', expected '$VERSION'"
fi

# Check --help just runs without crashing; output not inspected.
"$INSTALL_PATH" --help >/dev/null 2>&1 \
  || die "post-install smoke: --help exited non-zero"

log ""
log "installed."
log "  before: $BEFORE_VERSION"
log "  after:  $AFTER_VERSION"
log ""
log "note: \`npm ls -g @rmk40/opencode\` still reports the previously"
log "installed npm version. \`opencode --version\` is the source of"
log "truth for what's actually running."
log ""
