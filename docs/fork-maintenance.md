# Fork Maintenance Guide

How to maintain `rmk40/opencode` against upstream `anomalyco/opencode`
without accumulating unnecessary divergence.

This is the operating manual for both the human maintainer and any
agent (Claude / opencode subagents / etc.) doing work on this fork.
Read it before starting any non-trivial change. Re-read it before
each upstream merge.

## North star

**Mirror upstream, deviate only on UX.**

Every line of code we carry that upstream does not is debt. Every
deviation in the core (CLI, server, schemas, plugin API, session
lifecycle) makes the next upstream merge harder and increases the
chance our build silently rots while upstream evolves. We accept
that debt only when:

1. The change is mobile/web UX work that motivated the fork in the
   first place, OR
2. Upstream has a bug we need fixed today and they haven't merged
   their own fix yet.

Anything else: take upstream.

The reciprocal rule is just as important: **when upstream lands an
equivalent fix for something we patched, revert ours and take theirs
wholesale.** We do not try to merge the two; we replace ours with
theirs, even if theirs is uglier or smaller-scoped than ours. Reasons:

- Future merges are simpler with less divergence.
- Upstream's version will keep getting upstream attention; ours
  won't.
- "Close enough" is the bar, not "identical." If upstream's fix
  addresses the same user-visible symptom and doesn't break our
  mobile/web work, that's enough.

## Constraints (hard rules)

- **No API breaking changes.** Plugins built against upstream must
  load against the fork. Sessions/configs created against upstream
  must read against the fork.
- **No schema breaking changes.** DB migrations stay upstream-only
  in practice. We don't add fork-only migrations.
- **No fork-only npm dependencies in core paths.** "Core paths"
  means anything outside `packages/app/`, `packages/ui/`, and
  fork-only scripts/docs. UI deps for mobile/web work are fine and
  expected. Adding deps the upstream build doesn't already have to a
  core path multiplies merge conflicts.
- **No reformatting unrelated code.** Don't run a global formatter
  pass; it generates spurious conflicts every merge.
- **Targeted, revertable commits.** One bug, one feature, or one
  refactor per commit (not necessarily one file). The reason is
  exactly the upstream-replacement workflow below — when upstream
  lands their version, we want a single SHA to revert.

## Decision tree for any incoming change

```
Is this fork-only infrastructure?
(release pipeline, oc-* scripts, fork docs, fork release CI)
├─ Yes → Carry it. These are intentional fork-owned areas.
│        Keep changes scoped, document rationale.
└─ No → Is this a mobile/web UX issue?
        ├─ Yes → Carry it. Note it as fork-intentional in the commit
        │        body. We are the canonical implementation; upstream
        │        may or may not adopt it.
        └─ No → Is upstream already aware of the issue?
                ├─ Already merged upstream
                │   ├─ In the upstream tag we'd target next
                │   │   → Merge that upstream tag. Do not patch.
                │   └─ Only on origin/dev after our last merged tag
                │       → Wait for the next upstream tag unless
                │         urgent. If patching now, cite the merge
                │         commit and revert ours when we merge that
                │         tag.
                ├─ Open PR exists with a working fix
                │   ├─ Active commits in last ~30 days, looks ready
                │   │   → If we can wait, wait and take theirs.
                │   ├─ Marked draft / WIP, author still iterating
                │   │   → Watch for landing; do not port yet.
                │   ├─ Stalled / not merging soon (>90d no activity)
                │   │   → Cherry-pick or port the PR to our shape.
                │   │     Reference the PR number in commit body.
                │   │     When it lands upstream, revert ours.
                │   └─ Closed without merging
                │       → Read the close comment for the rejection
                │         reason. Don't blindly port a rejected
                │         approach. Treat as "no upstream fix
                │         available" below if our reasoning differs.
                ├─ Open issue but no PR
                │   → Comment with our analysis if non-obvious;
                │     then: write our own fix, reference the issue.
                └─ No issue or PR
                    → Open one upstream first (or at least file the
                      analysis there). Then patch locally if we
                      need it now.
```

The default at every node: **prefer upstream's fix over ours, unless
it's UX, fork-only infra, or we genuinely need it before they ship.**

## Before patching anything in the core

