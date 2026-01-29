# Gamma Extension — Architecture

## Overview

Context window token source analyzer & visualizer for Pi coding agent.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         GAMMA ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐     ┌──────────────┐     ┌──────────────────────────┐ │
│  │  /gamma     │────▶│   Analyzer   │────▶│      TUI Dashboard       │ │
│  │  command    │     │   Service    │     │                          │ │
│  └─────────────┘     └──────────────┘     │  ┌────────────────────┐  │ │
│                             │              │  │ Header (usage bar) │  │ │
│                             ▼              │  ├────────────────────┤  │ │
│                      ┌──────────────┐     │  │ Category Table     │  │ │
│                      │   Tokenizer  │     │  ├────────────────────┤  │ │
│                      │  (js-tiktoken│     │  │ Top-N Bar Chart    │  │ │
│                      │   cl100k)    │     │  ├────────────────────┤  │ │
│                      └──────────────┘     │  │ Pie Chart (ASCII)  │  │ │
│                             │              │  ├────────────────────┤  │ │
│                             ▼              │  │ Turn Timeline      │  │ │
│                      ┌──────────────┐     │  ├────────────────────┤  │ │
│                      │   Session    │     │  │ Drill-down List    │  │ │
│                      │   Manager    │     │  └────────────────────┘  │ │
│                      │  (Pi API)    │     └──────────────────────────┘ │
│                      └──────────────┘                                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Module Structure

```
gamma/
├── src/
│   ├── index.ts              # Extension entry point + /gamma command
│   ├── analyzer.ts           # Token source analysis service
│   ├── tokenizer.ts          # js-tiktoken wrapper (lazy singleton)
│   ├── types.ts              # Shared type definitions
│   └── ui/
│       ├── dashboard.ts      # Main TUI dashboard component
│       ├── charts.ts         # ASCII bar/pie chart renderers
│       └── components.ts     # Reusable TUI primitives
├── dist/
├── docs/
│   ├── README.md
│   └── ARCHITECTURE.md       # (this file)
├── install.sh
├── uninstall.sh
├── package.json
├── tsconfig.json
└── AGENTS.md
```

## Data Flow

```
┌───────────────────────────────────────────────────────────────────────┐
│                           DATA FLOW                                   │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  1. User invokes /gamma                                               │
│           │                                                           │
│           ▼                                                           │
│  2. Analyzer extracts sources from SessionManager                     │
│           │                                                           │
│           ├──▶ getBranch() → all session entries                      │
│           ├──▶ buildSessionContext() → resolved messages              │
│           ├──▶ getContextUsage() → Pi's total token count             │
│           └──▶ System prompt (captured via before_agent_start)        │
│           │                                                           │
│           ▼                                                           │
│  3. Tokenizer counts tokens per source                                │
│           │                                                           │
│           ├──▶ System prompt sections (parse AGENTS.md, skills, etc.) │
│           ├──▶ Each message (user/assistant/tool)                     │
│           ├──▶ Tool schemas (from registered tools)                   │
│           └──▶ Custom message entries (delta, epsilon injections)     │
│           │                                                           │
│           ▼                                                           │
│  4. Analyzer builds TokenAnalysis (categorized breakdown)             │
│           │                                                           │
│           ▼                                                           │
│  5. Dashboard renders full-screen TUI                                 │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

## Core Types

```typescript
// Token source categories
type TokenCategory =
  | "system"      // Base system prompt, AGENTS.md, project context
  | "skills"      // SKILL.md files loaded during session
  | "memory"      // Delta notes, epsilon tasks, KV, episodic
  | "tools"       // Tool schemas (all registered tools)
  | "user"        // User messages
  | "assistant"   // Assistant responses
  | "tool_io"     // Tool call arguments + tool outputs
  | "images"      // Image tokens (if any)
  | "other";      // Anything else

// Individual token source
interface TokenSource {
  id: string;           // Unique identifier
  category: TokenCategory;
  label: string;        // Display name (e.g., "AGENTS.md", "delta_log call")
  tokens: number;       // Token count
  percent: number;      // % of total
  turnIndex?: number;   // For per-turn grouping
  details?: string;     // Truncated preview of content
}

// Aggregated category stats
interface CategoryStats {
  category: TokenCategory;
  tokens: number;
  percent: number;
  sourceCount: number;
}

// Full analysis result
interface TokenAnalysis {
  totalTokens: number;
  contextWindow: number;    // Max context window
  usagePercent: number;
  categories: CategoryStats[];
  sources: TokenSource[];   // All individual sources
  turnBreakdown: TurnStats[];
  timestamp: number;
}

interface TurnStats {
  turnIndex: number;
  userTokens: number;
  assistantTokens: number;
  toolTokens: number;
  cumulativeTokens: number;
}
```

## Analyzer Service

### Source Extraction Strategy

| Source Type | Extraction Method |
|-------------|-------------------|
| System prompt | Capture in `before_agent_start` handler |
| AGENTS.md | Parse system prompt for AGENTS.md marker |
| Skills | Parse system prompt for SKILL.md markers |
| Memory (delta) | Identify `<delta_memory>` blocks in system prompt |
| Tasks (epsilon) | Identify `<epsilon_tasks>` blocks in system prompt |
| Tool schemas | `ctx.model` doesn't expose tools — estimate from tool_call events |
| User messages | Filter `SessionMessageEntry` with `role: "user"` |
| Assistant messages | Filter `SessionMessageEntry` with `role: "assistant"` |
| Tool calls | Extract from assistant messages' `tool_use` blocks |
| Tool results | Filter `SessionMessageEntry` with `role: "tool_result"` |
| Images | Count image content blocks |

### Tokenization

```typescript
// Lazy singleton tokenizer (js-tiktoken with cl100k_base)
let tokenizer: Tiktoken | null = null;

