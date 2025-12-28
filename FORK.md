# Fork Maintenance Guide

This fork of [sst/opencode](https://github.com/sst/opencode) maintains custom patches on top of upstream.

## Branch Structure

| Branch | Purpose                                                  |
| ------ | -------------------------------------------------------- |
| `dev`  | Pure mirror of upstream `sst/opencode:dev` (auto-synced) |
| `rmk`  | Custom patches rebased on top of `dev`                   |

## Syncing with Upstream

### Option 1: Manual Sync (Recommended)

Run the sync script locally:

```bash
./script/sync-fork.sh
```

This will:

1. Check if upstream has new commits
2. Sync `dev` with upstream
3. Rebase `rmk` onto the updated `dev`
4. Force push both branches to your fork

### Option 2: Automatic Syncing (GitHub Actions)

**Note:** This only works if `dev` is set as your fork's default branch on GitHub.

A GitHub Action (`.github/workflows/sync-fork.yml`) can run every 2 hours to automatically sync and rebase. To enable:

1. Go to your fork on GitHub: Settings → Branches
2. Change default branch to `dev` (if not already)
3. The workflow will run on schedule or can be triggered manually via Actions tab

## Adding a New Patch

```bash
# Ensure you're on the rmk branch
git checkout rmk

# Make your changes
# ...

# Commit
git commit -m "feat: description of your patch"

# Push to fork
git push fork rmk
```

Then sync with upstream using one of the methods above.

## Resolving Rebase Conflicts

If the automated rebase fails (you'll get a GitHub notification):

```bash
# Fetch latest
git fetch origin
git fetch fork

# Checkout rmk and rebase manually
git checkout rmk
git rebase origin/dev

# Resolve conflicts
# ... edit files ...
git add <resolved-files>
git rebase --continue

# Force push the fixed branch
git push fork rmk --force
```

## Deploying

Deploy from the `rmk` branch - it always contains upstream + your patches.

```bash
git checkout rmk
git pull fork rmk
# ... deploy steps ...
```

## Current Patches

Patches in `rmk` branch (on top of upstream):

1. **MCP Auto-Reconnection** - Automatic reconnection for MCP servers
   - Addresses: #1878, #829
   - Status: Not yet submitted upstream

2. **Session Switcher** - Interactive dialog for navigating between subagent sessions
   - PR: https://github.com/sst/opencode/pull/6184
   - Status: Pending review
   - If merged upstream, this patch can be removed

3. **Fork Maintenance** - Documentation and tooling for maintaining this fork
   - Status: Fork-specific, will not be submitted upstream

## Upstream PRs

When submitting patches upstream:

1. Create a feature branch from `dev` (not `rmk`)
2. Make your changes
3. Push to fork and create PR against `sst/opencode:dev`
4. If accepted, remove the patch from `rmk` after upstream merges
5. If rejected, keep the patch in `rmk`
