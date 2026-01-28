---
name: delta
description: >-
  Persistent project memory with tag-based classification. Stores decisions,
  preferences, workflows, conventions, architecture, issues, explorations,
  and auto-captured commits in a unified memories table with FTS5 search.
  Includes /delta-prune for intelligent memory cleanup.
  Triggers: remember, recall, memory, delta, preference, convention, decision,
  workflow, gotcha, issue, pattern, exploration, architecture, approach,
  save knowledge, what did I decide, log discovery, prune, cleanup, stale.
license: MIT
compatibility: Requires delta Pi extension installed (~/.pi/agent/extensions/delta)
metadata:
  author: pi-user
  version: "4.0"
---

# Delta Memory — Unified Model & Retrieval Guide

## Architecture

```
┌─ TIER 1: MEMORY MAP (always in system prompt) ──────────────────┐
│ Shows category names + counts + keywords. NO content.            │
│ Read the map to know WHAT exists, then pull what you need.       │
├─ TIER 2: ON-DEMAND RETRIEVAL (you call tools) ──────────────────┤
│ delta_search(query)            — FTS5 full-text search           │
│ delta_search(tags=["..."])     — filter by tags                  │
│ delta_search(importance="...") — filter by importance             │
├─ TIER 3: CRITICAL AUTO-LOAD (rare exceptions) ──────────────────┤
│ HIGH/CRITICAL importance memories always visible in prompt.      │
│ Use sparingly — only for must-know project-wide knowledge.       │
└──────────────────────────────────────────────────────────────────┘
```

## Tools

| Tool | Purpose | Key Arguments |
|------|---------|---------------|
| `delta_remember` | Persist knowledge | content, tags?, importance?, context? |
| `delta_search` | Find memories | query?, tags?, importance?, limit? |
| `delta_forget` | Delete memory | id |
| `delta_info` | Stats & diagnostics | — |

## Awareness Categories

All memories use **tags** for classification. No separate tables or rigid types.

### 1. Decisions

| | |
|---|---|
| **When** | After making architecture, design, or technology choices |
| **Store** | `delta_remember content="Chose X over Y — reason" tags=["decision", "<domain>"]` |
| **Retrieve** | `delta_search(tags=["decision"])` or `delta_search(query="<topic>")` |
| **Examples** | "Chose vitest over jest — ESM support", "REST over gRPC — simpler debugging" |

### 2. User Preferences

| | |
|---|---|
| **When** | User corrects you, expresses preference, or establishes a pattern |
| **Store** | `delta_remember content="Prefers <X>" tags=["preference", "<domain>"]` |
| **Retrieve** | `delta_search(tags=["preference"])` |
| **Examples** | "Prefers ultra-concise responses", "Uses vitest for testing", "Commit style: conventional" |

### 3. System & Environment

| | |
|---|---|
| **When** | Discover OS, runtime versions, toolchain, infra details |
| **Store** | `delta_remember content="<env detail>" tags=["environment", "<aspect>"]` |
| **Retrieve** | `delta_search(tags=["environment"])` |
| **Examples** | "macOS Tahoe 26.3 arm64", "Node 22.x", "CI: GitHub Actions" |

### 4. Workflows

| | |
|---|---|
| **When** | User describes or demonstrates work processes |
| **Store** | `delta_remember content="<workflow>" tags=["workflow", "<process>"]` |
| **Retrieve** | `delta_search(tags=["workflow"])` |
| **Examples** | "Git worktree workflow", "Deploy to staging process" |

### 5. Conventions & Approach

| | |
|---|---|
| **When** | Code patterns, methodology, or solution approaches emerge |
| **Store** | `delta_remember content="<pattern>" tags=["convention"]` |
| **Retrieve** | `delta_search(tags=["convention"])` or `delta_search(tags=["approach"])` |
| **Examples** | "Async-first, thread-safe always", "All tools use createTool() from pi-ext-shared" |

### 6. Explorations & Experiments

