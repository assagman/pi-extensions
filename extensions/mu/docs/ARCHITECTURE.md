# Architecture: mu

This document details the architectural design of `mu`, a Pi Coding Agent extension that provides a condensed, CLI-first transcript experience while preserving full tool output fidelity for LLM context and on-demand inspection.

## 1. High-Level Design

`mu` operates as an interception layer between the agent's runtime events and the user interface. It employs a **"Condense-and-Persist"** strategy:

1.  **Condense**: Intercepts tool execution to render minimal, CLI-style summaries in the TUI transcript.
2.  **Persist**: Captures full, unredacted tool outputs and stores them in a parallel, persisted session history structure.
3.  **Restore**: Re-injects full outputs into the LLM context and provides an on-demand TUI viewer for human inspection.

### Architectural Goals

*   **Transcript Hygiene**: Eliminate scroll fatigue by hiding verbose outputs (e.g., `read`, `grep`, `ls`) by default.
*   **Data Fidelity**: Ensure the LLM *always* receives full tool outputs, even if the user sees a summary.
*   **Resilience**: Persist extension state across agent restarts using custom session entry types.
*   **Zero Config**: Work out-of-the-box by overriding standard tool rendering behavior.

---

## 2. Core Components

The architecture consists of four main subsystems:

1.  **Tool Overrides & Rendering**: Wrappers for builtin tools to control their transcript appearance.
2.  **Event Interception & Redaction**: Logic to sanitize and summarize non-builtin tool outputs.
3.  **State Management & Persistence**: Dual-layer storage (In-memory cache + Session persistent entries).
4.  **UI Components**: Custom TUI elements for pulsing status indicators and the result viewer.

### 2.1 Component Diagram

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│                              Pi Runtime                                            │
│                                                                                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌───────────┐      │
│  │   Event Bus     │  │ Session Manager │  │  Terminal UI    │  │LLM Context│      │
│  │                 │  │                 │  │      (TUI)      │  │  Builder  │      │
│  └────────┬────────┘  └────────┬────────┘  └───────┬─────────┘  └──────┬────┘      │
└───────────┼────────────────────┼───────────────────┼───────────────────┼───────────┘
            │                    │                   │                   │
            │ tool_call          │                   │                   │
            ├───────────────────►│                   │                   │
            │                    │                   │                   │
            │ tool_result        │                   │                   │
            ├───────────────────►│                   │                   │
            │                    │                   │                   │
┌────────────────────────────────┼───────────────────┼───────────────────┼──────────┐
│         mu Extension           │                   │                   │          │
│                                │                   │                   │          │
│  ┌──────────────────────────┐  │  ┌──────────────┐ │  ┌─────────────┐  │          │
│  │     Tool Overrides       │  │  │   Result     │ │  │   State     │  │          │
│  │                          │  │  │   Redactor   │ │  │  Manager    │  │          │
│  │  renderCall ────────────►│  │  │              │ │  │             │  │          │
│  │                          │  │  │  sanitize ──►│ │  │             │  │          │
│  │  renderResult ──────────►│  │  │              │ │  │             │  │          │
│  │                          │  │  │  rewrite ───►│ │  │             │  │          │
│  └──────────────────────────┘  │  └──────────────┘ │  │  persist ──►│  │          │
│                                │                   │  │             │  │          │
│  ┌──────────────────────────┐  │                   │  │  restore ──►│  │          │
│  │      Result Viewer       │  │                   │  │             │  │          │
│  │                          │  │                   │  │  hydrate ──►│  │          │
│  │  overlay ───────────────►│  │                   │  │             │  │          │
│  └──────────────────────────┘  │                   │  └─────────────┘  │          │
│                                │                   │                   │          │
│  ┌──────────────────────────┐  │                   │  ┌─────────────┐  │          │
│  │    Pulsing Component     │  │                   │  │   Viewer    │  │          │
│  │                          │  │                   │  │             │  │          │
│  │  (tool_call) ◄───────────┘  │                   │  │  overlay ──►│  │          │
│  └──────────────────────────┘  │                   │  └─────────────┘  │          │
│                                │                   │                   │          │
└────────────────────────────────┼───────────────────┼───────────────────┼──────────┘
```

---

## 3. Subsystem Details

### 3.1 Tool Overrides (Builtins)

`mu` completely replaces the rendering logic for standard tools: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`.

*   **Mechanism**: `pi.registerTool` allows re-registering existing tools. `mu` wraps the original tool factory.
*   **Execution**:
    *   The wrapper instantiates the *real* tool with the current `ctx.cwd` to ensure directory context correctness.
    *   It executes the tool, catching errors.
    *   **Error Handling**: If a tool fails (throws or exit code != 0), `mu` forces the `isError` flag and preserves the error message to ensure red-box rendering in the UI.
*   **Rendering (`renderCall`)**:
    *   Uses `PulsingToolLine` component.
    *   Generates a compact, one-line summary (e.g., `bash $ npm test`, `read src/index.ts @L1-50`).
*   **Rendering (`renderResult`)**:
    *   **Collapsed (Default)**: Returns an empty `Text` component (effectively hidden).
    *   **Expanded/Error/Partial**: Returns the original tool's full output or a markdown block.

### 3.2 Event Interception & Redaction (Non-Builtins)

For tools not explicitly overridden (e.g., `agentsbox_*`, `browserbase_*`), `mu` listens to `tool_result` events.

