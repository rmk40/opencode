# Plan: Local fork build → install over npm-managed `opencode`

## Goal

Compile the fork CLI from the current checkout (darwin-arm64, ~30s)
and overwrite the npm-managed `/opt/homebrew/bin/opencode` so the
running command is whatever the latest commit produces. No CI, no
tag, no npm publish.

## Background

`/opt/homebrew/bin/opencode` is a symlink that npm wrote when the
fork release was installed via `npm install -g @rmk40/opencode@aai
--registry=https://npm.pkg.github.com`. brew is not involved (the
brew package was uninstalled). The symlink points at
`/opt/homebrew/lib/node_modules/@rmk40/opencode/bin/opencode`.

`packages/opencode/script/build.ts` already:

- Reads `OPENCODE_VERSION`, `OPENCODE_CHANNEL`, `OPENCODE_REPO`,
  `OPENCODE_NPM_PACKAGE`, `OPENCODE_NPM_REGISTRY` from env and
  bakes them into the binary as build-time defines.
- Supports `--single` to filter `allTargets` to the host platform.
- Skips the GitHub release upload unless `OPENCODE_RELEASE` is set.

`packages/opencode/script/generate.ts` already:

- Fetches `https://models.dev/api.json` at build time.
- Honors an optional `MODELS_DEV_API_JSON=<path>` to use a captured
  snapshot instead.

So a single-target local build needs no new build-time code. The new
piece is a wrapper that exports the fork-shaped envs, runs the build,
and copies the resulting binary into place.

## Constraints

- darwin-arm64 only.
- No edits to `oc-wrapper.sh`, `oc-dev-wrapper.sh`,
  `script/fork-release-artifacts.sh`, `packages/opencode/script/build.ts`,
  or `package.json`. The new script is purely additive.
- AGENTS.md says docs/CI workflows should call `bun run release:fork
...`, not `script/build.ts` directly. This script is local-machine
  tooling, not docs/CI. Calling `build.ts` directly is the only way
  to skip the full-matrix validator that `release:fork build`
  enforces. The exception is documented in the script header.
- Must not interfere with running `opencode` processes — fail loud
  if the target file is in use rather than corrupting a live session.
- The replaced binary must continue to share `opencode-aai.db` with
  any other fork-shaped runs (oc, oc-dev, future released aai.N).

## Approach

1. **`script/oc-install-local.sh`** (new, executable). One-shot.
   Prints what it does, fails loud, exits non-zero on any step.

2. **Preflight** (before any work):
   - `command -v bun` on PATH.
   - Repo sanity: `$REPO/.git`, `$REPO/packages/opencode`, etc.
   - `$INSTALL_PATH = /opt/homebrew/bin/opencode` is writable by the
     invoking user (no `sudo`). If not, refuse with a clear message.
   - `which opencode` resolves to `$INSTALL_PATH`. If something else
     (a stray `~/.local/bin/opencode`, a `cargo install`'d copy,
     etc.) is shadowing it, refuse — overwriting `$INSTALL_PATH`
     would have no observable effect.
   - `lsof "$INSTALL_PATH"` returns empty, i.e. no running process
     currently holds the file open. macOS is forgiving about
     replacing a running executable, but a freshly forked child
     reading from the file mid-replace is a real corruption window.
     Refuse rather than risk it.

3. **Version derivation:**
   - Upstream version is read live from
     `packages/opencode/package.json`'s `"version"` field. After each
     upstream merge that bumps the baseline, the script picks up the
     new version automatically.
   - Short SHA from `git rev-parse --short=7 HEAD`.
   - Dirty check: `git diff --quiet HEAD` and `git diff --cached
--quiet HEAD`; if either is non-zero, append `.dirty`.
   - Final string: `<upstream>-aai.local.<sha>` (or
     `<upstream>-aai.local.<sha>.dirty`, e.g.
     `1.14.25-aai.local.7d4789e`). Dot-separated prerelease tag keeps
     the whole thing valid semver.

4. **Env setup** (all exported before invoking `build.ts`):

   ```
   OPENCODE_VERSION=<upstream>-aai.local.<sha>[.dirty]
   OPENCODE_CHANNEL=aai
   OPENCODE_REPO=rmk40/opencode
   OPENCODE_NPM_PACKAGE=@rmk40/opencode
   OPENCODE_NPM_REGISTRY=https://npm.pkg.github.com
   ```

   Defensively `unset OPENCODE_BUMP OPENCODE_RELEASE GH_REPO` so any
   leak from a prior CI shell or `release:fork` invocation can't
   change behavior. Skip pinning `MODELS_DEV_API_JSON` — `generate.ts`
   falls back to live fetch, which is fine for local rebuilds.

