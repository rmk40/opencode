# Plan: Finalize in-flight assistant messages on prompt-setup throw

Follow-up to `docs/plans/stuck-session-status.md`. Commit 1 (UI) of
that plan shipped in `v1.14.25-aai.1` and is in the running binary
(verified via `git merge-base --is-ancestor` against `993864211`).
Commits 2 (server-side `Effect.tapErrorCause` finalizer) and 3 (DB
sweep on boot) did not.

## Symptom

User reports stuck "Thinking" persists after `aai.1`. DB scan at the
time of the report:

```
13 incomplete assistant messages
Most recent: msg_dcc931a9d002Ub3qUdQWVf4lKu @ 2026-04-26 18:34:45
            (after aai.1 was running, in a different session)
            msg_dcc91f3ed0026ZZBQSHNYsdC99 @ 2026-04-26 18:33:30
            (also after aai.1, different session)
```

Two new incomplete messages in the live binary. New residue is being
generated, not just historical residue showing through.

## Why Commit 1 alone wasn't enough

Commit 1 stopped the four UI derivations from misreading
`messages.findLast(incomplete assistant)` as "session is working".
That correctly hides historical DB residue.

But it cannot hide residue from the **last** assistant message of a
session, because `session-turn.tsx::pending` deliberately checks the
last message (the legitimate "this turn is currently streaming"
case). If the last message is incomplete, the turn IS pending —
unless the work that should have finalized it errored out before
the finalize point.

