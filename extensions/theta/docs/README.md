# Theta

Theta is a Pi extension for interactive code review workflows. It provides a 3-column TUI dashboard for reviewing git diffs.

## Features

- **3-Column Layout:** Commits | Files | Diff
- **Search & Filter:** Interactive search in all panels with match highlighting
- **Commit History:** Browse commits with dynamic loading (50 per batch)
- **Commit Metadata:** Shows author, date, and commit message for each commit
- **Branch Comparison:** Compare any two refs with `/theta base..head`
- **Line Numbers:** Displays old/new line numbers in diff view
- **Uncommitted Changes:** Auto-detected and shown as first entry
- **Commit Statistics:** Total files changed, additions, deletions
- **Interactive Navigation:** Vim-style panel switching and scrolling
- **Keyboard Help:** Press `?` to view all keybindings

## Installation

```bash
# In your pi extensions directory
bun install
./install.sh
```

## Usage

### Commands
- `/theta`: Open the dashboard for commit history
- `/theta base..head`: Compare two refs/branches (e.g., `/theta main..feature`)
- `/theta v1.0..v2.0`: Compare tags

### Layout

```
┌──────────────┬──────────────┬────────────────────────────────────────────┐
│ COMMITS      │ FILES        │ DIFF                                       │
│ (20%)        │ (20%)        │ (60%)                                      │
├──────────────┼──────────────┼────────────────────────────────────────────┤
│▸ Uncommitted │▸ +2 -1 foo.ts│   1|  1 @@ -1,3 +1,5 @@                    │
│  abc1234 Fix │  +5 -3 bar.ts│    |  2 +import { x } from 'y';             │
│  def5678 Add │              │   2|  3  function main() {                 │
│  ghi9012 Ref │              │   3|     -  return null;                    │
│  ...         │              │    |  4 +  return 42;                       │
│              │              │                                            │
│ John Doe · 2026-01-28       3 files · +42 -15       (1-20/156)        │
│ [h/l] Panel [j/k] Nav [PgUp/Dn] Fast [?] Help [q] Quit               │
└──────────────┴──────────────┴────────────────────────────────────────────┘
```

### Search & Filter

Press `/` to search within the active panel:

- **Commits:** Filter by SHA, subject, author, or message
- **Files:** Filter by file path
- **Diff:** Highlight matches in content with navigation

**Search Keybindings:**
- `/` — Enter search mode
- `Enter` — Apply filter (commits/files) or confirm
- `Esc` — Exit search / clear filter
- `n` — Next match
- `N` — Previous match (Shift+n)
- `Ctrl+I` — Toggle case sensitivity
- `h` / `l` — Switch search to left/right panel
- `Backspace` — Delete character

**Examples:**
- Search commits by author: `/` → `John Doe` → `Enter`
- Find test files: `l` (switch to files) → `/` → `test` → `Enter`
- Find TODO in diff: `l l` (switch to diff) → `/` → `TODO` → `n` (next)

### Keybindings

| Key | Action |
|-----|--------|
| `h` | Switch to left panel |
| `l` | Switch to right panel |
| `j` / `↓` | Navigate down / scroll |
| `k` / `↑` | Navigate up / scroll |
| `PgUp` / `C-u` | Fast scroll up (20 lines) |
| `PgDn` / `C-d` | Fast scroll down (20 lines) |
| `/` | **Enter search mode** |
| `?` | Toggle keyboard help overlay |
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
