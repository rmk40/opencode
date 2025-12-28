#!/usr/bin/env bash
set -euo pipefail

# Sync fork with upstream releases and rebase patches
# Usage: ./script/sync-fork.sh

UPSTREAM_REMOTE="origin"  # sst/opencode
FORK_REMOTE="fork"        # rmk40/opencode
UPSTREAM_BRANCH="dev"
PATCH_BRANCH="rmk"

echo "🔍 Checking for new upstream releases..."

# Fetch all remotes
git fetch "$UPSTREAM_REMOTE"
git fetch "$FORK_REMOTE"

# Find latest release commit (pattern: "release: v1.0.XXX")
LATEST_RELEASE=$(git log "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" --oneline --grep="^release: v" --max-count=1 --format="%H")
LATEST_VERSION=$(git log "$LATEST_RELEASE" --oneline --format="%s" -1)

if [ -z "$LATEST_RELEASE" ]; then
  echo "❌ No release commits found in upstream"
  exit 1
fi

# Get current base of rmk branch (first commit that's not our patches)
CURRENT_BASE=$(git merge-base "$FORK_REMOTE/$PATCH_BRANCH" "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")

if [ "$CURRENT_BASE" = "$LATEST_RELEASE" ]; then
  echo "✅ Already based on latest release: $LATEST_VERSION"
  echo "   Commit: $(echo $LATEST_RELEASE | cut -c1-8)"
  exit 0
fi

echo "📥 New release detected: $LATEST_VERSION"
echo "   Current base: $(git log $CURRENT_BASE --oneline --format="%s" -1 | cut -c1-60)"
echo "   New release:  $LATEST_VERSION"
echo ""

# Sync dev with upstream (for reference)
echo "🔄 Syncing $UPSTREAM_BRANCH with upstream..."
git checkout "$UPSTREAM_BRANCH"
git reset --hard "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git push "$FORK_REMOTE" "$UPSTREAM_BRANCH" --force --no-verify

echo "✅ $UPSTREAM_BRANCH synced"
echo ""

# Rebase rmk onto latest release
echo "🔄 Rebasing $PATCH_BRANCH onto $LATEST_VERSION..."
git checkout "$PATCH_BRANCH"

if git rebase --onto "$LATEST_RELEASE" "$CURRENT_BASE" "$PATCH_BRANCH"; then
  echo "✅ Rebase successful"
  git push "$FORK_REMOTE" "$PATCH_BRANCH" --force --no-verify
  echo "✅ $PATCH_BRANCH pushed to fork"
else
  echo "❌ Rebase failed - conflicts detected"
  echo ""
  echo "To resolve:"
  echo "  1. Fix conflicts in the listed files"
  echo "  2. git add <resolved-files>"
  echo "  3. git rebase --continue"
  echo "  4. git push $FORK_REMOTE $PATCH_BRANCH --force --no-verify"
  exit 1
fi

echo ""
echo "🎉 Sync complete!"
echo "   Base release: $LATEST_VERSION ($(echo $LATEST_RELEASE | cut -c1-8))"
echo "   Patches: $(git log $LATEST_RELEASE..$PATCH_BRANCH --oneline | wc -l | tr -d ' ')"