Concretely: a user opens a session, types a prompt, the prompt-
setup phase throws (e.g. tool resolution fails, plugin trigger
errors, model lookup races), the assistant message stays in DB
with `time.completed = undefined`, and from that moment onward the
last-message-only `pending` check renders that turn as forever
"Thinking". `session_status` is correctly idle (the throw clears
it via `runner.ts::finishRun`'s `onIdle`), so the prompt-input
stop icon clears, but the per-turn shimmer doesn't.

## Where the finalize gap is

`packages/opencode/src/session/prompt.ts::runLoop`:

```
line 1410   const msg: MessageV2.Assistant = { time: { created: Date.now() }, ... }
line 1425   yield* sessions.updateMessage(msg)        ← persisted to DB, no `completed`
line 1426   const handle = yield* processor.create({ assistantMessage: msg, ... })
line 1432   const outcome = yield* Effect.gen(function* () {
              ...
line 1436     const tools = yield* resolveTools(...)   ← can throw (agent/tool config)
line 1476     yield* plugin.trigger(...)               ← can throw (plugin error)
line 1478     yield* Effect.all([...])                 ← can throw (sys/instruction)
line 1487     const result = yield* handle.process(...)
              })
```

`handle.process` (line 1487) is wrapped in `Effect.ensuring(cleanup())`
inside `processor.ts` (`packages/opencode/src/session/processor.ts:581`),
and `cleanup` does set `time.completed = Date.now()` at line 519.
So errors **inside** `handle.process` are already finalized.

The gap is **before** `handle.process` is reached: anything between
line 1425 (persistence) and line 1487 (handle.process invocation)
that throws leaves `time.completed` undefined and never enters the
`Effect.ensuring(cleanup())` scope.

Additional paths in the same risk class (handled by the same fix):

- `handleSubtask` at line 528: persists `assistantMessage` at line
  541 then runs subtask logic; final completion at line 666 is
  conditional on success.
- `shellImpl` at line 721: persists `msg` at line 745 then 770;
  finalize at line 852 is in a try-block that may not always reach.

The same `Effect.tapErrorCause` finalizer pattern works for all
three call sites.

## Fix

### The fix (single commit, runLoop-only scope)

Wrap the assistant-message-persist + `processor.create` + inner
prompt-setup gen in a single `Effect.gen` and apply `Effect.onError`
(Effect v4 helper that runs on any non-success Cause — failure,
defect, or interrupt — and rethrows the original cause automatically).

The cleanup body must be infallible (`never` in the E channel). Use
`Effect.catchCause(() => Effect.void)` for the inner `sessions.updateMessage`,
NOT `Effect.ignore` — `Effect.ignore` in Effect v4 only converts typed
failures (`Fail`) and may re-propagate defect causes, masking the
original prompt-setup error.

Inlined at the call site (used once, so no named helper per
`AGENTS.md` style):

```ts
const msg: MessageV2.Assistant = {
  /* ... existing literal ... */
}
const outcome: "break" | "continue" =
  yield *
  Effect.gen(function* () {
    yield* sessions.updateMessage(msg)
    const handle = yield* processor.create({
      assistantMessage: msg,
      sessionID,
      model,
    })
    return yield* Effect.gen(function* () {
      /* current 1432-1529 body, using `handle` from outer scope */
    }).pipe(Effect.ensuring(instruction.clear(handle.message.id)))
  }).pipe(
    Effect.onError(() =>
      Effect.gen(function* () {
        if (typeof msg.time.completed === "number") return
        msg.time.completed = Date.now()
        yield* sessions.updateMessage(msg).pipe(Effect.catchCause(() => Effect.void))
      }),
    ),
  )
```

Why this scope:

- `processor.create` itself yields `snapshot.track()` at
  `processor.ts:112` before allocating its context. `snapshot.track()`
  does git operations that can fail. A failure there leaves `msg`
  persisted (line 1425 already ran) but `handle` undefined — outside
  the scope of any existing `Effect.ensuring`.
- The wrap point used to be the inner gen's `.pipe(Effect.ensuring(
instruction.clear(handle.message.id)))` at line 1530, but
  `instruction.clear` requires `handle.message.id` so it cannot move
  outward. Move it inside the inner gen and put the new finalizer on
  the outer gen.

Why `Effect.onError` not `Effect.tapErrorCause` or `Effect.onExit`:

- `onError` fires on any non-success Cause (Fail, Die, Interrupt).
  `tapErrorCause` is functionally equivalent for this case;
  `onError` was picked because the existing codebase already uses
  `Effect.onExit` (`packages/opencode/src/effect/runner.ts:82`),
  making `Effect.onError` a closer-to-precedent name.
- `onExit` fires on every exit including success. Wrong here — it
  would generate a redundant `updateMessage` event publish on every
  successful turn (idempotence guard prevents the DB-side double-
  write but not the event publish).
- Effect v4 finalizers (`onError`, `ensuring`, `addFinalizer`) all
  run **uninterruptibly** by default, so the cleanup body cannot be
  interrupted mid-write.

Why runLoop only:

- Empirical evidence: 13 incomplete messages in the user's DB at
  report time, all with `error = undefined`. None went through
  `halt` (which sets `error`). Of those 13, four have zero parts
  (pure setup-throw with no progress) and the rest have step-start +
  tool parts (post-process-entry crashes that should already be
  covered by `processor.cleanup` via `Effect.ensuring`, but
  evidently aren't, suggesting `cleanup` itself races with
  interrupt finalization).
- `handleSubtask` (line 528) and `shellImpl` (line 721) already have
  their own finalize paths via `Effect.ensuring` and explicit
  `time.completed = Date.now()`. Empirical data does not implicate
  them. **Defer**: if subsequent residue traceable to those paths
  appears, a follow-up commit applies the same pattern there.

Idempotence:

- `msg` (prompt.ts:1410) and `handle.message` are the same JS
  reference. `processor.create` at processor.ts:113-124 stores
  `ctx.assistantMessage = input.assistantMessage` with no clone.
- If `processor.cleanup` runs first (when `handle.process` was
  reached and then errored), it sets `time.completed` and persists.
  When the outer `onError` then runs, the guard
  `if (typeof msg.time.completed === "number") return` no-ops.
- A duplicate `updateMessage` would be harmless anyway —
  `sessions.updateMessage` publishes a `SyncEvent.run` that the
  projector reacts to. The projector is idempotent for the same
  message id with the same shape.

Upstream linkage:

- Upstream PR `anomalyco/opencode#17593` (open, by Shoubhit Dash)
  describes the same diagnosis: "backend now finalizes assistant
  messages when prompt setup fails." It predates the Effect
  migration in this codebase, so the diff cannot port verbatim — we
  lift the idea, not the diff. The commit body must include
  `Refs upstream PR anomalyco/opencode#17593` per fork-maintenance.md.