*   **Target**: Successful, text-only tool results.
*   **Action**:
    1.  **Check**: Is it an error? (Explicit `isError` or heuristic "error-like" details). If yes, **SKIP** redaction.
    2.  **Persist**: Save the full content to the session (see 3.3).
    3.  **Mutate**: Replace the `content` in the event with a lightweight summary (e.g., `(query: "foo", limit: 5)`).
    4.  **Metadata**: Attach `details._mu` with `toolCallId` to allow tracing redacted results back to their originals.

### 3.3 State Management & Persistence

Data is managed in two layers to support both immediate access and cross-session durability.

#### Layer 1: In-Memory (Hot Storage)
*   **`recentToolResults`**: Array of `StoredToolResult`.
    *   *Capacity*: `MU_CONFIG.MAX_TOOL_RESULTS` (200).
    *   *Usage*: Backs the `/mu-tools` viewer.
    *   *Content*: Sanitized (no base64 images).
*   **`fullToolResultContentById`**: Map of `toolCallId -> Content[]`.
    *   *Usage*: Fast lookup for LLM context restoration.
    *   *Eviction*: FIFO based on max size.

#### Layer 2: Session Persistence (Cold Storage)
*   **Entry Type**: `custom`
*   **Custom Type**: `mu_tool_result_full_v1`
*   **Payload**:
    ```typescript
    {
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      content: StoredToolResultContent[]; // Sanitized
      isError: boolean;
      timestamp: number;
      exitCode?: number;
      duration?: number;
    }
    ```
*   **Rehydration**: On `session_start`, `mu` scans the session history. It rebuilds the in-memory state by merging:
    1.  Standard `toolResult` messages (for non-redacted builtins).
    2.  Custom `mu_tool_result_full_v1` entries (for redacted tools).

### 3.4 Context Restoration

To ensure the LLM is not "blinded" by the redacted transcript:

*   **Hook**: `pi.on("context")`
*   **Logic**:
    1.  Iterates over the message history being prepared for the LLM.
    2.  Identifies `toolResult` messages by `toolCallId`.
    3.  Checks `fullToolResultContentById` for a preserved full output.
    4.  **Swap**: Replaces the redacted (summary) content with the full original content in the payload sent to the model.

---

## 4. UI Components

### 4.1 PulsingToolLine
A dynamic TUI component for the tool call line.

*   **Visuals**:
    *   **Active State**: The tool name/icon pulses in brightness (sine wave animation).
    *   **Elapsed Time**: Shows a live counter (`⏱ 4s`) while running.
    *   **Completed**: Shows static text + final duration (if > 1s).
*   **Implementation**:
    *   Uses a single global `setInterval` (20 FPS) to drive the animation frame.
    *   Tracks `activeToolSignatures` (hash of name + args) to map `tool_call` start/end events to specific rendered lines.
    *   **Optimization**: Only invalidates/re-renders currently active instances to minimize CPU usage.

### 4.2 ToolResultDetailViewer (`/mu-tools`)
An interactive overlay for inspecting tool outputs.

*   **Structure**:
    *   **List View**: Selectable list of recent results with summaries and status icons.
    *   **Detail View**: Full-screen modal rendering the output.
*   **Rendering**:
    *   Uses `Markdown` component for syntax-highlighted output.
    *   Shows metadata: Exit code, Duration, Timestamp, Full Argument list.
*   **Navigation**: Vim-like bindings (`j`/`k` scroll, `n`/`p` next/prev result, `G`/`g` top/bottom).

---

## 5. Data Structures

### 5.1 StoredToolResult
```typescript
type StoredToolResult = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: StoredToolResultContent[];
  isError: boolean;
  timestamp: number;
  exitCode?: number;
  duration?: number;
};
```

### 5.2 Sanitization Rules
To prevent memory bloat and session file explosion:
*   **Text**: Stored as-is.
*   **Images**: **STRIPPED**. Converted to placeholder `{ type: "image", mimeType: "...", dataLength: 123 }`. Base64 data is never stored in `mu` state.
*   **Other**: Stored as generic objects.

---

## 6. Logic Flows

### 6.1 Tool Execution Flow
1.  **User** prompts agent.
2.  **Agent** calls tool (e.g., `bash`).
3.  **Pi** emits `tool_call`.
4.  **mu** (`PulsingToolLine`) catches event -> Starts pulsing UI + Timer.
5.  **Tool** executes.
6.  **Pi** emits `tool_result`.
7.  **mu** (`on("tool_result")`):
    *   Stops pulsing.
    *   Calculates duration.
    *   Sanitizes content.
    *   Persists to `recentToolResults` + Session.
    *   **If non-builtin & success**: Modifies event content to summary.
8.  **TUI** renders result (likely hidden/condensed).

### 6.2 Session Rebuild Flow
1.  **`session_start`** triggers.
2.  **mu** clears in-memory caches.
3.  **mu** scans session entries (reverse chronological or leaf-first).
4.  **Loop**:
    *   Found `mu_tool_result_full_v1`? -> Add to `recentToolResults` + `fullToolResultContentById`.
    *   Found standard `toolResult`? -> Add to `recentToolResults` (unless already added via custom entry).
5.  **Result**: Viewer is populated with history from previous session run.

---

## 7. Edge Cases & Safety

1.  **Redaction Failure**: If redaction logic fails, `mu` defaults to showing the original content to prevent data loss.
2.  **Base64 Images**: Explicitly stripped to avoid OOM.
3.  **Concurrency**: `activeToolSignatures` uses a counter to handle multiple identical tool calls running in parallel (though rare in Pi's sequential execution model).
4.  **Theme Compatibility**: Pulsing logic detects `ThemeWithAnsi` support; gracefully falls back to static text if truecolor manipulation is impossible.
