# WebUI-Plus → opencode (actualyze) Port Gap Analysis

## Summary

- **38 distinct UI gaps identified** across 21 files plus root HTML/manifest.
- **Severity breakdown**
  - **Major (whole feature missing)**: 7
    1. Mobile session/changes pill (segmented control) portaled into titlebar center
    2. Mobile refresh button + reconnecting spinner in session header
    3. `globalSDK.event.restart()` + `reconnecting` signal + `isTouchDevice` reconnect strategy
    4. iOS PWA viewport / safe-area / standalone mode handling (CSS + `index.html` meta + manifest)
    5. Mobile dashboard rework (compact list rows, header→toolbar collapse, search/sort/server moved into titlebar slots)
    6. Force-sync ancillary reconciliation on `sync.session.sync(..., {force:true})` (`session_status` + `todo` + `diff`)
    7. Visibility-change + reconnect-edge force-resync wiring on touch devices
  - **Moderate (feature partially missing)**: 14
  - **Minor (polish/styling)**: 17

The bulk of missing work is the **mobile / iOS PWA hardening track** — 30+ commits on `web-fork` between `d89b2cc1e` and `e64377ca5` that landed after the dashboard/status-provider commit (`49b25ae67`) which is the last upstream-shaped commit shared with `actualyze`.

## Methodology

- Compared `opencode-webui-plus@web-fork` (HEAD `e64377ca5`) against `opencode@actualyze` (HEAD `4f7a8317b`).
- File-level diff with `diff -rq` over `packages/app/src` and `packages/ui/src`.
- File-content diff for every differing file, reading both directions to distinguish:
  - "plus has, current lacks" (true gap)
  - "current has, plus lacks" (current is on a newer upstream — not a gap)
- Cross-referenced with `git log` on both repos to determine direction of each delta.
- Walked the last 72 commits on `web-fork` that touched `packages/app` or `packages/ui` since the shared baseline (`33b2795cc chore: generate`) and classified each as landed / not-landed / out-of-scope.
- Excluded per scope: `packages/opencode/src`, `plus/`, build/CI, Tauri/desktop except where it surfaces UI, docs, tests-only.

The current `actualyze` is on a **newer upstream** than `web-fork` for several files (e.g. `packages/ui/src/components/session-turn.tsx` carries upstream `91468fe45` parentID matching, `session-review.tsx` carries upstream `febadc558`, `prompt-input.tsx` carries `4712f0f3c` shell-mode UI + `f033d2d8f` conditional variant selector, `settings.tsx`/`settings-general.tsx` carry `811a7e9a8` show-progress-bar setting, `dialog-edit-project.tsx` carries `06066dbb7`+`d884ab73d` icon-source consolidation). Those are explicitly **not** gaps and have been excluded from the gap list below.

## Gaps by Category

### A. Files present in webui-plus, absent in current opencode

**None.** Every `.tsx`/`.ts`/`.css` file under `packages/app/src` and `packages/ui/src` in `web-fork` exists in `actualyze`. The asymmetric files (`dashboard-helpers.ts`, `use-dock-max-height.ts`, `dashboard.test.ts`, `project-status.test.ts`, `vite-config.test.ts`) all flow the other way — they exist only in `actualyze` (newer upstream factoring) and are not gaps.

All gaps are **inside** files that exist on both sides.

### B. Features stripped from files that exist in both

For each entry: **file** · **what plus has** · **what current lacks** · severity · restoration complexity.

#### B1. `packages/app/src/components/titlebar.tsx` — iOS PWA safe-area + center portal hardening — **PORTED** (commit 8)

- **Plus**: titlebar reserves room for iOS status bar in PWA standalone mode via `padding-top: env(safe-area-inset-top)` + `height: calc(env(safe-area-inset-top) + 2.5rem)`; forces a stacking context with `relative z-30 isolate` so iOS Safari's translucent status-bar overlay never paints over titlebar grid items; column order is `[auto_minmax(0,1fr)_auto]` (left/center/right reserved correctly); center mount is a single flat element with `touch-action: manipulation` and a single `overflow-hidden` boundary — no nested `pointer-events-none → pointer-events-auto` pair.
- **Current**: `h-10`, no safe-area padding, no stacking context guarantees, column order is `[minmax(0,1fr)_auto_minmax(0,1fr)]`, center mount is wrapped in a `pointer-events-none → pointer-events-auto` pair that (per the plus commit message) corrupts iOS WKWebView hit-testing in PWA standalone mode after pill width mutates.
- **Why this matters**: Without these changes the iOS PWA mode (a) overlaps content under the translucent status bar, (b) bricks the titlebar after a single tap on the mobile session/changes pill until the app is force-quit.
- **Severity**: Major. **Restoration**: small (single file, ~20 lines, no new deps).

#### B2. `packages/app/src/components/session/session-header.tsx` — mobile refresh button + reconnect indicator

- **Plus**: imports `createMediaQuery` and `useGlobalSDK`; computes `isMobile = (max-width: 767px)` and `isMd = (min-width: 768px)`; defines `refresh()` that calls `sync.session.sync(id, { force: true })` and `globalSDK.event.restart()`; renders a tooltip-wrapped ghost button at mobile widths that swaps between an `Icon name="reset"` and a `Spinner` based on `globalSDK.event.reconnecting()`; the search input is `isMd()`-gated for the center mount; titlebar mount lookups are read **synchronously** during render with `onMount` only as fallback (avoids one-frame layout shift).
- **Current**: no refresh button, no `useGlobalSDK` import, no mobile-vs-desktop split, mount lookups are signal-only inside `onMount` (one-frame flicker), search portal is unconditionally mounted.
- **Why this matters**: Mobile users have no way to recover from a backgrounded SSE stream that didn't auto-reconnect, and they get no visual signal that a reconnect is in progress. The mount layout shift was a deliberate fix.
- **Severity**: Major. **Restoration**: small. Depends on `Spinner` (already imported in current header), `createMediaQuery` (already a dep), `useGlobalSDK` (B3 must land first). **PORTED** (commit 12).

#### B3. `packages/app/src/context/global-sdk.tsx` — `reconnecting` signal, `restart()`, `isTouchDevice` strategy — **PORTED** (commit 10)

- **Plus**: detects `isTouchDevice` via `matchMedia("(pointer: coarse)")`; exposes `reconnecting` signal that flips true on `attempt.abort()` and false on a successful subscribe; exposes `restart()` that aborts the current attempt to force the outer reconnect loop to fire immediately; on `visibilitychange` to visible, touch devices unconditionally call `restart()` (instead of relying on `lastEventAt` heartbeat which lags because mobile JS timers pause when backgrounded). Returns `{ ..., restart, reconnecting, isTouchDevice }`.
- **Current**: only `aborts` on visibilitychange, no `reconnecting`, no `restart()`, no `isTouchDevice` short-circuit.
- **Why this matters**: This is the keystone of the mobile reliability story. The pill, the refresh button, the visibilitychange resync in `pages/session.tsx`, the reconnect-edge resync — all of them call into one or more of these three exports.
- **Severity**: Major. **Restoration**: small (single file, ~30 lines added; no new deps; no API consumer changes if added additively).

