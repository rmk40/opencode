# Plan: `oc-dev` — HMR-enabled source-mode dev wrapper

## Goal

Add a second wrapper script — `oc-dev` — that runs the opencode backend
from source on `:4096` **and** spawns a Vite dev server with full HMR
for `packages/app`, all in one foreground command. Pin the backend to
the same `opencode-aai.db` (via `OPENCODE_DB`) so live UI iteration
shares server-side session state with the brew binary's `aai` channel.
Note: `OPENCODE_CHANNEL` is a build-time `declare const` baked in by
`packages/opencode/script/build.ts`, **not** a runtime env var —
`InstallationChannel` is always `"local"` for source-mode runs
regardless of what the wrapper exports, so the runtime backend
"channel" is `local`, not `aai`. The shared DB is what actually keeps
state in sync. The SPA's UI-channel signal (`VITE_OPENCODE_CHANNEL`)
is set to `dev` because that controls SPA badge/feature-gate logic,
unrelated to the backend's notion of channel. Leave the existing `oc`
wrapper (production-shape, embedded/disk UI) untouched.

## Background

Today, `oc` (script/oc-wrapper.sh) launches the CLI in source mode and
points its catch-all UI route at a freshly-stamped `packages/app/dist`.
Every UI edit therefore triggers a full `vite build` on the next launch,
and there is no live reload — the dist is static and served by Hono
under `UIRoutes`. This is the right shape for testing the
production-equivalent embedded asset path, but it is the wrong shape
for iteration.

The upstream-blessed dev flow described in `packages/app/AGENTS.md`
(backend on `:4096`, `bun --cwd packages/app dev` separately, with
Vite injecting `VITE_OPENCODE_SERVER_HOST`/`VITE_OPENCODE_SERVER_PORT`
so the SPA points back at the API) is supported by the codebase but
not packaged into a single fork-shaped command. CORS already accepts
any `http://127.0.0.1:*` origin (see
`packages/opencode/src/server/middleware.ts:74`), so no server-side
changes are required.

## Constraints

- Read-only on the existing `oc` flow: `script/oc-wrapper.sh`,
  `script/opencode-dev-preload.ts`, and `packages/opencode/src/server/routes/ui.ts`
  stay as-is. The current `oc` keeps its stamp-cached `vite build`
  behavior for production-shape testing.
- No changes to `packages/app/vite.config.ts` defaults (its declared
  port stays `3000`); the dev wrapper resolves a port at runtime and
  passes it to Vite via `--port`.
- CORS already accepts `http://127.0.0.1:*` and `http://localhost:*` —
  no server changes needed.
- Same `OPENCODE_DB=opencode-aai.db`, same `OPENCODE_CHANNEL=aai`,
  identical user-PWD semantics via the existing preload shim.
- Do not touch the long-running `bun … src/index.ts --hostname 0.0.0.0
-c` process owned by the user during execution. The new wrapper
  spawns its own children and does not interfere.
- Do not push to `fork` until manually authorized.

## Approach