Run this checklist. Skipping any of these multiplies the chance we
end up maintaining something upstream is about to fix.

### 1. Check for an existing upstream PR

Most stalled-feeling problems have an open PR somewhere upstream.
Find it before writing code:

```bash
# By file path (PRs touching the file we'd touch):
gh pr list --repo anomalyco/opencode --state all \
  --search "<filename or path keyword>" \
  --json number,state,title,url,headRefName \
  --limit 20

# By symptom keywords:
gh search prs --repo anomalyco/opencode \
  "<keyword phrase>" --json number,state,title,url --limit 20

# By head branch (if you know plus/another fork has the fix):
gh pr list --repo anomalyco/opencode --head "<branch-name>" --state all
```

Skim the results. If a PR matches the symptom:

- **Open with active commits in the last ~30 days**: read the diff,
  check the discussion. If reviewers have asked for changes the
  author hasn't made, our fix may need to follow the requested
  shape so it lands cleanly later.
- **Open but stalled (>90 days no activity)**: still cite it; our
  fix may need to be a wholesale port. Plan to revert ours when (if)
  the PR moves.
- **Closed without merging**: read the close comment. Often there's
  a reason the maintainer rejected the approach. Don't blindly port
  a rejected PR — we'd be carrying a permanent fork patch.
- **Merged**: verify whether the merge commit is in `origin/dev` or
  a release tag we've merged. Use:
  ```bash
  gh pr view <NNNNN> --repo anomalyco/opencode --json state,mergedAt,mergeCommit
  git merge-base --is-ancestor <mergeCommit.oid> v<our-current-baseline>
  ```
  If the merge commit is reachable from our current upstream
  baseline, the fix is already in our build — no patch needed. If
  it's only on `origin/dev` after our merged tag, the right action
  is "merge that upstream tag next," not "patch."

### 2. Check for an existing upstream issue

```bash
gh issue list --repo anomalyco/opencode --state all \
  --search "<keyword>" --limit 20
```

If an issue exists with no PR, that's a signal upstream knows about
the bug but hasn't prioritized it. Decide:

- We need this fixed today → patch + reference the issue number.
- We can wait → don't patch; bump the issue with our analysis if
  helpful.

### 3. Check if a sibling fork already has the fix

`opencode-webui-plus` has carried fork-only fixes that later landed
upstream. If we're patching something they already patched, learn
from their approach:

```bash
git -C /Users/rmk/projects/oss/opencode-webui-plus \
  log web-fork --oneline | grep -iE "<keyword>"
```

Don't blindly cherry-pick. Use it as reference — their fix may
predate refactors we already have.

### 4. Check if the fork already patched it

Don't double-patch. Search:

```bash
git log --oneline --grep "<keyword>" actualyze
git log --oneline --all -- <file-path>
```

**Never introduce a parallel patch for a bug we already patched.**
If we already have a fix in `actualyze`, refine the existing one
(amend if local-only and unpushed; follow-up commit referencing the
original SHA if already pushed). Two separate commits patching the
same bug make the eventual revert harder and the symptom less
greppable.

## Writing the patch

### Commit shape

One bug, one feature, or one refactor per commit. "One file per
commit" is too granular. The rule is **what gets reverted as a
unit**.

If the same bug touches three files, that's still one commit. If
two unrelated bugs both happen to touch `layout.tsx`, that's two
commits.

### Commit body must include

- **What the bug is** in user-visible terms ("stuck 'Thinking'
  shimmer after work completes").
- **Why upstream's current code has it** (the actual mechanism, not
  just the symptom).
- **Upstream linkage**: every PR/issue/commit we found that is
  relevant. Use one of these literal forms so future sweeps can
  grep them:
  - `Refs upstream PR anomalyco/opencode#NNNNN` (PR reference)
  - `Refs upstream issue anomalyco/opencode#NNNNN` (issue reference)
  - `Refs upstream commit anomalyco/opencode@<sha>` (direct commit)

  PRs and issues share a numeric namespace on GitHub, so the
  distinct `PR` / `issue` words are for grep convenience only.
  Multiple refs are fine and encouraged. The single grep that finds
  all of them is `git log --grep "Refs upstream"`.

