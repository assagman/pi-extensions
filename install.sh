#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSIONS_DIR="$SCRIPT_DIR/extensions"
TARGET_DIR="$HOME/.pi/agent/extensions"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Non-deployable extensions (libraries, shared code)
SKIP_EXTENSIONS=("shared")

usage() {
  echo "Usage: $(basename "$0") [--ci] <extension-name>"
  echo ""
  echo "Build and install a pi extension to ~/.pi/agent/extensions/"
  echo ""
  echo "Arguments:"
  echo "  extension-name   Name of the extension to install"
  echo "  --ci             Use bun install --frozen-lockfile"
  echo ""
  echo "Available extensions:"
  for ext_dir in "$EXTENSIONS_DIR"/*/; do
    [[ ! -d "$ext_dir" ]] && continue
    ext=$(basename "$ext_dir")
    [[ ! -f "$ext_dir/package.json" ]] && continue
    for skip in "${SKIP_EXTENSIONS[@]}"; do
      [[ "$ext" == "$skip" ]] && continue 2
    done
    echo "  $ext"
  done
  exit 1
}

# Parse args
CI=false
EXT_NAME=""

for arg in "$@"; do
  case "$arg" in
    --ci) CI=true ;;
    -h|--help) usage ;;
    -*) echo -e "${RED}Unknown option: $arg${NC}"; usage ;;
    *) EXT_NAME="$arg" ;;
  esac
done

[[ -z "$EXT_NAME" ]] && { echo -e "${RED}Error: extension name is required${NC}"; echo ""; usage; }

# Validate extension exists
ext_dir="$EXTENSIONS_DIR/$EXT_NAME"
if [[ ! -d "$ext_dir" || ! -f "$ext_dir/package.json" ]]; then
  echo -e "${RED}Error: extension '$EXT_NAME' not found${NC}"
  echo ""
  usage
fi

# Check if skipped
for skip in "${SKIP_EXTENSIONS[@]}"; do
  if [[ "$EXT_NAME" == "$skip" ]]; then
    echo -e "${YELLOW}'$EXT_NAME' is a library, not a deployable extension${NC}"
    exit 1
  fi
done

BUN_INSTALL_FLAGS=()
$CI && BUN_INSTALL_FLAGS+=(--frozen-lockfile)

echo "Pi Extensions Installer${CI:+ (CI mode)}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━"

mkdir -p "$TARGET_DIR"

echo ""
echo "[$EXT_NAME]"

# Install deps
echo "  bun install..."
cd "$ext_dir"
if ! bun install --silent "${BUN_INSTALL_FLAGS[@]}"; then
  echo -e "  ${RED}✗ bun install failed${NC}"
  exit 1
fi

# Build
echo "  bun run build..."
if ! bun run build 2>&1; then
  echo -e "  ${RED}✗ build failed${NC}"
  exit 1
fi

# Symlink
dist_dir="$ext_dir/dist"
if [[ ! -d "$dist_dir" ]]; then
  echo -e "  ${RED}✗ dist/ not found${NC}"
  exit 1
fi

ln -sfn "$dist_dir" "$TARGET_DIR/$EXT_NAME"
echo -e "  ${GREEN}✓ installed${NC} → $TARGET_DIR/$EXT_NAME"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}Done${NC}"