1. **`script/oc-dev-wrapper.sh`** (new) — sibling to `oc-wrapper.sh`.
   Resolves a Vite port (default `40960`, falling back to the next free
   port if taken; honors `OC_DEV_VITE_PORT` override). Exports
   `VITE_OPENCODE_SERVER_HOST=127.0.0.1`,
   `VITE_OPENCODE_SERVER_PORT=4096`, and `VITE_OPENCODE_CHANNEL=dev`,
   then spawns:
   - **Child A — backend:**
     `bun --cwd "$REPO/packages/opencode" --conditions=browser
  --preload "$REPO/script/opencode-dev-preload.ts"
  "$REPO/packages/opencode/src/index.ts" serve
  --port 4096 --hostname 127.0.0.1`.
     All paths absolute (relative `--preload` would resolve against
     `--cwd` and miss the file). Inherits `OPENCODE_DB=opencode-aai.db`
     and `OPENCODE_USER_PWD=$PWD`. (`OPENCODE_CHANNEL` is exported
     too for parity with `oc-wrapper.sh` and any future code that
     reads it via `process.env`, but it does nothing for
     `InstallationChannel`, which is build-time only — see Goal.)
     **Does not export `OPENCODE_WEB_UI_DIR`** — UI traffic is
     supposed to go to Vite, not to a stale dist served by Hono.
     The preload shim is not optional: without it, `serve` falls
     back to its own `process.cwd()` (= `packages/opencode`) for
     project resolution instead of the user's launch directory.
     `--conditions=browser` is kept because upstream's own
     `packages/app/AGENTS.md:9` documents `bun run
--conditions=browser ./src/index.ts serve` as the supported
     headless invocation.

   - **Child B — Vite:**
     `bun --cwd "$REPO/packages/app" run dev -- --port <resolved>
--strictPort`. `bun run dev` invokes the workspace-pinned
     `vite` declared in `packages/app/package.json:14`; the args
     after `--` are forwarded to vite directly (matching upstream's
     documented `bun dev` invocation in `packages/app/AGENTS.md:10`
     and avoiding `bun x`'s npm-fallback resolution path).
     `--strictPort` ensures Vite exits non-zero on bind collision
     instead of silently hopping ports — the wrapper's banner stays
     accurate. Inherits the `VITE_*` env so Vite injects them at
     build time and the SPA's `getCurrentUrl()` (in
     `packages/app/src/entry.tsx:101`) points back at the API.

   - Banner to stderr: short SHA + `+dirty` marker, both URLs
     (`API http://127.0.0.1:4096`, `UI  http://127.0.0.1:<port>`),
     channel info (`backend channel=aai`, `frontend channel=dev` —
     the SPA reads `VITE_OPENCODE_CHANNEL` for badge/feature gates
     in `packages/app/src/components/titlebar.tsx`; the backend
     channel is unrelated and stays `aai` so DB/release behavior
     matches `oc`), the resolved DB path, and a one-line "press
     Ctrl-C to stop both."

2. **Lifecycle plumbing in the wrapper:**
   - Spawn each child as a background job and capture its real PID
     (`spawn …; pid=$!`) **without** piping through a prefixer. A
     prefixed pipeline (`spawn … | sed -u 's/^/[api] /'`) makes `$!`
     point at the prefixer, not the child, which breaks signal
     forwarding and exit-code propagation. Start the wrapper without
     prefixers; revisit only if interleaved output proves unreadable.
   - **Reaper detection:** macOS ships `bash` 3.2 by default, which
     **does not** support `wait -n`. The wrapper does not rely on
     `wait -n`. Instead, immediately after spawning each child it
     forks a per-child watcher subshell:
     `( wait $api_pid; exit_code=$?; echo "api $exit_code" >&3 ) &`
     where `>&3` is a named-pipe FIFO opened by the wrapper. The
     main loop then `read`s one line from the FIFO, which unblocks
     the moment **either** child dies. The reaper then runs the
     trap handler, kills the surviving sibling, and exits with the
     dead child's exit code. This is portable to bash 3.2.
   - **Trap handler:** `SIGINT`, `SIGTERM`, and `EXIT` all route
     through one idempotent function. It first clears its own trap
     (so re-entry via the EXIT trap after a SIGINT handler returns
     cannot double-kill), sends `TERM` to both PIDs, sleeps briefly,
     sends `KILL` to anything still alive, then `wait`s on both and
     exits. Safe under double signals.
   - **Grandchild reaping:** macOS does not ship `setsid(1)` by
     default (verified — `setsid` is gnu coreutils, only available
     via Homebrew as `gsetsid`). Without process-group isolation,
     grandchildren spawned by Vite (esbuild service, dep-optimizer
     workers) can outlive a `kill` against the Vite PID alone.
     Mitigation: during cleanup, `pkill -P <vite_pid>` to catch
     direct grandchildren, then `pkill -f "esbuild.*$REPO"` to
     scope by repo path and catch any forked esbuild workers.
     Verification step: after Ctrl-C, confirm `pgrep -f esbuild`
     reports zero in this repo.

