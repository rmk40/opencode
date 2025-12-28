#!/bin/bash
# Wrapper to run patched opencode from rmk branch
# Preserves current working directory as the project root

OPENCODE_DIR="/Users/rmk/projects/opencode/packages/opencode"
USER_DIR="$(pwd)"

# If first arg is not a flag and not empty, it's a project path - pass through
# Otherwise, inject current directory as the project argument
if [[ -n "$1" ]] && [[ "$1" != -* ]]; then
  # User specified a project path
  ARGS=("$@")
else
  # No project specified, use current directory
  ARGS=("$USER_DIR" "$@")
fi

# Change to opencode dir for module resolution
cd "$OPENCODE_DIR" && exec bun --conditions=browser "$OPENCODE_DIR/src/index.ts" "${ARGS[@]}"
