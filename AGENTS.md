# AGENTS.md

Instructions for AI coding agents working on this codebase.

## Repository Overview

This is a **monorepo** containing extensions for the [Pi coding agent](https://github.com/mariozechner/pi-coding-agent).

```
pi-extensions/
├── extensions/
│   ├── sigma/          # Better questionnaire tool
│   ├── delta/          # Persistent memory (KV, episodic, notes)
│   ├── epsilon/        # Task management
│   ├── mu/             # Output condensation
│   ├── omega/          # Step looper
│   ├── shared/         # Shared libraries (not deployable)
│   │   ├── core/       # Repo ID, SQLite helpers, tool factory
│   │   └── tui/        # Dimmed overlays, shared TUI components
│   └── theta/          # Code review
├── README.md
├── AGENTS.md           # (this file)
└── llms.txt
```

## Extension Structure Convention

Each extension MUST follow this structure:

```
extension/
├── src/
│   └── index.ts        # Extension entry point (exports Pi extension)
├── dist/               # Compiled output (only .js, no .d.ts or .map)
├── docs/
│   ├── README.md       # User documentation
│   └── ARCHITECTURE.md # Technical details
├── AGENTS.md           # AI agent instructions for this extension
├── llms.txt            # LLM context doc for this extension
├── install.sh          # Build + symlink to ~/.pi/agent/extensions/<name>
├── uninstall.sh        # Remove symlink
├── package.json        # name, version: 1.0.0, pi.extensions field
├── tsconfig.json
└── .gitignore          # node_modules/, dist/
```

### package.json Requirements

```json
{
  "name": "<extension-name>",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist",
    "deploy": "./install.sh",
    "undeploy": "./uninstall.sh"
  },
  "pi": {
    "extensions": ["./dist/index.js"]
  }
}
```

### tsconfig.json Requirements

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*"]
}
```

## Adding a New Extension

1. Create directory: `extensions/<name>/`
2. Initialize: `bun init`
3. Create structure matching convention above
4. Add dependencies:
   ```bash
   bun add @mariozechner/pi-coding-agent @mariozechner/pi-tui
   bun add -d typescript @types/node
   ```
5. Implement `src/index.ts` exporting Pi extension
6. Create `install.sh` and `uninstall.sh` (copy from existing)
7. Add documentation in `docs/`

## Build & Install

```bash
# Build single extension
cd extensions/<name>
bun install
bun run build

# Install (build + symlink)
./install.sh

# Clean
bun run clean
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-coding-agent` | Pi agent core, extension API |
| `@mariozechner/pi-tui` | Terminal UI components |
| `@mariozechner/pi-ai` | AI/LLM utilities |
| `@sinclair/typebox` | Runtime type validation |

## Code Conventions

- **TypeScript** with strict mode
- **ESM modules** (`"type": "module"`)
- **Async-first**: Prefer async/await patterns
- **Thread-safe**: All code must be thread-safe
- **No declaration files**: `declaration: false` in tsconfig
- **No source maps**: `sourceMap: false` in tsconfig

## Testing

**Pi runs extensions with Node.js, NOT Bun.** This has critical testing implications:

| Constraint | Detail |
|-----------|--------|
| `better-sqlite3` | Cannot load under `bun test` — native bindings are Node-only |
| `bun:sqlite` | Cannot be used at all — Bun-specific, fails in Pi's Node.js runtime |
| Test runner | **Use `vitest`** (runs on Node.js), never `bun:test` |
| Test imports | `import { describe, it, expect } from "vitest"` |

### Setup

Each extension with tests needs:

```bash
bun add -d vitest
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

`package.json` scripts:
```json
{
  "test": "vitest run",
  "test:watch": "vitest"
}
```

### Running Tests

```bash
cd extensions/<name>
bun run test          # vitest run (Node.js runtime)
```

### Manual Testing

```bash
./install.sh
pi  # Start Pi agent, test extension features
```

## File Locations After Install

```
~/.pi/agent/extensions/
├── sigma -> /path/to/extensions/sigma/dist
├── delta -> /path/to/extensions/delta/dist
├── epsilon -> /path/to/extensions/epsilon/dist
├── mu -> /path/to/extensions/mu/dist
├── omega -> /path/to/extensions/omega/dist
└── theta -> /path/to/extensions/theta/dist
```

## Common Tasks

| Task | Command |
|------|---------|
| Add extension | Create dir, copy structure, implement |
| Build | `bun run build` |
| Install | `./install.sh` |
| Remove | `./uninstall.sh` |
| Clean | `bun run clean` |
