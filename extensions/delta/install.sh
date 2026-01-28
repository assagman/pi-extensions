#!/usr/bin/env bash
set -euo pipefail

EXT_NAME="delta"
EXT_TARGET="$HOME/.pi/agent/extensions"
SKILL_TARGET="$HOME/.pi/agent/skills"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
SKILL_DIR="$SCRIPT_DIR/skill"

# Build
echo "Building $EXT_NAME..."
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

# Install skill (symlink skill/ → skills/)
if [ -d "$SKILL_DIR" ]; then
  mkdir -p "$SKILL_TARGET"
  ln -sfn "$SKILL_DIR" "$SKILL_TARGET/$EXT_NAME"
  echo "✅ Skill:     $SKILL_DIR → $SKILL_TARGET/$EXT_NAME"
fi
