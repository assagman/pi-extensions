# Epsilon — Agent Instructions

## What This Is

Task management extension for Pi coding agent. SQLite-backed tasks with subtasks, priorities, statuses, and tags.

## Structure

```
epsilon/
├── src/
│   ├── index.ts        # Extension factory, event handlers, prompt builders
│   ├── db.ts           # SQLite operations, schema, task queries
│   ├── tools.ts        # 7 tool definitions with TypeBox schemas
│   └── db.test.ts      # Database unit tests (vitest)
├── docs/
│   └── README.md       # User docs
├── dist/
├── install.sh
├── uninstall.sh
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Key Facts

| Item | Detail |
|------|--------|
| Tools | 7 total: Task CRUD(5) + Info(1) + Version(1) |
| DB location | `~/.local/share/pi-ext-epsilon/<repo-id>/epsilon.db` |
| System prompt | Injects `<epsilon_tasks>` block with active tasks + status overview |
| Events | `before_agent_start` (inject context) |
| Shared dep | `pi-ext-shared` (shared/core) — repo ID, SQLite helpers, tool factory |
| Tests | `vitest` — `bun run test` |

## Build

```bash
bun install && bun run build
./install.sh
```

## Important

- Extracted from delta — epsilon handles tasks, delta handles memory
- Subtask deletion cascades (FOREIGN KEY ON DELETE CASCADE)
- First turn gets full instructions + data; subsequent turns get data only
