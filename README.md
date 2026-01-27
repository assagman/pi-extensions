# pi-extensions

> Monorepo of extensions for the [Pi coding agent](https://github.com/mariozechner/pi-coding-agent).
> completes what's missing from vanilla.

```sh
./incredibly-experimental
./nothing-guaranteed 
./shamelessly-committed
./eagerly-copied
./manually-tested
./opinionated-pi-vibes

echo "shipping fun..."
```

## Extensions

| Extension | Description |
|-----------|-------------|
| **ask** | Better questionnaire tool — number keys, C-n/C-p nav, proper long text wrapping, always-present "Type something" option |
| **delta** | Persistent memory: SQLite-backed KV, episodic events, project notes, memory index |
| **epsilon** | Task management: SQLite-backed tasks with subtasks, priorities, statuses, tags |
| **mu** | Condenses tool call/result output in transcript while preserving full outputs for LLM |
| **omega** | Generic step looper — repeat user-defined steps with aggressive compaction |
| **theta** | Code review dashboard with 3-column TUI (commits, files, diff) |

## Repository Structure

```
pi-extensions/
├── extensions/
│   ├── ask/            # Better questionnaire tool
│   ├── delta/          # Persistent memory (KV, episodic, notes)
│   ├── epsilon/        # Task management
│   ├── mu/             # Output condensation
│   ├── omega/          # Step looper
│   ├── shared/         # Shared libraries (not deployable)
│   │   ├── core/       # Repo ID, SQLite helpers, tool factory
│   │   └── tui/        # Dimmed overlays, shared TUI components
│   └── theta/          # Code review
├── biome.json          # Linter/formatter config
├── package.json        # Workspace config
├── llms.txt            # LLM context doc
├── AGENTS.md           # AI agent instructions
├── LICENSE             # MIT
└── README.md
```

Each extension follows a standard structure:

```
extension/
├── src/                # TypeScript source
├── dist/               # Compiled JS (built)
├── docs/               # Documentation
├── install.sh          # Build + symlink to ~/.pi/agent/extensions/
├── uninstall.sh        # Remove symlink
├── package.json
└── tsconfig.json
```

## Installation

```bash
# Interactive — pick which extensions to install
./install.sh -i

# Install a specific extension
./install.sh <name>

# CI mode (frozen lockfile)
./install.sh --ci <name>
```

The install script:
1. Builds shared dependencies if needed (`shared/core`, `shared/tui`)
2. Runs `bun install` + `bun run build` (compiles TypeScript)
3. Creates symlink: `~/.pi/agent/extensions/<name>` → `dist/`

## Uninstallation

```bash
# Uninstall all extensions (removes symlinks)
./uninstall.sh

# Or uninstall a specific extension
cd extensions/<name>
./uninstall.sh
```

## Documentation

See each extension's `docs/` directory:

- [ask/docs/](extensions/ask/docs/) - Better questionnaire tool
- [delta/docs/](extensions/delta/docs/) - Persistent memory architecture
- [epsilon/docs/](extensions/epsilon/docs/) - Task management
- [mu/docs/](extensions/mu/docs/) - Output condensation details
- [omega/docs/](extensions/omega/docs/) - Step looper
- [theta/docs/](extensions/theta/docs/) - Code review integration

## Development

```bash
# Build an extension
cd extensions/<name>
bun run build

# Clean build artifacts
bun run clean

# Run tests (vitest, Node.js runtime)
bun run test

# Lint/format (biome)
bun run lint
bun run format
```

## License

MIT
