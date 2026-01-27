# Epsilon — Task Management

Task management extension for Pi coding agent using SQLite.

## Features

| Feature | Description |
|---------|-------------|
| **Tasks** | Create, list, update, delete tasks |
| **Subtasks** | Hierarchical tasks via `parent_id` |
| **Priorities** | low, medium, high, critical |
| **Statuses** | todo, in_progress, blocked, done, cancelled |
| **Tags** | Arbitrary string tags for categorization |
| **Auto-injection** | Task context injected into system prompt each turn |

## Installation

```bash
cd extensions/epsilon
bun install
./install.sh
```

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                      Session Start                          │
│  Epsilon injects task context into system prompt:           │
│  - Active tasks (todo, in_progress, blocked)                │
│  - Status overview (counts per status)                      │
│  - Workflow guidelines (create before, update after)        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Agent Aware Of                         │
│  - Current task list and priorities                         │
│  - Task workflow (create → in_progress → done)              │
│  - How to use epsilon tools                                 │
└─────────────────────────────────────────────────────────────┘
```

## Database Location

```
~/.local/share/pi-ext-epsilon/<repo-id>/epsilon.db
```

Repo-scoped — each project gets its own task database.

## Tools (7 total)

### Task CRUD

| Tool | Description |
|------|-------------|
| `epsilon_task_create` | Create task with title, description, priority, status, tags, parent_id |
| `epsilon_task_list` | List tasks — filter by status, priority, tags, parent_id |
| `epsilon_task_update` | Update any task field (only provided fields change) |
| `epsilon_task_delete` | Delete task and its subtasks |
| `epsilon_task_get` | Get single task with full details |

### Info

| Tool | Description |
|------|-------------|
| `epsilon_info` | Show database location |
| `epsilon_version` | Show DB version info |

## Usage Examples

```
# Create a high-priority task
epsilon_task_create title="Implement auth flow" priority="high" tags=["auth", "backend"]

# Create a subtask
epsilon_task_create title="Add login endpoint" parent_id=1

# List active tasks
epsilon_task_list status=["todo", "in_progress"]

# Start working on a task
epsilon_task_update id=1 status="in_progress"

# Complete a task
epsilon_task_update id=1 status="done"

# List only blocked tasks
epsilon_task_list status="blocked"

# Delete a task (cascades to subtasks)
epsilon_task_delete id=5
```

## Task Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | int | Auto-generated ID |
| `title` | string | Task title (required) |
| `description` | string | Optional details |
| `status` | enum | todo, in_progress, blocked, done, cancelled |
| `priority` | enum | low, medium, high, critical |
| `tags` | string[] | Categorization tags |
| `parent_id` | int \| null | Parent task (for subtasks) |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |

## System Prompt Injection

Epsilon injects an `<epsilon_tasks>` block into the system prompt containing:

1. **Task Workflow** — create before acting, update after acting
2. **Active Tasks** — list of todo/in_progress/blocked tasks with icons
3. **Status Overview** — counts by status category
