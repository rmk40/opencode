# Upstream Merge Process

How to merge a new upstream OpenCode release into the `actualyze` fork
release branch. Living document — extend as new decision points arise.

## Goal

The fork **mirrors** upstream. Every upstream release should land on
`actualyze` as soon as it's been smoke-tested locally and dual-reviewed.
The core stays compatible (no API or schema breaks); the fork carries
patches for bugs and the mobile/web UX work that motivated it.

## Vocabulary

- **Upstream**: `anomalyco/opencode` (`origin` remote in this checkout).
- **Fork**: `rmk40/opencode` (`fork` remote).
- **Release branch**: `actualyze`.
- **Default upstream branch**: `dev` (per repo `AGENTS.md`).
- **Upstream tag format**: `vX.Y.Z` (e.g. `v1.14.25`).
- **Fork tag format**: `vX.Y.Z-aai.N` (e.g. `v1.14.25-aai.1`).
- **N**: monotonically increasing integer per upstream baseline; resets
  to 1 when the upstream version bumps.

## Pre-flight

### 1. Tree state

```bash
cd /Users/rmk/projects/oss/opencode
git status --short
```

Working tree must be clean of tracked-file modifications. Untracked
docs/screenshots are fine to leave in place.

If anything is dirty, stash or commit before starting:

```bash
git stash push -m "pre-upstream-merge stash"
# ...later...
git stash pop
```

### 2. Fetch all remotes

```bash
git fetch origin --tags
git fetch fork --tags
```

### 3. Identify the new upstream version

Upstream tags follow `vX.Y.Z`. The latest one we haven't merged is the
target.

```bash
git ls-remote origin "refs/tags/v*" \
  | grep -v aai \
  | awk '{print $2}' \
  | grep -E "^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$" \
  | sort -V \
  | tail -5
```

Compare against our most recent fork tag baseline:

```bash
git tag -l 'v*-aai.*' --sort=-version:refname | head -5
```

The leading `vX.Y.Z` of the most recent fork tag is the previous
upstream baseline. The new upstream version is the merge target.

### 4. Verify branch position

```bash
git rev-parse actualyze
git rev-parse fork/actualyze
```

Both should match. If local is ahead, push first
(`git push fork actualyze`); if behind, pull
(`git pull --ff-only fork actualyze`). Don't merge while local
disagrees with the remote release branch.

### 4.5. Anchor tag

Create a local-only tag pointing at the pre-merge HEAD. This is
your clean revert target if anything goes wrong later — including
after you've already committed merge fixups on top, where
`git reset --hard fork/actualyze` would discard the fixups too.

```bash
NEW=v1.14.28   # the upstream tag you're about to merge
git tag -f "pre-merge-${NEW}" HEAD
echo "anchor: pre-merge-${NEW} = $(git rev-parse "pre-merge-${NEW}")"
```

If you're chaining multiple tags in one session (see 5.5 below),
one anchor at the start of the session is enough. Don't push the
anchor tag — it's a local safety net, not a release artifact. Drop
it after the merge is verified and tagged (`git tag -d pre-merge-*`).

## Investigation phase

### 5. Range size

Count the commits coming in:

```bash
git log --oneline v<PREV>..v<NEW> | wc -l
```

A range under 50 commits is routine. 50–200 deserves more careful
review. >200 means consider splitting the merge across multiple
intermediate tags or doing a focused diff against UI-relevant paths
first.

### 5.5. Single tag or multiple tags in one session

If several upstream release tags have landed since our last merge
(e.g. v1.14.26, v1.14.27, and v1.14.28 are all available and we
last merged at v1.14.25), you have two options:

- **One merge per tag, sequentially in one session.** Preferred when
  upstream tags are close together and conflict surface is overlapping
  (resolving the same file three times in one editing pass is faster
  than three separate sessions). Each merge becomes its own merge
  commit; bisect granularity is preserved.
- **One big merge straight to the newest tag.** Faster, but a
  regression introduced by any of the skipped intermediates can only
  be bisected across one giant merge commit. Acceptable when the
  intermediate tags are very small (under ~10 commits each) and you
  want one merge commit to revert if needed.

**Default to sequential per-tag merges.** Only collapse when you've
checked the intermediate ranges and confirmed they're trivial.

When chaining sequential merges:

- Run typecheck + tests after **each** merge before starting the next.
  A clean tree between merges keeps regressions attributable.
- One anchor tag (step 4.5) at the start of the session is sufficient
  — it points at the pre-session HEAD, and any of the per-tag merges
  can be unwound by resetting to it.