3. **Port resolution in the wrapper:**
   - **API port (`:4096`):** probed before any spawn. If
     `lsof -nP -iTCP:4096 -sTCP:LISTEN` shows a listener, fail loud
     with that listener's command line and exit non-zero. This is
     the most likely real-world failure mode: the user already has
     a long-running source-mode `bun ... src/index.ts` on `:4096`
     (or the brew binary on `:4096`). The wrapper hardcodes the
     backend port to match the SPA's
     `VITE_OPENCODE_SERVER_PORT=4096`; making it configurable
     defeats the muscle-memory reason `oc-dev` exists. The plan is
     to detect-and-abort, not to retry.
   - **Vite port:**
     - If `OC_DEV_VITE_PORT` is set: validate it parses as an
       integer in `[1024, 65535]`. If valid and **free**, use it.
       If valid and **taken**, fail loud — print the offending
       listener (`lsof -nP -iTCP:<n> -sTCP:LISTEN`) and exit
       non-zero. The user pinned a port; silently moving off it
       would break browser bookmarks and contradict the entire
       reason to set the override.
     - If `OC_DEV_VITE_PORT` is unset: start at `40960` and
       increment until a free port is found, capped at 20 attempts.
       Report the resolved port in the banner.
   - Free-port test: `lsof -nP -iTCP:<p> -sTCP:LISTEN` returning
     non-zero with empty stdout means "free at probe time." Avoid
     `nc -z` because its exit code semantics differ across Netcat
     implementations.
   - **TOCTOU acknowledgement:** the probe-vs-bind race is real but
     short for both ports. The wrapper passes `--strictPort` to
     Vite so a lost race surfaces as a Vite bind failure within
     ~100ms; the API child fails the same way (Bun's HTTP server
     surfaces `EADDRINUSE` immediately). The reaper notices the
     dead child via the watcher-FIFO, kills the surviving sibling,
     and exits non-zero. Recovery is "rerun." Acceptable on a
     personal dev box; not acceptable for CI but this is not CI.

4. **Symlink:** `~/.local/bin/oc-dev` → `script/oc-dev-wrapper.sh`.
   Keeps `oc` (prod-shape) and `oc-dev` (HMR-shape) as two distinct,
   unambiguous commands.

5. **Documentation:** add a short "Local development" section to
   `AGENTS.md`'s fork section explaining the two-command split and the
   port-resolution behavior. Plan-only for now; will be drafted at
   execution time per Rule 4.

## Why two wrappers, not one with a flag

- Failure modes diverge. `oc` runs one child (the CLI). `oc-dev` runs
  two children with a kill-the-sibling-on-exit invariant. Conflating
  them in one script means more conditional plumbing for no muscle-
  memory savings.
- `oc` is for production-shaped artifacts. `oc-dev` is explicitly an
  HMR experience. The mental model that survives a year is "same name,
  same shape." A `--dev` flag would require remembering which shape
  `oc` is currently in.
- `oc` already mutates `packages/app/dist/.oc-source-stamp` and runs
  `vite build` opportunistically. `oc-dev` does not touch dist at all.
  Zero shared state between the two.

## What `oc-dev` does **not** do

- No reverse-proxy of Vite into `:4096` (single-port mode rejected).
- No second DB. Same `opencode-aai.db` as `oc` and the brew binary.
- No watch-rebuild of the embedded asset bundle. To test the embedded
  path, run `oc` instead.
- No automatic browser open. The banner prints the URL.
- No TUI HMR. The TUI/CLI restarts on edits the same way as today
  (re-run the wrapper).

## Risks

- **Vite + workspace HMR:** edits to `packages/ui` are consumed via
  the workspace `exports` map. Vite resolves them as source `.tsx`,
  so `vite-plugin-solid` HMR should apply. If `optimizeDeps`
  inadvertently pre-bundles `@opencode-ai/ui`, HMR breaks for that
  package. Mitigation: if encountered during smoke, add
  `optimizeDeps.exclude: ["@opencode-ai/ui"]` to `vite.config.ts`.
  Plan-only for now; only added if observed.
- **Port hopping:** if the chosen port changes between runs because
  `40960` is taken, browser bookmarks go stale. Mitigation:
  `OC_DEV_VITE_PORT=40960` in shell rc pins it; banner makes the
  resolved port explicit on every run.
