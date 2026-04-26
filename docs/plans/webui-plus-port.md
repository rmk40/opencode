# Plan: Port outstanding webui-plus UI work into actualyze

## Goal

Restore every UI/UX feature that exists in `opencode-webui-plus@web-fork`
but is missing from `opencode@actualyze`. Server lifecycle, build/CI,
`plus/` overlay, daemon, and `manage.sh` remain explicitly out of scope.
Each logical UI feature lands as its own commit, dual-reviewed before
moving on.

**Final commit count: 19 commits maximum** across 3 phases (Phase 4
cancelled — see below).

## Background

`actualyze` was ported from `opencode-webui-plus`. The port intentionally
dropped server-lifecycle work but was supposed to bring all UI work. A
gap audit (full report at `docs/code-analysis/webui-plus-port-gaps.md`)
identified 38 deltas; ~19 are real UI gaps, the rest are either
already-in-via-newer-upstream or out of scope.

Ground-truth audit:

- 0 whole-file gaps. Every gap is inside files present in both repos.
- Pivotal feature missing: the **mobile session pill** portaled into the
  titlebar (`#opencode-titlebar-center`). Currently rendered as an
  in-flow `<Tabs>` instead.
- The pill depends on a chain: PWA meta tags → titlebar safe-area +
  stacking → standalone-mode CSS → globalSDK reconnect/restart APIs →
  sync force-resync ancillaries → mobile refresh button → portaled pill
  itself.

**Dual-review verification (already complete) confirmed:**

- All cited file paths exist in both repos.
- Phase 4 (dashboard rework) is **cancelled** — current dashboard is on
  a newer upstream refactor (extracted `dashboard-helpers.ts`, store
  state, mobile compact rows, `mobileSidebar.hide()` on mount) that
  already includes plus's mobile-dashboard intents.
- i18n `parity.test.ts` only enforces 2 specific keys, not all keys,
  so adding `session.header.refresh` to `en.ts` only is fine.
- `packages/app/public/site.webmanifest` exists; commit 2 edits both
  copies (app and ui-package).

## Constraints

- One commit per logical UI feature.
- Dual-review (`code-review-opus` + `code-review-gpt5` in parallel)
  **after each commit**. Address blockers + issues before next commit.
  Cap at 3 review rounds per commit. If blockers remain after 3 rounds,
  report and ask the user.
- Read-only on server lifecycle, `plus/`, build/CI/release pipeline,
  Tauri desktop except where it surfaces UI, daemon, `manage.sh`,
  `opencode-server`, and any "current is newer than plus" deltas (B17,
  B20–B36 of the audit, plus B7 dashboard rework).
- Do not touch any uncommitted work in the tree.
- Do not push. Local commits only until explicit authorization.
- Do not restart running app/server processes.
- macOS dev box. `bun typecheck` and `bun test` run from package dirs
  (`packages/app`, `packages/ui` as appropriate).

## Approach

### Phase 1 — Standalone polish (no shared deps)

Each commit independent; can be ordered freely. Land in this order
anyway because it minimizes review surface for later phases.

1. **`fix(app): add iOS PWA meta tags and viewport-fit=cover`**
   - Files: `packages/app/index.html`
   - Changes: add `viewport-fit=cover`,
     `apple-mobile-web-app-capable=yes`, `mobile-web-app-capable=yes`,
     `apple-mobile-web-app-status-bar-style=black-translucent`; root div
     `h-svh`.
   - Why first: prerequisite for B1/B8/B11 — without this, all
     `env(safe-area-inset-*)` returns 0 in iOS PWA mode and downstream
     changes silently no-op.
   - Source commits: `9996db665`, `6e7afb9e6`.
   - Risk: low. Cosmetic effect on non-iOS-PWA users (none).

2. **`fix(app): align webmanifest with iOS PWA standalone install path`**
   - Files: `packages/app/public/site.webmanifest`,
     `packages/ui/src/assets/favicon/site.webmanifest` (kept in sync —
     both already exist).
   - Changes: add `start_url`, `display`, `theme_color: "#131010"`,
     `background_color: "#131010"`; icon `purpose: "any maskable"`.
   - Source commit: `3f1d38691`.
   - Risk: low.

3. **`fix(app): collapse session todo dock by default on mobile`**
   - Files:
     `packages/app/src/pages/session/composer/session-todo-dock.tsx`
   - Changes: import `createMediaQuery`; `collapsed: !isMd()` default.
     Comment explaining iOS keyboard accessory bar.
   - Source commit: `e66ee1181`.
   - Risk: zero.

