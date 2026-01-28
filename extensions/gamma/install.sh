#!/usr/bin/env bash
set -euo pipefail

EXT_NAME="gamma"
EXT_TARGET="$HOME/.pi/agent/extensions"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"

# Build
echo "Building $EXT_NAME..."
bun install
bun run build

# Verify dist exists
if [ ! -d "$DIST_DIR" ]; then
  echo "ERROR: dist/ not found after build" >&2
  exit 1
fi

# Install extension (symlink dist → extensions/)
mkdir -p "$EXT_TARGET"
ln -sfn "$DIST_DIR" "$EXT_TARGET/$EXT_NAME"
echo "✅ Extension: $DIST_DIR → $EXT_TARGET/$EXT_NAME"
