# PR #6 Resolution Plan

**Repository:** assagman/pi-extensions  
**PR:** [#6 - feat(mu): rework entire display](https://github.com/assagman/pi-extensions/pull/6)  
**Generated:** 2026-01-26

## Summary

| Thread | Status | Verdict | Action |
|--------|--------|---------|--------|
| [#discussion_r2729014489](https://github.com/assagman/pi-extensions/pull/6#discussion_r2729014489) | Unresolved | **VALID** | Fix required |

## Valid Thread #1: Track tool state by call ID, not signature

**Thread:** https://github.com/assagman/pi-extensions/pull/6#discussion_r2729014489  
**File:** `extensions/mu/src/index.ts` (line 385)

### Problem

The tool card status/elapsed time is looked up via signature (`hash(toolName + args)`), not by unique `toolCallId`. When the same tool is invoked multiple times with identical arguments:

1. `activeToolsBySig.set(sig, state)` overwrites the previous entry (line 1388)
2. `completedDurations.set(state.sig, duration)` overwrites for same sig (line 1400)
3. `ToolCard.getStatus()` and `getElapsed()` both use `this.sig` for lookup

This causes older cards to show incorrect status/duration when a duplicate tool call occurs.

### Required Changes

1. **`ToolCard` class** (lines 363-440): Store `toolCallId` instead of (or in addition to) `sig`. Update constructor to accept `toolCallId`.

2. **`getStatus()`** (line 382-385): Change to lookup by `toolCallId`:
   ```typescript
   private getStatus(): ToolStatus {
     const state = activeToolsById.get(this.toolCallId);
     return state?.status ?? "pending";
   }
   ```

3. **`getElapsed()`** (lines 387-393): Change to lookup by `toolCallId`:
   ```typescript
   private getElapsed(): number {
     const state = activeToolsById.get(this.toolCallId);
     if (!state) return 0;
     if (state.duration !== undefined) return state.duration;
     return Date.now() - state.startTime;
   }
   ```

4. **`completedDurations` map** (line 233): Either:
   - Remove it entirely (duration already stored in `ToolState.duration`), OR
   - Key by `toolCallId` instead of `sig`

5. **Patch view tool rendering** (lines 1141-1166): The inline tool status rendering also uses `sig` for lookup. Either pass `toolCallId` through, or derive it from context if available.

### Impacted Files

- `extensions/mu/src/index.ts`

### Suggested Fix Order

1. Add `toolCallId` to `ToolCard` constructor and store it
2. Update `getStatus()` to use `activeToolsById.get(this.toolCallId)`
3. Update `getElapsed()` to use `activeToolsById` and `state.duration`
4. Remove or refactor `completedDurations` map
5. Update any callers constructing `ToolCard` to pass the `toolCallId`
6. Test with duplicate bash commands (e.g., run `echo hello` twice in same session)

### Edge Cases / Testing

- Run the same bash command twice in a session - both cards should show correct independent status
- Parallel tool calls with identical args should each track independently
- Verify elapsed time updates correctly for each card
