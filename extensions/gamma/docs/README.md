# Gamma — Context Window Analyzer

Visualize token usage across all sources in your Pi coding agent context window.

## Features

- **Full token breakdown** — See exactly where your context tokens go
- **Category analysis** — System, Skills, Memory, Tools, User, Assistant, Tool I/O
- **Turn timeline** — Track token accumulation across conversation turns
- **Drill-down view** — Inspect individual sources and their token counts
- **ASCII charts** — Beautiful terminal visualizations

## Usage

```
/gamma
```

Opens full-screen dashboard showing:

```
┌─ Gamma: Context Window Analysis ─────────────────────────────────────────┐
│                                                                          │
│  Model: anthropic:claude-sonnet-4-20250514      128,000 tokens max       │
│  ████████████████████████████████░░░░░░░░░░░░░  78,432 / 128,000  (61.3%)│
│                                                                          │
├─ Category Breakdown ─────────────────────────────────────────────────────┤
│  Category     Tokens      %   ▏▎▍▌▋▊▉█                                   │
│  ───────────────────────────────────────                                 │
│  System       12,450   15.9%  ████████░░░░░░░░░░░░                       │
│  Skills        3,200    4.1%  ██░░░░░░░░░░░░░░░░░░                       │
│  Memory        8,100   10.3%  █████░░░░░░░░░░░░░░░                       │
│  ...                                                                     │
│                                                                          │
├─ Turn Timeline ──────────────────────────────────────────────────────────┤
│  Turn 1 ▏██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  12,300      │
│  Turn 2 ▏████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  31,500      │
│  ...                                                                     │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  [↑↓] scroll  [d] drill-down  [c] category view  [q] quit                │
└──────────────────────────────────────────────────────────────────────────┘
```

## Keybindings

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll |
| `d` | Toggle drill-down view |
| `c` | Toggle category filter |
| `←` / `→` | Switch categories (in category view) |
| `Enter` | View source details |
| `Esc` | Back / Close detail |
| `q` | Quit dashboard |

## Token Categories

| Category | Description |
|----------|-------------|
| **System** | Base system prompt, AGENTS.md, project context |
| **Skills** | Loaded SKILL.md files |
| **Memory** | Delta notes, episodic events, epsilon tasks |
| **Tools** | Tool schemas and descriptions |
| **User** | User messages |
| **Assistant** | Assistant responses |
| **Tool I/O** | Tool call arguments and results |
| **Images** | Image tokens (if any) |

## Installation

```bash
cd extensions/gamma
./install.sh
```

## Requirements

- Pi coding agent v1.x+
- Terminal with Unicode support (for charts)
- Nerd Font recommended (for icons)
