# Delta Extension — Architecture

> **v3.1.0** — Phase-gate workflow schema for Pi coding agent + phase-boundary compaction reset.
> Single-agent orchestration via deterministic lifecycle with explicit gates, evidence, and feedback loops.

---

## Overview

Delta steers the main Pi agent through a structured workflow without spawning subagents.
It works by injecting phase-specific instructions into the agent's system prompt before each turn,
and providing a `delta_advance` tool the agent calls to signal phase completion.

Key improvements vs v2:
- Explicit **Requirements** + **Design** phases with gates (handshakes)
- Gate decisions include structured **verdict + reasons + checklist + evidence**
- `review_impl` rejection routes to the *correct* phase (implement/test/plan/design/requirements)
- Gate rejection cap to prevent endless self-arguing
- Persisted per-phase timing and gate stats for metrics

---

## Phase Lifecycle

```
                    ┌──────────────────────────────┐
                    │         USER INPUT           │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │       🧾 REQUIREMENTS         │
                    │  Define acceptance criteria   │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
              ┌────▶│   🔎 REVIEW (Requirements)    │◀──────┐
              │     └───────┬──────────┬───────────┘       │
              │             │          │                   │
              │    approved │          │ needs_changes     │
              │             │          └───────────────────┘
              │             ▼
              │     ┌──────────────────────────────┐
              │     │         🧩 DESIGN             │
              │     │  Architecture/API decisions   │
              │     └──────────────┬───────────────┘
              │                    │
              │     ┌──────────────▼───────────────┐
              ├────▶│      🧠 REVIEW (Design)       │◀──────┐
              │     └───────┬──────────┬───────────┘       │
              │             │          │                   │
              │    approved │          │ needs_changes     │
              │             │          └───────────────────┘
              │             ▼
              │     ┌──────────────────────────────┐
              │     │         📋 PLAN               │
              │     │  Steps + AC→verification map  │
              │     └──────────────┬───────────────┘
              │                    │
              │     ┌──────────────▼───────────────┐
              ├────▶│      🧾 REVIEW (Plan)         │◀──────┐
              │     └───────┬──────────┬───────────┘       │
              │             │          │                   │
              │    approved │          │ needs_changes     │
              │             │          └───────────────────┘
              │             ▼
              │     ┌──────────────────────────────┐
              │     │        🔨 IMPLEMENT           │
              │     └──────────────┬───────────────┘
              │                    │
              │     ┌──────────────▼───────────────┐
              │     │          🧪 TEST              │
              │     └──────────────┬───────────────┘
              │                    │
              │     ┌──────────────▼───────────────┐
              │     │      ✅ REVIEW (Impl)         │
              │     └───────┬──────────┬───────────┘
              │             │          │
              │    approved │          │ needs_changes (classified)
              │             │          └─────────────┬───────────────┐
              │             ▼                        │               │
              │     ┌──────────────────────────────┐ │               │
              │     │         📦 DELIVER            │◀┘               │
              │     └──────────────┬───────────────┘                 │
              │                    │                                 │
              │                    ▼                                 │
              │     ┌──────────────────────────────┐                 │
              └────▶│           ✓ DONE             │                 │
                    └──────────────────────────────┘                 │
                                                                     │
               needs_changes routes by issueClass:                   │
                 fix_only  → implement                               │
                 test_gap  → test                                    │
                 plan_gap  → plan                                    │
                 design_gap→ design                                  │
                 req_gap   → requirements                            │
```

---

## Gates and “Solo Handshakes”

Since this is a solo agent workflow, handshakes are encoded as **gate phases** requiring:
- `verdict`: approved / needs_changes / blocked / abandoned
- `reasons[]`: actionable reasons when verdict != approved
- `checks`: checklist booleans (explicit pass/fail)
- `evidence`: commands run + key output excerpts (esp. test/typecheck/lint)

This makes approvals *auditable* and reduces self-review bias by forcing explicit criteria and evidence.

---

## Phase Artifacts & Context Compaction

Delta v3 intentionally compacts conversational context between phases to reduce review bias and “context inertia”.

### Artifact convention

Each phase must write its output to a file under the project working directory:

```
.delta/requirements.md
.delta/review_requirements.md
.delta/design.md
.delta/review_design.md
.delta/plan.md
.delta/review_plan.md
.delta/implement.md
.delta/test.md
.delta/review_impl.md
.delta/deliver.md
```

Rules:
- The agent **must** write/overwrite the phase file before calling `delta_advance`.
- The `delta_advance` tool call must include: `artifacts: { phaseFile: ".delta/<phase>.md" }`.
- Delta validates that the artifact exists (best-effort) before advancing.

### Compaction behavior (phase boundary reset)

After every successful `delta_advance` phase transition, Delta triggers a **hard reset compaction**:

- It appends a hidden `custom_message` marker (`customType: delta-phase-reset`) with:
  - current phase
  - phase goal
  - compact per-phase summaries (3–4 sentences each)
  - artifact paths
- It then runs `ctx.compact()` with a `[DELTA_PHASE_RESET]` instruction.
- A custom compaction hook (`session_before_compact`) ensures the compaction:
  - keeps only the phase-reset marker message as the earliest kept entry
  - replaces prior conversation with a minimal, phase-oriented summary

As a result, the next phase starts with **fresh context** and must rely on artifacts via file reads.

---

## Tool: `delta_advance`

Parameters:

| Param | Type | Required | Notes |
|---|---|---:|---|
| `summary` | `string` | Yes | Short phase summary (3–4 sentences or 3–8 bullets) |
| `verdict` | `approved \| needs_changes \| blocked \| abandoned` | Gate phases only | Enforced for `review_*` phases |
| `issueClass` | `fix_only \| test_gap \| plan_gap \| design_gap \| req_gap` | Only for `review_impl` + needs_changes | Drives routing |
| `reasons` | `string[]` | For non-approved gate verdicts | Enforced |
| `checks` | `{[k: string]: boolean}` | Optional | Gate checklist |
| `evidence` | `{commands?: string[], outputs?: string[]}` | Optional | Verification evidence |
| `artifacts` | `{[k: string]: string}` | Yes (must include `phaseFile`) | Inline or pointers |

---

## Data Model (`ProgressData`)

Stored at:
```
~/.local/share/pi/delta/<session-id>.json
```

Notable fields:
- `currentPhaseStartedAt` (phase timing)
- `gateRejectionCount` + `maxGateRejections` (anti-infinite-loop)
- `gateStats` (counts of needs_changes/blocked/abandoned per gate)
- `phaseSummaries` (compact per-phase summaries; injected into the next phase)
- `phaseArtifacts` (phase → artifact file pointer)
- Legacy fields: `requirements`, `design`, `plan`, etc. (kept for backward compatibility)
- `history[]` contains full audit entries with evidence/checklists

Schema versioning:
- v2 files (no `schemaVersion`) are migrated best-effort to v3 on load.
- v3 adds `phaseSummaries` + `phaseArtifacts` to support phase-compacted context.

---

## Module Breakdown

- `index.ts` — hooks, UI, `delta_advance` tool, phase-boundary compaction
- `phases.ts` — phase/gate instruction prompts + artifact conventions
- `progress.ts` — state machine, persistence, migration, metrics, compact context builder
- `VERIFY_COMPACTION.md` — manual verification checklist