4. **`fix(app): safe-area-aware composer bottom padding`**
   - Files:
     `packages/app/src/pages/session/composer/session-composer-region.tsx`
   - Changes: `pb-[calc(env(safe-area-inset-bottom)+0.375rem)]
md:pb-[calc(env(safe-area-inset-bottom)+0.75rem)]`.
   - Source commit: rolled into `39a2e7637`.
   - Risk: zero on non-iOS.

5. **`fix(app): preserve scroll position when restoring permission dock focus`**
   - Files:
     `packages/app/src/pages/session/composer/session-permission-dock.tsx`
   - Changes: `el.focus({ preventScroll: true })` then
     `el.scrollIntoView({ block: "nearest", behavior: "smooth" })`.
   - Source: gap identified by audit B12; no specific upstream hash —
     small mobile UX fix that was part of plus's mobile pass.
   - Risk: low. Mobile UX improvement.

6. **`fix(prompt): latch hasUserPrompt to stop placeholder flashing`**
   - Files: `packages/app/src/components/prompt-input.tsx` (memo only)
   - Changes: latch `hasUserPrompt` true once true for current session,
     reset on session id change. ~5 lines.
   - Source commit: `21f6c28c9`.
   - Risk: low. Reconcile against current's existing shell-mode +
     variant-selector additions (don't touch those).

7. **`chore(app): drop dev DebugBar overlay`**
   - Files: `packages/app/src/pages/layout.tsx` (remove import + usage).
   - Source commit: `f49909844`.
   - Risk: dev-only, no production impact.

### Phase 2 — iOS PWA + mobile pill (the headline feature)

**Prereq from Phase 1: commit 1 (index.html PWA meta).** Without those
meta tags `env(safe-area-inset-*)` returns 0 in iOS PWA mode and all of
Phase 2's safe-area work silently no-ops. All of Phase 1 must be in
first.

**Strict order — each commit assumes the previous is in.**

8. **`feat(app): titlebar safe-area, stacking context, and flat center mount`**
   - Files: `packages/app/src/components/titlebar.tsx`
   - Changes: column layout `[auto_minmax(0,1fr)_auto]`; add
     `relative z-30 isolate`; `padding-top: env(safe-area-inset-top)` +
     `height: calc(env(safe-area-inset-top) + 2.5rem)`; flatten center
     mount (remove nested `pointer-events-none → pointer-events-auto`
     pair); add `touch-action: manipulation`.
   - Source commits: `2a11cb63c`, `96747006d`, `eb3973f9c`,
     `e64377ca5`, `39a2e7637`. Commit body should enumerate all five
     so future archaeologists can map back.
   - Risk: low. Verify desktop layout unchanged via storybook.

9. **`fix(app): use 100lvh in iOS PWA standalone mode`**
   - Files: `packages/app/src/index.css`
   - Changes: append
     `@media all and (display-mode: standalone) { #root { height: 100lvh; } }`
     outside `@layer components` (with comment explaining why).
   - Source commit: `923895987`.
   - Risk: zero on non-PWA.

10. **`feat(app): expose globalSDK restart, reconnecting, isTouchDevice`**
    - Files: `packages/app/src/context/global-sdk.tsx`
    - Changes (additive): `isTouchDevice` via
      `matchMedia("(pointer: coarse)")`; `reconnecting` signal toggled
      around subscribe attempts; `restart()` aborts current attempt to
      fire reconnect loop; `visibilitychange → restart()` on touch
      devices.
    - Source commit: `a9ade1b73`.
    - Risk: medium. New visibility/lifecycle behavior — verify no
      regression in long-running sessions.

11. **`fix(sync): reconcile session_status, todo, diff on forced refresh`**
    - Files: `packages/app/src/context/sync.tsx`
    - Changes: extend `force` branch in `sync.session.sync(id,
{force:true})` to issue `client.session.status()`,
      `client.session.diff()`, `client.session.todo()` wrapped in
      `Promise.allSettled`; reconcile each into matching store.
    - Source commit: `5a86c0320`.
    - Risk: medium. Adds 3 network calls and 3 store writes per forced
      refresh.

12. **`feat(app): mobile refresh button with reconnect indicator in session header`**
    - Files: `packages/app/src/components/session/session-header.tsx`;
      `packages/app/src/i18n/en.ts` (add `session.header.refresh`).
    - Changes: import `useGlobalSDK` and `createMediaQuery`; `isMobile =
(max-width: 767px)`, `isMd = (min-width: 768px)`; `refresh()`
      calls `sync.session.sync(id, {force:true})` +
      `globalSDK.event.restart()`; render tooltip-wrapped ghost button
      at mobile widths swapping `Icon name="reset"` ↔ `Spinner` based on
      `globalSDK.event.reconnecting()`. Search portal gated on `isMd()`.
      Synchronous mount lookup with onMount fallback.
    - Source commits: `a9ade1b73`, `b969a29e4`, `bdd5aab47`. Commit body
      should enumerate.
    - Risk: medium. Touches a heavily-used file. Verify desktop layout
      unchanged. `session.header.refresh` only added to `en.ts` (matches
      plus's scope; non-en locales remain a separate polish task —
      `parity.test.ts` only enforces 2 specific keys, so this won't
      regress CI).

13. **`feat(app): portaled session/changes pill in mobile titlebar`**
    - Files: `packages/app/src/pages/session.tsx`
    - Changes: replace existing `<Tabs>` block with
      `<Portal mount={titlebarCenter()}>` containing custom segmented
      control (button + separator + button) with
      `touch-action: manipulation`, ~40px tap targets, `select-none`.
      **"Changes" label on the pill is intentionally static** (no file
      count) per `f4a78a87f` — file count appears next to the changes
      selector dropdown body instead. Add `visibilitychange → forceSync`
      listener gated on `isTouchDevice`. Add
      `createEffect(on(reconnecting))` firing forceSync on true→false
      edge, rate-limited to 1/800ms. Synchronous titlebar mount lookup.
      Preserve plus's transition guard pattern
      `isDesktop() && !size.active() && !ui.reviewSnap` for any animated
      transitions on this page (current lacks the `isDesktop()` guard).
    - Source commits: `c9d53ddfb`, `f4a78a87f`, `eb3973f9c`,
      `e64377ca5`, `2d497346a`, `5a86c0320`, `d27d9e0e4` (tap-delay /
      touch-action work). Commit body should enumerate.
    - Risk: medium-high. Headline feature; multiple subtle iOS hit-test
      pitfalls. Verify against PWA on a real iOS device (or at minimum
      Safari mobile-emulation).

### Phase 3 — Mobile polish + remaining moderate items

Each commit independent. Land in any order; suggested order minimizes
review thrash.

14. **`feat(app): show open projects panel on desktop dashboard sidebar`**
    - Files: `packages/app/src/pages/layout.tsx`
    - Changes: `<Switch>` adding open-projects panel branch (when
      `!params.dir && !panelProps.mobile && layout.projects.list().length > 0`).
      Comment: "Don't autoselect when on the dashboard — let user
      browse."
    - Source: gap from audit B6 (sidebar half — distinct from B6's
      DebugBar half handled in commit 7); no specific upstream hash for
      the sidebar panel addition.
    - Risk: low. Desktop-only.

15. **`fix(app): calmer progress glide animation + content-visibility gate`**
    - Files: `packages/app/src/index.css`
    - Changes: rename `session-progress-whip → session-progress-glide`
      with new keyframes (narrow segment slide), default `2400ms`,
      opacity `0.75`; mobile `1.5px / opacity 0.6`. Replace upstream
      `fade-in` keyframes with
      `@media (hover: hover) and (pointer: fine) {
.session-turn-cv-eligible { content-visibility: auto; ... } }`
      so iOS Safari doesn't show blank scroll regions.
    - Source commits: `2d497346a`, `db414bf27`, `b724285a3`. Verify
      upstream's `8cc2c81d5` `fade-in` removal hasn't already cleaned it
      before removing.
    - Risk: low. Cosmetic + perf gate.

16. **`fix(ui): cap mobile bash output with fade indicator`**
    - Files: `packages/ui/src/components/message-part.css` +
      `message-part.tsx`
    - Changes: CSS — `@media (max-width: 767px)` with
      `max-height: 60vh` and `mask-image` linear-gradient on the bash
      scroll container, gated on `data-overflow="true"` and
      `data-at-bottom="false"`. TSX — wire data attrs via ref-as-signal
      - `createResizeObserver` + scroll listener (pattern is non-obvious
        because Kobalte `Collapsible.Content` unmounts subtree while
        collapsed; ref must be a signal). Also wire
        `--permission-prompt-max-height` CSS var via `useDockMaxHeight`.
    - Source commits: `ec2d07a55`, `562984401`, `3f6f413ca`,
      `84cb51933`. Commit body should enumerate.
    - Risk: medium. The signal-as-ref pattern is the trickiest part of
      this whole plan. Run `bun typecheck` from `packages/ui` AND
      `packages/app`.

17. **`fix(timeline): last-message-only pending guard + calmer mobile pace`**
    - Files: `packages/app/src/pages/session/message-timeline.tsx`
    - Changes: extract `PACE_NARROW_WIDTH=360`, `PACE_WIDE_WIDTH=1200`,
      `PACE_NARROW_MS=3200`, `PACE_WIDE_MS=1800`; replace inline formula
      with linear interp. Narrow `pending` to "only the last message can
      indicate pending work" (current uses `findLast` — change to
      last-element-only). Update `working` to `!!pending() ||
sessionStatus().type !== "idle"`. Tighten `pb-16 → pb-4` mobile
      turn-list bottom padding.
    - Source commits: `2d497346a`, `f89d9034f`, rolled into the
      calmer-progress effort.
    - Preserve current's upstream `showSessionProgressBar` setting
      integration.
    - Risk: medium. The `working` derivation change is semantic.

