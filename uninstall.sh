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

# Collect installed extensions (symlinks pointing into this repo)
get_installed_extensions() {
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

    local link_path="$TARGET_DIR/$ext"
    if [[ -L "$link_path" ]]; then
      local link_target
      link_target="$(readlink "$link_path")"
      if [[ "$link_target" == "$ext_dir"* ]]; then
        exts+=("$ext")
      fi
    fi
  done
  echo "${exts[@]}"
}

# Collect all available extensions (for name validation)
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
  echo "Usage: $(basename "$0") [-i | <extension-name>]"
  echo ""
  echo "Uninstall pi extensions from ~/.pi/agent/extensions/"
  echo ""
  echo "Options:"
  echo "  (no args)          Uninstall all extensions from this repo"
  echo "  <extension-name>   Uninstall a single extension by name"
  echo "  -i, --interactive  Select extensions from an interactive checklist"
  echo ""
  echo "Available extensions:"
  local exts
  read -ra exts <<< "$(get_extensions)"
  for ext in "${exts[@]}"; do
    local link_path="$TARGET_DIR/$ext"
    if [[ -L "$link_path" ]]; then
      echo -e "  ${GREEN}●${NC} $ext  ${DIM}(installed)${NC}"
    else
      echo -e "  ${DIM}○ $ext${NC}"
    fi
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

    printf '\033[2K'"${BOLD}Select extensions to uninstall${NC}"' '"${DIM}(Space=toggle, Enter=confirm, q=cancel)${NC}"'\n'
    for ((i = 0; i < count; i++)); do
      printf '\033[2K'
      if (( i == cursor )); then
        printf '  '"${CYAN}❯${NC}"' '
      else
        printf '    '
      fi
      if (( _sel[i] )); then
        printf "${RED}◉${NC} %s\n" "${_items[$i]}"
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

# ── Uninstall helper ───────────────────────────────────────────────────
uninstall_extension() {
  local name="$1"
  local link_path="$TARGET_DIR/$name"
  local ext_dir="$EXTENSIONS_DIR/$name"

  if [[ -L "$link_path" ]]; then
    local link_target
    link_target="$(readlink "$link_path")"
    # Only remove symlinks that point into this repo's dist/ directories
    if [[ "$link_target" == "$ext_dir"* ]]; then
      rm "$link_path"
      echo -e "  ${GREEN}✓${NC} Removed: $name"
      return 0
    else
      echo -e "  ${YELLOW}⏭${NC} Skipped: $name ${DIM}(symlink points elsewhere: $link_target)${NC}"
      return 1
    fi
  elif [[ -e "$link_path" ]]; then
    rm -rf "$link_path"
    echo -e "  ${GREEN}✓${NC} Removed: $name"
    return 0
  else
    echo -e "  ${DIM}⏭ Not installed: $name${NC}"
    return 1
  fi
}

# ── Parse args ─────────────────────────────────────────────────────────
INTERACTIVE=false
EXT_NAME=""

for arg in "$@"; do
  case "$arg" in
    -i|--interactive) INTERACTIVE=true ;;
    -h|--help) usage ;;
    -*) echo -e "${RED}Unknown option: $arg${NC}"; usage ;;
    *) EXT_NAME="$arg" ;;
  esac
done

# ── Interactive mode ───────────────────────────────────────────────────
if $INTERACTIVE; then
  read -ra INSTALLED_EXTS <<< "$(get_installed_extensions)"

  if (( ${#INSTALLED_EXTS[@]} == 0 )); then
    echo -e "${YELLOW}No extensions currently installed${NC}"
    exit 0
  fi

  SELECTED=()
  if run_checklist INSTALLED_EXTS SELECTED; then
    # Collect chosen names
    CHOSEN=()
    for ((i = 0; i < ${#INSTALLED_EXTS[@]}; i++)); do
      (( SELECTED[i] )) && CHOSEN+=("${INSTALLED_EXTS[$i]}")
    done

    if (( ${#CHOSEN[@]} == 0 )); then
      echo ""
      echo -e "${YELLOW}No extensions selected${NC}"
      exit 0
    fi

    echo ""
    echo "Pi Extensions Uninstaller"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"

    removed=0
    for ext in "${CHOSEN[@]}"; do
      uninstall_extension "$ext" && (( removed++ )) || true
    done

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "Removed: ${GREEN}$removed${NC} symlink(s)"
  else
    echo ""
    echo -e "${DIM}Cancelled${NC}"
    exit 0
  fi
  exit 0
fi

# ── Single extension mode ─────────────────────────────────────────────
if [[ -n "$EXT_NAME" ]]; then
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

  echo "Pi Extensions Uninstaller"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"

  uninstall_extension "$EXT_NAME" && {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${GREEN}Done${NC}"
  } || {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${YELLOW}Nothing to remove${NC}"
  }
  exit 0
fi

# ── Default: uninstall all ─────────────────────────────────────────────
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
