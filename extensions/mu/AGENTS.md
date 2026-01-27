# Mu — Agent Instructions

## What This Is

Output condensation extension. Overrides standard tool rendering to show minimal CLI-style summaries while preserving full outputs for LLM context and on-demand inspection.

## Structure

```
mu/
├── src/
│   └── index.ts        # Everything: overrides, redaction, state, viewer, pulsing UI
├── docs/
│   ├── README.md       # User docs
│   └── ARCHITECTURE.md # Technical details
├── dist/
├── install.sh
├── uninstall.sh
└── package.json
```

## Key Facts

| Item | Detail |
|------|--------|
| Strategy | "Condense-and-Persist" — summary in UI, full content for LLM |
| Builtin overrides | bash, read, write, edit, grep, find, ls |
| Non-builtin | Redacts tool_result events, preserves originals |
| Context hook | `pi.on("context")` swaps summaries back to full content for LLM |
| State layers | In-memory (200 results) + session persistence (`mu_tool_result_full_v1`) |
| Viewer | `/mu-tools` command — overlay with vim-like nav |
| Pulsing UI | Global 20 FPS interval, sine-wave brightness animation |
| Keybinding | `Ctrl+O` expand all, `Ctrl+Alt+O` pick single result |

## Build

```bash
bun install && bun run build
./install.sh
```

## Important

- Base64 images are STRIPPED from stored results (memory safety)
- Error results are never redacted — always shown in full
- Single ~1750 LOC file — all logic is in `index.ts`
- No tests currently
