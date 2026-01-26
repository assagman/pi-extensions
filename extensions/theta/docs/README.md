# Theta

Theta is a Pi extension for interactive code review workflows. It provides a 3-column TUI dashboard for reviewing git diffs.

## Features

- **3-Column Layout:** Commits | Files | Diff
- **Commit History:** Browse commits with dynamic loading (50 per batch)
- **Uncommitted Changes:** Auto-detected and shown as first entry
- **Interactive Navigation:** Vim-style panel switching and scrolling

## Installation

```bash
# In your pi extensions directory
bun install
./install.sh
```

## Usage

### Command
- `/theta`: Open the interactive dashboard

### Layout

```
┌──────────────┬──────────────┬────────────────────────────────────────────┐
│ COMMITS      │ FILES        │ DIFF                                       │
│ (20%)        │ (20%)        │ (60%)                                      │
├──────────────┼──────────────┼────────────────────────────────────────────┤
│▸ Uncommitted │▸ +2 -1 foo.ts│ @@ -1,3 +1,5 @@                            │
│  abc1234 Fix │  +5 -3 bar.ts│ +import { x } from 'y';                    │
│  def5678 Add │              │  function main() {                         │
│  ghi9012 Ref │              │ -  return null;                            │
│  ...         │              │ +  return 42;                              │
└──────────────┴──────────────┴────────────────────────────────────────────┘
```

### Keybindings

| Key | Action |
|-----|--------|
| `h` | Switch to left panel |
| `l` | Switch to right panel |
| `j` / `↓` | Navigate down / scroll |
| `k` / `↑` | Navigate up / scroll |
| `PgUp` / `C-u` | Fast scroll up |
| `PgDn` / `C-d` | Fast scroll down |
| `q` / `Esc` | Exit dashboard |

### Panels

| Panel | Behavior |
|-------|----------|
| **Commits** | Select commit to view. "Uncommitted" appears when changes exist. Dynamic loading when scrolling near bottom. |
| **Files** | Select file to view its diff. Shows +additions/-deletions. |
| **Diff** | Scroll through diff content. Syntax colored (+/-/@@). |

## Development

```bash
bun install
bun run build
```