18. **`feat(prompt): inline +/send buttons in mobile prompt input row`**
    - Files: `packages/app/src/components/prompt-input.tsx`
    - Changes: place `+` button, textarea, send button on the same
      horizontal row with `flex items-center gap-1 px-2 py-2`. Remove
      absolute positioning + fade gradient. `pb-1.5`/`pt-4` mobile
      spacing.
    - Source commits: `0842f5ead`, `c9517a7dd`, `11ddf8f5e`. Commit body
      should enumerate.
    - Risk: medium-high. Touches the prompt input markup. Reconcile
      against current's existing shell-mode UI + conditional variant
      selector + animation cleanup. Keep separate from commit 6's latch
      fix.

19. **`feat(app): persisted project cache in global-sync`**
    - Files: `packages/app/src/context/global-sync.tsx`,
      `packages/app/src/context/global-sync/child-store.ts`
    - Changes: persist global project list to
      `Persist.global("globalSync.project", ["globalSync.project.v1"])`
      via `persisted()`. Rehydrate from cache on mount when nothing has
      been written yet. Sanitize via `sanitizeProject` before write. Use
      `active` + `projectWritten` flags to avoid clobbering fresh server
      data with stale cache. Replace store-set with `cacheProjects()`
      after every write. In child-store, seed `projectMeta` from
      `meta[0].value`; on `meta[2]` resolution, replace if still equal
      to initial.
    - Source commits: not in the audit's commit table (older). Verify
      against plus's `global-sync.tsx` directly. Time-box verify pass to
      15 min; if longer, escalate or split.
    - Do not regress the upstream `6387b35a2` "log session sdk errors"
      addition that current already has.
    - Risk: medium. Adds persistence/rehydration lifecycle, not just UI
      layout. UX-motivated (faster startup) so kept in this plan, but
      flagged as the most architectural commit in the set.

