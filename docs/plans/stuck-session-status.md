# Plan: Fix stuck "Thinking" / busy session indicator

## Symptom

User on the live web UI (mobile or desktop) sees:

- "Thinking" shimmer on the most-recent (or older) assistant message
  long after the server has finished work.
- The prompt input bar showing the `stop` icon (busy state) when
  there's nothing actually running.
- Sometimes spam-clicking the segmented pill or refreshing eventually
  resolves it; sometimes the page has to be reloaded.

User noted this was fixed once before in `opencode-webui-plus`.

## Empirical evidence

DB scan of `~/.local/share/opencode/opencode-aai.db` at the time of the
report:

```
12 incomplete assistant messages persisted across the DB.
Most recent: msg_dcb3d44b4002Rw8ni2fWOjjP63 in session
ses_23f798445ffeVKkW1qfdNWDsnd at 2026-04-26 12:21:23 (today, during
the user's reported session).
```

This is the live residue causing the symptom. Each one is an
assistant message whose processing started, was persisted to DB
(`time.created` set, `time.completed = undefined`), then crashed or
got interrupted before reaching `time.completed = Date.now()`.

## Investigation summary

There are **three** independent code paths that flag a session as
"working", and they don't all use the same source of truth:

| Where                                                 | Current logic                                       | Trusts                   |
| ----------------------------------------------------- | --------------------------------------------------- | ------------------------ |
| `prompt-input.tsx::working` (l. 246)                  | `status()?.type !== "idle"`                         | server status only       |
| `session-turn.tsx::working` (l. 323)                  | `status().type !== "idle" && active()`              | status AND `pending` msg |
| `session-turn.tsx::pending` (l. 201)                  | `messages.findLast(incomplete assistant)`           | full message list        |
| `message-timeline.tsx::working` (after our commit 17) | `!!pending() \|\| sessionStatus().type !== "idle"`  | status OR `pending` msg  |
| `sidebar-items.tsx::SessionItem.isWorking`            | message.findLast(incomplete) OR status non-idle     | status OR pending msg    |
| `session.tsx::busy(sessionID)`                        | non-idle status OR any incomplete assistant message | status OR pending msg    |

The "trusts message list" derivations have a long-tail failure mode:
the assistant message persists to DB the moment it's created
(`time.created = Date.now()`). If processing throws **anywhere**
before `time.completed` is set, the DB message stays un-finalized
forever. On any subsequent boot/reconnect/page-load, the UI sees that
message and renders it as "still pending".

The server status (`session_status` map) does correctly clear to idle:

- `processor.ts::halt` line 536 — `status.set(idle)` on assistant
  error path. (Already in upstream from `51d8219c46`.)
- `run-state.ts::cancel` line 80 — `status.set(idle)` when cancel is
  called on a runner that doesn't exist. (Equivalent to plus's
  `6c9b2c37a` fix; already in current upstream.)
- `runner.ts::finishRun` line 65 — runs `onIdle` callback (which
  calls `status.set(idle)`) on ANY fiber exit (success/failure/
  interrupt).

So **`session_status` is reliably idle** after error paths in current
code. The bug is **client-side message-list derivations** treating an
un-finalized DB message as a live indicator.

There are also two REAL holes that don't show up as the user-reported
symptom but are tangential:

1. The DB assistant message does keep `time.completed = undefined`
   forever after a setup-phase throw (between line 1423 message
   persistence and line 1485 `handle.process` in `prompt.ts`). This
   doesn't affect `session_status` but does feed the bad
   client-side derivations.
2. iOS PWA can miss the `session.idle` SSE event during background
   sleep. We auto-recover via:
   - visibilitychange → forceSync (touch devices only)
   - SSE reconnect edge → forceSync (all devices)

   Auto-recovery covers the sleep case; the persistent DB-residue
   case it does not.

## Root cause

`message.findLast(incomplete assistant)` was meant to detect "the
session is currently working on an assistant message". It actually
detects "the DB has an assistant message that was never finalized" —
which is a permanent property of any session that ever crashed
mid-stream, NOT a property of the current session state.

`session_status` is the correct source of truth for "is the session
working right now." The message list is the source of truth for
"what messages exist in this session."

Mixing the two confuses "still streaming" with "was once interrupted."

## Plus's prior fix (commit `6c9b2c37a`, by Dax)

Targeted at the symptom but server-side only. Two parts:

1. `processor.ts` halt path: `SessionStatus.set(idle)` after error
   publish. **Already in current via upstream `51d8219c46`.**
2. `prompt.ts::cancel`: when no in-flight runner exists, force
   `SessionStatus.set(idle)` rather than no-op. **Already in current
   via `run-state.ts::cancel` (the analogous Effect-era code).**

Plus's fix is therefore fully ported via upstream. **The plus fix is
not what's missing.**

## Upstream PR #17593 (open, by Shoubhit Dash)

`fix(app + tui): clear stale running session indicators`. More
comprehensive. Two commits:

- `060f482eb` — extracts `pages/session/activity.ts` exporting
  `pending(messages)` (last-msg-only) and `working(status)` (status
  only). Refactors `sidebar-items`, `session.tsx::busy`, and
  `session/message-timeline.tsx` to use the helpers. Adds tests.
  Also adds `session/assistant.ts` exporting `done(msg)` and a
  server-side `.catch(...)` in `prompt.ts` that finalizes the
  in-flight assistant message before re-throwing.
