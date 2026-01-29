# Gamma Extension — Agent Instructions

## Overview

Context window token analyzer & visualizer for Pi coding agent.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Extension entry, `/gamma` command |
| `src/analyzer.ts` | Token source analysis service |
| `src/tokenizer.ts` | js-tiktoken wrapper |
| `src/types.ts` | Shared type definitions |
| `src/ui/dashboard.ts` | Main TUI dashboard |
| `src/ui/charts.ts` | ASCII chart renderers |

## Architecture

```
/gamma → Analyzer.analyze(ctx) → TokenAnalysis → Dashboard.render()
```

1. User invokes `/gamma`
2. Analyzer extracts all token sources from session
3. Tokenizer counts tokens per source
4. Dashboard renders full-screen TUI

## Token Categories

- **system**: Base prompt, AGENTS.md
- **skills**: SKILL.md files
- **memory**: Delta/epsilon injections
- **tools**: Tool schemas
- **user/assistant**: Conversation messages
- **tool_io**: Tool call args + results
- **images**: Image tokens

## Constraints

- Uses `js-tiktoken` (pure JS, no native deps)
- cl100k_base encoding for all models
- Read-only analysis — no mutations
- Must complete <1s for typical sessions

## Testing

```bash
bun run test       # vitest run
bun run test:watch # vitest watch
```