- **Our resolution choice**: did we cherry-pick, port to our shape,
  or write our own? Why?

Example:

```
fix(timeline): trust session_status only for working derivation

[user-visible symptom]
[mechanism]

Refs upstream PR anomalyco/opencode#17593.

Lifted the idea (trust status, not message list) from PR #17593.
The diff in that PR predates our Effect migration of prompt.ts so
the structure doesn't apply directly. When PR #17593 lands upstream
(or any equivalent fix), revert this commit and take theirs.
```

### Avoid these in commit messages

- Vague refs like "see upstream" without a number.
- Claiming "this is a port of PR #X" if the diff was actually
  rewritten — say "lifted the idea from."
- Editorializing about upstream maintainers' priorities.

## Upstream merge cadence

Merge upstream version tags (`vX.Y.Z`) into `actualyze` as they land.
Not arbitrary `origin/dev` HEAD — we want known-good upstream
baselines so we have a clean baseline to bisect against if something
breaks.

Process documented separately in
[`docs/upstream-merge-process.md`](upstream-merge-process.md). That
doc covers:

- Pre-flight (tree state, fetching all remotes, identifying the
  target tag).
- Investigation (range size, UI-impact triage, dry-run merge).
- Conflict resolution decision matrix.
- Verification (typecheck, tests, smoke).
- Commit and tag.
- Rollback rules.

## After every upstream merge

This step is the lever that minimizes downstream maintenance. **It
is not optional.** Every upstream merge ends with a sweep of our
fork-only commits to identify ones we can drop:

### Sweep procedure

The goal is to identify each fork-only commit and decide whether
upstream has subsumed it. The sweep is against the upstream tag we
just merged, NOT against `origin/dev` (which is typically ahead of
the tag).

#### 1. Enumerate fork-only commits since the upstream baseline

```bash
# v<NEW> is the upstream tag we just merged.
NEW=v1.14.25
git log --no-merges --format='%H %s%n%b%n---' "${NEW}..actualyze"
```

`--no-merges` skips merge commits (they're not patches). `%b`
includes the body so you can grep for `Refs upstream PR`.

If you only want commits that already cite an upstream ref (the
common case for sweeping):

```bash
git log --no-merges --grep='Refs upstream' \
  --format='%H %s%n%b%n---' "${NEW}..actualyze"
```

For each commit returned, ask:

#### 2. Is the cited upstream PR merged into our baseline?

```bash
PR=17593
gh pr view "$PR" --repo anomalyco/opencode \
  --json state,mergedAt,mergeCommit

# If state == MERGED, verify the merge commit is in our baseline:
MERGE_SHA=$(gh pr view "$PR" --repo anomalyco/opencode \
  --json mergeCommit --jq '.mergeCommit.oid')
git merge-base --is-ancestor "$MERGE_SHA" "$NEW" \
  && echo "REDUNDANT: revert ours" \
  || echo "Not in this baseline; defer"
```

If the merge commit is reachable from `v<NEW>`, our patch is
redundant: revert ours. (Date comparison alone is unreliable —
upstream may rebuild a tag, revert a PR, or merge the PR after the
tag was cut.)

#### 3. Did upstream solve the same problem differently?

Some upstream fixes don't reference our PR ref because they came
through a different path. For each fork-only commit, identify the
files it touched and look for upstream activity there in the merge
range:

```bash
# Files our commit touched:
SHA=<fork-commit-sha>
git diff-tree --no-commit-id --name-only -r "$SHA"

# Upstream commits to those files in the merge range:
PREV=v1.14.24    # the previous upstream baseline
git log --oneline "${PREV}..${NEW}" -- $(git diff-tree --no-commit-id --name-only -r "$SHA")
```

Read the diffs. If upstream's approach addresses our symptom (not
necessarily line-by-line equivalent), revert ours.

#### 4. Is our patch still needed at all?

Sometimes the bug we patched simply ceased to exist because
surrounding code was rewritten. Smoke-test the symptom against the
post-merge tree with our patch reverted in a scratch branch:

```bash
git switch -c sweep-test-<sha> "$NEW"
git revert --no-edit <fork-commit-sha>
# rebuild + run the relevant smoke test
# if the bug is gone, the revert is safe to land on actualyze.
git switch actualyze
```

