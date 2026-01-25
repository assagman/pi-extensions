#!/usr/bin/env bash
set -euo pipefail

EXT_NAME="theta"
TARGET_PATH="$HOME/.pi/agent/extensions/$EXT_NAME"

if [ -L "$TARGET_PATH" ]; then
  rm "$TARGET_PATH"
  echo "✅ Uninstalled: $TARGET_PATH"
elif [ -e "$TARGET_PATH" ]; then
  rm -rf "$TARGET_PATH"
  echo "✅ Removed: $TARGET_PATH"
else
  echo "Not installed: $TARGET_PATH"
fi