### Phase 4 — Dashboard mobile rework (CANCELLED)

**Phase 4 is cancelled.** Dual-review (GPT-5) verified that current
`packages/app/src/pages/dashboard.tsx` is on a **newer upstream
refactor** than plus's version: extracted `dashboard-helpers.ts`,
store-based state, mobile compact rows, `mobileSidebar.hide()` on mount,
search/sort wiring, per-card new-session button — all already present.
Re-porting plus's older structure would be a regression.

The audit's B7 row (mobile dashboard rework) is therefore **closed as
"in via upstream"** — same status as B17 and B20–B36. Mark it as such in
the audit doc when sweeping at the end.

If a specific dashboard mobile UX issue is discovered in real use, file
it as a separate task — do not revive Phase 4 wholesale.

## Per-commit workflow

For each commit:

1. **Implement** in build mode, in-line edits unless task spans many
   files.
2. **Verify locally**: `bun typecheck` from `packages/app` (and
   `packages/ui` for commit 16); `bun test` from `packages/app` if
   tests touch the change. Visual smoke via `oc-dev` (HMR) or
   `oc-install-local` for compiled-binary checks. Do NOT restart
   running opencode sessions.
3. **Stage** with `git add` for the planned files only.
4. **Update audit doc**: mark the gap as ported in
   `docs/code-analysis/webui-plus-port-gaps.md` (one-line edit) and
   `git add` it. **Same commit as the code change** — keeps total
   commit count to 19, not 38.
