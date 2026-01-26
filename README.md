# pi-extensions

> Monorepo of extensions for the [Pi coding agent](https://github.com/mariozechner/pi-coding-agent).

## Extensions

| Extension | Description |
|-----------|-------------|
| **delta** | Persistent memory: SQLite-backed storage for tasks, notes, key-value pairs, episodic events |
| **mu**    | Condenses tool call/result output in transcript while preserving full outputs for LLM |
| **theta** | Code review dashboard with 3-column TUI (commits, files, diff) |

## Repository Structure

```
pi-extensions/
├── extensions/
│   ├── delta/          # Persistent memory
│   ├── mu/             # Output condensation
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
# Install a specific extension
cd extensions/<name>
npm install
./install.sh

# Example: Install delta
cd extensions/delta
npm install
./install.sh
```

The install script:
1. Runs `npm run build` (compiles TypeScript)
2. Creates symlink: `~/.pi/agent/extensions/<name>` → `dist/`

## Uninstallation

```bash
cd extensions/<name>
./uninstall.sh
```

## Documentation

See each extension's `docs/` directory:

- [delta/docs/](extensions/delta/docs/) - Phase-gate workflow architecture
- [mu/docs/](extensions/mu/docs/) - Output condensation details
- [theta/docs/](extensions/theta/docs/) - Code review integration

## Development

```bash
# Build an extension
cd extensions/<name>
npm run build

# Clean build artifacts
npm run clean
```

## License

MIT
