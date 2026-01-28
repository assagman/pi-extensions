# Sigma — Better Questionnaire Extension

Replaces the built-in `questionnaire` tool with an improved version.

## Improvements

| Feature | Original | Sigma |
|---------|----------|-------|
| Number keys (1-9) | ✗ | ✓ Direct selection |
| C-n / C-p | ✗ | ✓ Emacs-style nav |
| Long question wrap | Buggy | ✓ `wrapTextWithAnsi` |
| "Type something" | Agent-controlled | ✓ Always present |

## Keybindings

| Key | Action |
|-----|--------|
| `↑` / `C-p` | Move up |
| `↓` / `C-n` | Move down |
| `1`–`9` | Quick select option |
| `Enter` | Confirm selection |
| `Esc` | Cancel |
| `Tab` / `→` | Next question (multi) |
| `Shift+Tab` / `←` | Prev question (multi) |

## Install

```bash
cd extensions/sigma
./install.sh
```

## Uninstall

```bash
cd extensions/sigma
./uninstall.sh
```
