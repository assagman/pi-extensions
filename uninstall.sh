#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSIONS_DIR="$SCRIPT_DIR/extensions"
TARGET_DIR="$HOME/.pi/agent/extensions"

GREEN='\033[0;32m'
NC='\033[0m'

echo "Pi Extensions Uninstaller"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"

removed=0

for ext_dir in "$EXTENSIONS_DIR"/*/; do
  [[ ! -d "$ext_dir" ]] && continue
  
  ext_name=$(basename "$ext_dir")
  link_path="$TARGET_DIR/$ext_name"
  
  if [[ -L "$link_path" ]]; then
    link_target="$(readlink "$link_path")"
    # Only remove symlinks that point into this repo's dist/ directories
    if [[ "$link_target" == "$ext_dir"* ]]; then
      rm "$link_path"
      echo -e "  ${GREEN}✓${NC} Removed: $ext_name"
      removed=$((removed + 1))
    else
      echo "  ⏭ Skipped: $ext_name (symlink points elsewhere: $link_target)"
    fi
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "Removed: ${GREEN}$removed${NC} symlink(s)"
