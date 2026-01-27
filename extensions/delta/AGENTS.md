# Delta — Agent Instructions

## What This Is

Persistent memory extension for Pi coding agent. SQLite-backed storage for key-value pairs, episodic events, project notes, and a full-text memory index.

## Structure

```
delta/
├── src/
│   ├── index.ts        # Extension factory, event handlers, prompt builders
│   ├── db.ts           # SQLite operations, schema, all queries
│   ├── tools.ts        # 16 tool definitions with TypeBox schemas
│   └── db.test.ts      # Database unit tests (vitest)
├── docs/
│   ├── README.md       # User docs
│   └── ARCHITECTURE.md # Technical details
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
| Tools | 16 total: KV(3) + Episodic(3) + Notes(5) + Index(2) + Info(1) + Version(2) |
| DB location | `~/.local/share/pi-ext-delta/<sanitized-cwd>-<git-branch>/delta.db` |
| System prompt | Injects `<delta_memory>` block with notes, index summary, stats |
| Events | `before_agent_start` (inject context), `session_shutdown` (close DB) |
| Shared dep | `pi-ext-shared` (shared/core) — repo ID, SQLite helpers, tool factory |
| Tests | `vitest` — `bun run test` |

## Build

```bash
bun install && bun run build
./install.sh
```

## Important

- **No task tools** — tasks moved to epsilon extension
- DB is per-project AND per-branch (branch-aware isolation)
- WAL mode enabled for better read concurrency
- All queries are parameterized (SQL injection safe)
