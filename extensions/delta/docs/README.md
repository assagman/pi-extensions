# Delta - Memory for AI Agents

Persistent memory extension for Pi coding agent using SQLite.

## Features

| Type | Description |
|------|-------------|
| **Key-Value** | Simple persistent storage for named values |
| **Episodic** | Timestamped events/facts with tags and context |
| **Tasks** | Project and session-level task management |
| **Project Notes** | Persistent context loaded at every session start |
| **Memory Injection** | Automatic system prompt with memory context |

## Installation

```bash
cd extensions/delta
bun install
./install.sh
```

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                      Session Start                          │
│  Delta injects memory context into system prompt:           │
│  - Active project notes                                     │
│  - Task overview (status counts + active tasks)             │
│  - Memory stats (kv keys, episode count)                    │
│  - Workflow guidelines                                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Agent Aware Of                         │
│  - Project context via notes                                │
│  - Current tasks and their status                           │
│  - What's stored in memory                                  │
│  - How to use delta tools                                   │
└─────────────────────────────────────────────────────────────┘
```

## Database Location

Data is stored per-project and per-branch:

```
~/.local/share/pi-ext-delta/<sanitized-project-path>-<git-branch>/delta.db
```

This ensures:
- Data persists across sessions
- Not tracked by git (user-specific)
- Branch-aware isolation

## Tools

### Project Notes (NEW)

Notes are loaded into the system prompt at every session start.

| Tool | Description |
|------|-------------|
| `delta_note_create` | Create project note (auto-loaded if active) |
| `delta_note_list` | List notes with filters |
| `delta_note_update` | Update note, set active=false to archive |
| `delta_note_delete` | Permanently delete note |
| `delta_note_get` | Get single note with full content |

**Note Categories:**
| Category | Use Case |
|----------|----------|
| `issue` | Known bugs, limitations, workarounds |
| `convention` | Code style, naming, patterns |
| `workflow` | Build steps, deployment, testing |
| `reminder` | Things to remember |
| `general` | Everything else |

**Importance Levels:** `low`, `normal`, `high`, `critical`

### Task Management

| Tool | Description |
|------|-------------|
| `delta_task_create` | Create new task (session or project scope) |
| `delta_task_list` | List tasks with filters |
| `delta_task_update` | Update task fields |
| `delta_task_delete` | Delete task (and subtasks) |
| `delta_task_get` | Get single task details |

### Key-Value Memory

| Tool | Description |
|------|-------------|
| `delta_get` | Get value by key |
| `delta_set` | Store key-value pair |
| `delta_delete` | Delete key |

### Episodic Memory

| Tool | Description |
|------|-------------|
| `delta_log` | Log event/fact with timestamp, context, tags |
| `delta_recall` | Search past events by query, tags, time, session |

### Info

| Tool | Description |
|------|-------------|
| `delta_info` | Show database location |

## Usage Examples

### Project Notes

```
# Create a critical issue note (will be in every prompt)
delta_note_create \
  title="Auth rate limiting not implemented" \
  content="Production auth service has no rate limiting. Add before launch." \
  category="issue" \
  importance="critical"

# Create a coding convention note
delta_note_create \
  title="Error handling pattern" \
  content="Always use Result<T, E> for fallible operations. Never throw." \
  category="convention"

# Archive a note (won't be loaded anymore)
delta_note_update id=1 active=false

# List all active notes
delta_note_list activeOnly=true
```

### Tasks

```
# Create project task
delta_task_create title="Implement auth flow" priority="high" tags=["auth", "backend"]

# Create session task (temporary)
delta_task_create title="Debug this error" scope="session"

# Create subtask
delta_task_create title="Add login endpoint" parent_id=1

# List active tasks
delta_task_list status=["todo", "in_progress"]

# Update task
delta_task_update id=1 status="in_progress"

# Complete task
delta_task_update id=1 status="done"
```

### Key-Value

```
delta_set key="pref:test_framework" value="vitest"
delta_get key="pref:test_framework"
delta_delete key="pref:test_framework"
```

### Episodic

```
delta_log content="Chose React for frontend" context="architecture" tags=["decision"]
delta_log content="Found race condition in auth" tags=["bug", "auth"]
delta_recall tags=["decision"] limit=10
delta_recall query="auth" sessionOnly=true
```

## Schemas

### Project Note

| Field | Type | Description |
|-------|------|-------------|
| `id` | int | Auto-generated ID |
| `title` | string | Note title (required) |
| `content` | string | Note content, markdown supported |
| `category` | enum | issue, convention, workflow, reminder, general |
| `importance` | enum | low, normal, high, critical |
| `active` | bool | If true, loaded at session start |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |

### Task

| Field | Type | Description |
|-------|------|-------------|
| `id` | int | Auto-generated ID |
| `title` | string | Task title (required) |
| `description` | string | Optional details |
| `status` | enum | todo, in_progress, blocked, done, cancelled |
| `priority` | enum | low, medium, high, critical |
| `scope` | enum | session, project |
| `tags` | string[] | Categorization tags |
| `parent_id` | int | Parent task (for subtasks) |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |
| `completed_at` | timestamp | Completion time |

## Session vs Project Scope

| Scope | Persists | Use Case |
|-------|----------|----------|
| `session` | Current session only | Temporary debugging tasks |
| `project` | Forever | Long-term project tasks |

## System Prompt Injection

Delta automatically injects a `<delta_memory>` block into the system prompt containing:

1. **Project Notes** - All active notes with importance markers
2. **Tasks Overview** - Status counts and list of active tasks
3. **Memory Stats** - Number of kv entries and episodes
4. **Workflow Guidelines** - How to use delta tools

This ensures the agent is always aware of project context without manual loading.
