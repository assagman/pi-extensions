#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSIONS_DIR="$SCRIPT_DIR/extensions"
TARGET_DIR="$HOME/.pi/agent/extensions"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# CI mode: pass --frozen-lockfile to bun install
BUN_INSTALL_FLAGS=()
if [[ "${1:-}" == "--ci" ]]; then
  BUN_INSTALL_FLAGS+=(--frozen-lockfile)
  echo "Pi Extensions Installer (CI mode)"
else
  echo "Pi Extensions Installer"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━"

mkdir -p "$TARGET_DIR"

failed=0
installed=0

for ext_dir in "$EXTENSIONS_DIR"/*/; do
  [[ ! -d "$ext_dir" ]] && continue
  
  ext_name=$(basename "$ext_dir")
  
  # Skip if no package.json
  [[ ! -f "$ext_dir/package.json" ]] && continue
  
  echo ""
  echo "[$ext_name]"
  
  # Install deps (--silent avoids noisy lifecycle-script output)
  echo "  bun install..."
  cd "$ext_dir"
  if ! bun install --silent "${BUN_INSTALL_FLAGS[@]}"; then
    echo -e "  ${RED}✗ bun install failed${NC}"
    failed=$((failed + 1))
    cd "$SCRIPT_DIR"
    continue
  fi
  
  # Build
  echo "  bun run build..."
  if ! bun run build 2>&1; then
    echo -e "  ${RED}✗ build failed${NC}"
    failed=$((failed + 1))
    cd "$SCRIPT_DIR"
    continue
  fi
  cd "$SCRIPT_DIR"
  
  # Symlink
  dist_dir="$ext_dir/dist"
  if [[ ! -d "$dist_dir" ]]; then
    echo -e "  ${RED}✗ dist/ not found${NC}"
    failed=$((failed + 1))
    continue
  fi
  
  ln -sfn "$dist_dir" "$TARGET_DIR/$ext_name"
  echo -e "  ${GREEN}✓ installed${NC} → $TARGET_DIR/$ext_name"
  installed=$((installed + 1))
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "Installed: ${GREEN}$installed${NC}  Failed: ${RED}$failed${NC}"

[[ $failed -eq 0 ]] && exit 0 || exit 1
