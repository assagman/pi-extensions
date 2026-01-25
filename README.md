# pi-extensions

> Monorepo of extensions for the [Pi coding agent](https://github.com/mariozechner/pi-coding-agent).

## Extensions

| Extension | Description |
|-----------|-------------|
| **delta** | Phase-gate workflow: requirements → design → plan → implement ↔ test → review → deliver |
| **mu**    | Condenses tool call/result output in transcript while preserving full outputs for LLM |
| **theta** | Code review extension using critique for visual diff sharing |

## Repository Structure

```
pi-extensions/
├── extensions/
│   ├── delta/          # Phase-gate workflow
│   ├── mu/             # Output condensation
│   └── theta/          # Code review
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
bun install
./install.sh

# Example: Install delta
cd extensions/delta
bun install
./install.sh
```

The install script:
1. Runs `bun run build` (compiles TypeScript)
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
bun run build

# Clean build artifacts
bun run clean
```

## License

MIT
