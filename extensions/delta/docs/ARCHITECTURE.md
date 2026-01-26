# Delta Architecture

## Overview

Delta is a persistent memory extension for Pi coding agent that provides SQLite-backed storage for tasks, notes, key-value pairs, and episodic events.

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Pi Agent                                  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    System Prompt                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │  <delta_memory>                                          │  │  │
│  │  │  • Active project notes                                  │  │  │
│  │  │  • Task overview (status counts + active tasks)          │  │  │
│  │  │  • Memory stats (kv keys, episode count)                 │  │  │
│  │  │  • Workflow guidelines                                   │  │  │
│  │  │  </delta_memory>                                         │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Delta Tools (16)                           │  │
│  │                                                               │  │
│  │  KV Store        Tasks           Notes           Episodic     │  │
│  │  ─────────       ─────           ─────           ────────     │  │
│  │  delta_get       delta_task_*    delta_note_*    delta_log    │  │
│  │  delta_set       (5 tools)       (5 tools)       delta_recall │  │
│  │  delta_delete                                                 │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    SQLite Database                            │  │
│  │  ~/.local/share/pi-ext-delta/<project>-<branch>/delta.db     │  │
│  │                                                               │  │
│  │  ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌───────────────┐      │  │
│  │  │   kv    │ │ episodes │ │  tasks  │ │ project_notes │      │  │
│  │  └─────────┘ └──────────┘ └─────────┘ └───────────────┘      │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Module Structure

| File | LOC | Purpose |
|------|-----|---------|
| `index.ts` | ~170 | Extension entry, event handlers, prompt builders |
| `db.ts` | ~890 | SQLite operations, schema, queries |
| `tools.ts` | ~490 | Tool definitions, TypeBox schemas |
| `db.test.ts` | ~320 | Database unit tests (vitest) |

## Data Flow

### Session Start

```
┌────────────────────┐
│  Pi Session Start  │
└─────────┬──────────┘
          │
          ▼
┌─────────────────────────────┐
│  before_agent_start event   │
└─────────┬───────────────────┘
          │
          ▼
┌─────────────────────────────┐
│  getMemoryContext()         │
│  • Load active notes        │
│  • Get task summary         │
│  • Count KV keys            │
│  • Count episodes           │
└─────────┬───────────────────┘
          │
          ▼
┌─────────────────────────────┐
│  buildMemoryPrompt()        │
│  • Format as XML block      │
│  • Inject into systemPrompt │
└─────────────────────────────┘
```

### Tool Execution

```
┌──────────────────────┐
│  Agent calls tool    │
│  e.g. delta_task_*   │
└─────────┬────────────┘
          │
          ▼
┌──────────────────────┐
│  tools.ts handler    │
│  • Validate params   │
│  • Call db function  │
└─────────┬────────────┘
          │
          ▼
┌──────────────────────┐
│  db.ts operation     │
│  • Execute SQL       │
│  • Return result     │
└─────────┬────────────┘
          │
          ▼
┌──────────────────────┐
│  Format response     │
│  • Return to agent   │
└──────────────────────┘
```

## Database Schema

### Tables

```sql
-- Key-Value Store (simple persistent storage)
kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)

-- Episodic Memory (timestamped events)
episodes (
  id INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  context TEXT,           -- optional: file, task, etc.
  tags TEXT,              -- JSON array
  timestamp INTEGER NOT NULL,
  session_id TEXT         -- links to specific session
)

-- Task Management
tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'todo',    -- todo|in_progress|blocked|done|cancelled
  priority TEXT DEFAULT 'medium', -- low|medium|high|critical
  scope TEXT DEFAULT 'project',   -- session|project
  tags TEXT,                      -- JSON array
  parent_id INTEGER,              -- self-reference for subtasks
  created_at INTEGER,
  updated_at INTEGER,
  completed_at INTEGER,
  session_id TEXT
)

-- Project Notes (persistent context)
project_notes (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT DEFAULT 'general', -- issue|convention|workflow|reminder|general
  importance TEXT DEFAULT 'normal', -- low|normal|high|critical
  active INTEGER DEFAULT 1,         -- 1=loaded at session start
  created_at INTEGER,
  updated_at INTEGER
)
```

### Indexes

```sql
idx_episodes_timestamp ON episodes(timestamp)
idx_episodes_session ON episodes(session_id)
idx_tasks_status ON tasks(status)
idx_tasks_scope ON tasks(scope)
idx_tasks_session ON tasks(session_id)
idx_tasks_parent ON tasks(parent_id)
idx_notes_category ON project_notes(category)
idx_notes_active ON project_notes(active)
idx_notes_importance ON project_notes(importance)
```

## Storage Location

Database path formula:
```
~/.local/share/pi-ext-delta/<sanitized-cwd>-<git-branch>/delta.db
```

Example:
```
Project: /Users/dev/my-app on branch: feat/auth
Database: ~/.local/share/pi-ext-delta/Users_dev_my-app-feat_auth/delta.db
```

Benefits:
- Per-project isolation
- Per-branch isolation (separate data per feature branch)
- Not in git (user-specific data)
- XDG-compliant location

## Thread Safety

- SQLite WAL mode enabled (`journal_mode = WAL`)
- Single database connection per process
- Synchronous operations (no concurrent access issues)

## Security Considerations

1. **Path Traversal**: `sanitizePath()` + `resolve()` boundary check
2. **SQL Injection**: Parameterized queries throughout
3. **Parent Cycle Detection**: Validates task parent references

## Performance Notes

- Git branch cached per cwd (avoids repeated `execSync`)
- Query limits default to 50 items
- Indexes on frequently filtered columns
- WAL mode for better read concurrency

## Extension Events

| Event | Handler |
|-------|---------|
| `before_agent_start` | Inject memory context into system prompt |
| `session_shutdown` | Close database connection |

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `better-sqlite3` | ^11.7.0 | Synchronous SQLite driver |
| `@sinclair/typebox` | ^0.32.15 | Runtime type validation |
| `@mariozechner/pi-coding-agent` | * | Pi extension API |
