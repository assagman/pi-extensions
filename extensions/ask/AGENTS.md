# Ask — Agent Instructions

## What This Is

Pi extension that replaces the built-in `questionnaire` tool with improved keyboard-driven UX: number keys (1-9), C-n/C-p nav, proper long text wrapping, always-present "Type something" option.

## Structure

```
ask/
├── src/
│   ├── index.ts        # Extension factory, tool registration, system prompt injection
│   ├── types.ts        # Question, Answer, AskResult, RenderOption interfaces
│   ├── helpers.ts      # Pure functions: normalize, build options, format answers
│   ├── helpers.test.ts # Unit tests for helpers
│   └── ask-ui.ts       # createAskUI() — TUI component with state + input handling
├── docs/
│   ├── README.md       # User docs
│   └── ARCHITECTURE.md # Technical details
├── dist/               # Compiled output (esbuild bundled)
├── install.sh
├── uninstall.sh
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Key Facts

| Item | Detail |
|------|--------|
| Tool registered | `ask` (replaces built-in `questionnaire`) |
| Build | esbuild bundle (not plain tsc) — see `package.json` scripts |
| System prompt | Injects "Ask Tool — Mandatory Usage Rules" |
| TUI pattern | `ctx.ui.custom()` with closure-based state |
| Dependencies | `@mariozechner/pi-tui`, `@sinclair/typebox`, `shared-tui` |
| Tests | `vitest` — `bun run test` |

## Build

```bash
bun install && bun run build    # esbuild bundle
./install.sh                    # build + symlink
```

## Design Decisions

- `allowOther` intentionally omitted from schema — agents must not disable free-text
- Options memoized per question (immutable once built)
- Single-question mode auto-submits; multi-question has tab navigation + submit tab
