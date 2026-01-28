# Delta — Agent Instructions

## What This Is

Persistent memory extension for Pi coding agent. Single unified `memories`
table with FTS5 full-text search. Everything is `content + tags[]`.

## Structure

```
delta/
├── src/
│   ├── index.ts           # Extension factory, events, prompt injection
│   ├── db.ts              # Schema, migration, CRUD, FTS5, prompt building
│   ├── tools.ts           # Tool definitions (Phase 2 rewrite pending)
│   ├── db.test.ts         # 96 tests (vitest)
│   └── prune/
│       ├── analyzer.ts    # Prune analysis + scoring
│       ├── detector.ts    # File path / branch ref detection
│       ├── types.ts       # Prune types + config
│       ├── ui.ts          # TUI dashboard
│       └── analyzer.test.ts  # 17 tests
├── docs/
│   ├── README.md
│   └── ARCHITECTURE.md
├── skill/
│   └── SKILL.md
├── install.sh / uninstall.sh
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Key Facts

| Item | Detail |
|------|--------|
| Schema | v4 — single `memories` table + `memories_fts` (FTS5) |
| Tools | `delta_remember`, `delta_search`, `delta_forget`, `delta_info` |
| DB location | `~/.local/share/pi-ext-delta/<repo-id>/delta.db` |
| Repo-scoped | All worktrees share one DB (NOT per-branch) |
| System prompt | Injects `<delta_memory>` block every turn |
| Events | `session_start`, `before_agent_start`, `tool_call`, `tool_result`, `session_shutdown` |
| Auto-capture | Git commits → memories with `["commit", "auto-captured"]` tags |
| Shared dep | `pi-ext-shared` — repo ID, SQLite helpers, tool factory |
| Tests | `vitest` — `bun run test` (113 total: 96 db + 17 prune) |

## DB API (db.ts)

| Function | Purpose |
|----------|---------|
| `remember(content, opts?)` | Create memory (tags, importance, context) |
| `search(opts?)` | FTS5 + tag/importance/session/time filtering |
| `forget(id)` | Delete memory |
| `update(id, input)` | Partial update (content, tags, importance, context) |
| `getById(id)` | Single memory lookup |
| `getAllMemories()` | Bulk read for prune |
| `batchDeleteMemories(ids)` | Bulk delete for prune |
| `getMemoryContext()` | Load memories + important for prompt |
| `buildMemoryPrompt(opts?)` | Generate system prompt injection |

## Build

```bash
bun install && bun run build
./install.sh
```

## Important

- v4 migration auto-runs on v3 databases (episodes + notes + kv → memories)
- Defensive `cleanupV3Artifacts()` handles partially-migrated DBs
- FTS5 searches content, tags, AND context columns
- `tools.ts` and `prune/` have compile errors (Phase 2 rewrite pending)
