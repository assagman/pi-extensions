#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSIONS_DIR="$SCRIPT_DIR/extensions"
TARGET_DIR="$HOME/.pi/agent/extensions"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
DIM='\033[2m'
BOLD='\033[1m'
CYAN='\033[0;36m'
NC='\033[0m'

# Non-deployable directories (libraries, shared code)
SKIP_EXTENSIONS=("shared")

# Collect available extensions into array
get_extensions() {
  local exts=()
  for ext_dir in "$EXTENSIONS_DIR"/*/; do
    [[ ! -d "$ext_dir" ]] && continue
    local ext
    ext=$(basename "$ext_dir")
    [[ ! -f "$ext_dir/package.json" ]] && continue
    local skip_it=false
    for skip in "${SKIP_EXTENSIONS[@]}"; do
      [[ "$ext" == "$skip" ]] && skip_it=true && break
    done
    $skip_it && continue
    exts+=("$ext")
  done
  echo "${exts[@]}"
}

usage() {
  echo "Usage: $(basename "$0") [--ci] [-i | <extension-name>]"
  echo ""
  echo "Build and install pi extensions to ~/.pi/agent/extensions/"
  echo ""
  echo "Options:"
  echo "  <extension-name>   Install a single extension by name"
  echo "  -i, --interactive  Select extensions from an interactive checklist"
  echo "  --ci               Use bun install --frozen-lockfile"
  echo ""
  echo "Available extensions:"
  local exts
  read -ra exts <<< "$(get_extensions)"
  for ext in "${exts[@]}"; do
    echo "  $ext"
  done
  exit 1
}

# ── Interactive checklist ──────────────────────────────────────────────
# Minimal TUI: ↑/↓ navigate, Space toggle, Enter confirm, q/Esc cancel
run_checklist() {
  local -n _items=$1   # extension names array (nameref)
  local -n _sel=$2     # selection results array (nameref)
  local count=${#_items[@]}
  local cursor=0

  # Init all selected
  for ((i = 0; i < count; i++)); do _sel[$i]=1; done

  # Hide cursor, enable raw mode
  tput civis 2>/dev/null || true
  stty -echo -icanon min 1 time 0 2>/dev/null

  # Restore terminal on exit
  trap 'tput cnorm 2>/dev/null; stty echo icanon 2>/dev/null' RETURN

  _draw_checklist() {
    # Move to start (clear previous render)
    if (( _first_draw == 0 )); then
      printf '\033[%dA' "$((count + 2))"  # +2 for header + footer
    fi
    _first_draw=0

    printf '\033[2K'"${BOLD}Select extensions to install${NC}"' '"${DIM}(Space=toggle, Enter=confirm, q=cancel)${NC}"'\n'
    for ((i = 0; i < count; i++)); do
      printf '\033[2K'
      if (( i == cursor )); then
        printf '  '"${CYAN}❯${NC}"' '
      else
        printf '    '
      fi
      if (( _sel[i] )); then
        printf "${GREEN}◉${NC} %s\n" "${_items[$i]}"
      else
        printf "${DIM}○${NC} %s\n" "${_items[$i]}"
      fi
    done
    printf '\033[2K'"${DIM}  %d/%d selected${NC}"'\n' "$(printf '%s\n' "${_sel[@]}" | grep -c 1 || true)" "$count"
  }

  local _first_draw=1
  _draw_checklist

  while true; do
    # Read one byte
    local key
    key=$(dd bs=1 count=1 2>/dev/null)
    local code
    code=$(printf '%d' "'$key" 2>/dev/null || echo 0)

    case "$key" in
      q)  # Cancel
        return 1
        ;;
      '') # Enter (empty = newline)
        return 0
        ;;
      ' ') # Space → toggle
        (( _sel[cursor] = !_sel[cursor] )) || true
        _draw_checklist
        ;;
      $'\x1b') # Escape sequence
        local seq1 seq2
        seq1=$(dd bs=1 count=1 2>/dev/null)
        seq2=$(dd bs=1 count=1 2>/dev/null)
        if [[ "$seq1" == "[" ]]; then
          case "$seq2" in
            A) # Up
              (( cursor = cursor > 0 ? cursor - 1 : count - 1 ))
              _draw_checklist
              ;;
            B) # Down
              (( cursor = (cursor + 1) % count ))
              _draw_checklist
              ;;
          esac
        else
          # Bare Escape → cancel
          return 1
        fi
        ;;
    esac
  done
}

# ── Shared build helpers ───────────────────────────────────────────────
build_shared_dep() {
  local dep_dir="$1"
  local dep_name
  dep_name=$(basename "$dep_dir")
  if [[ ! -d "$dep_dir/dist" ]]; then
    echo ""
    echo "[shared/$dep_name] (dependency)"
    echo "  bun install..."
    (cd "$dep_dir" && bun install --silent "${BUN_INSTALL_FLAGS[@]}")
    echo "  bun run build..."
    if ! (cd "$dep_dir" && bun run build 2>&1); then
      echo -e "  ${RED}✗ shared/$dep_name build failed${NC}"
      return 1
    fi
    echo -e "  ${GREEN}✓ built${NC}"
  fi
}

ensure_shared_deps() {
  local ext_dir="$1"
  if grep -q '"pi-ext-shared"' "$ext_dir/package.json" 2>/dev/null; then
    local shared_core="$EXTENSIONS_DIR/shared/core"
    [[ -d "$shared_core" ]] && build_shared_dep "$shared_core"
  fi
  if grep -q '"shared-tui"' "$ext_dir/package.json" 2>/dev/null; then
    local shared_tui="$EXTENSIONS_DIR/shared/tui"
    [[ -d "$shared_tui" ]] && build_shared_dep "$shared_tui"
  fi
}

install_extension() {
  local name="$1"
  local ext_dir="$EXTENSIONS_DIR/$name"

  ensure_shared_deps "$ext_dir"

  echo ""
  echo "[$name]"

  echo "  bun install..."
  if ! (cd "$ext_dir" && bun install --silent "${BUN_INSTALL_FLAGS[@]}"); then
    echo -e "  ${RED}✗ bun install failed${NC}"
    return 1
  fi

  echo "  bun run build..."
  if ! (cd "$ext_dir" && bun run build 2>&1); then
    echo -e "  ${RED}✗ build failed${NC}"
    return 1
  fi

  local dist_dir="$ext_dir/dist"
  if [[ ! -d "$dist_dir" ]]; then
    echo -e "  ${RED}✗ dist/ not found${NC}"
    return 1
  fi

  ln -sfn "$dist_dir" "$TARGET_DIR/$name"
  echo -e "  ${GREEN}✓ installed${NC} → $TARGET_DIR/$name"
}

# ── Parse args ─────────────────────────────────────────────────────────
CI=false
INTERACTIVE=false
EXT_NAME=""

for arg in "$@"; do
  case "$arg" in
    --ci) CI=true ;;
    -i|--interactive) INTERACTIVE=true ;;
    -h|--help) usage ;;
    -*) echo -e "${RED}Unknown option: $arg${NC}"; usage ;;
    *) EXT_NAME="$arg" ;;
  esac
done

BUN_INSTALL_FLAGS=()
$CI && BUN_INSTALL_FLAGS+=(--frozen-lockfile)

# ── Interactive mode ───────────────────────────────────────────────────
if $INTERACTIVE; then
  read -ra ALL_EXTS <<< "$(get_extensions)"

  if (( ${#ALL_EXTS[@]} == 0 )); then
    echo -e "${RED}No extensions found${NC}"
    exit 1
  fi

  SELECTED=()
  if run_checklist ALL_EXTS SELECTED; then
    # Collect chosen names
    CHOSEN=()
    for ((i = 0; i < ${#ALL_EXTS[@]}; i++)); do
      (( SELECTED[i] )) && CHOSEN+=("${ALL_EXTS[$i]}")
    done

    if (( ${#CHOSEN[@]} == 0 )); then
      echo ""
      echo -e "${YELLOW}No extensions selected${NC}"
      exit 0
    fi

    echo ""
    echo "Pi Extensions Installer${CI:+ (CI mode)}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━"
    mkdir -p "$TARGET_DIR"

    failed=0
    for ext in "${CHOSEN[@]}"; do
      install_extension "$ext" || (( failed++ )) || true
    done

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━"
    if (( failed > 0 )); then
      echo -e "${RED}Done with $failed failure(s)${NC}"
      exit 1
    fi
    echo -e "${GREEN}Done — ${#CHOSEN[@]} extension(s) installed${NC}"
  else
    echo ""
    echo -e "${DIM}Cancelled${NC}"
    exit 0
  fi
  exit 0
fi

# ── Single extension mode (original behavior) ─────────────────────────
[[ -z "$EXT_NAME" ]] && { echo -e "${RED}Error: extension name is required${NC}"; echo ""; usage; }

ext_dir="$EXTENSIONS_DIR/$EXT_NAME"
if [[ ! -d "$ext_dir" || ! -f "$ext_dir/package.json" ]]; then
  echo -e "${RED}Error: extension '$EXT_NAME' not found${NC}"
  echo ""
  usage
fi

for skip in "${SKIP_EXTENSIONS[@]}"; do
  if [[ "$EXT_NAME" == "$skip" ]]; then
    echo -e "${YELLOW}'$EXT_NAME' is a library, not a deployable extension${NC}"
    exit 1
  fi
done

echo "Pi Extensions Installer${CI:+ (CI mode)}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━"
mkdir -p "$TARGET_DIR"

install_extension "$EXT_NAME" || { echo -e "\n${RED}Failed${NC}"; exit 1; }

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}Done${NC}"
