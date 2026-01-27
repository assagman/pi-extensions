#!/usr/bin/env bash
set -euo pipefail

EXT_NAME="epsilon"
TARGET_DIR="$HOME/.pi/agent/extensions"

rm -f "$TARGET_DIR/$EXT_NAME"
echo "✅ Uninstalled: $TARGET_DIR/$EXT_NAME"