5. **Build:**
   - `bun run --cwd "$REPO/packages/opencode" script/build.ts --single`.
   - `--single` tells `build.ts` to filter `allTargets` to
     `process.platform === "darwin" && process.arch === "arm64"` and
     skip the baseline (avx2: false) variant. One target.
   - Output: `packages/opencode/dist/opencode-darwin-arm64/bin/opencode`.
   - Verify the file exists and is a `Mach-O 64-bit executable
arm64` via `file`. Fail loud otherwise.

6. **Install:**
   - `cp "$BUILT_BIN" "$INSTALL_PATH.new"` (same dir, so `mv` later
     is atomic on the same filesystem).
   - `chmod +x "$INSTALL_PATH.new"`.
   - `mv -f "$INSTALL_PATH.new" "$INSTALL_PATH"` (replaces the npm
     symlink with a real Mach-O binary). Atomic; safe even if a
     concurrent reader grabs the inode mid-mv (it gets the old one).
   - Note: this leaves the npm-tracked metadata at
     `/opt/homebrew/lib/node_modules/@rmk40/opencode/` untouched. To
     revert: `npm install -g @rmk40/opencode@aai
--registry=https://npm.pkg.github.com`.

7. **Post-install smoke:**
   - `"$INSTALL_PATH" --version` reports the expected
     `<upstream>-aai.local.<sha>` string. If not, fail loud.
   - `"$INSTALL_PATH" --help | head -5` runs without crash.
   - Print a 3-line summary: build time, before/after version, and a
     reminder that the npm metadata is now out of sync.

## What this does not do

- No watch/auto-rebuild. Re-run after each commit you want installed.
- No multi-target build. linux/x64, windows, darwin baseline are
  out — local box is darwin-arm64.
- No SHA256SUMS, no GitHub release, no npm package.
- No reverse-migration helper. `npm install -g @rmk40/opencode@aai
--registry=https://npm.pkg.github.com` is one line; not worth
  scripting.
- No symlink under `~/.local/bin`. The whole point is to overwrite
  the existing `opencode` so muscle memory keeps working.

## Risks

- **Concurrent running `opencode`.** macOS allows replacing a running
  executable's file (the running process keeps the old inode), but a
  child process spawned right after the swap reads the new file. If
  the user runs the install script while a long session is alive,
  the _current_ session keeps running fine; the _next_ session uses
  the rebuilt binary. The `lsof` preflight reduces but does not
  eliminate this. Acceptable for a personal dev tool.
- **`opencode upgrade` from local build.** Triggers `npm install -g
@rmk40/opencode@aai`, which re-symlinks the bin and overwrites the
  local binary. That is the intended revert path; don't run upgrade
  on a local build expecting it to "stay local."
- **npm metadata drift.** `npm ls -g @rmk40/opencode` will continue
  reporting whatever version was last `npm install -g`'d, while
  `opencode --version` reports the local build. The script's banner
  calls this out so the mismatch is not silent.
- **AGENTS.md guidance bypass.** Calling `script/build.ts` directly
  is explicitly discouraged for docs/workflows. This is local-machine
  tooling. Documented in the script header.
- **Stale models.dev embed.** Live-fetched at every build, so always
  fresh as long as `models.dev` is reachable. No caching layer to
  invalidate. If `models.dev` is down, build fails loud.
- **Hardcoded `/opt/homebrew/bin/opencode`.** If npm prefix changes
  later, this script silently installs the wrong place. Preflight
  catches it (`which opencode` would not match). Manual fix.

## Verification

- `which opencode` → `/opt/homebrew/bin/opencode` (unchanged).
- `file /opt/homebrew/bin/opencode` → `Mach-O 64-bit executable arm64`
  (was previously a `symbolic link`).
- `opencode --version` → `<upstream>-aai.local.<sha>` (with `.dirty`
  if the working tree is dirty at install time).
- `opencode --help | head -5` runs clean.
- An existing fork session (started under `oc` or the npm-installed
  binary) is still readable from the new binary, proving shared
  `opencode-aai.db`.
- After `npm install -g @rmk40/opencode@aai
--registry=https://npm.pkg.github.com`, `opencode --version`
  reverts to whatever's published on the `aai` dist-tag, and the
  install script can be re-run to overlay again.

## Out of scope

- npm prefix migration off `/opt/homebrew` (user explicitly declined).
- Multi-arch / cross-compilation.
- File watcher / auto-install on commit.
- README or AGENTS.md prose. Single-script personal tool; the
  script header is the doc.

## Revisions

(None yet — first version.)
