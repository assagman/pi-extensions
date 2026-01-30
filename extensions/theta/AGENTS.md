# Theta — Agent Instructions

## What This Is

Interactive code review extension with 3-column TUI dashboard for browsing git diffs (commits → files → diff).

## Structure

```
theta/
├── src/
│   ├── index.ts                 # Extension entry, /theta command
│   ├── services/
│   │   └── diff-service.ts      # Git operations: commits, diffs, file lists
│   └── ui/
│       └── dashboard.ts         # 3-column TUI dashboard component
├── docs/
│   ├── README.md                # User docs
│   └── CHANGELOG.md             # Change history
├── dist/
├── install.sh
├── uninstall.sh
└── package.json
```

## Key Facts

| Item | Detail |
|------|--------|
| Commands | `/theta` — commit history mode<br>`/theta base..head` — branch comparison mode |
| Layout | Commits (20%) \| Files (20%) \| Diff (60%) |
| Search & Filter | `/` key enters search mode, filters all panels<br>Commits: SHA/subject/author/body<br>Files: path<br>Diff: content with highlighting |
| Match navigation | `n`/`N` for next/prev match, `Ctrl+I` case toggle |
| Line numbers | Old\|New line numbers shown in diff gutter (8 chars) |
| Commit metadata | Author, date shown in footer for selected commit |
| Statistics | Files changed, +additions, -deletions in footer |
| Commit loading | Dynamic batches of 50, loads more on scroll |
| Uncommitted | Auto-detected, shown as first entry |
| Navigation | Vim-style: h/l panels, j/k scroll, PgUp/PgDn fast scroll |
| Help overlay | `?` key toggles keyboard shortcuts popup |
| Diff parsing | `@pierre/diffs` library for structured diff metadata |
| Dependencies | `@mariozechner/pi-tui`, `@pierre/diffs` |
| Tests | None currently |

## Build

```bash
bun install && bun run build
./install.sh
```

## Important

- Dashboard is a class implementing `Component` interface
- `DiffService` wraps all git operations via `child_process.exec`
- Relative paths used throughout (respects CWD)
- maxBuffer set to 10MB for large diffs
