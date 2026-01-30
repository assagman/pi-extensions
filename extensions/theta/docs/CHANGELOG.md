# Change Log

## v0.3.0 - 2026-01-28

### ✨ New Features
- **Search & Filter**: Interactive search in all panels with `/` key
  - **Commits Panel**: Filter by SHA, subject, author, or message body
  - **Files Panel**: Filter by file path
  - **Diff Panel**: Find and highlight matches with `n`/`N` navigation
- **Match Highlighting**: Visual highlighting of search matches in diff content
  - Current match highlighted with accent color
  - Other matches highlighted with warning color
- **Case Sensitivity Toggle**: `Ctrl+I` to toggle case-sensitive search
- **Match Navigation**: Navigate between matches with `n` (next) and `N` (previous)
- **Panel Switching in Search**: Use `h`/`l` to switch search between panels
- **Match Counter**: Real-time display of match count and current position

### 🔧 Improvements
- Added `/` shortcut to footer keybindings hint
- Enhanced search bar with match counter and help text
- Improved empty results feedback with red "0 matches" indicator

---

## v0.2.0 - 2026-01-28

### ✨ New Features
- **Branch Comparison Mode**: Compare any two refs with `/theta base..head` (e.g., `/theta main..feature`, `/theta v1.0..v2.0`)
- **Line Numbers**: Diff panel now displays old/new line numbers for each line
- **Commit Metadata**: Shows author name and date in footer for selected commits
- **Commit Statistics**: Display total files changed, additions, and deletions in footer
- **Keyboard Help Overlay**: Press `?` to view all available keybindings

### 🔧 Improvements
- Enhanced footer to show metadata and stats in a cleaner layout
- Better visual hierarchy with line number gutter
- Improved help discoverability with in-app overlay

---

## v0.1.x - Previous Releases

- **v0.1.4**: Renamed command from `/review` to `/theta` to avoid conflicts with other extensions.
- **v0.1.3**: Fixed path resolution and scoped review to CWD.
- **v0.1.2**: Fixed UI lag and added HEAD diff support.
- **v0.1.1**: Fixed theme error.