- **CSP applies only to `UIRoutes`-served HTML.** `routes/ui.ts`
  attaches `DEFAULT_CSP` on three paths: the static-file branch
  (line 28) and both 503 fallbacks (lines 53, 76). In dev the SPA
  is served by Vite on a different port, so no SPA HTML response
  comes from `UIRoutes`. Vite's own `index.html` carries no CSP and
  the inline-eval that HMR depends on works. The earlier "CSP only
  on the static path" framing was loose — there are three CSP
  attach points in that file, but none of them are reached when the
  SPA loads from Vite.
- **`auth_token` query string is visible in dev tooling.** If the
  user's shell exports `OPENCODE_SERVER_PASSWORD`, the SPA's
  WebSocket reconnect (`packages/app/src/components/terminal.tsx:516–517`)
  bakes `Basic <base64(user:pw)>` into the WebSocket URL via
  `?auth_token=`. WebSocket URLs do not enter the browser address
  bar or top-level navigation history, but they are visible in
  DevTools' Network panel, in any logging proxy, and in shell-side
  process listings of curl-style debugging. In production this is
  generally invisible (URL stays inside the embedded SPA's WS
  client); in dev with DevTools open it is plainly readable.
  Recommendation when using `oc-dev`: avoid exporting
  `OPENCODE_SERVER_PASSWORD` unless you accept the credential
  appearing in your local DevTools session. The wrapper does not
  unset it for you because doing so silently changes the security
  posture vs. `oc`.
- **Vite HMR socket vs. SPA data sockets.** Vite's HMR WebSocket
  binds to its own port at the root path. The SPA's data sockets
  (SSE on `/event`, WebSocket on `/session/*`, terminal pty WS) all
  target `:4096`. Different origins, no path collision possible.
- **localStorage is origin-scoped.** The dev SPA runs at
  `http://127.0.0.1:<vite-port>` while `oc` and the brew binary
  serve the SPA at `http://127.0.0.1:4096`. The two origins do not
  share `localStorage`, `sessionStorage`, or IndexedDB. (Cookies
  are **not** strictly origin-scoped — RFC 6265 ignores port for
  cookie matching — but opencode does not use cookies for auth or
  state, so this distinction is moot in practice.) The shared
  `opencode-aai.db` keeps server-side session state in sync, but
  UI preferences (theme, default server URL, `displayedServers`
  list, browser permission grants like Notification, etc.) live
  in browser storage and will drift between `oc-dev` and `oc`
  until manually synced. Out of scope to fix here; just be aware.
- **Two children, one terminal:** prefixers might mangle Solid's HMR
  overlay or backend color output. Cheap to undo if it bites.
- **Preload shim:** required, not optional. `bun --cwd
packages/opencode` makes `process.cwd()` = `packages/opencode`,
  and `serve` resolves the project directory from `process.cwd()`
  when no explicit directory is supplied. Without the preload,
  config discovery, MCP server CWDs, and `.opencode/`-style lookups
  would all walk up from `packages/opencode` instead of the user's
  launch directory.

## Verification

- `lsof -nP -iTCP:4096 -sTCP:LISTEN` shows the bun backend child;
  `lsof -nP -iTCP:<resolved-port> -sTCP:LISTEN` shows Vite.
- `curl -sS http://127.0.0.1:4096/global/health` returns
  `{"healthy":true,"version":"<x.y.z>"}` (with auth if set).
  Confirmed against `packages/opencode/src/server/routes/global.ts:93`.
- `curl -sS http://127.0.0.1:<port>/` returns Vite-injected HTML
  containing `/@vite/client` and an `import.meta.env.DEV` bundle.
- Open the Vite URL; confirm the SPA hits `:4096` for `/event`,
  `/session/*`, etc. via the network tab.
- Edit `packages/app/src/pages/session/composer/session-question-dock.tsx`
  (or any leaf component); confirm the change appears without a full
  reload (Solid HMR overlay or no reload).
- Edit `packages/ui/src/components/<x>.tsx`; confirm same.
- Ctrl-C: both children exit cleanly within ~1s; no orphaned
  Vite/bun.
- Kill the bun backend manually (e.g. `kill <pid>`); the wrapper
  notices and exits, taking Vite with it.