| | |
|---|---|
| **When** | After trying something — success or failure |
| **Store** | `delta_remember content="Tried X — result" tags=["exploration", "outcome:<result>"]` |
| **Retrieve** | `delta_search(tags=["exploration"])` |
| **Examples** | "Tried bun:sqlite — fails in Node.js runtime", "d2 renders ASCII diagrams well" |

### 7. Architecture & System Design

| | |
|---|---|
| **When** | Understand or design system components, data flows |
| **Store** | `delta_remember content="<design>" tags=["architecture", "<component>"]` |
| **Retrieve** | `delta_search(tags=["architecture"])` |
| **Examples** | "Pi extension lifecycle: factory → register tools → event handlers" |

### 8. Bugs, Issues & Gotchas

| | |
|---|---|
| **When** | Encounter bugs, pitfalls, workarounds |
| **Store** | `delta_remember content="<issue>" tags=["bug", "<component>"] importance="high"` |
| **Retrieve** | `delta_search(tags=["bug"])` or `delta_search(tags=["issue"])` |
| **Examples** | "better-sqlite3 doesn't load under bun test", "Empty IN() causes SQLite syntax error" |

### 9. Commits (auto-captured)

Git commits are **automatically logged** with `tags=["commit", "auto-captured"]`.
No manual action needed. Retrieve: `delta_search(tags=["commit"])`

---

## Retrieval Patterns

### Before Starting Any Task

1. Read the **Memory Map** in your system prompt
2. Identify relevant categories
3. `delta_search(query="<relevant topic>")` or `delta_search(tags=["<category>"])`

### During Work

| Trigger | Action |
|---------|--------|
| Found a bug | `delta_remember(content, tags=["bug", "<component>"])` |
| Made a decision | `delta_remember(content, tags=["decision", "<domain>"])` |
| Discovered a pattern | `delta_remember(content, tags=["convention"])` |
| User expressed preference | `delta_remember(content, tags=["preference"])` |
| Tried something | `delta_remember(content, tags=["exploration", "outcome:<r>"])` |
| Learned architecture | `delta_remember(content, tags=["architecture"])` |
| Identified workflow | `delta_remember(content, tags=["workflow"])` |

### After Task Completion

- Log significant outcomes: `delta_remember(content, tags=["milestone"])`
- For must-know knowledge: `delta_remember(content, importance="high")`

---

## Importance Levels

| Level | Behavior |
|-------|----------|
| `low` | Stored, searchable, not auto-loaded |
| `normal` | Default — stored, searchable, appears in Memory Map |
| `high` | **Auto-loaded** into system prompt every turn |
| `critical` | **Auto-loaded** into system prompt every turn (highest priority) |

Only use `high`/`critical` for knowledge that is essential across ALL sessions.

---

## Memory Maintenance: /delta-prune

TUI dashboard for intelligent memory cleanup.

### What It Detects

| Reason | Condition |
|--------|-----------|
| `stale` | Never accessed or age > 30 days |
| `orphaned_path` | References non-existent files |
| `orphaned_branch` | References non-existent branches |
| `old_session` | From previous session + somewhat stale |
| `low_importance` | Low importance + stale > 14 days |
| `duplicate` | >80% content similarity |
| `low_content` | Content < 10 chars (likely junk) |

### Scoring

`score = importance × recency × access_frequency` (0–100)
Items below threshold with prune reasons become candidates.

### TUI Controls

| Key | Action |
|-----|--------|
| `j/k` | Navigate |
| `space` | Toggle selection |
| `a/n` | Select all / deselect all |
| `Enter/l` | View details |
| `d` | Delete selected |
| `q/Esc` | Exit |

### When to Prune

- After completing a major feature/milestone
- When memory gets noisy
- Before starting a new project phase
- Periodically (weekly/monthly)

---

## Tag Convention Summary

```
Classification:  ["decision"], ["bug"], ["convention"], ["workflow"],
                 ["exploration"], ["architecture"], ["issue"], ["preference"],
                 ["environment"], ["reminder"], ["approach"]

Qualifiers:      ["outcome:success"], ["outcome:failure"], ["auto-captured"]

Importance:      low, normal, high (auto-loaded), critical (auto-loaded)
```
