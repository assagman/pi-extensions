# Theta

Theta is a Pi extension for interactive code review workflows. It provides a TUI dashboard for reviewing git diffs.

## Features

- **TUI Dashboard:** Interactive terminal UI for reviewing changes with file navigation and diff scrolling.

## Installation

```bash
# In your pi extensions directory
bun install
./install.sh
```

## Usage

### Commands
- `/theta`: Open the interactive dashboard.

### Keybindings

| Key | Action |
|-----|--------|
| `C-n` / `C-p` | Navigate files |
| `j` / `k` / `↑` / `↓` | Scroll diff |
| `PgUp` / `PgDn` / `C-u` / `C-d` | Fast scroll |
| `q` / `Esc` | Exit |

## Development

```bash
bun install
bun run build
```