function getTokenizer(): Tiktoken {
  if (!tokenizer) {
    tokenizer = getEncoding("cl100k_base");
  }
  return tokenizer;
}

function countTokens(text: string): number {
  return getTokenizer().encode(text).length;
}
```

**Model note**: cl100k_base (GPT-4/Claude compatible) is used for all models. Minor variance acceptable — exact token matching is non-goal.

## TUI Dashboard Design

### Layout (80x24 minimum)

```
┌─ Gamma: Context Window Analysis ─────────────────────────────────────────┐
│                                                                          │
│  Model: anthropic:claude-sonnet-4-20250514      128,000 tokens max       │
│  ████████████████████████████████░░░░░░░░░░░  78,432 / 128,000  (61.3%)  │
│                                                                          │
├─ Category Breakdown ─────────────────────────────────────────────────────┤
│  Category     Tokens      %   ▏▎▍▌▋▊▉█                                   │
│  ───────────────────────────────────────                                 │
│  System       12,450   15.9%  ████████░░░░░░░░░░░░                       │
│  Skills        3,200    4.1%  ██░░░░░░░░░░░░░░░░░░                       │
│  Memory        8,100   10.3%  █████░░░░░░░░░░░░░░░                       │
│  Tools         4,500    5.7%  ███░░░░░░░░░░░░░░░░░                       │
│  User          6,800    8.7%  ████░░░░░░░░░░░░░░░░                       │
│  Assistant    28,000   35.7%  ██████████████████░░                       │
│  Tool I/O     15,382   19.6%  ██████████░░░░░░░░░░                       │
│                                                                          │
├─ Top Sources ────────────────────────────────────────────────────────────┤
│  1. Assistant turn 3 ·················· 8,450 (10.8%)                    │
│  2. Assistant turn 2 ·················· 7,200  (9.2%)                    │
│  3. read: src/index.ts ················ 6,100  (7.8%)                    │
│  ...                                                                     │
│                                                                          │
├─ Turn Timeline ──────────────────────────────────────────────────────────┤
│  Turn 1 ▏██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  12,300      │
│  Turn 2 ▏████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  31,500      │
│  Turn 3 ▏█████████████████████████████░░░░░░░░░░░░░░░░░░░░  58,200      │
│  Turn 4 ▏██████████████████████████████████████░░░░░░░░░░░  78,432      │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│  [↑↓] scroll  [d] drill-down  [c] category view  [q] quit                │
└──────────────────────────────────────────────────────────────────────────┘
```

### Interaction Modes

| Mode | View | Keys |
|------|------|------|
| **Summary** (default) | Category table + timeline | ↑↓ scroll, d/c/q |
| **Drill-down** | Full source list (scrollable) | ↑↓ scroll, Enter details, Esc back |
| **Category** | Single category expanded | ← → switch category, Esc back |

### Color Palette

```typescript
const CATEGORY_COLORS = {
  system:    { r: 100, g: 180, b: 255 },  // Blue
  skills:    { r: 167, g: 139, b: 250 },  // Violet
  memory:    { r:  38, g: 222, b: 129 },  // Green
  tools:     { r: 254, g: 211, b:  48 },  // Yellow
  user:      { r:  84, g: 160, b: 160 },  // Teal
  assistant: { r: 255, g: 159, b:  67 },  // Orange
  tool_io:   { r: 254, g: 202, b:  87 },  // Amber
  images:    { r:  34, g: 211, b: 238 },  // Cyan
  other:     { r: 140, g: 140, b: 140 },  // Gray
};
```

## Implementation Plan

### Phase 1: Core Infrastructure (~100 LOC)
- [ ] Extension skeleton (index.ts, package.json, tsconfig.json)
- [ ] `/gamma` command registration
- [ ] Tokenizer wrapper (js-tiktoken)

### Phase 2: Analyzer Service (~200 LOC)
- [ ] System prompt capture (before_agent_start hook)
- [ ] Session entry parsing
- [ ] Source extraction & categorization
- [ ] Token counting & aggregation

### Phase 3: Basic TUI (~150 LOC)
- [ ] Dashboard component structure
- [ ] Header (usage bar)
- [ ] Category breakdown table
- [ ] Basic scrolling

### Phase 4: Charts & Timeline (~100 LOC)
- [ ] ASCII horizontal bar chart
- [ ] Turn timeline visualization
- [ ] Gradient progress bars

### Phase 5: Drill-down & Polish (~100 LOC)
- [ ] Drill-down mode
- [ ] Category filter view
- [ ] Detail popups
- [ ] Keybind hints

**Total estimate**: ~650 LOC, 6-8 hours

## Dependencies

| Package | Purpose | Notes |
|---------|---------|-------|
| `@mariozechner/pi-coding-agent` | Pi extension API | Required |
| `@mariozechner/pi-tui` | TUI components | Required |
| `@sinclair/typebox` | Schema validation | Tool params |
| `js-tiktoken` | Token counting | Pure JS, no native deps |

## Constraints & Edge Cases

| Constraint | Handling |
|------------|----------|
| No tiktoken in Pi runtime | Use js-tiktoken (pure JS) |
| Tool schemas not exposed | Estimate from tool_call events |
| System prompt parsing | Regex-based section detection |
| Large sessions | Lazy tokenization, cache results |
| Images | Count as ~765 tokens per image (Claude estimate) |
| Model variance | cl100k_base for all — minor variance OK |

## Testing Strategy

- **Unit tests** (vitest): Tokenizer, analyzer extraction logic
- **Integration tests**: Full analysis on mock session data
- **Manual testing**: Real Pi sessions with various content types