If the bug is gone, revert on `actualyze`. If it returns, our patch
is still needed for now; defer until upstream catches up or we open
our own upstream PR.

#### Reverting ours

When the sweep identifies a redundant commit:

```bash
git revert <fork-commit-sha>
```

The revert commit body **must** reference the upstream PR or merge
commit that made ours unnecessary using the same `Refs upstream PR
anomalyco/opencode#NNNNN` literal so future grep finds the linkage:

```
Revert "fix(timeline): trust session_status only for working derivation"

This reverts commit 3e7acb80d.

Refs upstream PR anomalyco/opencode#17593, merged in vX.Y.Z (commit
ABCDEF...). Their fix addresses the same stuck-Thinking symptom.
Take theirs to reduce fork divergence per docs/fork-maintenance.md.
```

Run typecheck + tests + visual smoke after the revert. Sometimes
upstream's fix and ours coexisted by coincidence; the revert may
expose a regression that needs a smaller follow-up patch focused on
the gap, not a re-assertion of the whole original patch.

### Sweep cadence

- **Required** after every upstream version-tag merge.
- **Recommended** any time a known fork-only commit references a PR
  number — periodically poll `gh pr view` and revert proactively
  rather than waiting for the next merge.

## Handling existing fork-only commits without upstream refs

Some commits predate this discipline. The audit document
(`docs/code-analysis/webui-plus-port-gaps.md` for the webui-plus
port) maps each ported file to its upstream lineage. When working
on those files, treat the audit as the cross-reference for what's
fork-intentional vs. accidental divergence.

Going forward, every new commit must have the upstream linkage in
the body. Old commits without a ref get the linkage tracked
externally if we notice during a sweep:

- **Do not amend pushed commits on `actualyze`.** It's a long-lived
  release branch with tags pointing into its history. Rewriting
  pushed commits forces consumers to re-fetch and breaks tag
  ancestry checks.
- Instead, add the linkage to a tracking doc that maps SHA →
  upstream ref. The audit doc above is one such map; if the file
  isn't covered there, append a note in
  `docs/code-analysis/upstream-refs.md` (create if it doesn't
  exist).
- Local, unpushed commits can be amended freely.

## When to open an upstream PR ourselves

If we patch something that:

