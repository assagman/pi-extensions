# Delta — Memory for AI Agents

Persistent memory extension for Pi coding agent. Single unified storage with
FTS5 full-text search — everything is `content + tags[]`.

## Features

| Feature | Description |
|---------|-------------|
| **Unified Memory** | Single `memories` table — no separate KV/episodic/notes |
| **FTS5 Search** | Full-text search across content, tags, and context |
| **Tag-Based Classification** | Flexible tags instead of rigid categories |
| **Importance Levels** | `low`, `normal`, `high`, `critical` |
| **Auto-Capture** | Git commits automatically logged as memories |
| **System Prompt Injection** | Memory context injected every turn |
| **Prune Dashboard** | TUI-based intelligent memory cleanup (`/delta-prune`) |

## Installation

```bash
cd extensions/delta
bun install
./install.sh
```

## How It Works

```
┌────────────────────────────────────────────────────────────────┐
│                      Session Start                             │
│  Delta injects <delta_memory> into system prompt:              │
│  • Mandatory recall/persist instructions                       │
│  • Critical Knowledge (high/critical memories, full content)   │
│  • Memory Map (category counts + sample keywords)              │
└──────────────────────────┬─────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────┐
│                    Agent Operations                             │
│  delta_remember — persist knowledge with tags + importance      │
│  delta_search   — FTS5 full-text + tag/importance filtering    │
│  delta_forget   — delete memory by ID                          │
│  delta_info     — stats, version, schema                       │
└────────────────────────────────────────────────────────────────┘
```

## Database Location

Data is stored per-repo (worktree-aware, NOT per-branch):

```
~/.local/share/pi-ext-delta/<repo-id>/delta.db
```

All worktrees of the same repository share one DB.

## Tools

### Core Operations

| Tool | Description |
|------|-------------|
| `delta_remember` | Store a memory with content, tags, importance, context |
| `delta_search` | FTS5 search by query, tags, importance, time, session |
| `delta_forget` | Delete a memory by ID |
| `delta_info` | Database location, version, stats, schema dump |

### Usage Examples

```
# Remember a decision
delta_remember content="Chose PostgreSQL over MySQL — better JSON support"
               tags=["decision", "database"]
               importance="high"

# Remember a bug
delta_remember content="Race condition in worker pool — use mutex"
               tags=["bug", "concurrency"]
               context="src/worker.ts"

# Remember a convention
delta_remember content="All error handling uses Result<T,E> pattern"
               tags=["convention", "error-handling"]

# Search by content
delta_search query="PostgreSQL"

# Search by tags
delta_search tags=["decision"]

# Search with filters
delta_search query="auth" tags=["bug"] importance="critical"

# Forget a memory
delta_forget id=42
```

## Memory Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | int | Auto-generated ID |
| `content` | string | Memory content (required) |
| `tags` | string[] | Classification tags (JSON array) |
| `importance` | enum | `low`, `normal`, `high`, `critical` |
| `context` | string? | File path, task ref, etc. |
| `session_id` | string? | Session that created it |
| `created_at` | timestamp | Creation time (epoch ms) |
| `updated_at` | timestamp | Last update time |
| `last_accessed` | timestamp | Last search access time |

## Tag Conventions

Tags classify memories into awareness categories:

| Tag | Use Case |
|-----|----------|
| `decision` | Architecture, design, technology choices |
| `bug`, `gotcha` | Bugs, pitfalls, workarounds |
| `convention`, `approach` | Code patterns, methodology |
| `workflow` | Build, deploy, test processes |
| `exploration` | Experiments (pair with `outcome:success/failure`) |
| `issue`, `reminder` | Known problems, things to remember |
| `architecture` | System design, component relationships |
| `commit`, `auto-captured` | Git commits (auto-logged) |

**Importance levels:** `high`/`critical` memories are auto-loaded into the
system prompt every turn. Use sparingly for must-know project knowledge.

## System Prompt Injection

Delta injects a `<delta_memory>` block every turn containing:

1. **Mandatory instructions** — recall-before-work, persist-after-decisions
2. **Critical Knowledge** — full content of high/critical importance memories
3. **Memory Map** — awareness categories with counts and sample keywords

## Auto-Capture

Git commits are automatically detected and stored:
- Triggered on `git commit` via Bash tool result
- Stored with tags `["commit", "auto-captured"]`
- Includes branch, hash, message, and file stats

## Memory Maintenance: /delta-prune

TUI dashboard for intelligent memory cleanup.

### Detection

| Reason | Condition |
|--------|-----------|
| `stale` | Never accessed or age > 30 days |
| `orphaned_path` | References non-existent files |
| `orphaned_branch` | References non-existent branches |
| `old_session` | From a previous session + somewhat stale |
| `low_importance` | Low importance + stale > 14 days |
| `duplicate` | >80% content similarity |
| `low_content` | Content < 10 chars (likely junk) |

### Scoring

`score = importance_weight × recency × access_frequency` (0–100)

Items with `score < 30` + a prune reason become candidates.

### Controls

| Key | Action |
|-----|--------|
| `j/k` | Navigate |
| `space` | Toggle selection |
| `a/n` | Select all / deselect all |
| `Enter/l` | View details |
| `d` | Delete selected |
| `q/Esc` | Exit |

## Migration

Delta v4 automatically migrates v3 databases:

| v3 Source | v4 Mapping |
|-----------|------------|
| `episodes` | content, tags, context, session_id preserved |
| `project_notes` | title+content merged, category → tag, active=0 → "archived" tag |
| `kv` | "key: value" content, `["kv", key]` tags |
| `memory_index` | Dropped (FTS5 replaces it) |

All v3 tables are dropped after migration.
