# Architecture: mu

This document details the architectural design of `mu`, a Pi Coding Agent extension that provides a condensed, CLI-first transcript experience while preserving full tool output fidelity for LLM context and on-demand inspection.

## 1. High-Level Design

`mu` operates as a **rendering interception layer** between the agent's runtime events and the user interface. It employs a **"Condense-at-Render"** strategy:

1.  **Condense**: Overrides builtin tool rendering and monkey-patches all TUI components to show minimal, CLI-style summaries.
2.  **Preserve**: Never modifies tool result data — the LLM always receives full, unredacted outputs natively.
3.  **Inspect**: Stores tool results in-memory for on-demand inspection via the `/mu-tools` viewer.

### Architectural Goals

*   **Transcript Hygiene**: Eliminate scroll fatigue by hiding verbose outputs (e.g., `read`, `grep`, `ls`) by default.
*   **Data Fidelity**: Ensure the LLM *always* receives full tool outputs. Achieved by never mutating event/message content.
*   **Zero Config**: Work out-of-the-box by overriding standard tool rendering behavior.

### Key Design Principle

The rendering layer is **completely separated** from the data layer. `mu` only changes what the user *sees* — it never modifies what the LLM *receives*. This eliminates the need for content restoration hooks or session persistence.

---

## 2. Core Components

The architecture consists of four main subsystems:

1.  **Tool Overrides**: Re-register builtin tools with custom `renderCall`/`renderResult` while delegating execution to the original tool.
2.  **UI Monkey-Patcher**: Runtime interception of all TUI components (User, Assistant, Tool) to strip backgrounds and apply condensed styling.
3.  **In-Memory State**: Track tool execution state and store results for the viewer overlay.
4.  **UI Components**: BoxedToolCard (pulsing animation), MuToolsOverlay (result browser), custom footer (stats/model display).

### 2.1 Component Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                          Pi Runtime                          │
│                                                              │
│  ┌──────────┐  ┌──────────────┐  ┌────────────┐             │
│  │Event Bus │  │  Terminal UI │  │LLM Context │             │
│  └─────┬────┘  └──────┬───────┘  └──────┬─────┘             │
└────────┼───────────────┼────────────────┼────────────────────┘
         │               │                │
         │ tool_call     │                │
         │ tool_result   │                │ full data
         │ session_start │                │ (unchanged)
         │ agent_start   │                │
         │ agent_end     │                │
         │ turn_start    │                │
         │               │                │
┌────────┼───────────────┼────────────────┼────────────────────┐
│        │  mu Extension │                │                    │
│        │               │                │                    │
│  ┌─────┴──────────┐    │                │                    │
│  │  Event Handlers │    │   ┌────────────────────┐           │
│  │  (state tracking)────────│  In-Memory State  │           │
│  └────────────────┘    │   │  activeToolsById   │           │
│                        │   │  toolStatesBySig   │           │
│  ┌────────────────┐    │   │  toolResultOptions │           │
│  │ Tool Overrides │    │   │  fullToolResult... │           │
│  │ (7 builtins)   │────┘   └─────────┬──────────┘           │
│  │ renderCall     │                   │                      │
│  │ renderResult   │        ┌──────────┴──────────┐           │
│  └────────────────┘        │  MuToolsOverlay     │           │
│                            │  (/mu-tools viewer) │           │
│  ┌────────────────┐        └─────────────────────┘           │
│  │ UI Patcher     │                                          │
│  │ (all components)───► patches User/Assistant/Tool render   │
│  └────────────────┘                                          │
│                                                              │
│  ┌────────────────┐                                          │
│  │ Custom Footer  │───► token stats, context bar, model info │
│  └────────────────┘                                          │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Subsystem Details

### 3.1 Tool Overrides (Builtins)

