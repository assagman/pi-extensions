# Omega — Step Looper

Omega repeats user-defined steps with aggressive compaction between each. Define your workflow, set repetitions, let it run.

## Quick Start

```bash
cd extensions/omega
bun install && ./install.sh
```

Then in Pi:

```
/omega
```

## How It Works

```
/omega
  │
  ├─ Editor: enter steps (one per line)
  │    review uncommitted changes
  │    apply fixes for all findings
  │
  ├─ Select: repetitions → 3
  │
  └─ Loop:
     rep 1: step1 → compact → step2 → compact
     rep 2: step1 → compact → step2 → compact
     rep 3: step1 → compact → step2 → compact
     ✅ Done
```

## Commands

| Command | Description |
|---------|-------------|
| `/omega` | Start — opens step editor + repetition selector |
| `/omega stop` | Abort the current loop |
| `/omega status` | Show progress |

Inline text is pre-filled in the editor: `/omega review and fix code`

## Examples

**Plan refinement:**
```
Steps:
  1. create a comprehensive plan for auth system, write to plan.md
  2. review plan.md critically, write review to plan_review.md
  3. read plan.md and plan_review.md, update plan.md addressing all feedback

Repetitions: 3
```

**Code review loop:**
```
Steps:
  1. review uncommitted changes for bugs and security issues
  2. fix all issues found

Repetitions: 4
```

**Documentation:**
```
Steps:
  1. audit all public APIs, write docs gaps to docs_audit.md
  2. fix documentation for all gaps found in docs_audit.md

Repetitions: 2
```

## Compaction

Between every step, omega compacts the session with ultra-minimal instructions: only the step list and current progress are preserved. This gives each step fresh context.

## Session Interrupt Recovery

State is persisted via `appendEntry`. If Pi restarts mid-loop, omega detects the interrupted state and notifies the user with the step list and progress. The loop does **not** auto-resume — use `/omega` to restart.
