# Delta - Memory for AI Agents

Persistent memory extension for Pi coding agent using SQLite.

## Features

| Type | Description |
|------|-------------|
| **Key-Value** | Simple persistent storage for named values |
| **Episodic** | Timestamped events/facts with tags and context |
| **Project Notes** | Persistent context loaded at every session start |
| **Memory Index** | Full-text search across all memory types |
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
│  - Memory stats (kv keys, episode count)                    │
│  - Workflow guidelines                                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Agent Aware Of                         │
│  - Project context via notes                                │
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

## Tools (16 total)

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
| `delta_episode_delete` | Delete an episode by ID |

### Project Notes

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

### Memory Index

| Tool | Description |
|------|-------------|
| `delta_index_search` | Search across all memory types by keywords |
| `delta_index_rebuild` | Force rebuild the memory index |

### Info & Diagnostics

| Tool | Description |
|------|-------------|
| `delta_info` | Show database location and stats |
| `delta_version` | Show DB version info |
| `delta_schema` | Dump complete DDL schema |

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

### Memory Index

```
delta_index_search query="auth"
delta_index_rebuild
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

## System Prompt Injection

Delta automatically injects a `<delta_memory>` block into the system prompt containing:

1. **Mandatory Workflow** — recall-first, save-discoveries guidelines
2. **Memory Index** — summary of notes and episodes with tags
3. **Fetch instructions** — how to retrieve full content

This ensures the agent is always aware of project context without manual loading.