`mu` completely replaces the rendering logic for 7 standard tools: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`.

*   **Mechanism**: `pi.registerTool` re-registers existing tools. `mu` wraps the original tool factory via the `override()` function.
*   **Execution**:
    *   The wrapper instantiates the *real* tool with the current `ctx.cwd` to ensure directory context correctness.
    *   It executes the real tool and returns the **full, unmodified result**.
    *   **Error Handling**: If a tool fails (`result.isError`), `mu` extracts the error text and exit code, then `throw`s an `Error`. Pi catches this and renders the standard red error box. This ensures errors are always visible.
*   **Rendering (`renderCall`)**:
    *   Returns a `BoxedToolCard` component.
    *   Generates a compact, one-line summary (e.g., `󰆍 bash $ bun test`, `󰈙 read src/index.ts @L1-50`).
    *   Bash commands render as multiline with full command text (no truncation).
*   **Rendering (`renderResult`)**:
    *   **Collapsed (Default)**: Returns an empty `Text("")` component (effectively hidden).
    *   **Expanded (Ctrl+O)**: Delegates to the original tool's `renderResult` or wraps text in a `Markdown` component.

### 3.2 UI Monkey-Patcher (All Components)

For **all** TUI components (including non-builtin tools like `agentsbox_*`, `ask`, `delta_*`), `mu` patches the rendering at the component level.

*   **Trigger**: `session_start` → `setupUIPatching(ctx)`
*   **Mechanism**: `ctx.ui.custom()` provides access to the TUI component tree. `mu` iterates all children and:
    *   **User messages** (`patchUser`): Strips backgrounds, renders markdown with teal text color, adds blank line separator.
    *   **Assistant messages** (`patchAssistant`): Strips backgrounds, wraps thinking blocks with `󰛨` icon prefix, wraps content blocks without borders.
    *   **Tool executions** (`patchTool`): Replaces `render()` entirely — shows icon + tool name + args preview + status indicator + elapsed time.
*   **Future components**: Hooks `container.addChild()` to automatically patch newly added components.
*   **Idempotency**: Each component is marked with `_mu_patched` flag to prevent double-patching.

### 3.3 In-Memory State Management

All state is in-memory only. No session persistence or cross-session rehydration.

*   **`activeToolsById`**: `Map<toolCallId, ToolState>` — tracks running tools.
*   **`toolStatesBySig`**: `Map<signature, ToolState[]>` — maps tool signature (hash of name + args) to state array. Used by `BoxedToolCard` to look up status and elapsed time for the correct instance.
*   **`fullToolResultContentById`**: `Map<toolCallId, Content[]>` — stores full result content for all tools. Used by the `/mu-tools` viewer.
*   **`toolResultOptions`**: `ToolResultOption[]` — ordered list of tool results backing the viewer list. FIFO eviction at 200 entries.
*   **`cardInstanceCountBySig`**: `Map<signature, number>` — disambiguates multiple calls with identical name+args.

### 3.4 LLM Data Fidelity

The LLM always receives full tool outputs because `mu` **never modifies event or message content**:

*   For **builtin tools**: The `execute()` wrapper returns the real tool's `ToolResultEvent` unchanged. Pi stores this full result in the message history.
*   For **non-builtin tools**: `mu` only listens to events for state tracking (`tool_call`, `tool_result`). It does not modify event payloads.
*   No `on("context")` hook is needed — the data is never redacted in the first place.

---

## 4. UI Components

### 4.1 BoxedToolCard

A dynamic TUI component used as `renderCall` for overridden builtin tools.

*   **Visuals**:
    *   **Running**: Tool icon and name pulse in brightness (sine wave, 20 FPS via `setInterval`).
    *   **Elapsed Time**: Shows live duration (e.g., `5.2s`) once ≥ 1 second.
    *   **Completed**: Static icon with final duration + status indicator (✓/✗).
*   **Bash special case**: Renders full command as multiline text with `$ ` prefix and word wrapping. Other tools use single-line truncated rendering.
*   **Instance tracking**: Uses `computeSignature(name, args)` + `instanceIndex` to correctly associate `tool_call`/`tool_result` events with the right card when multiple identical calls exist.
*   **Leading space**: First tool after a user message gets a blank line separator for visual clarity.

### 4.2 MuToolsOverlay (`/mu-tools`)

An interactive overlay for inspecting tool outputs. Opened via `Ctrl+Alt+O` shortcut or `/mu-tools` command.

*   **Structure**:
    *   **List View** (`MuToolsOverlay`): Scrollable list of recent results (max 10 visible) with status icons, tool names, and durations. Includes an argument preview pane below the list.
    *   **Detail View** (`ToolResultDetailViewer`): Full-screen modal showing complete output with argument listing, duration, and error status.
*   **Navigation**: Vim-like bindings:
    *   `j`/`k` or `↑`/`↓`: Navigate list / scroll detail
    *   `g`/`G`: Jump to top / bottom
    *   `Enter`: Open detail view
    *   `Esc`/`q`: Close overlay or return from detail to list

### 4.3 Custom Footer

A 2–3 line footer replacing Pi's default, registered via `ctx.ui.setFooter()`.

*   **Line 1**: Working directory (with `~` home substitution) + git branch + session name.
*   **Line 2 (left)**: Bracketed stats groups with semantic colors:
    *   `[↑in ↓out]` (cyan) — input/output tokens
    *   `[Rread Wwrite]` (green) — cache read/write
    *   `[$cost sub]` (amber) — total cost + subscription indicator
    *   `[█░░░░ ctx/win (pct%)]` (gradient bar) — context window usage with green→yellow→red gradient
*   **Line 2 (right)**: Model display as `provider:model:thinkingLevel` with per-segment colors.
*   **Line 3** (optional): Extension status messages, sorted alphabetically, space-joined.
*   **Reactivity**: Re-renders on git branch change via `footerData.onBranchChange()`. Token/cost data computed from a single-pass scan of the session branch on each render.

### 4.4 Working Timer

A global timer that displays elapsed time in Pi's working message area.

*   Starts on `agent_start`, stops on `agent_end`.
*   Updates every 100ms with `⏱ Xs` format.
*   On completion, shows a notification if elapsed ≥ 1 second.

---

## 5. Data Structures

### 5.1 ToolState
```typescript
interface ToolState {
  toolCallId: string;
  sig: string;            // SHA-256 hash of name + JSON(args), first 16 chars
  toolName: string;
  args: Record<string, unknown>;
  startTime: number;
  status: ToolStatus;     // "pending" | "running" | "success" | "failed" | "canceled"
  exitCode?: number;
  duration?: number;
}
```

### 5.2 ToolResultOption
```typescript
interface ToolResultOption {
  key: string;            // toolCallId
  toolName: string;
  sig: string;
  label: string;          // truncated preview for list display
  args: Record<string, unknown>;
  result: unknown;        // { content, isError }
  startTime: number;
  duration?: number;
  isError: boolean;
}
```

### 5.3 Status Indicators
| Status | Symbol | Color |
|--------|--------|-------|
| Pending | `◌` | dim |
| Running | `●` (pulsing) | orange |
| Success | `` | green |
| Failed | `` | red |
| Canceled | `` | gray |

---

## 6. Logic Flows

### 6.1 Tool Execution Flow (Builtin)
1.  **Agent** calls tool (e.g., `bash`).
2.  **Pi** routes to mu's registered override.
3.  **mu** `execute()`: Instantiates real tool via `factory(ctx.cwd)`, runs it.
4.  **Result**:
    *   **Error**: Extracts text + exit code, `throw`s Error → Pi shows red box.
    *   **Success**: Returns full `ToolResultEvent` unchanged to Pi.
5.  **Pi** stores full result in message history (LLM gets it).
6.  **Pi** calls `renderCall()` → `BoxedToolCard` (condensed card with pulse).
7.  **Pi** calls `renderResult()` → empty `Text("")` (hidden by default).

### 6.2 Tool Execution Flow (Non-Builtin)
1.  **Agent** calls tool (e.g., `agentsbox_execute`).
2.  **Pi** executes tool normally (mu does not override non-builtins).
3.  **Pi** emits `tool_call` → mu tracks in `activeToolsById` + `toolStatesBySig`.
4.  **Pi** emits `tool_result` → mu records duration, status, stores in `fullToolResultContentById` + `toolResultOptions`.
5.  **Pi** renders via standard ToolExecutionComponent → **mu's UI patcher** intercepts `render()` and returns condensed line.
6.  **LLM** receives full result (mu never modifies event content).

### 6.3 Session Start Flow
1.  **`session_start`** triggers.
2.  **mu** stops any prior working timer (defensive cleanup).
3.  **mu** calls `setupUIPatching(ctx)` — patches existing and future TUI components.
4.  **mu** enables custom footer if `modelDisplayEnabled`.
5.  **Note**: In-memory state (`toolResultOptions`, `fullToolResultContentById`) starts empty each session. There is no cross-session persistence or rehydration.

---

## 7. Edge Cases & Safety

1.  **Error visibility**: Errors are never condensed. Builtin tool errors are re-thrown as `Error` objects, ensuring Pi's standard red-box rendering. The UI patcher also preserves error display for non-builtins.
2.  **Idempotent patching**: All patched components are marked with `_mu_patched` flag to prevent double-application.
3.  **Concurrency**: `toolStatesBySig` stores arrays of `ToolState` per signature, and `cardInstanceCountBySig` assigns unique indices, handling multiple identical tool calls correctly.
4.  **Pulse cleanup**: `BoxedToolCard.dispose()` and `patchTool` cleanup both clear `setInterval` timers to prevent memory leaks.
5.  **Theme compatibility**: Pulsing uses raw ANSI RGB escape codes (`\x1b[38;2;r;g;bm`), requiring truecolor terminal support.
6.  **Capacity limits**: `toolResultOptions` capped at 200 entries (FIFO). `toolStatesBySig` capped at 500 entries.
7.  **Leading space tracking**: `nextToolNeedsLeadingSpace` flag + `_mu_lastWasUser` on containers ensure proper visual spacing between user messages and tool calls.
