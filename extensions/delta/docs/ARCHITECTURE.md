# Delta v4 Architecture

## Overview

Delta is a persistent memory extension for Pi coding agent. A single unified
`memories` table with FTS5 full-text search replaces the v3 multi-table design.

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Pi Agent                                  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    System Prompt                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │  <delta_memory>                                          │  │  │
│  │  │  • Mandatory recall/persist instructions                 │  │  │
│  │  │  • Critical Knowledge (high/critical memories)           │  │  │
│  │  │  • Memory Map (category counts + keywords)               │  │  │
│  │  │  </delta_memory>                                         │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Delta Tools                                │  │
│  │                                                               │  │
│  │  delta_remember    — persist knowledge                        │  │
│  │  delta_search      — FTS5 full-text + tag/importance filter   │  │
│  │  delta_forget      — delete memory by ID                      │  │
│  │  delta_info        — stats, version, schema dump              │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    SQLite Database                             │  │
│  │  ~/.local/share/pi-ext-delta/<repo-id>/delta.db               │  │
│  │                                                               │  │
│  │  ┌────────────────┐   ┌──────────────────────┐                │  │
│  │  │   memories     │──▶│  memories_fts (FTS5)  │                │  │
│  │  │   (unified)    │   │  (full-text index)    │                │  │
│  │  └────────────────┘   └──────────────────────┘                │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Module Structure

```
delta/
├── src/
│   ├── index.ts          # Extension entry, events, prompt injection
│   ├── db.ts             # SQLite: schema, migration, CRUD, FTS5, prompt
│   ├── tools.ts          # Tool definitions (Phase 2: rewrite pending)
│   ├── db.test.ts        # 96 db tests (vitest)
│   └── prune/
│       ├── analyzer.ts   # Prune analysis + scoring
│       ├── detector.ts   # File path / branch ref detection
│       ├── types.ts      # Prune types + config
│       ├── ui.ts         # TUI dashboard component
│       └── analyzer.test.ts  # 17 prune tests
├── docs/
│   ├── README.md
│   └── ARCHITECTURE.md
├── skill/
│   └── SKILL.md          # Agent skill doc (prompt injection guide)
├── install.sh
├── uninstall.sh
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

| File | Lines | Purpose |
|------|------:|---------|
| `db.ts` | 895 | Schema, migration, CRUD, FTS5 search, prompt building |
| `index.ts` | 208 | Extension factory, event handlers, git commit auto-capture |
| `tools.ts` | 406 | Tool definitions (v3 — Phase 2 rewrite pending) |
| `db.test.ts` | 1158 | 96 tests: schema, CRUD, FTS5, migration, edge cases |
| `prune/` | 1451 | Prune module: analyzer, detector, types, TUI, tests |

## Database Schema (v4)

### Tables

```sql
-- Unified memory storage
memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,                    -- memory content
  tags TEXT,                                -- JSON array of strings
  importance TEXT NOT NULL DEFAULT 'normal', -- low|normal|high|critical
  context TEXT,                             -- file path, task ref, etc.
  session_id TEXT,                          -- session that created it
  created_at INTEGER NOT NULL,              -- epoch ms
  updated_at INTEGER NOT NULL,              -- epoch ms
  last_accessed INTEGER NOT NULL DEFAULT 0  -- epoch ms (0 = never)
)

-- FTS5 full-text index (external content, synced via triggers)
memories_fts USING fts5(
  content,                    -- indexed from memories.content
  tags,                       -- indexed from memories.tags
  context,                    -- indexed from memories.context
  content=memories,           -- external content table
  content_rowid=id            -- rowid mapping
)
```

### Indexes

```sql
idx_memories_importance ON memories(importance)
idx_memories_session    ON memories(session_id)
idx_memories_created    ON memories(created_at)
idx_memories_updated    ON memories(updated_at)
```

### FTS5 Sync Triggers

```
memories_fts_ai  — AFTER INSERT: add to FTS5 index
memories_fts_ad  — AFTER DELETE: remove from FTS5 index
memories_fts_au  — AFTER UPDATE: delete old + insert new in FTS5
```

### Schema Version History

| Version | Changes |
|--------:|---------|
| v1 | Original: kv, episodes, tasks, project_notes |
| v2 | Added memory_index + triggers, dropped task columns |
| v3 | Removed tasks, added last_accessed, repo-scoped storage |
| **v4** | **Unified memories table + FTS5, dropped all v3 tables** |

## Data Flow

### Session Lifecycle

```
session_start ──▶ resetSession()
                  resetState()

before_agent_start (every turn)
  │
  ├──▶ getMemoryContext()
  │      ├── Load all memories (limit 100, importance-ordered)
  │      ├── Load important memories (high/critical)
  │      └── Count total
  │
  ├──▶ buildMemoryPrompt()
  │      ├── Mandatory instructions
  │      ├── Critical Knowledge (full content of high/critical)
  │      └── Memory Map (awareness categories + counts)
  │
  └──▶ Inject into systemPrompt

tool_result (Bash) ──▶ Auto-capture git commits as memories
                       tags: ["commit", "auto-captured"]

session_shutdown ──▶ closeDb()
```

### Search Flow

```
search(query?, tags?, importance?, ...)
  │
  ├── query provided?
  │   ├── YES ──▶ sanitizeFtsQuery() ──▶ FTS5 MATCH + rank
  │   │          on error ──▶ LIKE fallback
  │   └── NO  ──▶ filteredSearch (importance + recency order)
  │
  ├── Apply additional filters (tags, importance, since, session)
  ├── Update last_accessed on results
  └── Return Memory[]
```

## Storage Location

```
~/.local/share/pi-ext-delta/<repo-id>/delta.db
```

Repo ID is derived from the git root directory (worktree-aware):
- `/Users/dev/my-app` → `Users_dev_my-app`
- All worktrees of the same repo share the same DB

## Migration v3→v4

```
v3 Tables          Migration                     v4 Table
───────────        ──────────                    ─────────
episodes     ──▶   content, tags, context,       memories
                    session_id preserved
                    timestamp → created/updated

project_notes ──▶  title || "\n\n" || content    memories
                    category → tag
                    active=0 → "archived" tag
                    importance preserved

kv           ──▶   "key: value" as content       memories
                    ["kv", key] as tags

memory_index ──▶   DROPPED (FTS5 replaces it)
```

After migration: all v3 tables, triggers, and indexes are dropped.
Defensive `cleanupV3Artifacts()` runs on every init to handle partial migrations.

## Awareness Classification

Memories are classified into awareness categories based on tags:

| Category | Tags |
|----------|------|
| Commits | `commit`, `auto-captured` |
| Decisions | `decision` |
| Preferences | `preference`, `pref` |
| Environment | `environment`, `env` |
| Workflows | `workflow` |
| Conventions | `convention`, `approach` |
| Architecture | `architecture` |
| Issues | `issue`, `bug`, `gotcha`, `reminder` |
| Explorations | `exploration` |
| Other | (no matching tags) |

Used by `buildMemoryPrompt()` to generate the Memory Map section.

## Thread Safety

- SQLite WAL mode (`PRAGMA journal_mode = WAL`)
- Single DB connection per process (module-level singleton)
- Synchronous operations (better-sqlite3)
- `PRAGMA foreign_keys = ON`

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `better-sqlite3` | ^11.7.0 | Synchronous SQLite with FTS5 support |
| `@sinclair/typebox` | ^0.32.15 | Runtime type validation for tools |
| `@mariozechner/pi-coding-agent` | * | Pi extension API |
| `pi-ext-shared` | local | Repo ID, DB path, SQLite helpers, tool factory |
