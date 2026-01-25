# Theta

Theta is a Pi extension for first-class code review workflows. It integrates with `git` for diffing and `critique` for sharing visual reviews.

## Features

- **TUI Dashboard:** Interactive terminal UI for reviewing changes (`/review`).
- **Agent Tools:**
  - `theta_diff`: Allows the agent to inspect code changes.
  - `theta_review`: Allows the agent to generate review analysis (and optional `critique.work` links).
- **Critique Integration:** Uses `critique` CLI to generate sharable review links when available.

## Installation

Ensure `critique` is installed:
```bash
npm install -g critique
# or
bun add -g critique
```

Install Theta:
```bash
# In your pi extensions directory or via settings.json
npm install
```

## Usage

### Commands
- `/theta`: Open the interactive dashboard. Use `j`/`k` to navigate files and `q` to exit.

### Agent
The agent can use `theta_diff` to see what changed and `theta_review` to perform a full review analysis.

## Development

```bash
npm install
npm test
```