- The final fork release tag uses the **last** upstream version
  (`v<NEWEST>-aai.1`), not the intermediate hops.

### 6. UI-impact triage

Our scope is mobile and web UI work. Get an early read on whether
upstream touched anything we care about:

```bash
git diff --stat v<PREV>..v<NEW> -- packages/app packages/ui packages/shared 2>/dev/null
```

If the diff is empty or trivial (package.json bumps only), the merge
is mechanically simple and the risk surface is upstream backend. If
it's non-trivial, expect to spend time on conflict resolution and UI
regression testing.

### 7. Dry-run merge

```bash
git merge --no-commit --no-ff v<NEW>
```

Outcomes:

- **"Already up to date"** → nothing to do; abort and stop.
- **"Automatic merge went well; stopped before committing as
  requested"** → great. Continue to inspection.
- **"CONFLICT (...)"** → real conflicts. Continue to conflict
  resolution.

Inspect the staged result regardless of outcome:

```bash
git status --short | grep -v "^??"
git diff --cached --stat
```

If you want to bail without committing:

```bash
git merge --abort
```

## Conflict resolution

This section will grow as we encounter conflicts. Initial guidance:

### Decision-point matrix

| File area                                                      | Default resolution                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `package.json` / `bun.lock` / `nix/*.json`                     | Take upstream version bumps. Re-run `bun install` after merge.                                                 |
| `packages/app/src/components/titlebar.tsx`                     | Keep ours. iOS PWA hardening (B1 in the webui-plus port).                                                      |
| `packages/app/src/pages/session.tsx`                           | Keep ours for the mobile pill + per-pane sibling structure (`220a3ddfa`).                                      |
| `packages/app/src/components/prompt-input.tsx`                 | Keep our latch + inline-button layout. Reconcile carefully against upstream additions.                         |
| `packages/app/src/index.css`                                   | Keep our progress glide, content-visibility gate, 100lvh standalone rule.                                      |
| `packages/app/index.html`                                      | Keep our PWA meta tags.                                                                                        |
| `packages/app/public/site.webmanifest`                         | Symlink → `packages/ui/src/assets/favicon/site.webmanifest`. Keep our manifest.                                |
| `packages/app/src/context/global-sdk.tsx`                      | Keep our `restart`, `reconnecting`, `isTouchDevice` additions.                                                 |
| `packages/app/src/context/sync.tsx`                            | Keep our force-reconcile branch on `force: true`.                                                              |
| `packages/app/src/context/global-sync.tsx`                     | Keep our persisted project cache.                                                                              |
| `packages/app/src/components/session/session-header.tsx`       | Keep our mobile refresh button + isMd gate.                                                                    |
| `packages/app/src/pages/session/message-timeline.tsx`          | Keep our pace constants, last-msg pending guard, cv class swap.                                                |
| `packages/app/src/pages/session/composer/*`                    | Keep our mobile-collapse and safe-area work.                                                                   |
| `packages/ui/src/components/message-part.*`                    | Keep our mobile bash output cap.                                                                               |
| `script/`, `.github/workflows/`, `package.json` (root scripts) | Fork-owned files (`fork-release-artifacts.*`, `release:fork` script) are ours; everything else takes upstream. |
| `.github/workflows/fork-release-artifacts.yml`                 | Keep ours unchanged unless upstream changed something we depend on.                                            |
| `docs/code-analysis/`, `docs/plans/`                           | Always ours; ignore upstream additions in these dirs (we don't have them).                                     |
| `README.md`                                                    | Keep ours (fork mission). If upstream changes the lang README files, take theirs.                              |

### When the matrix doesn't cover it

Walk the conflict file by file. For each, ask:

1. **Did the webui-plus port (commits `9aec5f9ba` through `21c948fa2`)
   touch this file?** If yes, default to keeping our version unless
   upstream's change is a clear bug fix our version doesn't have.
2. **Is this file a fork-only artifact** (anything under `script/`
   matching `fork-*` or `oc-*`, the `release:fork` script in root
   `package.json`, our docs)? Always keep ours.
3. **Otherwise** — take upstream. Our policy is mirror, not diverge.

If the resolution is non-obvious, write the decision into the merge
commit body so the next merger has a precedent. Update this doc's
matrix when a non-obvious case repeats.

### Silent miss: package-wide refactors that don't conflict

The "keep ours" default for fork-owned files has a known failure
mode: when upstream applies a **mechanical refactor** package-wide
(e.g. renaming `@opencode-ai/shared/*` imports to
`@opencode-ai/core/*` after the v1.14.26 `shared` → `core` package
rename), the auto-merger only touches files where there's a textual
conflict. Fork-owned files are kept on the "ours" side without
warning, and any reference they have to the old name silently
survives.

**Symptoms:**

- `bun typecheck` may still pass under `skipLibCheck` + bundler
  resolution if the missing module's type shape happens to match.
- `bun test` may pass because the file isn't exercised in tests.
- Runtime fails with `ReferenceError`, `Cannot find module`, or
  similar once the old name is fully purged from `node_modules`.

**Counter:** after merging, before committing the merge, sweep for
known-renamed identifiers across all packages:

```bash
# Adjust the patterns to whatever upstream just renamed.
# Examples from past merges:
grep -rn '@opencode-ai/shared'  --include='*.ts' --include='*.tsx' --include='*.json' packages/ | grep -v node_modules
grep -rn '../../src/flag/flag'  --include='*.ts' --include='*.tsx' packages/ | grep -v node_modules
grep -rn '../../src/installation/version' --include='*.ts' packages/ | grep -v node_modules
```

If the upstream merge introduced a new package rename or a new
canonical import path, add a grep for it here. The patterns are
cheap to run; missing them costs a follow-up commit and a runtime
failure during smoke testing.

When you find stale references, fix them in the merge commit if
the merge isn't committed yet, or as a separate follow-up `fix:`
commit citing the upstream PR that did the rename. Cite the PR
either way — the commit becomes the precedent for the next merge.

### Resolving

Standard `git mergetool` works. For text-only conflicts, manual edit

- `git add <file>` is fine. After all conflicts resolved:

```bash
git status --short | grep "^U" # should be empty
```

## Verification

### 8. Stale-reference sweep, type-check, and tests

Before typecheck, run the stale-reference greps from the "Silent
miss: package-wide refactors" section above. Any hits are stale
imports the auto-merger missed; fix them now (in the merge commit
if the merge isn't committed yet, otherwise a follow-up `fix:`
commit citing the upstream rename PR).

Then run typecheck and tests from package directories (never repo
root — guard rejects):

```bash
cd packages/app && bun typecheck
cd packages/app && bun test
cd packages/ui && bun typecheck
cd packages/opencode && bun typecheck
cd packages/opencode && bun test
```

If any package's typecheck or tests regress, the merge is not done.
Most type errors after an upstream merge are SDK type drift in
packages we don't own; they need fixes in our code if they're in our
ported files. Don't disable tests to make the merge "go through".

Note: `bun typecheck` (tsgo with `skipLibCheck` + `bundler`
resolution) can pass even with a stale import to a deleted package
when the missing symbol's type shape happens to match. The
stale-reference grep above is the cheap counter — don't rely on
typecheck alone to catch package-wide renames.

### 9. UI smoke test

Build and run locally. Two paths:

**Source mode (HMR, fastest iteration):**

```bash
# Start backend on :4096
oc-localdev   # or `~/.local/bin/opencode-localdev`

# In another terminal, start Vite at :40960 against that backend
cd packages/app
VITE_OPENCODE_SERVER_HOST=127.0.0.1 VITE_OPENCODE_SERVER_PORT=4096 \
  bun run dev -- --port 40960 --strictPort
```

Open `http://localhost:40960` in browser at mobile viewport (390×844)
and desktop viewport (1440×900). Verify:

- Dashboard renders (mobile compact list; desktop card grid).
- Session view loads with messages.
- **Mobile pill** in titlebar: tap Session ↔ Changes is instant
  (commit `220a3ddfa` post-fix; pre-fix this hung on long sessions).
- **Mobile inline +/send** in prompt input row.
- **Desktop search portal** in titlebar center on session view.
- **Both panes simultaneous** on desktop.
- 0 console errors beyond the known CSP warning on `oc-theme-preload.js`.

**Compiled binary mode (production-shape):**

```bash
script/oc-install-local.sh
~/.local/bin/opencode --version   # should say 1.14.<NEW>-aai.local.<sha>
~/.local/bin/opencode --hostname 0.0.0.0 -c --allow-insecure-no-auth
```

Hit `http://localhost:4096`. Same checks as above.

### 10. Dual code review

Launch in parallel for any non-trivial merge (anything beyond
package-bump-only):

```
Agent("code-review-opus", description="Upstream merge review", prompt=...)
Agent("code-review-gpt5", description="Upstream merge review", prompt=...)
```

Prompt should include the upstream tag, the conflict-resolution
decisions, and the diff-stat against the previous fork tag. Re-review
after addressing blockers/issues. Cap 3 rounds.

## Commit and tag

### 11. Commit message

The merge commit subject is `Merge upstream <vX.Y.Z>`. Body
enumerates:

- Upstream commit count and range.
- Conflicts encountered and how they were resolved.
- Any decisions worth capturing for the next merge (then mirror those
  into this doc's matrix).
- Test/typecheck results.

```bash
git commit  # editor opens with the auto-generated merge message
```

### 12. Push branch

```bash
git push fork actualyze
```

Wait for the pre-push hook (typecheck) to pass.

### 13. Tag the fork release

```bash
NEW=1.14.25
SUFFIX=aai.1   # reset to .1 because upstream baseline bumped
bun run release:fork -- validate \
  --upstream-version "$NEW" --suffix "$SUFFIX"

git tag -a "v${NEW}-${SUFFIX}" -m "fork: v${NEW}-${SUFFIX} — upstream ${NEW} merge

Upstream merge of ${NEW} (commits A..B). <Decisions / fixes summary>."

git push fork "v${NEW}-${SUFFIX}"
```

Watch CI: `https://github.com/rmk40/opencode/actions`.

If CI fails, follow the rollback rules in the fork release pipeline
section of `AGENTS.md`: delete the tag, fix, re-tag with the SAME
suffix only if no release artifact was created; otherwise bump the
suffix.

## Rollback

If anything turns out wrong after merging but before tagging, you can
reset to the anchor tag from step 4.5:

```bash
git reset --hard pre-merge-v<NEW>   # the anchor tag, not fork/actualyze
git push fork actualyze --force-with-lease   # only if you'd already pushed
```

Reset to the **anchor tag**, not `fork/actualyze`. The anchor pins
the pre-session HEAD; resetting to `fork/actualyze` only works if
you haven't yet committed merge fixups on top of the merge — the
moment you've added a fixup commit (e.g. resolving a stale import
the auto-merger missed), `fork/actualyze` is no longer your clean
revert target.

`--force-with-lease` (not `--force`) ensures you don't clobber a
push someone else made. We're solo on this branch in practice but
the safer flag is free insurance.

After tagging, see `AGENTS.md` "Fork Release Operational Notes" for
the irreversibility rules around tags + GitHub Packages.

## Reference

- `AGENTS.md` "Actualyze Fork Release Branch" — repo invariants.
- `docs/code-analysis/webui-plus-port-gaps.md` — file-by-file map of
  fork divergence from upstream as of the webui-plus port.
- `docs/plans/webui-plus-port.md` — the original port plan; useful
  for cross-referencing why a given file diverged.

## Revisions

- **2026-04 initial**: drafted during the v1.14.24 → v1.14.25 dry-run.
  Merge dry-run produced 75 staged files (72 modified, 3 added, 0
  deletions, 0 conflicts). Only `package.json` required auto-merge.
  Range: 34 upstream commits. UI-package changes were package.json
  bumps only — no app/ui/app-shared source conflicts. The decision
  matrix is seeded from the webui-plus port mapping; expect to extend
  it on the first merge that hits a real conflict in those files.

- **2026-04 v1.14.25 → v1.14.28 multi-hop merge**: three sequential
  upstream merges (v1.14.26, v1.14.27, v1.14.28) in one session. 90
  upstream commits, 402 files, 16 content conflicts plus 1
  modify/delete (`packages/shared/` deleted upstream). Three additions
  to this doc came out of that merge:
  1. **Step 4.5 (anchor tag).** Created `pre-merge-v1.14.28` before
     starting; needed it to be the rollback target instead of
     `fork/actualyze` once two follow-up `fix:` commits landed on top
     of the merge commits.
  2. **Step 5.5 (single tag vs. multiple tags).** Merging tags one at
     a time produced cleaner bisect granularity than collapsing into
     one big merge would have, and the conflict-resolution muscle
     memory carried across the three hops.
  3. **"Silent miss: package-wide refactors" + grep sweep in step 8.**
     The v1.14.26 `shared` → `core` rename was applied package-wide
     upstream, but our fork-owned files (`dashboard.tsx`,
     `ui-embedded-shadow-worker.ts`, `ui.test.ts`) kept the old
     `@opencode-ai/shared/*` and `../../src/flag/flag` import paths
     because they're "ours" by default and had no textual conflict.
     `bun typecheck` passed; runtime would have failed. Caught by
     `code-review-opus` post-merge and added a grep sweep so the next
     mechanical refactor doesn't slip through.
