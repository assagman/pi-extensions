# Omega — Agent Instructions

## What This Is

Generic step looper. Define workflow steps, set repetitions, omega executes them with aggressive compaction between each step to give fresh context.

## Structure

```
omega/
├── src/
│   ├── index.ts        # Extension entry, /omega command, step editor, events
│   ├── loop.ts         # Step execution loop, AgentEndAwaiter, compaction
│   ├── types.ts        # OmegaState type, factory
│   ├── loop.test.ts    # Loop unit tests
│   └── types.test.ts   # Type unit tests
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
| Command | `/omega` — opens step editor + repetition selector |
| Commands | `/omega stop` abort, `/omega status` show progress |
| Execution | `for rep × for step: sendUserMessage → await agentEnd → compact` |
| Compaction | Ultra-minimal — only step list + progress preserved |
| AgentEndAwaiter | Solves `waitForIdle()` race condition |
| State persistence | `appendEntry` for session interrupt recovery |
| Context filter | Strips stale omega messages from LLM context |
| Tests | `vitest` — `bun run test` |

## Build

```bash
bun install && bun run build
./install.sh
```

## Important

- Does NOT auto-resume after interrupt — user must `/omega` to restart
- Inline text pre-fills editor: `/omega review and fix code`
- AgentEndAwaiter creates promise BEFORE message send (race-free)
