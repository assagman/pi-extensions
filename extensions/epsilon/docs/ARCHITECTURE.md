# Epsilon Architecture

## Overview

Epsilon is a task management extension extracted from delta. It provides SQLite-backed task CRUD with subtasks, priorities, statuses, and tags.

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Pi Agent                                  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    System Prompt                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │  <epsilon_tasks>                                         │  │  │
│  │  │  • Active tasks (todo, in_progress, blocked)             │  │  │
│  │  │  • Status overview (counts per status)                   │  │  │
│  │  │  • Workflow: create before, update after                 │  │  │
│  │  │  </epsilon_tasks>                                        │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Epsilon Tools (7)                          │  │
│  │                                                               │  │
│  │  Task CRUD            Info                                    │  │
│  │  ──────────           ────                                    │  │
│  │  epsilon_task_create  epsilon_info                             │  │
│  │  epsilon_task_list    epsilon_version                          │  │
│  │  epsilon_task_update                                          │  │
│  │  epsilon_task_delete                                          │  │
│  │  epsilon_task_get                                             │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    SQLite Database                            │  │
│  │  ~/.local/share/pi-ext-epsilon/<repo-id>/epsilon.db          │  │
│  │                                                               │  │
│  │  ┌──────────────────┐  ┌────────────────────┐                │  │
│  │  │      tasks       │  │  schema_version    │                │  │
│  │  └──────────────────┘  └────────────────────┘                │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Module Structure

| File | LOC | Purpose |
|------|-----|---------|
| `index.ts` | ~93 | Extension factory, event handlers, prompt builders |
| `db.ts` | ~458 | SQLite operations, schema, task queries |
| `tools.ts` | ~193 | 7 tool definitions with TypeBox schemas |
| `db.test.ts` | ~181 | Database unit tests (vitest) |

## Data Flow

### Session Start

```
Pi Session Start
      │
      ▼
before_agent_start
      │
      ▼
getTaskSummary()
  • Count by status
  • List active tasks
      │
      ▼
buildTasksPrompt()
  • First turn: instructions + data
  • Subsequent: data only
      │
      ▼
Inject into systemPrompt
  + hidden message (display: false)
```

### Tool Execution

```
Agent calls epsilon_task_*
      │
      ▼
tools.ts handler
  • Validate params (TypeBox)
  • Call db function
      │
      ▼
db.ts operation
  • Execute SQL (parameterized)
  • Return result
      │
      ▼
Format response → Agent
```

## Database Schema

```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT DEFAULT 'medium',
  tags TEXT,                              -- JSON array
  parent_id INTEGER,                      -- self-reference for subtasks
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_priority ON tasks(priority);
```

## Storage Location

```
~/.local/share/pi-ext-epsilon/<repo-id>/epsilon.db
```

Uses `pi-ext-shared` (`getExtensionDbPath`) for consistent repo-scoped DB paths.

## Prompt Injection Strategy

| Turn | System Prompt | Hidden Message |
|------|---------------|----------------|
| First | Instructions + task data | Summary with emoji + active task list |
| Subsequent | Task data only (no instructions) | None |
| Empty state | Minimal prompt (tools listed) | "No tasks yet" message |

## Dependencies

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | Synchronous SQLite driver |
| `@sinclair/typebox` | Runtime type validation for tool schemas |
| `@mariozechner/pi-coding-agent` | Pi extension API |
| `pi-ext-shared` | Repo ID, SQLite helpers, tool factory |