- `6bfce604b` — inlines the helpers (deletes the activity module),
  reverts the `working = pending() || status` half of the helper to
  pure `status.type !== "idle"`. Same logic in `tui` route.

Net effect of both commits combined:

1. **Drop message-list derivations** in
   `sidebar-items.tsx::SessionItem.isWorking`,
   `session.tsx::busy()`, and
   `session/message-timeline.tsx::working`. Trust status only.
2. **Tighten** `session-turn.tsx::pending` and `tui::pending` to
   last-msg-only.
3. **Add server-side** `.catch` around the prompt setup phase to
   finalize the assistant message before propagating the error.

Item 3 cannot apply cleanly: the upstream PR is against the older
non-Effect prompt.ts. Current uses `Effect.fn` + `Effect.gen`. The
fix needs an Effect translation.

## Plan

Three commits, in order:

### Commit 1: Trust session_status only on the client

- `packages/app/src/pages/session/message-timeline.tsx`: revert our
  commit 17's `working = !!pending() || sessionStatus().type !== "idle"`
  to `working = sessionStatus().type !== "idle"`. Keep the
  last-msg-only `pending` derivation (it's still used for
  `activeMessageID` and the working-class progress glide).
- `packages/app/src/pages/session.tsx::busy(sessionID)`: drop the
  `findLast incomplete assistant` check; trust status only.
- `packages/app/src/pages/layout/sidebar-items.tsx::SessionItem.isWorking`:
  drop the `findLast incomplete assistant` check; trust status only.
- `packages/ui/src/components/session-turn.tsx::pending`: tighten to
  last-msg-only (was `findLast(incomplete assistant)` — now
  `last-of(messages)` then check incomplete). The `active` and
  `pendingUser` derivations downstream stay correct.

This alone fixes the user-visible symptom for both desktop and
mobile because all three "stuck Thinking" / "stuck busy" rendering
paths now read `session_status`, which is reliably idle.

### Commit 2: Server-side guarantee — finalize message on setup-phase throw

- Wrap the prompt-setup `Effect.gen` block at
  `packages/opencode/src/session/prompt.ts` lines 1430-1528 in a
  `.pipe(Effect.tapErrorCause(cause => ...))` (or equivalent) that:
  - Reads `handle.message.time.completed`. If undefined, set it to
    `Date.now()` and `yield* sessions.updateMessage(handle.message)`.
  - Always rethrow the original cause.

This stops new assistant messages from being persisted with
`time.completed = undefined`. Old messages are still in DB but
commit 1's UI changes make them irrelevant.

This is structurally similar to PR #17593's `.catch(...)` block, but
expressed as Effect instead of Promise.

### Commit 3: Add a one-shot DB sweep

Optional. On server boot, scan recent assistant messages where
`time.completed` is undefined AND the message's session is not
currently busy, and finalize them. Catches the residue from sessions
that crashed before commit 2 landed.

Decide based on volume — if there are hundreds of stale messages in
the user's DB, do this; otherwise the in-flight-only fix from
commit 2 is enough and stale messages are tolerated as cosmetic
debt.

## Risk and rollback

### Commit 1 (UI)

- **Risk: low.** Drops conservative checks. The only failure mode is
  if `session_status` legitimately fails to update on some path —
  but if that happens, message-list derivations don't help (they
  produce false positives, not false negatives).
- **Rollback**: revert the commit. Returns to current behavior
  (which has the bug).

### Commit 2 (server)

- **Risk: medium.** Adds a `Session.updateMessage` call on the error
  path. If the update itself throws, we'd swallow the error chain;
  use `Effect.catchAllCause` on the inner update to log and ignore.
- **Risk: minor data churn**. Each error path now writes the
  in-flight message once more before re-throwing. Negligible volume.
- **Rollback**: revert. Setup-phase errors stop finalizing; old
  behavior restored (clean + stale assistant messages persist).

### Commit 3 (DB sweep)

- **Risk: low** (read + targeted update on bootstrap). Bound the scan
  to recent messages (e.g. last 7 days) to keep boot time fast.
- **Rollback**: revert; old residue lingers but commits 1+2 already
  hide it from the UI.

## Verification

After commit 1:

- Open a session that previously showed stuck "Thinking". Refresh.
  Status should be idle; no shimmer; input bar should not show stop
  icon.
- Tap into a session that's actually running. Working indicators
  should still appear.

After commit 2:

- Force a setup-phase error (e.g. delete a model from auth, then
  send a prompt with that model). Confirm:
  - Server logs show the throw.
  - DB-persisted assistant message has `time.completed` set.
  - `session_status` is idle (already true via existing halt path).
  - Client UI shows the message with an error indicator (existing
    behavior) but NO stuck shimmer.

`bun typecheck` and `bun test` pass for both `packages/app` and
`packages/opencode`.

## Out of scope

- Persisting `session_status` across server restarts. The in-memory
  Map is sufficient because runner state is also in-memory and
  always cleared on restart.
- Reworking the SSE missed-event recovery for non-touch desktop
  devices. The reconnect-edge force-sync (commit 13's createEffect)
  already covers this path; the user-reported symptom is the
  message-residue case, not the SSE-drop case.
- Porting PR #17593 verbatim. The structure has diverged enough that
  a port is more risk than a targeted fix; we lift the ideas, not
  the diff.
