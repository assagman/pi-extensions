# PR #3 Resolution Plan

**Repository**: assagman/pi-extensions  
**PR**: [#3 - refactor(theta): simplify extension and enhance dashboard UI](https://github.com/assagman/pi-extensions/pull/3)  
**Date**: 2026-01-26  
**Reviewer**: AI (gh-pr-review skill)

---

## Summary

| Category | Count | Details |
|----------|-------|---------|
| **Total Unresolved Threads** | 5 | All valid issues requiring code fixes |
| **VALID (needs work)** | 5 | 2 distinct bugs reported in 5 threads |
| **INVALID (resolved)** | 0 | N/A |
| **UNCLEAR (needs input)** | 0 | N/A |

---

## VALID Issues (Work Plan)

### Issue 1: Race Condition in File Selection ⚠️ HIGH

**Thread**: [PRRT_kwDORA2vqs5q9aiX](https://github.com/assagman/pi-extensions/pull/3#discussion_r2726044654)  
**Location**: `extensions/theta/src/ui/dashboard.ts:42-56` (`selectFile` method)  
**Reported by**: gemini-code-assist

#### Problem
When users rapidly press `Ctrl+N` to navigate files, multiple async `getDiff()` calls are triggered without cancellation. If they resolve out of order, the UI displays the wrong diff for the currently selected file.

**Example scenario**:
1. User selects File A → `getDiff(A)` starts (slow network)
2. User quickly selects File B → `getDiff(B)` starts
3. `getDiff(B)` completes → displays diff B ✅
4. `getDiff(A)` completes (late) → **overwrites** with diff A ❌ (but File B is selected)

#### Required Changes

**File**: `src/ui/dashboard.ts`

Add a guard to check if the selected index is still valid after async completion:

```typescript
async selectFile(index: number) {
  this.selectedIndex = index;
  const file = this.files[index];
  this.diffContent = `Loading diff for ${file.path}...`;
  this.diffScrollOffset = 0;
  this.refresh();

  try {
    const { raw } = await this.diffService.getDiff(undefined, undefined, file.path);
    // ✅ Guard: only update if this file is still selected
    if (this.selectedIndex === index) {
      this.diffContent = raw || "No changes in file.";
      this.refresh();  // ⬅️ Move refresh inside guard
    }
  } catch (_e) {
    // ✅ Guard: only show error if this file is still selected
    if (this.selectedIndex === index) {
      this.diffContent = "Error loading diff.";
      this.refresh();  // ⬅️ Move refresh inside guard
    }
  }
}
```

**Key changes**:
- Add `if (this.selectedIndex === index)` checks in both try/catch blocks
- Move `this.refresh()` calls inside the guards (no need to refresh stale data)

#### Testing
1. Open theta dashboard with multiple files
2. Rapidly press `Ctrl+N` 5-10 times
3. Wait for all diffs to load
4. Verify displayed diff matches the highlighted file in sidebar
5. Test on slow network (throttle to 3G in dev tools if testing with remote repos)

---

### Issue 2: Hardcoded Scroll Limit (Dynamic Viewport Bug) ⚠️ HIGH

**Threads** (4 duplicates reporting same bug):
- [PRRT_kwDORA2vqs5q9aib](https://github.com/assagman/pi-extensions/pull/3#discussion_r2726044658) (gemini-code-assist)
- [PRRT_kwDORA2vqs5q9auj](https://github.com/assagman/pi-extensions/pull/3#discussion_r2726045621) (chatgpt-codex-connector)
- [PRRT_kwDORA2vqs5q9a3Z](https://github.com/assagman/pi-extensions/pull/3#discussion_r2726046279) (copilot-pull-request-reviewer)
- [PRRT_kwDORA2vqs5q9a3e](https://github.com/assagman/pi-extensions/pull/3#discussion_r2726046285) (copilot-pull-request-reviewer)

**Location**: `extensions/theta/src/ui/dashboard.ts:116, 130` (`handleInput` method)  

#### Problem
Scroll bounds use hardcoded `this.maxDiffLines - 10`, but the viewport height is calculated dynamically as `Math.max(10, termRows - 3)` in the `render()` method. This causes:

- **Tall terminals** (e.g., 50 rows → contentHeight=47): Users cannot scroll to the last 37 lines (stuck at offset `maxLines - 10`)
- **Small terminals** (e.g., 13 rows → contentHeight=10): Works by coincidence, but logic is wrong

**Affected lines**:
- Line 116: `if (this.diffScrollOffset < this.maxDiffLines - 10) {`
- Line 130: `Math.max(0, this.maxDiffLines - 10)`

#### Required Changes

**Option A: Cache contentHeight as instance variable** (Recommended)

1. Add instance variable:
```typescript
export class Dashboard implements Component {
  private files: DiffFile[] = [];
  private selectedIndex = 0;
  private diffContent = "Loading...";
  private diffService: DiffService;
  private diffScrollOffset = 0;
  private maxDiffLines = 0;
  private contentHeight = 10; // ✅ Add this
```

2. Update `render()` to set contentHeight:
```typescript
render(width: number): string[] {
  // ... existing code ...
  
  const termRows = this.tui.terminal.rows || 24;
  this.contentHeight = Math.max(10, termRows - 3); // ✅ Set instance var
  
  // ... rest of render ...
}
```

3. Update `handleInput()` scroll logic (lines 116-136):
```typescript
// Diff scrolling (j/k, arrows)
const maxScroll = Math.max(0, this.maxDiffLines - this.contentHeight); // ✅ Use dynamic value

if (matchesKey(data, "j") || matchesKey(data, "down")) {
  if (this.diffScrollOffset < maxScroll) { // ✅ Fixed
    this.diffScrollOffset++;
    this.refresh();
  }
  return;
}
if (matchesKey(data, "k") || matchesKey(data, "up")) {
  if (this.diffScrollOffset > 0) {
    this.diffScrollOffset--;
    this.refresh();
  }
  return;
}
if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
  this.diffScrollOffset = Math.min(this.diffScrollOffset + 20, maxScroll); // ✅ Fixed
  this.refresh();
  return;
}
if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
  this.diffScrollOffset = Math.max(0, this.diffScrollOffset - 20);
  this.refresh();
  return;
}
```

**Option B: Recalculate in handleInput** (Less efficient)
Calculate `contentHeight` at the start of `handleInput()` using `this.tui.terminal.rows` (same logic as render). Simpler but duplicates code.

**Recommended**: Option A (cleaner separation, avoids duplicate logic)

#### Testing
1. Test on **small terminal** (resize to ~15 rows):
   - Open theta with a diff > 100 lines
   - Press `j` to scroll - should stop when last line is visible
   - Press `Ctrl+D` (page down) - should not scroll past end

2. Test on **large terminal** (resize to 50+ rows):
   - Same diff
   - Verify you can scroll to see ALL lines (not stopping 37 lines early)
   - Footer scroll indicator should show correct total (e.g., `45-50/100`)

3. Test **terminal resize mid-session**:
   - Open dashboard
   - Resize terminal larger
   - Verify scroll limits adjust (can now see more lines before hitting max)

4. Edge case: **diff shorter than viewport**:
   - Open file with only 5 lines changed
   - Verify `j`/`k` don't scroll (already showing everything)

---

## Implementation Order

1. **Fix Issue 2 first** (scroll limits) - easier, no async complexity
2. **Fix Issue 1 second** (race condition) - requires careful async testing

**Estimated effort**: 30-45 minutes total (both fixes + testing)

---

## Risks & Edge Cases

### Issue 1 (Race Condition)
- **Risk**: If `selectFile()` is called with same index twice in a row (e.g., user re-selects current file), both calls will pass the guard. This is actually fine - it just re-fetches the same diff.
- **Edge case**: If `this.files` array is modified while `getDiff()` is pending, `this.selectedIndex` might be out of bounds. Currently no code modifies `files` after init, so safe for now.

### Issue 2 (Scroll Limits)
- **Risk**: `this.tui.terminal.rows` might be undefined in non-interactive environments (tests?). Fallback to 24 is already handled.
- **Edge case**: If user resizes terminal while scrolled near bottom, scroll position might "jump". This is acceptable UX - alternative would be to recalculate scroll offset on resize (complex).

---

## Tests to Add (Optional, for robustness)

1. **Unit test**: Mock `DiffService.getDiff()` with delayed promises, verify race condition guard works
2. **Integration test**: Simulate rapid file navigation (fire 10 `selectFile()` calls with 0ms delay), verify final diff matches final selection
3. **Viewport test**: Mock different `terminal.rows` values, verify scroll limits adjust correctly

*(Not blocking for merge - manual testing is sufficient given the UI-focused nature)*

---

## Next Steps

1. ✅ **This review complete** - all threads validated
2. ⬜ Implement fixes for Issues 1 & 2 (see code snippets above)
3. ⬜ Test thoroughly (see Testing sections)
4. ⬜ Push changes to `fix/theta` branch
5. ⬜ Request re-review (or auto-merge if confident)
6. ⬜ Reviewers: verify fixes and mark threads as resolved

---

## Notes

- All 5 review threads are **legitimate bugs** - no invalid/outdated comments
- Issues 2-5 are duplicates (4 bots caught the same bug independently 🤖🤖🤖🤖)
- Both bugs are **high priority** (affect core UX: wrong diff display, incomplete scrolling)
- Fixes are **low risk** (surgical, no architectural changes)
- No breaking changes or API modifications needed