UI consequence (no error indicator):

- The finalizer only sets `time.completed`. It does NOT set
  `msg.error`, so the resulting assistant message renders as
  "completed without success indicator" — no shimmer (good), no
  error badge (could be misleading). The throw was a genuine error,
  but at the finalize point we don't have a structured cause to
  attach. Acceptable for this commit; users get the silenced
  shimmer and can retry. A follow-up could attach a synthetic
  `NamedError.Unknown { message: "Prompt setup failed" }` — defer
  pending empirical observation of how often the finalizer fires.

### Why not also a DB sweep on boot

The plan's Commit 3 (boot-time sweep) was optional, gated on
"decide based on volume". Volume is 13 messages. That's
manageable as cosmetic debt. Skipping the sweep keeps the change
minimal and maintains the principle that we don't bulk-mutate user
DB state without explicit opt-in. The 13 stale messages stay
visible only on their respective last-message turns; UI is calmer
overall after Commit 1, and the finalize fix stops new residue from
forming.

If user reports specific old sessions where stuck Thinking is
still visible after this change, we add a one-shot opt-in sweep
command.

## Risk

- **Idempotent**: only runs the update if `time.completed` is
  undefined. Cannot finalize a message twice.
- **Cause preserved**: `tapErrorCause` re-throws automatically.
- **`Effect.ignore` on the inner `updateMessage`**: if the DB write
  itself errors (disk full, etc.), we don't mask the original
  cause with a secondary error.
- **Reactive consumers**: setting `time.completed` and publishing
  the updated message will cause UI clients to re-render the turn
  as completed-with-error (existing behavior — the `error` field
  set elsewhere on the message drives the error visual). No new
  state machine.

## Verification

After the change:

1. `bun typecheck` from `packages/opencode` clean.
2. Manually trigger a prompt-setup error. Note that "delete a
   model from auth config" probably won't work — model lookup
   happens via `getModel` at line 1369, **before** the new wrap
   scope, so a model-not-found error throws too early. Reliable
   repros that land inside the wrap scope:
   - Misconfigure an MCP server so its tool list errors during
     `resolveTools` (line 1436-1444).
   - Inject a synthetic throw in a `plugin.trigger(
"experimental.chat.messages.transform", ...)` handler (line
     1476).
   - Force `processor.create`'s `snapshot.track()` to fail (e.g.
     by making the working tree non-readable mid-prompt).

   Expected: server logs the throw; DB-persisted assistant message
   has `time.completed` set; UI shows the message WITHOUT an error
   indicator (the finalizer doesn't set `msg.error`) and WITHOUT a
   stuck shimmer (the new last-msg-only `pending` derivation from
   the parent plan now sees a finalized message).

3. SQL probe at `~/.local/share/opencode/opencode-aai.db`:

   ```sql
   SELECT id, datetime(time_created/1000, 'unixepoch', 'localtime')
   FROM message
   WHERE json_extract(data, '$.role') = 'assistant'
     AND json_extract(data, '$.time.completed') IS NULL
   ORDER BY time_created DESC LIMIT 10;
   ```

   Count should not increase across new prompt errors after this
   commit lands. The 13 historical messages are a separate concern
   (cosmetic; visible only on their respective last-message turns;
   could be addressed by an opt-in DB sweep in a follow-up if
   user-visible).

## Out of scope

- Persisting `session_status` across server restarts (already
  out-of-scope per parent plan).
- Bulk DB sweep of historical residue.
- iOS PWA missed-SSE recovery for non-touch desktop devices.
