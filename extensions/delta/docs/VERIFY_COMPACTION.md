# Delta Phase-Compaction Verification Plan

## Goal
Confirm that Delta compacts/reset context between phases so review phases feel “fresh” while still being able to rely on persisted artifacts.

## Pre-req
Run pi with the Delta extension enabled.

## Steps

### 1) Start a workflow and produce first artifact
1. Toggle Delta on: `Ctrl+Alt+L` (or ensure it is enabled).
2. Enter a goal prompt (any small task).
3. In **requirements** phase, write `.delta/requirements.md`.
4. Call `delta_advance` with:
   - `summary`: short bullets
   - `artifacts: { phaseFile: ".delta/requirements.md" }`

Expected:
- Delta advances to `review_requirements`.
- A notification appears: `Δ will compact context after this phase`.

### 2) Confirm phase-boundary reset compaction happens
1. Complete `review_requirements` and call `delta_advance` (with verdict/checks/etc) and artifact `.delta/review_requirements.md`.

Expected:
- After the tool returns, Delta triggers compaction on `turn_end`.
- You should see a notification: `Δ compacted context for next phase`.

### 3) Confirm session context is minimal
1. Continue to the next phase and observe the assistant behavior.

Expected:
- The assistant should not “remember” long conversational details.
- The injected context should include only:
  - the goal
  - compact per-phase summaries
  - artifact file paths

### 4) Confirm artifacts are required & validated
1. Try calling `delta_advance` without `artifacts.phaseFile`.

Expected:
- Tool returns an error requiring `artifacts.phaseFile`.

2. Try calling `delta_advance` with a non-existent relative artifact path.

Expected:
- Tool returns `Error: Artifact file not found`.

### 5) Resume behavior
1. Restart pi / reload the session.

Expected:
- Delta resumes at the correct phase.
- `.delta/*` files remain and are referenced in context.

## Notes
- Delta uses a custom compaction hook (`session_before_compact`) only when the compaction is tagged with `[DELTA_PHASE_RESET]`.
- Normal pi compaction behavior remains unchanged for non-Delta compactions.