#### B4. `packages/app/src/context/sync.tsx` — force-refresh ancillary reconciliation — **PORTED** (commit 11)

- **Plus**: when `sync.session.sync(id, { force: true })` is called, in addition to the session + messages reload it also issues `client.session.status()`, `client.session.diff({sessionID})`, and `client.session.todo({sessionID})`, wrapped in `Promise.allSettled` so a transient diff failure on a large session does not fail the whole resync. Each result is reconciled into the matching store (`session_status`, `session_diff`, `todo`).
- **Current**: only re-fetches session + messages.
- **Why this matters**: Without this, a refresh button or visibilitychange resync on mobile leaves the "Thinking" indicator and stop button stuck on a session that the server already finished, until the user types something. Status/todo/diff events were dropped while the tab was backgrounded.
- **Severity**: Major. **Restoration**: small (additive inside the existing `force` branch; no new deps).

#### B5. `packages/app/src/pages/session.tsx` — mobile session/changes pill portaled to titlebar — **PORTED** (commit 13)

- **Plus**: imports `Portal` from `solid-js/web`; reads titlebar center mount synchronously (`document.getElementById("opencode-titlebar-center")` at module-evaluation time) with `onMount` fallback; renders a custom segmented-control pill (`<button>+<button>` with intentional `touch-action: manipulation`, ~40px tap targets, `select-none`, intentional separator div) **inside** `<Portal mount={titlebarCenter()}>`. The "Changes" label is intentionally **static** (not toggling to "N Files Changed") — per the in-source comment that's the commit `f4a78a87f` fix that prevents iOS PWA hit-test corruption from in-place width mutation. The file count is shown in the review pane header instead.
- **Plus also**: registers a `visibilitychange → forceSync` listener gated on `globalSDK.event.isTouchDevice`; registers a `createEffect(on(reconnecting))` that fires `forceSync` on the true→false edge (rate-limited to 1/800ms) — catches invisible reconnects (laptop sleep, flaky network, server restart) that don't coincide with visibilitychange.
- **Plus also**: `<Show when={isDesktop() && !size.active() && !ui.reviewSnap}>` — guards a conditional that previously was unconditional, which kept some desktop-only chrome from rendering on mobile.
- **Plus also**: changes-selector wrapper now has a sibling `<Show when={hasReview()}>` showing the "{n} Files Changed" text next to the dropdown.
- **Current**: uses the upstream `<Tabs>` component (`@opencode-ai/ui/tabs`) instead of a portaled segmented control; tabs render in normal layout, not in the titlebar; **no** Portal logic, **no** mobile visibilitychange resync, **no** reconnect-edge resync.
- **Why this matters**: The portaled pill is the headline mobile UX feature ("session view enhancements to the top bar with pill type selectors" — the user's quoted concern). Without it, mobile users get a normal-layout `<Tabs>` row that consumes vertical space below the titlebar instead of a compact segmented pill that lives where iOS expects header chrome.
- **Severity**: Major. **Restoration**: medium. Hard dependency on B1 (titlebar mount + safe-area), B3 (reconnecting/restart/isTouchDevice). Watch the i18n note: do not toggle the "Changes" label on mobile (intentional static label per `f4a78a87f`).

#### B6. `packages/app/src/pages/layout.tsx` — desktop dashboard "Open projects" sidebar list — **PORTED** (commit 14)

- **Plus**: when on `/` with projects open in the sidebar (`!params.dir && !panelProps.mobile && layout.projects.list().length > 0`), the sidebar shows an "Open projects" panel listing all open projects with name + truncated path that opens that project on click. Wrapped in a `<Switch>` with the empty state as the other branch.
- **Plus also**: removed `<DebugBar />` from the persistent layout (commit `f49909844 fix: remove dev debug bar overlay`); deletes the unused `DebugBar` import. **PORTED** (commit 7).
- **Plus also**: extra comment/guard "Don't autoselect when on the dashboard (/) — let user browse projects manually".
- **Plus also**: uses `platform.update!() + platform.restart!()` (two-call shape); current uses a single `platform.updateAndRestart!()` because `platform.tsx` was consolidated upstream — this is a current-is-newer pattern, **not** a gap (already current).
- **Current**: empty-state branch only — no "Open projects" panel for desktop dashboard. `DebugBar` is mounted in dev.
- **Why this matters**: The desktop dashboard ergonomics — being able to glance at open projects from the sidebar without leaving the dashboard — is missing. The DebugBar removal is intentional cleanup.
- **Severity**: Moderate (sidebar panel). Minor (DebugBar). **Restoration**: small for both.

#### B7. `packages/app/src/components/prompt-input.tsx` — placeholder latch + buttons-inline-with-text layout

Substantial divergence here. `actualyze` is on the **newer upstream** for most of this file (shell-mode UI with cancel button + custom icon + example placeholder from `4712f0f3c`, conditional variant selector from `f033d2d8f`, prompt-input animation cleanup from `8cc2c81d5`). The genuine gaps from plus that did not transfer:

- **`hasUserPrompt` placeholder latch (commit `21f6c28c9`)** — **PORTED** (commit 6). plus latches `hasUserPrompt` to true once it's been true for the current session and pins until the session id changes. The current memo recomputes from scratch on every dep tick and can transiently flip back to false during SSE updates, flashing the placeholder back to the cycling example for one frame.
- **Inline +/send buttons (commit `0842f5ead`)** — **PORTED** (commit 18). plus puts the `+` button, the textarea, and the send button on the **same horizontal row** with `flex items-center gap-1 px-2 py-2` — vertically centered, no absolute positioning, no fade gradient.
- **`pb-1.5`/`pt-4` mobile spacing (commit `11ddf8f5e`)** — **PORTED** (commit 18). plus has tightened spacing on the mode strip (`pt-4 pb-1.5` vs current `pt-5.5 pb-2`).
- **Why this matters**: The latch fixes a real visible flicker during streaming. The inline buttons are the mobile-first input layout. The padding diffs are minor but part of the polished mobile feel.
- **Severity**: Moderate (latch is a real bug fix; inline buttons are a layout regression on mobile). **Restoration**: small for the latch (5-line memo change). Medium for the layout (touches the rest of the prompt input markup; needs care against the upstream shell-mode + variant-selector additions that current already has).

#### B8. `packages/app/src/index.css` — calmer progress, content-visibility gate, iOS PWA viewport, mobile bash mask — **PORTED** (PWA viewport in commit 9; calmer progress + content-visibility gate in commit 15). Note: current keeps `@keyframes fade-in` because prompt-input still uses it (upstream divergence — plus removed it). The `session-turn-cv-eligible` class is added in commit 17 (message-timeline).

- **Plus**: renames `session-progress-whip` → `session-progress-glide` with new keyframes (narrow segment slides instead of full-width whip), default duration `2400ms` not `1800ms`, opacity `0.75` not `1`. Adds a `@media (max-width: 767px)` block that shrinks the bar to `1.5px / opacity 0.6` on mobile.
- **Plus**: replaces upstream's `fade-in` keyframes with a `@media (hover: hover) and (pointer: fine)` gate on `.session-turn-cv-eligible { content-visibility: auto; contain-intrinsic-size: auto 500px; }` — disables the perf optimization on touch-primary devices (iOS Safari) where it produces visible blank regions during fast scroll.
- **Plus**: appends a top-level `@media all and (display-mode: standalone) { #root { height: 100lvh; } }` rule (intentionally **outside** `@layer components`, with extensive comment explaining why) so the iOS PWA root is the actual full screen, not viewport-minus-(non-existent-)urlbar.
- **Current**: still on `session-progress-whip`, no content-visibility gate, no PWA height override.
- **Why this matters**: progress bar feels frantic on mobile; iOS PWA leaves a ~47px gap at the bottom; iOS Safari shows blank turn-placeholders during scroll/streaming.
- **Severity**: Moderate (PWA height is a real visual bug). Minor (progress polish, content-visibility tradeoff). **Restoration**: small. Note current opencode also has `8cc2c81d5`'s prompt-input animation cleanup — confirm `fade-in` keyframes are still referenced before removing them.

#### B9. `packages/ui/src/components/message-part.css` + `message-part.tsx` — mobile bash output cap with fade — **PORTED** (commit 16; bash mask + scroll-state plumbing only — current keeps its newer `--permission-prompt-max-height` CSS var, which plus reverted)

- **Plus** (`message-part.css`): adds a `@media (max-width: 767px) { max-height: 60vh; ... mask-image: linear-gradient(to bottom, black calc(100% - 16px), transparent) }` block on the bash scroll container, gated on `data-overflow="true"` and `data-at-bottom="false"` data attrs.
- **Plus** (`message-part.tsx`): wires up the data attrs imperatively via a ref signal + `createResizeObserver` + scroll listener that updates `data-overflow` and `data-at-bottom` as content streams (commit chain `ec2d07a55`/`562984401`/`3f6f413ca`). The ref is held in a signal — not a plain variable — because the bash output is wrapped in a Kobalte `Collapsible.Content` that unmounts its subtree while collapsed; collapsible default-collapsed (`shellToolPartsExpanded false`) means the element does not exist at `onMount` time.
- **Plus** (`message-part.css`): wires `--permission-prompt-max-height` CSS var (consumed by `session-permission-dock.tsx` via `useDockMaxHeight` — that file already exists in current as an extracted helper, but the CSS var override is missing).
- **Current**: no mobile cap, no fade indicator, no `data-overflow`/`data-at-bottom` plumbing, hardcoded `max-height: 100dvh` for permission dock.
- **Why this matters**: Long bash output on mobile relayouts the whole timeline on every stream chunk and reads as "the screen clears before being repopulated".
- **Severity**: Moderate. **Restoration**: medium. Touches both files; the ref-as-signal pattern is non-obvious; depends on `createResizeObserver` (already a dep).

#### B10. `packages/app/src/pages/session/composer/session-todo-dock.tsx` — collapse-by-default on mobile — **PORTED** (commit 3)

- **Plus**: imports `createMediaQuery`, computes `isMd = (min-width: 768px)`, defaults `collapsed: !isMd()`. Comment explains that an expanded dock pushes the input behind the iOS keyboard accessory bar.
- **Current**: `collapsed: false` always.
- **Severity**: Moderate. **Restoration**: trivial (3-line change).

#### B11. `packages/app/src/pages/session/composer/session-composer-region.tsx` — safe-area aware bottom padding — **PORTED** (commit 4)

- **Plus / Current (post-port)**: bottom padding is `pb-[calc(env(safe-area-inset-bottom)+0.375rem)] md:pb-[calc(env(safe-area-inset-bottom)+0.75rem)]`.
- **Original current (pre-port)**: `pb-3` only.
- **Severity**: Minor. **Restoration**: trivial.

#### B12. `packages/app/src/pages/session/composer/session-permission-dock.tsx` & `session-question-dock.tsx` — **NOT A GAP** (current is newer)

- **Plus**: inline dock max-height computation per file; `el?.focus()` only on focus restore.
- **Current**: `useDockMaxHeight({ property, getRoot })` shared helper (upstream refactor); `session-question-dock.tsx` has `el.focus({ preventScroll: true }) + el.scrollIntoView({ block: "nearest", behavior: "smooth" })` (newer upstream). `session-permission-dock.tsx` has no focus restore in either version.
- **Verification (commit 5 investigation)**: `grep -n "focus\|scrollIntoView" packages/app/src/pages/session/composer/session-permission-dock.tsx` returns no hits in either repo, so the audit's "permission dock additionally has preventScroll+scrollIntoView" claim was wrong. The pattern lives in `session-question-dock.tsx` and is already present in current.
- **Severity**: not applicable. No port action required.

#### B13. `packages/app/src/pages/session/message-timeline.tsx` — calmer mobile pace + last-message-only pending guard + progress-bar setting integration — **PORTED** (commit 17; pace + pending guard + cv class swap + pb-16→pb-4 only — current keeps its newer `showSessionProgressBar` settings gate, `Show keyed`, and `id()` signal-call pattern)

Substantial divergence. The newer-upstream items already in `actualyze` (and **not** gaps): `811a7e9a8` `showSessionProgressBar` setting integration, `keyed` props on `<Show>` for proper reactivity (`785f3589a`), `Show keyed` on `id()` callback shape, `archiveSession(id())` shape changes — all upstream. The genuine gaps from plus:

- **Pace constants extracted** (`PACE_NARROW_WIDTH`, `PACE_WIDE_WIDTH`, `PACE_NARROW_MS=3200`, `PACE_WIDE_MS=1800`) with linear interpolation 360→1200px → 3200→1800ms; current uses an inline `Math.round(Math.max(1200, Math.min(3200, (Math.max(width,360)*2000)/900)))` formula with different constants.
- **Last-message-only pending guard**: plus narrows `pending` to "only the last message can indicate pending work" so an older assistant message with `time.completed` undefined (backend bug or dropped event) does not stick the progress bar forever. Current uses `findLast` over the full array.
- **`working` derivation**: plus is `!!pending() || sessionStatus().type !== "idle"` — current is `sessionStatus().type !== "idle"` only. (This is a genuine semantic difference and was deliberate in plus to keep the bar showing through brief status flips.)
- **`pb-16 → pb-4` mobile turn-list bottom padding** (commit `f89d9034f`).
- **Severity**: Moderate (last-message guard fixes a stuck-bar bug). Minor (pace constants, pb-4). **Restoration**: small but read carefully — the `showSessionProgressBar` upstream gate must be preserved.

#### B14. `packages/app/src/pages/dashboard.tsx` — entire mobile rework — **CANCELLED — current is on a newer upstream refactor** (extracted `dashboard-helpers.ts`, store-based state, `mobileSidebar.hide()` on mount, search/sort wiring, per-card new-session button, compact rows). Re-porting plus's older structure would be a regression. Verified by GPT-5 dual-review during plan validation. If a specific dashboard mobile UX issue surfaces, file as a separate task.

`actualyze` has the dashboard from upstream `49b25ae67` "feat(app): native dashboard, status provider, and non-loopback auth gate" (the consolidated upstream version of plus's `d89b2cc1e`). **Plus has 9 follow-up commits** that did not land:

- `b7d44baec` proxy all opencode API routes and wire `+` button to dashboard
- `c1271010c` 2-column grid, show full paths, stop auto-redirect from dashboard
- `f49909844` remove dev debug bar overlay (also touched layout.tsx — see B6)
- `fff970624` per-session status dots and new session button on dashboard (semantic — overlaps with upstream consolidation but plus-specific UI: per-session dots + new-session-button-per-card)
- `dbda50e6e` show basename in card header, clean ISO session titles, flex-grow card body
- `523a1c84e` independent card heights, hover-only new-session bar
- `183c57842` fixed card height, no layout shift on hover reveal
- `9a0e823ec` clear icon rail on dashboard, hide mobile sidebar at dashboard, no-show sidebar panel on mobile
- `e1a6a1be8` close mobile sidebar on dashboard mount, pl-20 offset
- `670fe20f1` revert pl-20, mobile uses px-4
- `b0043bb91` compact list rows on mobile, card grid on sm+ (significant)
- `e765709bc` collapse header into toolbar row, shrink sort buttons
- `2b1510237` move search/sort/server into titlebar slots, list starts top of screen (significant — uses titlebar portal)
- `b2289b279` use `<For>` for sort buttons so variant reacts to signal
- `6a3ed5cea` sort by extracting plain objects and keying `<For>` on IDs
- `f7e0923b5` single sort dropdown, move sort out of titlebar to above list on mobile

Net result of the plus follow-ups: a **fundamentally different mobile dashboard** with compact list rows, search/sort moved into titlebar slots, no layout shift on hover, and a per-card new-session button.

The current `dashboard.tsx` is the upstream-shaped grid view with `state` store + helpers from `dashboard-helpers.ts`; it is structurally newer and well-factored, but has none of the mobile-specific layout work.

- **Severity**: Major (mobile dashboard UX). **Restoration**: large + risky. The plus version is built on the older dashboard skeleton; the upstream version is structurally cleaner. Recommended approach: cherry-pick the **layout/UX intent** of the mobile commits (compact rows, titlebar slots, hover-only reveal, no-shift cards) onto the upstream skeleton rather than reverting to plus's structure. Watch for interaction with B1 (titlebar mounts).

#### B15. `packages/ui/src/assets/favicon/site.webmanifest` and `packages/app/public/site.webmanifest` — **PORTED** (commit 2)

- **Plus / Current (post-port)**: top-level `start_url: "/"`, `display: "standalone"`, `theme_color: "#131010"`, `background_color: "#131010"`, icon `purpose: "any maskable"`.
- **Original current (pre-port)**: no `start_url`, theme/background `#ffffff`, icon `purpose: "maskable"` only.
- **Why this matters**: dark theme color matches the app's dark default; `any maskable` lets iOS use the icon both flat and masked; missing `start_url` reduces "Add to Home Screen" reliability.
- **Severity**: Minor. **Restoration**: trivial. **Note**: `packages/app/public/site.webmanifest` is a symlink to `packages/ui/src/assets/favicon/site.webmanifest` in both repos, so editing the ui-package file updates both.

#### B16. `packages/app/index.html` — **PORTED** (commit 1)

- **Plus**: `viewport ... viewport-fit=cover`; adds `<meta apple-mobile-web-app-capable=yes>`, `<meta mobile-web-app-capable=yes>`, `<meta apple-mobile-web-app-status-bar-style=black-translucent>`; root div uses `h-svh`.
- **Current**: missing all three PWA meta tags; `viewport` lacks `viewport-fit=cover`; root div uses `h-dvh`.
- **Why this matters**: Without these the page is not eligible for iOS standalone PWA mode; without `viewport-fit=cover` `env(safe-area-inset-*)` returns 0 so all the safe-area work in B1/B8/B11 is a no-op.
- **Severity**: Major (this is the **prerequisite** for B1, B8 PWA branch, B11, B15). **Restoration**: trivial (3 meta tags + 1 viewport attr + 1 class change).

#### B17. `packages/ui/src/components/icon.tsx` — `arrow-undo-down` glyph

- **Current** has the `arrow-undo-down` glyph (added by upstream `4712f0f3c` for shell-mode cancel UI). **Plus** lacks it.
- This is **current-is-newer, not a gap.**

#### B18. `packages/app/src/context/global-sync.tsx` — persisted project cache — **PORTED** (commit 19)

- **Plus**: persists the global project list to `Persist.global("globalSync.project", ["globalSync.project.v1"])` via `persisted()`; rehydrates from cache on mount when nothing has been written yet; sanitizes via `sanitizeProject` before write; uses an `active` flag + `projectWritten` flag to avoid clobbering a fresh server payload with stale cached data; replaces `setGlobalStore("project", produce(next))` with a `cacheProjects()` after every write.
- **Current**: no project cache; project list is purely live, fetched on every cold start.
- **Plus also**: drops a `console.error("[global-sync] session error", ...)` on `session.error` events — but that error logging was **added** in upstream `6387b35a2` "log session sdk errors" and is in `actualyze`. Removing it would be a regression — **leave current as-is**.
- **Why this matters**: Cold-start project list flash; the cache means the sidebar renders instantly with the previous list while the live fetch is in flight.
- **Severity**: Moderate. **Restoration**: medium. `persisted` + `Persist` machinery already exists in `@/utils/persist`; no new deps. Risk is low — additive.

#### B19. `packages/app/src/context/global-sync/child-store.ts` — global project metadata seed + late hydration — **PORTED** (commit 19; only the projectMeta seeding + onPersistedInit(meta[2]) — current keeps its newer pathQuery-based path lazy load, plus uses synchronous path init)

- **Plus**: reads `meta[0].value` on initial child store creation and seeds `projectMeta` from it; on `meta[2]` (persisted-init promise) resolves, if the live `child[0].projectMeta` is still equal to the initial value, replaces with the persisted value. Removes the `useQuery(loadPathQuery)` indirection and uses a literal default `path` shape until SSE updates arrive.
- **Current**: lazy `useQuery` lookup for path; `projectMeta: undefined` initial.
- **Severity**: Minor (a startup smoothness improvement). **Restoration**: small.

#### B20. `packages/app/src/context/global-sync/event-reducer.ts` — produce wrapping shape

- **Plus** uses `(draft) => { ... }` callbacks against `setGlobalProject`; **current** wraps in `produce((draft) => { ... })`. Both are valid — current's shape was changed by upstream `22d33c57a` "properly wrap produce calls in setProjects".
- **Current is newer, not a gap.** (But the type signature diverged: current `(next: Project[] | ((draft: Project[]) => Project[]))` vs plus `(next: Project[] | ((draft: Project[]) => void))`. Current's signature is wrong — a draft mutator returning void is the produce convention. Track separately if not already on the list.)

#### B21. `packages/app/src/context/layout.tsx` — global project icon override read

- **Plus**: `getProjectMeta` for global/inferred-global projects reads `local.name`, `local.commands`, `local.icon.override`, `local.icon.color` — applies them on top of the metadata base.
- **Current**: only `metadata` + `project` flat-merge; no global-icon-override read; the `project.icon?.color || project.icon?.override || project.icon?.url` guard short-circuits the avatar `Show` early.
- This may be **current-is-newer** (upstream `06066dbb7`/`d884ab73d` consolidated icon source). Read carefully before restoring.
- **Severity**: Verify. Likely **not a gap** — leave current.

#### B22. `packages/app/src/components/dialog-edit-project.tsx`

- All deltas trace to upstream `06066dbb7 fix(app): improve icon override handling in project edit dialog` + `d884ab73d fix: consolidate project avatar source logic` (current-is-newer). **Not a gap.**

#### B23. `packages/app/src/components/settings-general.tsx`

- All deltas trace to upstream `811a7e9a8 feat(app): allow disabling progress bar in settings` (current-is-newer) and `2e156b899 fix(desktop): avoid relaunching without installing updates` (current-is-newer; current uses `updateAndRestart`, plus uses two-call `update` + `restart`). **Not a gap.**

#### B24. `packages/app/src/components/dialog-select-server.tsx`

- All deltas trace to upstream `224548d87 fix(desktop): adjust layout properties in DialogSelectServer component`. **Not a gap.**

#### B25. `packages/app/src/context/platform.tsx`

- All deltas trace to upstream `2e156b899` — current consolidates `update`+`restart` into `updateAndRestart`. **Not a gap.**

#### B26. `packages/app/src/context/project-status.tsx`

- All deltas trace to upstream `49b25ae67` rewrite (richer SimplifiedStatus enum, `version()` bumper, `reconcileSessions`, `forgetSession`). **Not a gap.**

#### B27. `packages/app/src/context/prompt.tsx`

- All deltas trace to upstream `687b75888 app: better loading` (current uses `createMemo` for `current` and `dirty`, ready as `().promise`). **Not a gap.**

#### B28. `packages/app/src/context/settings.tsx`

- All deltas trace to upstream `811a7e9a8` (current adds `showSessionProgressBar`). **Not a gap.**

#### B29. `packages/app/src/pages/directory-layout.tsx`

- Plus uses `createEffect(() => { void sync.session.sync(id) })`; current uses `createResource(() => params.id, (id) => sync.session.sync(id))`.
- This is a refactor; current is the cleaner upstream shape (`a72653073 fix(app): workspace loading and persist ready state`). Not behaviorally different. **Not a gap.**

#### B30. `packages/app/src/pages/error.tsx`

- All deltas trace to `2e156b899` updateAndRestart consolidation. **Not a gap.**

#### B31. `packages/app/src/pages/layout/sidebar-items.tsx`

- All deltas trace to `d884ab73d` `getProjectAvatarSource` consolidation + upstream `<Show keyed>` work. **Not a gap.**

#### B32. `packages/app/src/pages/layout/sidebar-workspace.tsx`

- Single delta: `loading = () => query.isLoading && count() === 0` (current) vs `query.isLoading` (plus). Current is newer (upstream `687b75888` better loading). **Not a gap.**

#### B33. `packages/app/src/components/prompt-input/placeholder.ts` + `placeholder.test.ts`

- Plus shell-mode placeholder is `"Enter shell command..."`; current is `"Enter shell command... {{example}}"` (upstream `4712f0f3c`). **Not a gap.**

#### B34. `packages/ui/src/components/timeline-playground.stories.tsx`

- Single delta: bun version string in fixture text. **Not a gap.**

#### B35. `packages/ui/src/components/session-turn.tsx`

- Plus uses positional scan; current uses parentID matching (upstream `91468fe45`). **Not a gap.**

#### B36. `packages/ui/src/components/session-review.tsx`

- Plus uses `&&` on diff render; current uses `||` (upstream `febadc558` "correct diff render condition logic"). **Not a gap.**

#### B37. `packages/app/src/app.tsx`

- Plus moves `QueryProvider` higher in the tree (above `GlobalSDKProvider`). Current has it lower (below `RouterRoot`). This is upstream `93e633fb7 refactor(app): move QueryProvider to AppInterface`. **Not a gap.**

#### B38. `packages/app/src/entry.tsx`

- Plus changes the dev API base resolution rules (uses same-origin via Vite proxy unless overridden). Current keeps `localhost:4096` behavior.
- This is **dev-only proxy plumbing** — out of scope per the brief (build/CI/server lifecycle adjacent). Flagged for awareness but not a UI gap.

### C. Recent webui-plus commits that did not make it into actualyze

Listed newest first. **In** = present in actualyze; **Out** = not present; **OOS** = out of audit scope.

| Hash                                                                    | Subject                                                                           | UI?         | Status                          | Notes                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------- | ------------------------------- | --------------------------------------------------------------------------- |
| `e64377ca5`                                                             | fix(ios): remove nested pointer-events toggle in titlebar center                  | yes         | **PORTED** (commit 8)           | B1                                                                          |
| `f4a78a87f`                                                             | fix(ios-pwa): prevent Changes pill width mutation from bricking titlebar          | yes         | **PORTED** (commit 13)          | B5 (intentional static label)                                               |
| `eb3973f9c`                                                             | fix(mobile): constrain titlebar center so pill cannot overlap right slot          | yes         | **PORTED** (commit 8)           | B1                                                                          |
| `d27d9e0e4`                                                             | fix(mobile): mobile pill tap target size and iOS tap-delay                        | yes         | **PORTED** (commit 13)          | B5                                                                          |
| `5a86c0320`                                                             | fix(sync): reconcile session_status/todo/diff on forced refresh                   | yes         | **PORTED** (commit 11)          | B4                                                                          |
| `864987261`                                                             | fix: dual-review follow-ups on today's three commits                              | yes         | **Out**                         | rolled into B1/B5/B8                                                        |
| `a9ade1b73`                                                             | fix(mobile): resume-sync + tighter heartbeat + refresh button                     | yes         | **PORTED** (commits 10+12)      | B2 + B3                                                                     |
| `2d497346a`                                                             | fix(mobile): calmer progress indicator and self-heal stuck state                  | yes         | **PORTED** (commit 15)          | B8 + B13                                                                    |
| `f5f075893`                                                             | fix(terminal): proxy WebSocket /pty/\*/connect through raw TCP                    | no          | OOS                             | server proxy                                                                |
| `923895987`                                                             | fix(pwa): use 100lvh in iOS PWA standalone mode                                   | yes         | **PORTED** (commit 9)           | B8                                                                          |
| `96747006d`                                                             | fix(pwa): force titlebar stacking context above iOS translucent status bar        | yes         | **PORTED** (commit 8)           | B1                                                                          |
| `39a2e7637`                                                             | fix(pwa): apply iOS safe-area insets at edges, not whole shell                    | yes         | **PORTED** (commits 4+8)        | B1 + B11                                                                    |
| `3f6f413ca`                                                             | fix(mobile): bash-output mask works when collapsible expanded later               | yes         | **PORTED** (commit 16)          | B9                                                                          |
| `84cb51933`                                                             | fix: address second-pass review findings on rendering commits                     | yes         | **PORTED** (commit 15)          | rolled into B8/B9                                                           |
| `9996db665`                                                             | fix(pwa): add mobile-web-app-capable meta tag                                     | yes         | **PORTED** (commit 1)           | B16                                                                         |
| `b969a29e4`                                                             | fix: read titlebar portal mounts synchronously to avoid layout shift              | yes         | **PORTED** (commit 12)          | B2 + B5                                                                     |
| `2a11cb63c`                                                             | fix(pwa): handle iOS safe-area for translucent status bar                         | yes         | **PORTED** (commit 8)           | B1                                                                          |
| `db414bf27`                                                             | fix(mobile): gate content-visibility on pointer capability not width              | yes         | **PORTED** (commit 15)          | B8                                                                          |
| `562984401`                                                             | fix(mobile): cap bash output at 60vh with fade indicator                          | yes         | **PORTED** (commit 16)          | B9                                                                          |
| `ec2d07a55`                                                             | fix(mobile): show full bash tool output on narrow viewports                       | yes         | **PORTED** (commit 16)          | B9                                                                          |
| `96bf793ec`                                                             | fix(mobile): disable content-visibility:auto on narrow viewports                  | yes         | **PORTED** (commit 15)          | superseded by `db414bf27` (B8)                                              |
| `e66ee1181`                                                             | fix(mobile): collapse todo dock by default on narrow viewports                    | yes         | **PORTED** (commit 3)           | B10                                                                         |
| `21f6c28c9`                                                             | fix(prompt): latch hasUserPrompt to stop placeholder flashing                     | yes         | **PORTED** (commit 6)           | B7                                                                          |
| `b724285a3`                                                             | fix(ios): stabilize layout during iPhone scroll/streaming                         | yes         | **PORTED** (commit 15)          | B8 (content-visibility gate)                                                |
| `c0d4b749b`                                                             | revert(ios): remove --kb-inset keyboard tracker entirely                          | yes         | **n/a**                         | reverted in plus too                                                        |
| `27037c1d2`                                                             | fix(ios): remove visualViewport scroll listener from kb-inset                     | yes         | **n/a**                         | reverted in plus too                                                        |
| `f89d9034f`                                                             | fix(mobile): reduce turn list bottom padding pb-16 → pb-4                         | yes         | **PORTED** (commit 17)          | B13                                                                         |
| `c9517a7dd`                                                             | fix(mobile): vertically center + and send buttons in input row                    | yes         | **PORTED** (commit 18)          | B7                                                                          |
| `11ddf8f5e`                                                             | fix(mobile): tighten input area spacing                                           | yes         | **PORTED** (commit 18)          | B7                                                                          |
| `b663fb787`                                                             | fix(ios): keyboard inset via --kb-inset padding-bottom on root                    | yes         | **Out**                         | superseded — but final `c0d4b749b` revert means this should also be skipped |
| `eef827240`/`5f478dfcc`/`d5f194363`/`b41c62619`/`35ddd1dea`/`e935d5a95` | iOS keyboard experiments and reverts                                              | yes         | **n/a**                         | net-zero in plus                                                            |
| `0842f5ead`                                                             | feat(mobile): inline + and send buttons with prompt input text                    | yes         | **PORTED** (commit 18)          | B7                                                                          |
| `bdd5aab47`                                                             | fix: gate session-header center portal on md+ breakpoint                          | yes         | **PORTED** (commit 12)          | B2                                                                          |
| `c9d53ddfb`                                                             | feat(mobile): move session/changes tabs into titlebar center as segmented control | yes         | **PORTED** (commit 13)          | B5 (headline)                                                               |
| `3f1d38691`                                                             | fix: update manifest in packages/ui source and app/public                         | yes         | **PORTED** (commit 2)           | B15                                                                         |
| `6e7afb9e6`                                                             | feat: PWA iOS support and reduce prompt input padding                             | yes         | **PORTED** (commit 1)           | B16 + B11/B7                                                                |
| `98ccce7f4`/`7d2409eb8`/`6518c6ab3`/`7c9d02fe4`                         | move scripts to plus/                                                             | no          | OOS                             | server-lifecycle                                                            |
| `bc9198151`/`f0306b63b`/`7499fbe1f`                                     | manage.sh launchd                                                                 | no          | OOS                             | server-lifecycle                                                            |
| `7979b7121`/`4a7500d92`                                                 | project-status comment + review-fix                                               | yes         | **In**                          | merged via `49b25ae67` upstream                                             |
| `9f0379ada`/`64f5511e0`                                                 | port config                                                                       | no          | OOS                             | server config                                                               |
| `f7e0923b5`                                                             | fix(dashboard): single sort dropdown, mobile sort placement                       | yes         | **Out**                         | B14                                                                         |
| `6a3ed5cea`                                                             | fix(dashboard): sort by extracting plain objects, key on IDs                      | yes         | **Out**                         | B14                                                                         |
| `b2289b279`                                                             | fix(dashboard): use `<For>` for sort buttons                                      | yes         | **Out**                         | B14                                                                         |
| `2b1510237`                                                             | fix(mobile): move search/sort/server into titlebar slots                          | yes         | **Out**                         | B14                                                                         |
| `e765709bc`                                                             | fix(mobile): collapse header into toolbar row, shrink sort buttons                | yes         | **Out**                         | B14                                                                         |
| `b0043bb91`                                                             | feat(dashboard): compact list rows on mobile, card grid on sm+                    | yes         | **Out**                         | B14                                                                         |
| `670fe20f1`                                                             | fix(dashboard): mobile uses px-4 (no icon rail offset)                            | yes         | **Out**                         | B14                                                                         |
| `e1a6a1be8`                                                             | fix(mobile): close mobile sidebar on dashboard mount                              | yes         | **Out**                         | B14                                                                         |
| `9a0e823ec`                                                             | fix(mobile): clear icon rail on dashboard, hide mobile sidebar                    | yes         | **Out**                         | B14                                                                         |
| `183c57842`                                                             | fix(dashboard): fixed card height, no layout shift on hover                       | yes         | **Out**                         | B14                                                                         |
| `523a1c84e`                                                             | fix(dashboard): independent card heights, hover-only new-session bar              | yes         | **Out**                         | B14                                                                         |
| `dbda50e6e`                                                             | fix(dashboard): show basename in card header, clean ISO titles                    | yes         | **Out**                         | B14                                                                         |
| `fff970624`                                                             | feat: per-session status dots and new session button on dashboard                 | yes/partial | **In via upstream `49b25ae67`** | upstream consolidated; per-card new-session-button still missing — B14      |
| `f49909844`                                                             | fix: remove dev debug bar overlay                                                 | yes         | **PORTED** (commit 7)           | B6                                                                          |
| `c1271010c`                                                             | fix: 2-column grid, show full paths, stop auto-redirect                           | yes         | **Out**                         | B14                                                                         |
| `b7d44baec`                                                             | fix: proxy all opencode API routes and wire + button to dashboard                 | partial     | **Out**                         | UI half = wire `+` button — B14; proxy half = OOS                           |
| `544e6d47d`                                                             | fix: add Vite dev proxy to handle auth+CORS                                       | no          | OOS                             | dev proxy                                                                   |
| `8f899b6b8`                                                             | fix(dashboard): use throwOnError:false client                                     | yes         | **In**                          | upstream `49b25ae67` covers this                                            |
| `d89b2cc1e`                                                             | feat: add all-projects dashboard and auto-sidebar sync                            | yes         | **In via upstream `49b25ae67`** | structurally rewritten upstream                                             |
| `b75ae5c82`                                                             | chore: pin ghostty-web                                                            | no          | OOS                             | dep pin                                                                     |

## Pill / Top Bar Selector specifically

The user called out "session view enhancements to the top bar with pill type selectors". This is the **B5 + B1 + B14 cluster**.

### Where is this implemented in webui-plus?

There are actually **two** distinct pill-in-titlebar systems:

1. **Session pill (`packages/app/src/pages/session.tsx`)** — segmented control with `Session | Changes` tabs that switch the mobile view between the message timeline and the changes review pane. Lives at lines 1854–1903 in plus, inside `<Show when={!isDesktop() && !!params.id && titlebarCenter()}>`. Uses `<Portal mount={titlebarCenter()}>` to render into `#opencode-titlebar-center` (the host div in `packages/app/src/components/titlebar.tsx`).
2. **Dashboard search/sort/server pill (`packages/app/src/pages/dashboard.tsx`)** — search box, sort dropdown, and server picker portaled into the titlebar on mobile so the project list starts at the top of the screen. Implemented via the same `#opencode-titlebar-center` mount.

### Data flow

For the session pill:

- `params.id` (router) → gates whether to render at all
- `isDesktop = createMediaQuery("(min-width: 768px)")` → only mount on `!isDesktop()`
- `titlebarCenter()` signal — read synchronously at module evaluation, fallback `onMount`
- Local `store.mobileTab: "session" | "changes"` (createStore inside the component)
- Click handler `setStore("mobileTab", ...)` toggles, which is also read by `mobileChanges` createMemo at line 597 of plus
- The "Changes" label is **intentionally static** (does not show file count) — see B5 — to prevent iOS PWA hit-test corruption
- `hasReview()` and `reviewCount()` from the review pane signals are surfaced **next to the changes selector dropdown** (line 1086 of plus's session.tsx) instead of in the pill, so the file count is still visible

For the dashboard pill (search/sort):

- Local `search` and `sort` signals (or `state` store)
- Mobile-vs-desktop split decides whether to render in-page or in titlebar
- Sort cycles via `<For each={SORTS}>` of buttons keyed on plain `{id, label}` objects (the keying matters — earlier plus revisions had a reactivity bug where the variant didn't update; commit `b2289b279` then `6a3ed5cea` fixed it)

### Dependencies

| Dependency                                                                                 | In current?                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `#opencode-titlebar-center` mount in `titlebar.tsx`                                        | exists, but lacks safe-area + stacking-context hardening (B1)                                                                                                                                                            |
| `createMediaQuery` from `@solid-primitives/media`                                          | already in `package.json` and used elsewhere                                                                                                                                                                             |
| `solid-js/web Portal`                                                                      | Solid built-in                                                                                                                                                                                                           |
| `globalSDK.event.reconnecting` / `restart` / `isTouchDevice`                               | missing (B3)                                                                                                                                                                                                             |
| Force-sync ancillary reconcile                                                             | missing (B4)                                                                                                                                                                                                             |
| `i18n` keys `session.header.refresh`, `session.tab.session`, `session.review.change.other` | partial — `session.tab.session` and `session.review.change.other` exist in current; `session.header.refresh` missing in current's `en.ts` (also missing from all non-en locales in plus — plus only added it to `en.ts`) |
| iOS safe-area meta in `index.html`                                                         | missing (B16)                                                                                                                                                                                                            |

### What's missing from current

- The portaled session pill (current uses an in-flow `<Tabs>` instead — see B5)
- The titlebar safe-area + stacking-context hardening (B1)
- The synchronous mount lookup pattern (B2 + B5; current would flicker for one frame even if the rest landed)
- The PWA meta tags + `viewport-fit=cover` (B16)
- The mobile dashboard search/sort/server titlebar slots (B14)
- The dock of dependencies that make the pill behave correctly under iOS (B3, B4, B7 latch, B9 mask, B10 todo collapse)

### Restoration outline (pill-specific, in order)

1. **`packages/app/index.html`** — add `viewport-fit=cover`, `apple-mobile-web-app-capable`, `mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style: black-translucent`; root div `h-svh`. _No code dependencies._ (B16) **PORTED commit 1.**
2. **`packages/ui/src/assets/favicon/site.webmanifest`** (symlinked from `packages/app/public/site.webmanifest`) — add `start_url`, `display`, `theme_color`, `background_color`; icons `purpose: "any maskable"`. _Cosmetic, but required for the iOS install path that activates standalone mode._ (B15) **PORTED commit 2.**
3. **`packages/app/src/components/titlebar.tsx`** — switch column layout to `[auto_minmax(0,1fr)_auto]`, add `relative z-30 isolate`, add `padding-top: env(safe-area-inset-top)` + `height: calc(env(safe-area-inset-top) + 2.5rem)`, flatten center mount (drop nested pointer-events pair, add `touch-action: manipulation`). (B1)
4. **`packages/app/src/index.css`** — add the `@media all and (display-mode: standalone) { #root { height: 100lvh; } }` rule outside `@layer components`. (B8 PWA branch)
5. **`packages/app/src/context/global-sdk.tsx`** — additively expose `restart`, `reconnecting`, `isTouchDevice`. _No consumer changes required by this commit alone._ (B3)
6. **`packages/app/src/context/sync.tsx`** — extend the `force` branch in `sync.session.sync` to issue ancillary status/diff/todo reconciles wrapped in `Promise.allSettled`. (B4)
7. **`packages/app/src/components/session/session-header.tsx`** — add `useGlobalSDK`, `isMobile` media query, `refresh()`, mobile refresh button with reconnecting spinner. Make titlebar mount lookup synchronous. Add `session.header.refresh` to `i18n/en.ts` (and matching translations to other locales as polish). (B2)
8. **`packages/app/src/pages/session.tsx`** — replace the `<Tabs>` block with the portaled custom segmented pill keeping the **intentionally static "Changes" label**, add the visibilitychange resync (gated on `isTouchDevice`), add the reconnect-edge resync createEffect. Add the file-count text **next to the changes selector**, not inside the pill. (B5)

After this 8-step sequence the pill is functional and the iOS PWA is hardened. The remaining gaps (B6, B7, B9, B10, B11, B13, B14, B18) are independent and can be staged separately.

## Restoration ordering proposal

Three phases, ordered by dependency depth and risk.

### Phase 1 — Standalone polish (no shared deps, ship in any order)

- **B11** safe-area composer padding _(trivial)_
- **B10** todo dock collapse-by-default on mobile _(trivial)_
- **B12** permission dock focus-with-scrollIntoView _(trivial)_
- **B15** site.webmanifest (single file via symlink) _(trivial)_ **— PORTED commit 2**
- **B16** index.html PWA meta tags _(trivial, but a prerequisite for B1/B8/B11 to actually take effect)_ **— PORTED commit 1**
- **B17/B22–B36** — re-verify nothing here is a gap (per the table they are all current-is-newer); skip
- **B7 latch only** — the `hasUserPrompt` 5-line memo change _(trivial; do not include the inline-buttons layout in this phase)_

### Phase 2 — iOS PWA + mobile pill (the headline feature, dependency chain)

In strict order — each step assumes the previous is in.

1. **B16** must be in (Phase 1)
2. **B1** titlebar safe-area + stacking + flat center mount
3. **B8 PWA branch** the standalone height override
4. **B3** global-sdk additive `restart`/`reconnecting`/`isTouchDevice`
5. **B4** sync.tsx force-resync ancillary reconcile
6. **B2** session-header refresh button + mobile reconnect indicator
7. **B5** session.tsx portaled pill + visibility/reconnect resync wiring

After (7) the user-quoted "session view enhancements to the top bar with pill type selectors" is restored.

### Phase 3 — Mobile polish + remaining moderate items

- **B6** desktop dashboard "Open projects" sidebar list + remove DebugBar overlay
- **B8 non-PWA branches** progress-bar glide animation, content-visibility gate
- **B9** mobile bash output cap with fade indicator (touches both `message-part.css` and `message-part.tsx`; test against current upstream's `Collapsible` shape)
- **B13** message-timeline last-message-only pending guard, pace constants, pb-4 turn-list padding
- **B7 layout half** inline +/send buttons (this is the most invasive — keep separate from the latch fix; reconcile against upstream shell-mode + variant-selector additions)
- **B18** persisted project cache in `global-sync.tsx`
- **B19** child-store metadata seeding

### Phase 4 — Dashboard mobile rework (separate deliberation)

- **B14** is large enough to deserve its own design pass. Recommendation: do not port the plus dashboard structure wholesale (current is on a structurally-better upstream factoring with `dashboard-helpers.ts`). Instead, port the **layout intent** of the mobile commits onto the upstream skeleton:
  1. Mobile breakpoint switches to a compact list (no card grid)
  2. Search and sort move into `#opencode-titlebar-center` slots (depends on Phase 2)
  3. New-session button per project card (semantic — not present in upstream consolidation)
  4. Hover-only reveal with no layout shift
  5. Close mobile sidebar on dashboard mount

This phase is the only one that is **risky** to port — every other gap is mechanically additive.

## Items deliberately flagged as out-of-scope (not gaps)

- `f5f075893 fix(terminal): proxy WebSocket /pty/*/connect through raw TCP` — server proxy code in `vite.config.ts` and `packages/opencode/src`; _not_ UI even though it gates whether the terminal UI works at all. Track separately if the terminal feature is broken.
- `544e6d47d fix: add Vite dev proxy` — dev tooling.
- All `plus/manage.sh` and `opencode-server` work — explicit scope exclusion.
- `entry.tsx` dev API base URL change (B38) — dev proxy plumbing.
- `c0d4b749b`/`27037c1d2`/`b663fb787`/`eef827240`/`5f478dfcc`/`d5f194363`/`b41c62619`/`35ddd1dea`/`e935d5a95` — iOS keyboard experiments that ended up reverted in plus itself; net-zero.
- All "current is newer than plus" deltas (B17, B20–B36) — leave current as-is.

## Items where intentional removal in plus did NOT propagate

- `f49909844 fix: remove dev debug bar overlay` — plus removed the `<DebugBar />` from `pages/layout.tsx` and removed the import. Current still mounts it under `import.meta.env.DEV`. Deliberate vs accident is unclear; flag for the user. (Listed as B6 alongside the sidebar work, since they share a commit and a file.)
