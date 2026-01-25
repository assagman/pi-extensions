# Testing mu extension

Since this is a TUI extension, it requires manual verification.

## Basic Tool Rendering

1. Run `pi -e mu/index.ts`
2. Execute standard commands:
   - `ls` -> Should show "📂 ."
   - `read mu/README.md` -> Should show "📖 mu/README.md"
   - `echo "test"` -> Should show "$ echo "test""
3. Error case:
   - `ls /nonexistent` -> Should show full error output.
4. Expansion:
   - Run `read mu/README.md`.
   - Press `Ctrl+O` on the tool result.
   - Verify it expands to full content with syntax highlighting.

## Tool Results Viewer (`/mu-tools` or `Ctrl+Alt+O`)

### Setup
1. Run several tool commands to populate results:
   ```
   ls
   read mu/index.ts
   echo "hello world"
   cat /nonexistent  # error case
   ```

### Picker UI
1. Run `/mu-tools` or press `Ctrl+Alt+O`
2. Verify picker shows:
   - Tool icon + name + truncated ID
   - Input summary
   - Error flag (if applicable)
   - Duration (e.g., "1.2s")
3. Use ↑/↓ to navigate, Enter to select

### Detail Viewer
1. Select a tool result
2. Verify overlay shows:
   - Bordered box with header (icon, name, ID, status ✓/✗)
   - Arguments section (full, properly wrapped)
   - Output section with line count
   - Footer with duration, timestamp, position (e.g., [1/4])
3. Test scrolling:
   - j/k or ↑/↓: scroll line by line
   - PgDn/PgUp or Ctrl+D/U: scroll half-page
   - g: jump to top
   - G: jump to bottom
   - Scroll percentage shown in help line
4. Test navigation:
   - ]/n: next result (without closing overlay)
   - [/p: previous result
   - Verify content updates, scroll resets to top
5. Press Esc or q to close

### Session Persistence
1. After running tools, exit pi
2. Restart `pi -e mu/index.ts` (same session)
3. Run `/mu-tools`
4. Verify previous tool results appear with correct data
5. Verify duration is preserved for tools that had it

### Edge Cases
- Empty output: Run a tool with no output, verify display
- Very long output: Run `cat` on a large file, verify scrolling works
- Error with exit code: Run `exit 1` in bash, verify status shows ✗ and exit code