- Is not UX (so it's not fork-intentional), AND
- Has no existing upstream PR, AND
- Is a clear bug or improvement that benefits all opencode users,

then **open an upstream PR with our fix**. The fork commit body
must reference our own upstream PR number (`Refs upstream PR
anomalyco/opencode#NNNNN`) so the revert path is set up from the
start. When upstream merges, we revert ours.

This is the cleanest possible deviation: temporary by construction.

Mobile/web UX work is different — those are fork-intentional. Open
upstream PRs for them only if upstream has indicated interest.

## Files we own vs. files upstream owns

The **authoritative conflict-resolution matrix lives in
[`docs/upstream-merge-process.md`](upstream-merge-process.md)**. The
table below is the high-level owner map for the "should I patch?"
decision; consult the merge-process doc for per-file conflict
resolution guidance.

| Area                                                                                                           | Owner                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Specific mobile/web UX port files listed in `docs/code-analysis/webui-plus-port-gaps.md`                       | Fork                                             |
| `packages/app/index.html` (PWA meta)                                                                           | Fork                                             |
| `packages/app/public/site.webmanifest` (symlinked to `packages/ui/src/assets/favicon/site.webmanifest`)        | Fork                                             |
| `packages/app/src/index.css` (mobile rules)                                                                    | Fork                                             |
| Other `packages/app/src/**` and `packages/ui/src/**` not in the port-gaps doc                                  | Default upstream; case-by-case if conflict       |
| `script/oc-*` (`oc-wrapper.sh`, `oc-dev-wrapper.sh`, `oc-install-local.sh`), `script/opencode-dev-preload.ts`  | Fork                                             |
| `script/fork-release-artifacts.sh`, `.github/workflows/fork-release-artifacts.yml`                             | Fork                                             |
| `docs/fork-*`, `docs/upstream-merge-process.md`, `docs/code-analysis/`, `docs/plans/`                          | Fork                                             |
| `docs/fork-release-pipeline.md`, `release-artifact-pipeline-plan.md`                                           | Fork                                             |
| `README.md` (fork mission)                                                                                     | Fork                                             |
| `AGENTS.md` (fork-maintenance philosophy section), `packages/app/AGENTS.md`, `CONTRIBUTING.md` (fork criteria) | Fork (merge upstream changes into our additions) |
| Root `package.json` `release:fork` script entry + fork-related deps                                            | Fork (preserve during merge)                     |
| Root `package.json` other entries (workspaces, catalog versions, etc.)                                         | Upstream (auto-merge)                            |
| `packages/opencode/src/**` (CLI, server, schemas, session, plugin)                                             | Upstream                                         |
| Schema files (`*.sql.ts`, `migration/`)                                                                        | Upstream                                         |
| `bun.lock`, `nix/hashes.json`                                                                                  | Upstream                                         |
| `README.<lang>.md` (other-language READMEs)                                                                    | Upstream                                         |

When the matrix doesn't cover a case: default to **taking upstream**
unless we have a documented intentional divergence in this guide or
a sibling doc.

## Anti-patterns to avoid

- **"Just one tiny fix, won't matter."** Every fork-only commit is
  permanent maintenance unless we sweep it out. There are no tiny
  fixes; there are only commits with upstream refs and commits
  without.
- **"I'll port the whole upstream PR."** When upstream's PR is
  large (multi-file refactor), porting it verbatim recreates a
  divergence even if it's a "good" divergence. Lift the minimum
  fix; cite the PR; revert when it lands.
- **"Upstream is going slow, let's just write our own architecture."**
  Reject. We mirror upstream. If we want a different architecture,
  we work it upstream first.
- **"This refactor will make future merges easier."** Almost
  certainly false. Upstream code that we refactor without upstream
  conflicts now until upstream changes the same code, then conflicts
  every merge forever. Refactor only with upstream's blessing or as
  part of a UX deviation.
- **"I'll squash the four commits into one for cleanliness."** Don't
  squash if each commit has a distinct upstream linkage and could be
  reverted independently. The concrete pain: `git revert -m 1
<merge-sha>` of a squashed commit unwinds unrelated changes you
  meant to keep. Cleanliness is for personal repos; fork hygiene
  wins.
- **"I'll add the upstream ref later."** Add it NOW, in the commit
  you're about to write. Future-you cannot grep for refs that don't
  exist yet, and "later" never happens.
- **"I'll fix it in a follow-up commit."** Same problem in the
  reverse direction — if the original commit body lacks the ref,
  the follow-up commit's ref doesn't help future sweeps grepping
  the original SHA's body.
- **"I'll resolve all UI conflicts by keeping ours."** Only
  intentional UX divergence is ours. Files in `packages/app/src/**`
  and `packages/ui/src/**` that are NOT in
  `docs/code-analysis/webui-plus-port-gaps.md` default to upstream.
  Keeping ours blanket-style on UI conflicts is how unintentional
  divergence accumulates.

## When this guide conflicts with itself

If the rules collide (e.g., "revert ours when upstream lands theirs"
vs "no API breaking changes" — what if upstream's fix introduces a
break we already worked around?), the default action is:

1. Take upstream's fix.
2. Accept the temporary regression in our workaround.
3. File a follow-up commit to re-add a narrow fix for the
   newly-exposed gap, with its own upstream-PR ref tracking.

If the regression is too severe to accept temporarily, flag it for
the human maintainer. The maintainer makes the call. Document the
decision in the relevant commit body so the next collision has
precedent.

## References

- [`AGENTS.md`](../AGENTS.md) — repo invariants and the
  fork-maintenance philosophy summary.
- [`docs/upstream-merge-process.md`](upstream-merge-process.md) —
  step-by-step merge runbook with conflict matrix.
- [`docs/code-analysis/webui-plus-port-gaps.md`](code-analysis/webui-plus-port-gaps.md)
  — file-by-file lineage of the original webui-plus port (precedent
  for what's fork-intentional in the UI).
- [`docs/plans/`](plans/) — design docs and per-feature plans.
- [`README.md`](../README.md) — fork mission for users.
