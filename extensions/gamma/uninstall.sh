#!/usr/bin/env bash
set -euo pipefail

EXT_NAME="gamma"
EXT_TARGET="$HOME/.pi/agent/extensions/$EXT_NAME"

if [ -L "$EXT_TARGET" ]; then
  rm "$EXT_TARGET"
  echo "✅ Removed extension symlink: $EXT_TARGET"
elif [ -e "$EXT_TARGET" ]; then
  echo "⚠️  $EXT_TARGET exists but is not a symlink — skipping"
else
  echo "ℹ️  Extension not installed: $EXT_TARGET"
fi