5. **Commit** with `feat|fix|chore(scope): summary` + body enumerating
   the source commits (see commit specs for which need enumeration) and
   what the gap was. Author identity: Rafi Khardalian
   <rafi@actualyze.ai>.
6. **Dual review the committed change**: launch
   `Agent("code-review-opus", ...)` and
   `Agent("code-review-gpt5", ...)` **in parallel** with a prompt that
   includes:
   - The commit hash and committed file paths.
   - The source plus commits being ported (so the reviewer can compare
     via `git -C /Users/rmk/projects/oss/opencode-webui-plus show
<hash>`).
   - Reminder that this is a port, not new work — divergence from plus
     is the bug.
7. **Address all blockers and issues**, re-review until clean (cap 3
   rounds; if blockers remain after 3, report and ask user). Use
   `git commit --amend` for follow-up fixes within the same commit.
8. **No push** until user explicitly authorizes.

## Verification

After each commit:

- `bun typecheck` from `packages/app` clean.
- `bun test` from `packages/app` clean (if tests touched).
- Visual smoke via `oc-dev` (HMR) confirms feature behaves as plus did.

After each phase:

- Full `oc-install-local` build succeeds.
- The compiled `opencode` launches without crash.
- Spot-check a session view and the dashboard.

After Phase 2:

- iOS PWA smoke (real device or Safari emulation) confirms the pill
  appears in the titlebar, taps register, no titlebar bricking after
  pill width change, safe-area insets render.

## Risks

- **Reviewer load**: 19 commits × dual review = 38 review invocations.
  At ~30-90s per review, this is 20-60min of review time spread across
  the work. Acceptable; plan accommodates.
- **iOS PWA cannot be smoke-tested without a real device**. Phase 2's
  headline feature is iOS-specific. Recommend setting aside time on a
  real iOS device (or accepting Safari-emulation as the primary smoke).
- **Plus's source commits may have follow-up fixes** within the same
  hash range. Re-verify the actual diff at execute time, not from the
  audit's summary.
- **Current's upstream is newer than plus**. For each port commit,
  re-read current's version of the file BEFORE editing — the audit was
  thorough but I will encounter places where current has factored code
  differently and a naive port would regress.
- **i18n keys**: `session.header.refresh` only added to `en.ts` matching
  plus's scope. `parity.test.ts` only enforces 2 specific keys, so no
  CI failure. Other 17 locales remain untranslated — known polish-only
  debt.
- **Long-running opencode sessions** during the work: Phase 2 commits
  change the session-view UI structure significantly. Existing sessions
  continue running on their old binary; reload only after the work
  lands.
- **Commit 19 (persisted project cache)** is the most architectural
  item — not pure UI. Kept in plan because it's UX-motivated, but
  reviewers should scrutinize the persistence lifecycle carefully.

## Out of scope

- Server lifecycle restoration. Plus had a daemon and `manage.sh`;
  explicitly excluded.
- `plus/` overlay restoration.
- Build/CI/release pipeline differences.
- Tauri desktop changes except those that surface UI.
- i18n translation of `session.header.refresh` into 17 locales
  (English-only, matching plus).
- Dashboard mobile rework (Phase 4 cancelled — already in via newer
  upstream).
- Currently-newer-than-plus deltas: B17, B20–B36, and B7 of the audit
  — leave current alone.
- Plus's own iOS keyboard inset experiments that ended up reverted
  (`c0d4b749b`, `27037c1d2`, `b663fb787`, et al.).

## Revisions

- **2025-XX-XX**: Phase 4 cancelled after dual-review confirmed current
  dashboard is on newer upstream refactor with all plus mobile-dashboard
  intents already present. Final commit count revised from 15-24 to
  fixed 19. Added prereq note to Phase 2. Risk labels for commits 10,
  11, 19 corrected upward. Source-commit attribution corrected for
  commits 5, 14. Commit 13 picks up `d27d9e0e4` and the `isDesktop()`
  transition guard. Workflow step clarified that audit doc updates ride
  in the same commit as the code change.
