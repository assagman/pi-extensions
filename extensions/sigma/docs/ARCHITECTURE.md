# Sigma — Architecture

## Overview

Sigma is a single-tool TUI extension that replaces Pi's built-in `questionnaire` tool with improved keyboard-driven UX. It registers one tool (`sigma`) and injects usage guidelines into every agent system prompt.

```
┌────────────────────────────────────────────────────────────────┐
│                         Pi Agent                               │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  System Prompt                                           │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │  ## Sigma Tool — Usage Guidelines                  │  │  │
│  │  │  • Use sigma for unclarity/ambiguity/decisions     │  │  │
│  │  │  • Ask category by category                        │  │  │
│  │  │  • "Type something" is always implicit             │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                             │                                  │
│                             ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  sigma tool                                              │  │
│  │  ┌────────────┐  ┌────────────┐  ┌───────────────────┐  │  │
│  │  │  Schema     │  │  Helpers    │  │  TUI Component    │  │  │
│  │  │  (TypeBox)  │  │  (pure fn)  │  │  (createSigmaUI)  │  │  │
│  │  └────────────┘  └────────────┘  └───────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

## Module Structure

| File | Purpose |
|------|---------|
| `index.ts` | Extension factory, tool registration, system prompt injection |
| `types.ts` | Shared interfaces: `Question`, `Answer`, `SigmaResult`, `RenderOption` |
| `helpers.ts` | Pure functions: `errorResult`, `normalizeQuestions`, `buildOptions`, `formatAnswerLines` |
| `sigma-ui.ts` | `createSigmaUI()` — TUI component factory with state, rendering, and input handling |

## Data Flow

### Tool Execution

```
Agent calls sigma(questions)
        │
        ▼
┌──────────────────┐
│  execute()       │
│  • Validate      │
│  • Normalize Qs  │
│  • Launch TUI    │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│  createSigmaUI(tui, theme, kb, done, questions)  │
│                                                  │
│  State: currentTab, optionIndex, inputMode,      │
│         answers Map, optionsCache Map             │
│                                                  │
│  ┌───────────────┐  ┌────────────────────────┐   │
│  │ handleInput() │  │ render()               │   │
│  │  ├─ editor    │  │  ├─ renderInputMode()  │   │
│  │  ├─ tabs      │  │  ├─ renderSubmitTab()  │   │
│  │  ├─ submit    │  │  └─ renderQuestionView │   │
│  │  ├─ nav       │  │      ()                │   │
│  │  ├─ numbers   │  └────────────────────────┘   │
│  │  ├─ enter     │                               │
│  │  └─ escape    │                               │
│  └───────────────┘                               │
└──────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│  Format result   │
│  → answer lines  │
│  → return to LLM │
└──────────────────┘
```

### Single vs Multi-Question Modes

| Mode | Behavior |
|------|----------|
| **Single** (1 question) | Simple option list. Auto-submits on selection. |
| **Multi** (2+ questions) | Tab bar navigation. Submit tab. All must be answered. |

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| "Type something" always present | Prevents agents from disabling free-text input; user agency > agent control |
| `allowOther` omitted from schema | Agents must not see or attempt to control this field |
| System prompt injection | Ensures LLMs know about usage guidelines and implicit free-text |
| Closure-based state | TUI component pattern requires mutable state within `ctx.ui.custom()` callback |
| Options memoized per question | `buildOptions()` result is cached since question options are immutable |

## Keyboard Bindings

| Key | Context | Action |
|-----|---------|--------|
| `↑` / `C-p` | Option list | Move up |
| `↓` / `C-n` | Option list | Move down |
| `1`–`9` | Option list | Quick-select option |
| `Enter` | Option list | Confirm highlighted |
| `Tab` / `→` | Multi-question | Next tab |
| `Shift+Tab` / `←` | Multi-question | Previous tab |
| `Esc` | Any | Cancel (or exit input mode) |
| `Enter` | Input mode | Submit typed answer |
| `Enter` | Submit tab | Submit all answers |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-coding-agent` | Extension API (`ExtensionFactory`, `ExtensionAPI`) |
| `@mariozechner/pi-tui` | TUI primitives (`Editor`, `Key`, `Text`, `truncateToWidth`, `wrapTextWithAnsi`) |
| `@sinclair/typebox` | Tool parameter schema validation |
