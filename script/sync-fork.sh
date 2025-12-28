#!/usr/bin/env bash
set -euo pipefail

# Sync fork with upstream and rebase patches
# Usage: ./script/sync-fork.sh

UPSTREAM_REMOTE="origin"  # sst/opencode
FORK_REMOTE="fork"        # rmk40/opencode
UPSTREAM_BRANCH="dev"
PATCH_BRANCH="rmk"

echo "🔍 Checking for upstream changes..."

# Fetch all remotes
git fetch "$UPSTREAM_REMOTE"
git fetch "$FORK_REMOTE"

# Check if upstream has new commits
LOCAL=$(git rev-parse "$FORK_REMOTE/$UPSTREAM_BRANCH" 2>/dev/null || echo "none")
REMOTE=$(git rev-parse "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "✅ Fork is up to date with upstream"
  echo "   $UPSTREAM_REMOTE/$UPSTREAM_BRANCH: $REMOTE"
  exit 0
fi

echo "📥 New upstream commits detected"
echo "   Local:    $LOCAL"
echo "   Upstream: $REMOTE"
echo ""

# Sync dev with upstream
echo "🔄 Syncing $UPSTREAM_BRANCH with upstream..."
git checkout "$UPSTREAM_BRANCH"
git reset --hard "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git push "$FORK_REMOTE" "$UPSTREAM_BRANCH" --force --no-verify

echo "✅ $UPSTREAM_BRANCH synced"
echo ""

# Rebase rmk onto dev
echo "🔄 Rebasing $PATCH_BRANCH onto $UPSTREAM_BRANCH..."
git checkout "$PATCH_BRANCH"

if git rebase "$UPSTREAM_BRANCH"; then
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
echo "   $UPSTREAM_BRANCH: $(git rev-parse $FORK_REMOTE/$UPSTREAM_BRANCH | cut -c1-8)"
echo "   $PATCH_BRANCH: $(git rev-parse $FORK_REMOTE/$PATCH_BRANCH | cut -c1-8)"
