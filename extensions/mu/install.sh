#!/usr/bin/env bash
set -euo pipefail

EXT_NAME="mu"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$HOME/.pi/agent/extensions"
DIST_DIR="$SCRIPT_DIR/dist"

# Build shared-tui dependency first
echo "Building shared-tui..."
(cd "$SCRIPT_DIR/../shared/tui" && bun install --frozen-lockfile 2>/dev/null || bun install && bun run build)

# Build
echo "Building $EXT_NAME..."
bun install --frozen-lockfile 2>/dev/null || bun install
bun run build

# Verify dist exists
if [ ! -d "$DIST_DIR" ]; then
  echo "ERROR: dist/ not found after build" >&2
  exit 1
fi

# Create symlink
mkdir -p "$TARGET_DIR"
ln -sfn "$DIST_DIR" "$TARGET_DIR/$EXT_NAME"

echo "✅ Installed: $DIST_DIR → $TARGET_DIR/$EXT_NAME"
