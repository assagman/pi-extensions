#!/usr/bin/env bash
set -euo pipefail

EXT_NAME="theta"
TARGET_DIR="$HOME/.pi/agent/extensions"
DIST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dist"

# Build
echo "Building $EXT_NAME..."
npm run build

# Verify dist exists
if [ ! -d "$DIST_DIR" ]; then
  echo "ERROR: dist/ not found after build" >&2
  exit 1
fi

# Create symlink
mkdir -p "$TARGET_DIR"
ln -sfn "$DIST_DIR" "$TARGET_DIR/$EXT_NAME"

echo "✅ Installed: $DIST_DIR → $TARGET_DIR/$EXT_NAME"
