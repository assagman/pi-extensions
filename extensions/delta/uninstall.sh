#!/usr/bin/env bash
set -euo pipefail

EXT_NAME="delta"
EXT_PATH="$HOME/.pi/agent/extensions/$EXT_NAME"
SKILL_PATH="$HOME/.pi/agent/skills/$EXT_NAME"

# Remove extension
if [ -L "$EXT_PATH" ]; then
  rm "$EXT_PATH"
  echo "✅ Extension removed: $EXT_PATH"
elif [ -e "$EXT_PATH" ]; then
  rm -rf "$EXT_PATH"
  echo "✅ Extension removed: $EXT_PATH"
else
  echo "Extension not installed: $EXT_PATH"
fi

# Remove skill
if [ -L "$SKILL_PATH" ]; then
  rm "$SKILL_PATH"
  echo "✅ Skill removed: $SKILL_PATH"
elif [ -e "$SKILL_PATH" ]; then
  rm -rf "$SKILL_PATH"
  echo "✅ Skill removed: $SKILL_PATH"
else
  echo "Skill not installed: $SKILL_PATH"
fi
