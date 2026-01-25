# mu extension

Overrides standard tools (read, write, edit, bash, etc.) to provide a condensed, CLI-friendly default view with Nerd Font icons and detailed summaries.

## Features

- **Condensed UI**: Minimal default view for cleaner output history.
- **Per-tool result viewer**: View/inspect a single tool result on-demand without enabling global tool expansion.
- **Nerd Font Icons**:
  - `` Bash
  - `` Read
  - `` Write
  - `` Edit
  - `` Grep
  - `` Find
  - `` Ls
- **Smart Summaries**:
  - **Read**: Shows path + Line Range (e.g., `L:10-50`)
  - **Write**: Shows path + Size (e.g., `1.2KB`)
  - **Edit**: Shows path + Diff size (e.g., `100B -> 120B`)
- **Error Expansion**: Automatically expands full output on errors.
- **Manual Expansion**: Press `Ctrl+O` to see full output (global tool expansion).
- **Per-tool Viewer**: Press `Ctrl+Alt+O` or run `/mu-tools` to pick and view a single tool result.

## Usage

```bash
pi -e ./mu/index.ts
```