- Run `oc` (the existing wrapper) afterwards: confirm it still
  rebuilds dist on the next stamp miss and serves the embedded path
  on `:4096`. (No need to check shell-env poisoning — exports in a
  child process cannot mutate the parent shell.)
- After Ctrl-C: `pgrep -f esbuild | xargs -I{} ps -p {} -o command`
  reports zero esbuild workers from this repo; `lsof -nP -iTCP:4096
-sTCP:LISTEN` and `lsof -nP -iTCP:<vite-port> -sTCP:LISTEN` both
  empty.

## Out of scope

- TUI HMR (would require restructuring the OpenTUI render loop;
  separate plan if ever pursued).
- A native `oc dev` subcommand inside the opencode CLI (versus a shell
  wrapper). Possible future cleanup, but adds maintenance surface for
  no functional gain right now.
- Reverse-proxying Vite through the API (single-port mode).
- An incremental-build fallback (`vite build --watch`). Not needed
  once HMR works; documented backup only.
- Updating `oc` itself.

## Revisions

- v4 (post-implementation): discovered during smoke testing that
  `bun --cwd <path> run <script> --some-flag` (Bun 1.3.13) consumes
  `--some-flag` as a top-level Bun flag rather than forwarding it
  to the script — even with `--` separator. This breaks the Vite
  invocation entirely. Workaround in the wrapper: `( cd "$APP_DIR"
&& exec bun run dev --port "$VITE_PORT" --strictPort ) &`.
  Subshell-cd avoids `--cwd` entirely. Also discovered that bash
  3.2 doesn't reliably deliver SIGINT to backgrounded scripts (a
  smoke-testing artifact, not a wrapper bug — Ctrl-C from a real
  terminal targets the foreground process group). Verified via pty
  test that Ctrl-C cleanly tears down both children. Reaper switched
  from a FIFO-based approach to a simple poll loop (`kill -0` at
  200ms cadence) because FIFO `read` is also signal-fragile in bash
  3.2. Trap split: `INT/TERM` handler exits 130; `EXIT` is a safety
  net.

- v3 (post-second-dual-review): corrected the Goal to acknowledge
  `OPENCODE_CHANNEL` is build-time only — source-mode runs are
  always `InstallationChannel === "local"` regardless of what the
  wrapper exports, so only `OPENCODE_DB` actually pins shared
  state; specified the reaper detection mechanism (per-child
  watcher subshells writing to a FIFO, since macOS bash 3.2 lacks
  `wait -n`); added an explicit pre-spawn probe of `:4096` with
  fail-loud-on-collision (catches the user's existing long-running
  backend); switched the Vite invocation from `bun x vite` to
  `bun --cwd packages/app run dev -- --port <n> --strictPort`,
  matching upstream `AGENTS.md` and avoiding `bun x`'s npm-fallback
  resolution path; promoted the `--conditions=browser` flag from
  "verify at smoke time" to "kept because upstream documents it";
  dropped "cookies" from the localStorage drift list (RFC 6265
  ignores port for cookie scope) and added a note that opencode
  doesn't use cookies anyway; toned down the `auth_token` risk
  (WebSocket URLs don't enter the address bar) but kept the
  DevTools/proxy-visibility warning; tightened the grandchild
  reaping plan with concrete `pkill` invocations; removed the
  no-op "shell-env not poisoned" verification step and replaced
  it with concrete post-Ctrl-C process and port checks.

- v2 (post-dual-review): fixed the `/global/health` response shape
  (`{ healthy, version }`, not `{ ok }`); reworded CSP risk to
  reflect all three attach points in `routes/ui.ts`; switched the
  Vite invocation to `bun x vite --port <n> --strictPort` and made
  all backend paths absolute; tightened the auth-token risk to
  call out browser-history exposure; clarified Vite-HMR vs SPA
  data-socket separation; added origin-scoped localStorage/cookie
  drift to risks; documented signal-handler idempotency, prefixer
  TOCTOU, and grandchild reaping; flipped `OC_DEV_VITE_PORT` from
  "preference with fallback" to "pin or fail loud"; pinned the
  `aai`-vs-`dev` channel split (backend stays `aai`, frontend
  badge is `dev`); upgraded the preload shim from "harmless
  parity" to "required for project-cwd resolution under `serve`."
