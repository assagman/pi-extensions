---
name: delta
description: >-
  Persistent project memory with 9 awareness categories. Manages decisions,
  preferences, environment, workflows, approach, explorations, structures,
  architecture, and issues/gotchas across sessions.
  Triggers: remember, recall, memory, delta, preference, convention, decision,
  workflow, gotcha, issue, pattern, exploration, architecture, approach,
  save knowledge, what did I decide, log discovery.
license: MIT
compatibility: Requires delta Pi extension installed (~/.pi/agent/extensions/delta)
metadata:
  author: pi-user
  version: "2.0"
---

# Delta Memory — Awareness Model & Retrieval Guide

## 3-Tier Retrieval Architecture

```
┌─ TIER 1: MEMORY MAP (always in system prompt) ──────────────────┐
│ Shows category names + counts + keywords. NO content.            │
│ You read the map to know WHAT exists, then pull what you need.   │
├─ TIER 2: ON-DEMAND RETRIEVAL (you call tools) ──────────────────┤
│ delta_recall(tags/query)  — search episodes                      │
│ delta_note_list(category) — list notes by category               │
│ delta_note_get(id)        — full note content                    │
│ delta_index_search(query) — keyword search across all types      │
│ delta_get(key)            — specific KV value                    │
├─ TIER 3: CRITICAL AUTO-LOAD (rare exceptions) ──────────────────┤
│ HIGH/CRITICAL importance notes always visible in system prompt.   │
│ Use sparingly — only for must-know project-wide knowledge.       │
└──────────────────────────────────────────────────────────────────┘
```

## 9 Awareness Categories

### 1. Decisions (architecture & design)

| | |
|---|---|
| **When** | After making or approving architecture, design, or technology choices |
| **Store** | `delta_log content="Chose X over Y — reason" tags=["decision", "<domain>"]` |
| **Retrieve** | `delta_recall(tags=["decision"])` or `delta_index_search("decision <topic>")` |
| **Examples** | "Chose vitest over jest — ESM support", "REST over gRPC — simpler debugging" |

### 2. User Preferences

| | |
|---|---|
| **When** | User corrects you, expresses preference, or establishes a pattern |
| **Store** | `delta_set(key="pref:<name>", value="<description>")` |
| **Retrieve** | `delta_get(key="pref:<name>")` |
| **Examples** | `pref:test_framework`="vitest", `pref:commit_style`="conventional", `pref:response_style`="ultra-concise" |

### 3. System & Environment

| | |
|---|---|
| **When** | You discover OS, runtime versions, toolchain, infra details while working |
| **Store** | `delta_set(key="env:<name>", value="<value>")` |
| **Retrieve** | `delta_get(key="env:<name>")` |
| **Examples** | `env:os`="macOS Tahoe 26.3 arm64", `env:node`="22.x", `env:ci`="GitHub Actions" |

### 4. Way of Working (Workflows)

| | |
|---|---|
| **When** | User describes or demonstrates work processes, rituals, patterns |
| **Store** | `delta_note_create(title="...", category="workflow", content="...")` |
| **Retrieve** | `delta_note_list(category="workflow")` then `delta_note_get(id)` |
| **Examples** | "Git worktree workflow", "Deploy to staging process", "PR review checklist" |

### 5. Solution Approach

| | |
|---|---|
| **When** | User guides methodology or effective problem-solving patterns emerge |
| **Store** | `delta_note_create(title="...", category="convention", content="...")` or `delta_log(..., tags=["approach"])` |
| **Retrieve** | `delta_note_list(category="convention")` or `delta_recall(tags=["approach"])` |
| **Examples** | "Plan before executing", "Async-first, thread-safe always", "Verify results after every step" |

### 6. Explorations & Experiments

| | |
|---|---|
| **When** | After trying something — whether it worked or failed |
| **Store** | `delta_log(content="Tried X — result: Y", tags=["exploration", "<outcome>"])` |
| **Retrieve** | `delta_recall(tags=["exploration"])` |
| **Examples** | "Tried bun:sqlite — fails in Node.js runtime", "Tested WAL mode on NFS — breaks", "d2 renders ASCII diagrams well" |

Outcome tags: `outcome:success`, `outcome:failure`, `outcome:partial`

### 7. Project Structures & Patterns

| | |
|---|---|
| **When** | You discover or establish project-specific code patterns |
| **Store** | `delta_note_create(title="...", category="convention", content="...")` |
| **Retrieve** | `delta_note_list(category="convention")` then `delta_note_get(id)` |
| **Examples** | "Extension structure: src/index.ts exports ExtensionFactory", "All tools use createTool() from pi-ext-shared" |

### 8. Architecture & System Design

| | |
|---|---|
| **When** | You understand or design system components, data flows, interactions |
| **Store** | `delta_note_create(title="...", category="general", content="...")` |
| **Retrieve** | `delta_note_list(category="general")` then `delta_note_get(id)` |
| **Examples** | "Pi extension lifecycle: factory → register tools → event handlers", "Memory index auto-maintained via SQLite triggers" |

### 9. Bugs, Issues & Gotchas

| | |
|---|---|
| **When** | You encounter bugs, pitfalls, workarounds, or gotchas |
| **Store** | `delta_note_create(title="...", category="issue", content="...")` or `delta_log(..., tags=["bug", "<component>"])` |
| **Retrieve** | `delta_note_list(category="issue")` or `delta_recall(tags=["bug"])` |
| **Examples** | "better-sqlite3 doesn't load under bun test", "Empty IN() causes SQLite syntax error" |

### Commits (auto-captured)

Git commits are **automatically logged** as episodes with `tags=["commit", "auto-captured"]`.
No manual action needed. Retrieve with: `delta_recall(tags=["commit"])`

---

## Retrieval Patterns

### Before Starting Any Task

1. Read the **Memory Map** in your system prompt
2. Identify which categories are relevant to the task
3. Pull content from those categories using the retrieval tools above

### During Work

| Trigger | Action |
|---------|--------|
| Found a bug | `delta_note_create(category="issue")` or `delta_log(tags=["bug"])` |
| Made a decision | `delta_log(tags=["decision", "<domain>"])` |
| Discovered a pattern | `delta_note_create(category="convention")` |
| User expressed preference | `delta_set(key="pref:<name>")` |
| Tried something | `delta_log(tags=["exploration", "outcome:<result>"])` |
| Learned architecture | `delta_note_create(category="general")` |
| Identified workflow | `delta_note_create(category="workflow")` |

### After Task Completion

- Log significant outcomes: `delta_log(content="...", tags=["milestone"])`
- Update notes if knowledge changed: `delta_note_update(id, ...)`

---

## Tool Quick Reference

| Action | Tool | Key Arguments |
|--------|------|---------------|
| Search all | `delta_index_search` | query, source_type? |
| Recall events | `delta_recall` | query?, tags?, limit? |
| Get note | `delta_note_get` | id |
| List notes | `delta_note_list` | category?, importance? |
| Get KV | `delta_get` | key |
| Log event | `delta_log` | content, context?, tags? |
| Create note | `delta_note_create` | title, content, category?, importance? |
| Update note | `delta_note_update` | id, title?, content?, category?, importance?, active? |
| Set KV | `delta_set` | key, value |

---

## Storage Convention Summary

```
KV keys:     pref:<name>, env:<name>
Episode tags: ["decision","<domain>"], ["exploration","outcome:<r>"],
              ["bug","<component>"], ["approach"], ["commit","auto-captured"]
Note cats:    issue, convention, workflow, reminder, general
Importance:   low, normal, high, critical (high/critical auto-loaded)
```
