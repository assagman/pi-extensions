import { createHash } from "node:crypto";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ToolResultEvent,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import {
  type Component,
  type KeyId,
  Markdown,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

// -- Model Display Colors --
// Provider: Teal (#17917F)
// Model: Green (#85B06A)
// Thinking Level: Gradient from Tan (#A17E57) to Bright Red (#F24C38)
const MODEL_DISPLAY_COLORS = {
  provider: { r: 23, g: 145, b: 127 },   // #17917F - teal
  model: { r: 133, g: 176, b: 106 },     // #85B06A - green
  thinking: {
    off: null, // hidden
    minimal: { r: 161, g: 126, b: 87 },  // #A17E57 - tan (lowest)
    low: { r: 181, g: 114, b: 79 },      // #B5724F
    medium: { r: 202, g: 101, b: 72 },   // #CA6548
    high: { r: 222, g: 89, b: 64 },      // #DE5940
    xhigh: { r: 242, g: 76, b: 56 },     // #F24C38 - bright red (highest)
  },
} as const;

type ThinkingLevel = keyof typeof MODEL_DISPLAY_COLORS.thinking;

const rgb = (r: number, g: number, b: number, text: string): string =>
  `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;

const formatModelDisplay = (
  provider: string | undefined,
  modelId: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  hasReasoning: boolean
): string => {
  const parts: string[] = [];

  // Provider
  if (provider) {
    const { r, g, b } = MODEL_DISPLAY_COLORS.provider;
    parts.push(rgb(r, g, b, provider));
  }

  // Model
  if (modelId) {
    const { r, g, b } = MODEL_DISPLAY_COLORS.model;
    parts.push(rgb(r, g, b, modelId));
  } else {
    parts.push("no-model");
  }

  // Thinking level (only for reasoning models)
  if (hasReasoning && thinkingLevel && thinkingLevel !== "off") {
    const color = MODEL_DISPLAY_COLORS.thinking[thinkingLevel];
    if (color) {
      const { r, g, b } = color;
      parts.push(rgb(r, g, b, thinkingLevel));
    }
  }

  return parts.join(":");
};

// Local type definition for Tool - not exported from @mariozechner/pi-coding-agent main index
// biome-ignore lint/suspicious/noExplicitAny: Tool types require any for compatibility with pi-coding-agent
type Tool<TParameters = any> = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    id: string,
    params: TParameters,
    signal?: AbortSignal,
    onUpdate?: (event: ToolResultEvent) => void
  ) => Promise<ToolResultEvent>;
  renderCall?: (args: TParameters, theme: MuTheme) => Component;
  renderResult?: (result: unknown, options: unknown, theme: MuTheme) => Component;
};

// -- Type Definitions --
interface MuTheme {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
}

interface ThemeWithAnsi extends MuTheme {
  getFgAnsi?: (color: string) => string;
}

type ToolParams = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: Factory return type varies
type ToolFactory = (cwd: string) => any;

const MU_CONFIG = {
  MAX_TOOL_RESULTS: 200,
  MAX_COMPLETED_DURATIONS: 500,
  PREVIEW_LENGTH: 140,
  VIEWER_OPTION_MAX_LENGTH: 200,
  SIGNATURE_HASH_LENGTH: 16,
  PULSE_INTERVAL_MS: 50,
  PULSE_SPEED: 0.2,
  PULSE_MIN_BRIGHTNESS: 0.3,
} as const;

const GRAPHEME_SEGMENTER =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const splitGraphemes = (value: string): string[] => {
  if (!value) return [];
  if (GRAPHEME_SEGMENTER) {
    return Array.from(GRAPHEME_SEGMENTER.segment(value), (segment) => segment.segment);
  }
  return Array.from(value);
};

// -- Helper Functions --

function formatReadLoc(offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  const end = limit === undefined ? "end" : start + Math.max(0, Number(limit) - 1);
  return `@L${start}-${end}`;
}

function preview(text: string, max: number = MU_CONFIG.PREVIEW_LENGTH): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 3))}...`;
}

function formatArgsInline(input: Record<string, unknown>): string {
  const entries = Object.entries(input ?? {});
  if (entries.length === 0) return "";

  const fmtVal = (v: unknown): string => {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (typeof v === "string") return JSON.stringify(preview(v));
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
      return preview(JSON.stringify(v));
    } catch (error) {
      console.error("[mu] Failed to serialize value:", error);
      return "[unserializable]";
    }
  };

  const parts = entries.map(([k, v]) => `${k}: ${fmtVal(v)}`);
  return `(${parts.join(", ")})`;
}

export default function (pi: ExtensionAPI) {
  // ---------------------------------------------------------------------------
  // Pulsing Tool Line Component (Icon/Name fade-in/out)
  // ---------------------------------------------------------------------------

  // Track active tool calls by "signature" (name + args) to guess which component is active.
  // Store { count, startTime } for elapsed time display.
  type ActiveToolInfo = { count: number; startTime: number };
  const activeToolSignatures = new Map<string, ActiveToolInfo>();

  const getSignature = (name: string, args: unknown): string => {
    try {
      const argsStr = JSON.stringify(args ?? {});
      const hash = createHash("sha256")
        .update(argsStr)
        .digest("hex")
        .slice(0, MU_CONFIG.SIGNATURE_HASH_LENGTH);
      return `${name}:${hash}`;
    } catch (error) {
      console.error("[mu] Failed to create tool signature:", error);
      return `${name}:[unstringifiable]`;
    }
  };

  const formatElapsed = (ms: number): string => {
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}m${sec.toString().padStart(2, "0")}s`;
  };

  // Store completed tool durations by signature for historical display
  const completedToolDurations = new Map<string, number>();

  pi.on("tool_call", (e) => {
    const sig = getSignature(e.toolName, e.input);
    const existing = activeToolSignatures.get(sig);
    if (existing) {
      activeToolSignatures.set(sig, {
        count: existing.count + 1,
        startTime: existing.startTime,
      });
    } else {
      activeToolSignatures.set(sig, { count: 1, startTime: Date.now() });
    }
    // Track start time by toolCallId for duration computation
    toolCallStartTimes.set(e.toolCallId, Date.now());
  });

  pi.on("tool_result", (e) => {
    const sig = getSignature(e.toolName, e.input);
    const info = activeToolSignatures.get(sig);
    if (!info) return;
    // Store the elapsed time before removing from active
    const elapsedMs = Date.now() - info.startTime;
    completedToolDurations.set(sig, elapsedMs);
    if (completedToolDurations.size > MU_CONFIG.MAX_COMPLETED_DURATIONS) {
      const firstKey = completedToolDurations.keys().next().value;
      if (firstKey) {
        completedToolDurations.delete(firstKey);
      }
    }
    if (info.count > 1) {
      activeToolSignatures.set(sig, {
        count: info.count - 1,
        startTime: info.startTime,
      });
    } else {
      activeToolSignatures.delete(sig);
    }
  });

  pi.on("session_start", () => {
    activeToolSignatures.clear();
    completedToolDurations.clear();
  });

  // Registry of alive components to determine the "latest" one for a given signature.
  // We use a Set because it preserves insertion order. The last item is the most recently rendered (likely active).
  const componentRegistry = new Map<string, Set<PulsingToolLine>>();

  class PulsingToolLine implements Component {
    private textGenerator: () => string;
    private sig: string;
    private theme: MuTheme;
    private onInvalidate: (() => void) | null = null;

    private static frame = 0;
    private static timer: ReturnType<typeof setInterval> | null = null;
    private static instances = new Set<PulsingToolLine>();

    private static stopTimer(): void {
      if (PulsingToolLine.timer) {
        clearInterval(PulsingToolLine.timer);
        PulsingToolLine.timer = null;
      }
    }

    private static ensureTimer(): void {
      if (!PulsingToolLine.timer) {
        PulsingToolLine.timer = setInterval(() => {
          PulsingToolLine.frame++;
          // Invalidate all active instances to trigger re-render
          for (const instance of PulsingToolLine.instances) {
            if (instance.isActive() && instance.onInvalidate) {
              instance.onInvalidate();
            }
          }
        }, MU_CONFIG.PULSE_INTERVAL_MS);
      }
    }

    static cleanupAll(): void {
      PulsingToolLine.stopTimer();
      PulsingToolLine.instances.clear();
      componentRegistry.clear();
    }

    constructor(textGenerator: () => string, toolName: string, args: unknown, theme: MuTheme) {
      this.textGenerator = textGenerator;
      this.sig = getSignature(toolName, args);
      this.theme = theme;

      // Register component
      if (!componentRegistry.has(this.sig)) {
        componentRegistry.set(this.sig, new Set());
      }
      componentRegistry.get(this.sig)?.add(this);
      PulsingToolLine.instances.add(this);

      // Start global timer if needed
      PulsingToolLine.ensureTimer();
    }

    dispose(): void {
      PulsingToolLine.instances.delete(this);
      const set = componentRegistry.get(this.sig);
      if (set) {
        set.delete(this);
        if (set.size === 0) {
          componentRegistry.delete(this.sig);
        }
      }

      if (PulsingToolLine.instances.size === 0) {
        PulsingToolLine.stopTimer();
      }
    }

    isActive(): boolean {
      // Must be in active signatures
      if (!activeToolSignatures.has(this.sig)) return false;

      // Must be the LAST one in the registry for this signature
      const set = componentRegistry.get(this.sig);
      if (!set) return false;

      // Get the last item in the Set
      let last: PulsingToolLine | undefined;
      for (const item of set) last = item;

      return last === this;
    }

    getElapsedMs(): number {
      const info = activeToolSignatures.get(this.sig);
      if (!info) return 0;
      return Date.now() - info.startTime;
    }

    render(width: number): string[] {
      // Get fresh text from generator (supports live updates for write/edit)
      const text = this.textGenerator();

      // Wrap text to multiple lines respecting terminal width (ANSI-aware, no ellipsis)
      const wrapLines = (text: string): string[] => {
        const result: string[] = [];
        for (const line of text.split("\n")) {
          if (visibleWidth(line) <= width) {
            result.push(line);
            continue;
          }

          let currentLine = "";
          let currentWidth = 0;
          let i = 0;

          while (i < line.length) {
            const nextAnsiIndex = line.indexOf("\x1b", i);
            const textEnd = nextAnsiIndex === -1 ? line.length : nextAnsiIndex;

            if (textEnd > i) {
              const chunk = line.slice(i, textEnd);
              for (const segment of splitGraphemes(chunk)) {
                const segmentWidth = visibleWidth(segment);
                if (currentWidth + segmentWidth > width) {
                  result.push(currentLine);
                  currentLine = "";
                  currentWidth = 0;
                }
                currentLine += segment;
                currentWidth += segmentWidth;
              }
              i = textEnd;
            }

            if (i >= line.length) break;

            if (line[i] === "\x1b") {
              // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional ANSI escape sequence matching
              const match = line.slice(i).match(/^\x1b\[[0-9;]*m/);
              if (match) {
                currentLine += match[0];
                i += match[0].length;
                continue;
              }
            }

            const fallback = line[i] || "";
            const fallbackWidth = visibleWidth(fallback);
            if (currentWidth + fallbackWidth > width) {
              result.push(currentLine);
              currentLine = "";
              currentWidth = 0;
            }
            currentLine += fallback;
            currentWidth += fallbackWidth;
            i++;
          }

          if (currentLine) result.push(currentLine);
        }
        return result;
      };

      if (!this.isActive()) {
        // Show completed duration if available
        const completedMs = completedToolDurations.get(this.sig);
        if (completedMs !== undefined) {
          let dimAnsi = "\x1b[2m";
          const themeExt = this.theme as ThemeWithAnsi;
          try {
            if (typeof themeExt.getFgAnsi === "function") {
              dimAnsi = themeExt.getFgAnsi("dim");
            }
          } catch (error) {
            console.error("[mu] Failed to get dim color:", error);
          }
          // Only show timer if >= 1 second
          if (completedMs >= 1000) {
            const timerStr = `${dimAnsi}⏱ ${formatElapsed(completedMs)}`;
            return wrapLines(`${text} ${timerStr}`);
          }
          return wrapLines(text);
        }
        return wrapLines(text);
      }

      // Calculate pulsed color
      let accentAnsi = "";
      let dimAnsi = "";
      const themeExt = this.theme as ThemeWithAnsi;
      try {
        if (typeof themeExt.getFgAnsi !== "function") {
          return wrapLines(text);
        }
        accentAnsi = themeExt.getFgAnsi("accent");
        dimAnsi = themeExt.getFgAnsi("dim");
      } catch (error) {
        console.error("[mu] Failed to get accent color:", error);
        return wrapLines(text);
      }

      // Sine wave pulse
      const pulse = (Math.sin(PulsingToolLine.frame * MU_CONFIG.PULSE_SPEED) + 1) / 2; // 0..1
      const factor = MU_CONFIG.PULSE_MIN_BRIGHTNESS + (1 - MU_CONFIG.PULSE_MIN_BRIGHTNESS) * pulse;

      let pulsedColor = "";
      const m = accentAnsi.match(/38;2;(\d+);(\d+);(\d+)/);
      if (m?.[1] && m[2] && m[3]) {
        const r = Math.floor(Number.parseInt(m[1], 10) * factor);
        const g = Math.floor(Number.parseInt(m[2], 10) * factor);
        const b = Math.floor(Number.parseInt(m[3], 10) * factor);
        pulsedColor = `\x1b[38;2;${r};${g};${b}m`;
      } else {
        // Fallback for non-truecolor: blink or dim?
        // Just return text if we can't do smooth pulse
        return wrapLines(text);
      }

      // Replace the accent color in the text with the pulsed color
      // We assume the text starts with the icon/name which uses 'accent'
      // We'll replace the first occurrence of the accent ANSI sequence.
      const replaced = text.replace(accentAnsi, pulsedColor);

      // Build elapsed timer suffix (only if >= 1 second)
      const elapsed = this.getElapsedMs();
      if (elapsed >= 1000) {
        const timerStr = `${dimAnsi}⏱ ${formatElapsed(elapsed)}`;
        return wrapLines(`${replaced} ${timerStr}`);
      }

      return wrapLines(replaced);
    }

    invalidate(): void {
      // No-op to satisfy Component interface
    }
  }

  // ---------------------------------------------------------------------------
  // Per-tool result viewer (works across restarts)
  // ---------------------------------------------------------------------------
  // NOTE: Ctrl+O is a built-in, reserved keybinding in pi ("expandTools").
  // Extensions can't override it. Instead, mu provides a per-tool viewer.

  const MU_TOOL_VIEWER_SHORTCUT: KeyId = "ctrl+alt+o";

  type StoredToolResultContent =
    | { type: "text"; text?: string }
    | { type: "image"; mimeType?: string; dataLength?: number }
    | { type: string; [k: string]: unknown };

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

  const TOOL_ICON: Record<string, string> = {
    bash: "",
    read: "",
    grep: "",
    find: "",
    ls: "",
  };

  const recentToolResults: StoredToolResult[] = [];

  // Track tool_call start times by toolCallId for computing duration
  const toolCallStartTimes = new Map<string, number>();

  const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "grep", "find", "ls"]);

  // Persist full tool outputs for tools we redact from the normal transcript.
  // This keeps mu-tools usable across restarts and lets us restore full results for the LLM.
  const MU_TOOL_RESULT_ENTRY_TYPE = "mu_tool_result_full_v1";

  // toolCallId -> full tool result content (text-only). Used to restore full tool output in the LLM context.
  const fullToolResultContentById = new Map<string, StoredToolResultContent[]>();

  // Evict oldest entries from fullToolResultContentById when it exceeds MU_CONFIG.MAX_TOOL_RESULTS
  const evictOldestFromFullResults = (): void => {
    while (fullToolResultContentById.size > MU_CONFIG.MAX_TOOL_RESULTS) {
      const firstKey = fullToolResultContentById.keys().next().value;
      if (firstKey) {
        fullToolResultContentById.delete(firstKey);
      } else {
        break;
      }
    }
  };

  const sanitizeToolContent = (content: unknown): StoredToolResultContent[] => {
    if (!Array.isArray(content)) return [];

    return content.map((c) => {
      if (!isRecord(c)) return { type: String(c) };

      const type = typeof c.type === "string" ? c.type : "";

      if (type === "text") {
        return { type: "text", text: typeof c.text === "string" ? c.text : "" };
      }

      // Avoid storing base64 image payloads in memory.
      if (type === "image") {
        const data = c.data;
        const dataLength = typeof data === "string" ? data.length : undefined;
        return {
          type: "image",
          mimeType: typeof c.mimeType === "string" ? c.mimeType : undefined,
          dataLength,
        };
      }

      // Unknown content type
      return { type: type || String(c.type ?? "unknown") };
    });
  };

  // Attach lightweight metadata to tool result details so custom renderers can
  // recover toolCallId even if the toolResult content is redacted.
  const MU_DETAILS_KEY = "_mu" as const;

  const withMuDetails = (
    details: unknown,
    meta: Record<string, unknown>
  ): Record<string, unknown> => {
    if (!details || typeof details !== "object") {
      return { [MU_DETAILS_KEY]: meta };
    }

    const d = details as Record<string, unknown>;
    const existing =
      d[MU_DETAILS_KEY] && typeof d[MU_DETAILS_KEY] === "object"
        ? (d[MU_DETAILS_KEY] as Record<string, unknown>)
        : {};

    return {
      ...d,
      [MU_DETAILS_KEY]: {
        ...existing,
        ...meta,
      },
    };
  };

  const summarizeToolInput = (toolName: string, input: Record<string, unknown>): string => {
    switch (toolName) {
      case "bash": {
        const command = typeof input.command === "string" ? input.command : "";
        return preview(command);
      }
      case "read": {
        const path = typeof input.path === "string" ? input.path : "";
        const offset = typeof input.offset === "number" ? input.offset : undefined;
        const limit = typeof input.limit === "number" ? input.limit : undefined;
        const loc = formatReadLoc(offset, limit);
        return [path, loc].filter(Boolean).join(" ");
      }
      case "ls":
        return typeof input.path === "string" ? input.path : "";
      case "grep": {
        const p = input.pattern !== undefined ? JSON.stringify(input.pattern) : "";
        const where = typeof input.path === "string" ? `in ${input.path}` : "";
        return preview(`${p} ${where}`.trim());
      }
      case "find": {
        const p = input.pattern !== undefined ? JSON.stringify(input.pattern) : "";
        const where = typeof input.path === "string" ? `in ${input.path}` : "";
        return preview(`${p} ${where}`.trim());
      }
      default:
        return preview(JSON.stringify(input ?? {}));
    }
  };

  const toolContentToText = (content: StoredToolResult["content"]): string => {
    return content
      .map((c) => {
        if (c.type === "text") return typeof c.text === "string" ? c.text : "";
        if (c.type === "image") {
          const mt = typeof c.mimeType === "string" ? c.mimeType : "";
          const len = typeof c.dataLength === "number" ? c.dataLength : undefined;
          return `[image ${mt}${len ? ` ${len} chars` : ""}]`;
        }
        return `[${c.type}]`;
      })
      .join("\n");
  };

  const rebuildRecentToolResultsFromSession = (ctx: ExtensionContext) => {
    // Reset in-memory list
    recentToolResults.length = 0;

    const leafId = ctx.sessionManager.getLeafId();
    const entries: unknown[] = leafId
      ? (ctx.sessionManager.getBranch(leafId) as unknown[])
      : (ctx.sessionManager.getEntries() as unknown[]);

    // Prefer mu's persisted full tool results over transcript toolResult messages.
    const fullToolResultIds = new Set<string>();
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (entry.type !== "custom") continue;
      if (entry.customType !== MU_TOOL_RESULT_ENTRY_TYPE) continue;
      const data = entry.data;
      if (!isRecord(data)) continue;
      const toolCallId = data.toolCallId;
      if (typeof toolCallId === "string") {
        fullToolResultIds.add(toolCallId);
      }
    }

    // Collect toolCallId -> args from assistant messages on the current branch.
    const toolCallsById = new Map<string, { toolName: string; input: Record<string, unknown> }>();

    for (const entry of entries) {
      if (!isRecord(entry) || entry.type !== "message") continue;
      const msg = entry.message;
      if (!isRecord(msg)) continue;
      if (msg.role !== "assistant") continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type !== "toolCall") continue;
        if (typeof block.id !== "string" || typeof block.name !== "string") continue;

        const args = block.arguments;
        toolCallsById.set(block.id, {
          toolName: block.name,
          input: isRecord(args) ? args : {},
        });
      }
    }

    // Collect tool results (root-first order -> keep last N)
    for (const entry of entries) {
      if (!isRecord(entry)) continue;

      // 1) mu persisted full tool results
      if (entry.type === "custom" && entry.customType === MU_TOOL_RESULT_ENTRY_TYPE) {
        const data = entry.data;
        if (!isRecord(data)) continue;

        const toolCallId = data.toolCallId;
        const toolName = data.toolName;
        const input = data.input;
        const content = data.content;
        const isError = data.isError;
        const exitCode = data.exitCode;
        const duration = data.duration;

        if (typeof toolCallId !== "string" || typeof toolName !== "string") continue;

        const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Date.now();

        const storedContent = Array.isArray(content) ? (content as StoredToolResultContent[]) : [];

        recentToolResults.push({
          toolCallId,
          toolName,
          input: isRecord(input) ? input : {},
          content: storedContent,
          isError: Boolean(isError),
          timestamp: Number.isFinite(ts) ? ts : Date.now(),
          exitCode: typeof exitCode === "number" ? exitCode : undefined,
          duration: typeof duration === "number" ? duration : undefined,
        });

        // If the persisted content is text-only, also keep it around for restoring LLM context.
        if (storedContent.length > 0 && storedContent.every((c) => c.type === "text")) {
          fullToolResultContentById.set(toolCallId, storedContent);
        }

        if (recentToolResults.length > MU_CONFIG.MAX_TOOL_RESULTS) {
          recentToolResults.shift();
        }

        continue;
      }

      // 2) transcript toolResult messages (skip if we have a persisted full result)
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (!isRecord(msg) || msg.role !== "toolResult") continue;

      const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
      if (!toolCallId) continue;
      if (fullToolResultIds.has(toolCallId)) continue;

      const toolName =
        typeof msg.toolName === "string"
          ? msg.toolName
          : (toolCallsById.get(toolCallId)?.toolName ?? "");
      const input = toolCallsById.get(toolCallId)?.input ?? {};

      const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Date.now();

      recentToolResults.push({
        toolCallId,
        toolName,
        input,
        content: sanitizeToolContent(msg.content),
        isError: Boolean(msg.isError),
        timestamp: Number.isFinite(ts) ? ts : Date.now(),
      });

      if (recentToolResults.length > MU_CONFIG.MAX_TOOL_RESULTS) {
        recentToolResults.shift();
      }
    }
  };

  // -------------------------------------------------------------------------
  // Tool Result Detail Viewer (scrollable overlay)
  // -------------------------------------------------------------------------

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const min = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${min}m${s.toString().padStart(2, "0")}s`;
  };

  const formatTimestamp = (ts: number): string => {
    const d = new Date(ts);
    const pad2 = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  };

  const formatArgsFull = (input: Record<string, unknown>, innerWidth: number): string[] => {
    const entries = Object.entries(input ?? {});
    if (entries.length === 0) return ["  (none)"];
    const lines: string[] = [];
    for (const [k, v] of entries) {
      let valStr: string;
      if (typeof v === "string") {
        valStr = v;
      } else if (v === null || v === undefined) {
        valStr = String(v);
      } else {
        try {
          valStr = JSON.stringify(v, null, 2);
        } catch {
          valStr = "[unserializable]";
        }
      }
      // For short values, show inline
      if (valStr.length <= innerWidth - k.length - 6 && !valStr.includes("\n")) {
        lines.push(`  ${k}: ${valStr}`);
      } else {
        // Multi-line: show key on its own line, then indented value
        lines.push(`  ${k}:`);
        for (const vl of valStr.split("\n")) {
          lines.push(`    ${vl}`);
        }
      }
    }
    return lines;
  };

  class ToolResultDetailViewer implements Component {
    private items: StoredToolResult[];
    private currentIndex: number;
    private scrollOffset = 0;
    private contentLines: string[] = [];
    private cachedWidth = 0;
    private theme: MuTheme;
    private done: (result: undefined) => void;

    constructor(
      items: StoredToolResult[],
      startIndex: number,
      theme: MuTheme,
      done: (result: undefined) => void
    ) {
      this.items = items;
      this.currentIndex = startIndex;
      this.theme = theme;
      this.done = done;
    }

    private buildContent(width: number): void {
      const th = this.theme;
      const r = this.items[this.currentIndex];
      if (!r) {
        this.contentLines = [];
        return;
      }

      const innerW = Math.max(20, width - 4); // 2 border + 2 padding
      const lines: string[] = [];

      // ── Header ──
      const icon = TOOL_ICON[r.toolName] ?? "⚙";
      const idShort = r.toolCallId.slice(0, 12);
      const statusIcon = r.isError ? th.fg("error", "✗ error") : th.fg("success", "✓ ok");
      const exitStr = r.exitCode !== undefined ? th.fg("dim", ` exit=${r.exitCode}`) : "";
      const headerLeft = `${th.fg("accent", `${icon} ${r.toolName}`)} ${th.fg("dim", `#${idShort}`)}`;
      const headerRight = `${statusIcon}${exitStr}`;
      const headerGap = Math.max(1, innerW - visibleWidth(headerLeft) - visibleWidth(headerRight));
      lines.push(`${headerLeft}${" ".repeat(headerGap)}${headerRight}`);

      // ── Separator ──
      lines.push(th.fg("dim", "─".repeat(innerW)));

      // ── Arguments ──
      lines.push(th.fg("muted", "Arguments:"));
      const argLines = formatArgsFull(r.input, innerW);
      for (const al of argLines) {
        // Wrap long arg lines
        const wrapped = wrapTextWithAnsi(al, innerW);
        lines.push(...wrapped);
      }

      // ── Separator ──
      lines.push(th.fg("dim", "─".repeat(innerW)));

      // ── Output ──
      const outputText = toolContentToText(r.content);
      const outputRawLines = outputText.split("\n");
      const lineCountStr = th.fg("dim", `[${outputRawLines.length} lines]`);
      lines.push(`${th.fg("muted", "Output:")}  ${lineCountStr}`);

      // Wrap each output line to fit
      for (const ol of outputRawLines) {
        if (ol === "") {
          lines.push("");
        } else {
          const wrapped = wrapTextWithAnsi(`  ${ol}`, innerW);
          lines.push(...wrapped);
        }
      }

      // ── Separator ──
      lines.push(th.fg("dim", "─".repeat(innerW)));

      // ── Footer metadata ──
      const durationStr =
        r.duration !== undefined ? `${th.fg("dim", "⏱")} ${formatDuration(r.duration)}` : "";
      const timeStr = `${th.fg("dim", "⏲")} ${formatTimestamp(r.timestamp)}`;
      const navStr = th.fg("dim", `[${this.currentIndex + 1}/${this.items.length}]`);
      const metaParts = [durationStr, timeStr, navStr].filter(Boolean);
      lines.push(metaParts.join(th.fg("dim", "  │  ")));

      this.contentLines = lines;
    }

    render(width: number): string[] {
      if (width !== this.cachedWidth) {
        this.cachedWidth = width;
        this.buildContent(width);
        // Clamp scroll after rebuild
        this.scrollOffset = Math.min(
          this.scrollOffset,
          Math.max(0, this.contentLines.length - this.viewportHeight(width))
        );
      }

      const th = this.theme;
      const innerW = Math.max(20, width - 4);
      const vpHeight = this.viewportHeight(width);
      const result: string[] = [];

      // Top border
      result.push(th.fg("border", `╭─${"─".repeat(innerW)}─╮`));

      // Visible content window
      const visibleLines = this.contentLines.slice(this.scrollOffset, this.scrollOffset + vpHeight);
      for (const line of visibleLines) {
        const padded = this.padLine(line, innerW);
        result.push(`${th.fg("border", "│")} ${padded} ${th.fg("border", "│")}`);
      }

      // Fill remaining viewport if content is short
      const remaining = vpHeight - visibleLines.length;
      for (let i = 0; i < remaining; i++) {
        result.push(`${th.fg("border", "│")} ${" ".repeat(innerW)} ${th.fg("border", "│")}`);
      }

      // Bottom border
      result.push(th.fg("border", `╰─${"─".repeat(innerW)}─╯`));

      // Scroll indicator + help
      const scrollPct =
        this.contentLines.length <= vpHeight
          ? ""
          : th.fg(
              "dim",
              ` ${Math.round((this.scrollOffset / Math.max(1, this.contentLines.length - vpHeight)) * 100)}%`
            );
      const helpLine = th.fg(
        "dim",
        `↑↓/jk scroll  [/] prev/next  g/G top/bot  esc close${scrollPct}`
      );
      result.push(truncateToWidth(helpLine, width));

      return result;
    }

    private viewportHeight(_width: number): number {
      // Reserve: 1 top border + 1 bottom border + 1 help line = 3 chrome lines
      // Use process.stdout for terminal height, fallback 24
      const termHeight = (typeof process !== "undefined" && process.stdout?.rows) || 24;
      // 90% of terminal height minus chrome
      return Math.max(5, Math.floor(termHeight * 0.85) - 3);
    }

    private padLine(line: string, innerW: number): string {
      const w = visibleWidth(line);
      if (w >= innerW) return truncateToWidth(line, innerW);
      return line + " ".repeat(innerW - w);
    }

    handleInput(data: string): void {
      if (matchesKey(data, "escape") || matchesKey(data, "q")) {
        this.done(undefined);
        return;
      }

      const vpHeight = this.viewportHeight(this.cachedWidth);
      const maxScroll = Math.max(0, this.contentLines.length - vpHeight);

      // Scroll
      if (matchesKey(data, "down") || matchesKey(data, "j")) {
        this.scrollOffset = Math.min(this.scrollOffset + 1, maxScroll);
      } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
        this.scrollOffset = Math.max(this.scrollOffset - 1, 0);
      } else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
        this.scrollOffset = Math.min(this.scrollOffset + Math.floor(vpHeight / 2), maxScroll);
      } else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
        this.scrollOffset = Math.max(this.scrollOffset - Math.floor(vpHeight / 2), 0);
      } else if (matchesKey(data, "g")) {
        this.scrollOffset = 0;
      } else if (matchesKey(data, "shift+g")) {
        this.scrollOffset = maxScroll;
      }
      // Navigate between results
      else if (matchesKey(data, "]") || matchesKey(data, "n")) {
        if (this.currentIndex < this.items.length - 1) {
          this.currentIndex++;
          this.scrollOffset = 0;
          this.cachedWidth = 0; // Force content rebuild on next render
        }
      } else if (matchesKey(data, "[") || matchesKey(data, "p")) {
        if (this.currentIndex > 0) {
          this.currentIndex--;
          this.scrollOffset = 0;
          this.cachedWidth = 0; // Force content rebuild on next render
        }
      }
    }

    invalidate(): void {
      this.cachedWidth = 0; // Force rebuild on next render
    }

    dispose(): void {}
  }

  const openToolResultViewer = async (ctx: ExtensionContext | ExtensionCommandContext) => {
    if (!ctx.hasUI) return;

    if (recentToolResults.length === 0) {
      ctx.ui.notify("mu: no tool results yet", "info");
      return;
    }

    const items = [...recentToolResults].reverse();

    const options = items.map((r, i) => {
      const icon = TOOL_ICON[r.toolName] ?? "⚙";
      const idShort = r.toolCallId.slice(0, 8);
      const summary = summarizeToolInput(r.toolName, r.input);
      const exitCodeStr = r.exitCode !== undefined ? ` exit=${r.exitCode}` : "";
      const errorFlag = r.isError ? ` [error${exitCodeStr}]` : "";
      const durationStr = r.duration !== undefined ? ` ${formatDuration(r.duration)}` : "";
      const line = preview(
        `${i + 1}. ${icon} ${r.toolName} #${idShort} ${summary}`.trim(),
        MU_CONFIG.VIEWER_OPTION_MAX_LENGTH
      );
      return `${line}${errorFlag}${durationStr}`;
    });

    const selected = await ctx.ui.select("Tool results (mu)", options);
    if (!selected) return;

    const index = options.indexOf(selected);
    if (index < 0 || index >= items.length) return;

    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        const viewer = new ToolResultDetailViewer(items, index, theme, done);
        return {
          render: (w: number) => viewer.render(w),
          invalidate: () => viewer.invalidate(),
          handleInput: (data: string) => {
            viewer.handleInput(data);
            tui.requestRender();
          },
          dispose: () => viewer.dispose(),
        };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "92%",
          maxHeight: "92%",
        },
      }
    );
  };

  // Rebuild viewer state from current branch history on session load.
  pi.on("session_start", async (_e, ctx) => {
    activeToolSignatures.clear();
    PulsingToolLine.cleanupAll();
    fullToolResultContentById.clear();
    toolCallStartTimes.clear();

    try {
      rebuildRecentToolResultsFromSession(ctx);
    } catch (error) {
      console.error("[mu] Failed to rebuild tool results from session:", error);
    }
  });

  // Track tool results as they come in.
  //
  // Transcript behavior ("CLI-condensed"):
  // - agentsbox_* tools: replace successful output with args-inline summary (shown as second row)
  // - other non-builtin tools: replace successful text output with a short args tuple
  //
  // Full outputs are persisted for /mu-tools and restored for the LLM via pi.on("context").
  pi.on("tool_result", (e: ToolResultEvent) => {
    const storedContent = sanitizeToolContent(e.content);
    const isTextOnly = storedContent.length > 0 && storedContent.every((c) => c.type === "text");

    const isAgentsbox = typeof e.toolName === "string" && e.toolName.startsWith("agentsbox_");
    const detailsRecord = isRecord(e.details) ? e.details : undefined;

    // agentsbox returns failures as successful tool results with details.error + isError: true.
    // The extension wrapper reports e.isError=false in that case, so we treat details.error as error-like.
    const agentsboxErrorLike = isAgentsbox
      ? Boolean(
          e.isError || detailsRecord?.isError === true || typeof detailsRecord?.error === "string"
        )
      : false;

    const storedIsError = isAgentsbox ? agentsboxErrorLike : e.isError;

    // Extract exitCode from bash tool details
    const exitCode =
      e.toolName === "bash" && detailsRecord && typeof detailsRecord.exitCode === "number"
        ? detailsRecord.exitCode
        : undefined;

    // Compute duration from tracked start time
    const callStart = toolCallStartTimes.get(e.toolCallId);
    const duration = callStart !== undefined ? Date.now() - callStart : undefined;
    toolCallStartTimes.delete(e.toolCallId);

    const stored: StoredToolResult = {
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      input: isRecord(e.input) ? e.input : {},
      content: storedContent,
      isError: storedIsError,
      timestamp: Date.now(),
      exitCode: typeof exitCode === "number" ? exitCode : undefined,
      duration,
    };

    recentToolResults.push(stored);

    if (recentToolResults.length > MU_CONFIG.MAX_TOOL_RESULTS) {
      recentToolResults.splice(0, recentToolResults.length - MU_CONFIG.MAX_TOOL_RESULTS);
    }

    const isBuiltin = BUILTIN_TOOL_NAMES.has(e.toolName);

    // -----------------------------------------------------------------------
    // agentsbox_* tools
    // -----------------------------------------------------------------------

    if (isAgentsbox && isTextOnly) {
      const detailsWithMu = withMuDetails(e.details, {
        toolCallId: stored.toolCallId,
        toolName: stored.toolName,
        isError: storedIsError,
      });

      // Replace successful output with args-inline summary.
      // Pi's ToolExecutionComponent shows this below the tool name in toolOutput color:
      //   agentsbox_search_bm25       ← toolTitle, bold
      //   (text: "query", limit: 5)   ← toolOutput color
      // Full output is persisted for /mu-tools viewer and restored for the LLM via context event.
      if (!storedIsError) {
        fullToolResultContentById.set(stored.toolCallId, storedContent);
        evictOldestFromFullResults();

        try {
          pi.appendEntry(MU_TOOL_RESULT_ENTRY_TYPE, {
            toolCallId: stored.toolCallId,
            toolName: stored.toolName,
            input: stored.input,
            content: stored.content,
            isError: stored.isError,
            timestamp: stored.timestamp,
            exitCode: stored.exitCode,
            duration: stored.duration,
          });
        } catch (error) {
          console.error("[mu] Failed to persist tool result entry:", error);
        }

        const argsInline = formatArgsInline(stored.input);

        return {
          content: [{ type: "text" as const, text: argsInline }],
          details: detailsWithMu,
          isError: false,
        };
      }

      // Error-like agentsbox results stay visible by default, but we still attach mu metadata.
      return {
        details: detailsWithMu,
      };
    }

    // -----------------------------------------------------------------------
    // Other tools (non-builtin)
    // -----------------------------------------------------------------------

    // Only redact successful, text-only results from non-builtin tools.
    // - Errors should remain visible by default
    // - Image payloads are never redacted
    if (!isBuiltin && !e.isError && isTextOnly) {
      fullToolResultContentById.set(stored.toolCallId, storedContent);
      evictOldestFromFullResults();

      try {
        pi.appendEntry(MU_TOOL_RESULT_ENTRY_TYPE, {
          toolCallId: stored.toolCallId,
          toolName: stored.toolName,
          input: stored.input,
          content: stored.content,
          isError: stored.isError,
          timestamp: stored.timestamp,
          exitCode: stored.exitCode,
          duration: stored.duration,
        });
      } catch (error) {
        console.error("[mu] Failed to persist tool result entry:", error);
      }

      // Redacted display: show args only (tool name already shown by the tool call line).
      const argsInline = formatArgsInline(stored.input);

      return {
        content: [{ type: "text" as const, text: argsInline }],
        details: e.details,
        isError: e.isError,
      };
    }

    return undefined;
  });

  // Restore full tool outputs for the LLM context (while keeping transcript redacted).
  // biome-ignore lint/suspicious/noExplicitAny: Event type not exported from pi-coding-agent
  pi.on("context" as any, (e: any) => {
    let changed = false;
    const msgs = (e.messages as unknown[]).map((m) => {
      if (!isRecord(m)) return m;
      if (m.role !== "toolResult") return m;
      const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
      if (!toolCallId) return m;

      const full = fullToolResultContentById.get(toolCallId);
      if (!full) return m;

      changed = true;
      return {
        ...m,
        content: full,
      };
    });

    // biome-ignore lint/suspicious/noExplicitAny: Return type matches pi event handler
    return changed ? ({ messages: msgs } as any) : undefined;
  });

  pi.registerShortcut(MU_TOOL_VIEWER_SHORTCUT, {
    description: "mu: pick and view a single tool result (per-item)",
    handler: async (ctx) => {
      await openToolResultViewer(ctx);
    },
  });

  pi.registerCommand("mu-tools", {
    description: "mu: pick and view a single tool result in an overlay",
    handler: async (_args, ctx) => {
      await openToolResultViewer(ctx);
    },
  });

  // ---------------------------------------------------------------------------
  // Tool wrappers (condensed call lines, full output on error / partial / expanded)
  // ---------------------------------------------------------------------------

  function override(
    name: string,
    factory: ToolFactory,
    renderCondensed: (args: ToolParams, details: ToolParams, theme: MuTheme) => string
  ) {
    // Create a dummy instance to get metadata and original renderer
    const dummy = factory(process.cwd());

    type ExecutableTool = Tool<ToolParams> & {
      execute: (
        id: string,
        params: ToolParams,
        signal?: AbortSignal,
        onUpdate?: (event: ToolResultEvent) => void
      ) => Promise<ToolResultEvent>;
    };

    const throwIfAborted = (signal?: AbortSignal) => {
      if (!signal?.aborted) return;
      const error = new Error("Tool execution aborted");
      (error as { name?: string }).name = "AbortError";
      throw error;
    };

    pi.registerTool({
      name,
      label: dummy.label,
      description: dummy.description,
      // biome-ignore lint/suspicious/noExplicitAny: Type coercion for pi tool registration
      parameters: dummy.parameters as any,

      async execute(id, params, _onUpdate, ctx, signal) {
        throwIfAborted(signal);

        // Instantiate real tool with current CWD to ensure correct execution context
        const realTool = factory(ctx.cwd) as ExecutableTool;

        // Never pass onUpdate – suppress all streaming output from reaching UI
        const result = await realTool.execute(id, params, signal);

        throwIfAborted(signal);

        // Pi's wrapper sets isError based on whether tool throws, not result.isError
        // So we must throw for non-zero exit codes to get red box styling
        if (result.isError) {
          const content = Array.isArray(result.content) ? result.content : [];
          const errorText =
            content
              .filter((c: unknown) => isRecord(c) && c.type === "text")
              .map((c: unknown) =>
                typeof (c as Record<string, unknown>).text === "string"
                  ? (c as Record<string, unknown>).text
                  : ""
              )
              .join("\n") || "Command failed";

          // Include exit code in error message so renderResult can parse it back
          const details = isRecord(result.details) ? result.details : undefined;
          const exitCode = details?.exitCode;
          const exitPrefix = typeof exitCode === "number" ? `[mu_exit_code:${exitCode}] ` : "";

          const err = new Error(`${exitPrefix}${errorText}`);
          if (details && typeof details.stack === "string") {
            err.stack = details.stack;
          }
          throw err;
        }

        return result;
      },

      renderCall(args: ToolParams, theme: MuTheme) {
        // Create a generator that re-computes text on each render
        // For write/edit, this captures live-updated args (content grows during write)
        const textGenerator = () => renderCondensed(args, {}, theme).trimEnd();
        return new PulsingToolLine(textGenerator, name, args, theme);
      },

      renderResult(result, options, theme: MuTheme) {
        const { expanded } = options;

        const content = Array.isArray(result.content) ? result.content : [];
        const details = isRecord(result.details) ? result.details : undefined;
        const extractText = (item: unknown): string =>
          isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : "";

        // For bash: extract exit code from details or content
        // Note: Pi's renderResult doesn't pass isError, so we detect errors via:
        //   1. details.exitCode !== 0 (normal path)
        //   2. mu marker [mu_exit_code:N] in content (thrown error path)
        //   3. Pi's error format "Command exited with code N" (fallback)
        let exitCode: number | undefined;
        let isErrorDetected = false;
        if (name === "bash") {
          exitCode = typeof details?.exitCode === "number" ? details.exitCode : undefined;

          if (exitCode === undefined) {
            const text = content.map(extractText).join("\n");

            // Try mu marker first (most specific - inserted by our execute())
            let match = text.match(/\[mu_exit_code:(\d+)\]/);
            if (match?.[1]) {
              const parsed = Number.parseInt(match[1], 10);
              if (!Number.isNaN(parsed)) {
                exitCode = parsed;
                isErrorDetected = true;
              }
            }

            // Fallback: Pi's native error format "Command exited with code N"
            // This is specific enough to not match source code
            if (exitCode === undefined) {
              match = text.match(/Command exited with code (\d+)/i);
              if (match?.[1]) {
                const parsed = Number.parseInt(match[1], 10);
                if (!Number.isNaN(parsed)) {
                  exitCode = parsed;
                  isErrorDetected = true;
                }
              }
            }
          }
        }
        const hasNonZeroExit = typeof exitCode === "number" && exitCode !== 0;
        const isError = isErrorDetected || hasNonZeroExit;

        // Errors or non-zero bash exit: show formatted error box
        if (isError) {
          const rawText = content.map(extractText).join("\n");

          // Clean up bash error output for display
          const errorMsg = rawText
            .replace(/\[mu_exit_code:\d+\]\s*/g, "") // Remove mu marker
            .replace(/^\/bin\/(?:ba)?sh:\s*/gm, "") // Remove shell prefix
            .replace(/Command exited with code \d+\s*/gi, "") // Remove duplicate exit line
            .replace(/exit(?:ed with)? code[:\s]+\d+\s*/gi, "") // Remove exit code mentions
            .trim();

          if (name === "bash") {
            const lines = [
              "Bash command failed",
              exitCode !== undefined ? `Exit code : ${exitCode}` : "",
              errorMsg ? `Error     : ${errorMsg}` : "",
            ].filter(Boolean);
            return new Text(lines.join("\n"), 0, 0);
          }

          return new Markdown(
            rawText.replace(/\[mu_exit_code:\d+\]\s*/g, ""),
            0,
            0,
            getMarkdownTheme()
          );
        }

        // Expanded: use default renderer (partial is suppressed to avoid flash)
        if (expanded) {
          if (dummy.renderResult) {
            return dummy.renderResult(result, options, theme);
          }
          const text = content.map(extractText).join("\n");
          return new Markdown(text, 0, 0, getMarkdownTheme());
        }

        // Condensed View - hide all results
        // For write/edit, live progress is shown in the call line via textGenerator
        return new Text("", 0, 0);
      },
    });
  }

  // Define tools configuration
  const tools: [string, ToolFactory, (a: ToolParams, d: ToolParams, t: MuTheme) => string][] = [
    [
      "bash",
      createBashTool,
      (args, _details, t) => {
        const command = typeof args.command === "string" ? args.command : "";
        return `${t.fg("accent", "bash")} ${t.fg("dim", "$")} ${t.fg("text", command)}`;
      },
    ],
    [
      "read",
      createReadTool,
      (args, _details, t) => {
        const offset = typeof args.offset === "number" ? args.offset : undefined;
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const info = formatReadLoc(offset, limit);
        const infoColored = info ? t.fg("dim", info) : "";
        const path = typeof args.path === "string" ? args.path : "";
        return `${t.fg("accent", "read")} ${t.fg("text", path)} ${infoColored}`.trimEnd();
      },
    ],
    [
      "grep",
      createGrepTool,
      (args, details, t) => {
        const pattern = args.pattern !== undefined ? String(args.pattern) : "";
        const where = typeof args.path === "string" ? args.path : ".";
        const glob = args.glob !== undefined ? `glob: ${JSON.stringify(args.glob)}` : "";
        const ignoreCase = args.ignoreCase === true ? "ignoreCase: true" : "";
        const literal = args.literal === true ? "literal: true" : "";
        const context = typeof args.context === "number" ? `context: ${args.context}` : "";
        const limit = typeof args.limit === "number" ? `limit: ${args.limit}` : "";
        const detailsRecord = isRecord(details) ? details : {};
        const matches =
          typeof detailsRecord.matches === "number" ? `matches: ${detailsRecord.matches}` : "";
        const parts = [glob, ignoreCase, literal, context, limit, matches].filter(Boolean);
        const info = parts.length ? t.fg("dim", `(${parts.join(", ")})`) : "";
        return `${t.fg("accent", "grep")} ${t.fg("text", JSON.stringify(pattern))} ${t.fg("text", where)} ${info}`.trimEnd();
      },
    ],
    [
      "find",
      createFindTool,
      (args, details, t) => {
        const pattern = args.pattern !== undefined ? String(args.pattern) : "";
        const where = typeof args.path === "string" ? args.path : ".";
        const limit = typeof args.limit === "number" ? `limit: ${args.limit}` : "";
        const detailsRecord = isRecord(details) ? details : {};
        const count =
          typeof detailsRecord.count === "number" ? `count: ${detailsRecord.count}` : "";
        const parts = [limit, count].filter(Boolean);
        const info = parts.length ? t.fg("dim", `(${parts.join(", ")})`) : "";
        return `${t.fg("accent", "find")} ${t.fg("text", JSON.stringify(pattern))} ${t.fg("text", where)} ${info}`.trimEnd();
      },
    ],
    [
      "ls",
      createLsTool,
      (args, _details, t) => {
        const path = typeof args.path === "string" ? args.path : ".";
        return `${t.fg("accent", "ls")} ${t.fg("text", path)}`;
      },
    ],
    [
      "write",
      createWriteTool,
      (args, _details, t) => {
        const path = typeof args.path === "string" ? args.path : "";
        const content = typeof args.content === "string" ? args.content : "";
        const lines = content ? content.split("\n").length : 0;
        const info = lines > 0 ? t.fg("dim", `(${lines} lines)`) : "";
        return `${t.fg("accent", "write")} ${t.fg("text", path)} ${info}`.trimEnd();
      },
    ],
    [
      "edit",
      createEditTool,
      (args, _details, t) => {
        const path = typeof args.path === "string" ? args.path : "";
        const oldText = typeof args.oldText === "string" ? args.oldText : "";
        const newText = typeof args.newText === "string" ? args.newText : "";
        const oldLines = oldText ? oldText.split("\n").length : 0;
        const newLines = newText ? newText.split("\n").length : 0;
        const delta = newLines - oldLines;
        const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "±0";
        const info =
          oldLines > 0 || newLines > 0
            ? t.fg("dim", `(${oldLines}→${newLines} lines, ${deltaStr})`)
            : "";
        return `${t.fg("accent", "edit")} ${t.fg("text", path)} ${info}`.trimEnd();
      },
    ],
  ];

  // Register all tools
  for (const [name, factory, render] of tools) {
    override(name, factory, render);
  }

  // ---------------------------------------------------------------------------
  // Enhanced Model Display Footer
  // ---------------------------------------------------------------------------
  // Format: provider:model:thinkingLevel with custom colors
  // - Provider: #17917F (teal)
  // - Model: #8B9117 (olive)
  // - Thinking: gradient #176291 (blue) → #915017 (orange)

  let modelDisplayEnabled = true;

  const enableModelDisplayFooter = (ctx: ExtensionContext | ExtensionCommandContext) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // Compute tokens from session
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;

          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              totalInput += m.usage.input;
              totalOutput += m.usage.output;
              totalCacheRead += m.usage.cacheRead;
              totalCacheWrite += m.usage.cacheWrite;
              totalCost += m.usage.cost.total;
            }
          }

          // Get last assistant message for context calculation
          const assistantMessages: AssistantMessage[] = [];
          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              assistantMessages.push(e.message as AssistantMessage);
            }
          }
          const lastAssistant = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;

          const contextTokens = lastAssistant
            ? lastAssistant.usage.input + lastAssistant.usage.output +
              lastAssistant.usage.cacheRead + lastAssistant.usage.cacheWrite
            : 0;
          const contextWindow = ctx.model?.contextWindow || 0;
          const contextPercentValue = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
          const contextPercent = contextPercentValue.toFixed(1);

          // Format working directory with git branch
          let pwd = process.cwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }

          const branch = footerData.getGitBranch();
          if (branch) {
            pwd = `${pwd} (${branch})`;
          }

          // Add session name if set
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) {
            pwd = `${pwd} • ${sessionName}`;
          }

          // Truncate path if too long
          if (pwd.length > width) {
            const half = Math.floor(width / 2) - 2;
            if (half > 0) {
              const start = pwd.slice(0, half);
              const end = pwd.slice(-(half - 1));
              pwd = `${start}...${end}`;
            } else {
              pwd = pwd.slice(0, Math.max(1, width));
            }
          }

          // Format token counts
          const fmt = (n: number) => {
            if (n < 1000) return n.toString();
            if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
            if (n < 1000000) return `${Math.round(n / 1000)}k`;
            if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
            return `${Math.round(n / 1000000)}M`;
          };

          // Build stats line
          const statsParts: string[] = [];
          if (totalInput) statsParts.push(`↑${fmt(totalInput)}`);
          if (totalOutput) statsParts.push(`↓${fmt(totalOutput)}`);
          if (totalCacheRead) statsParts.push(`R${fmt(totalCacheRead)}`);
          if (totalCacheWrite) statsParts.push(`W${fmt(totalCacheWrite)}`);

          // Cost with subscription indicator
          const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          if (totalCost || usingSubscription) {
            const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
            statsParts.push(costStr);
          }

          // Context percentage with color coding
          let contextPercentStr: string;
          const contextPercentDisplay = `${contextPercent}%/${fmt(contextWindow)}`;
          if (contextPercentValue > 90) {
            contextPercentStr = theme.fg("error", contextPercentDisplay);
          } else if (contextPercentValue > 70) {
            contextPercentStr = theme.fg("warning", contextPercentDisplay);
          } else {
            contextPercentStr = contextPercentDisplay;
          }
          statsParts.push(contextPercentStr);

          const statsLeft = statsParts.join(" ");

          // Build model display: provider:model:thinkingLevel
          const model = ctx.model;
          const provider = model?.provider;
          const modelId = model?.id;
          const thinkingLevel = pi.getThinkingLevel() as ThinkingLevel;
          const hasReasoning = model?.reasoning ?? false;

          const rightSide = formatModelDisplay(provider, modelId, thinkingLevel, hasReasoning);

          // Calculate padding
          const statsLeftWidth = visibleWidth(statsLeft);
          const rightSideWidth = visibleWidth(rightSide);
          const minPadding = 2;
          const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

          let statsLine: string;
          if (totalNeeded <= width) {
            const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = statsLeft + padding + rightSide;
          } else {
            const availableForRight = width - statsLeftWidth - minPadding;
            if (availableForRight > 3) {
              const truncatedRight = truncateToWidth(rightSide, availableForRight);
              const truncatedWidth = visibleWidth(truncatedRight);
              const padding = " ".repeat(width - statsLeftWidth - truncatedWidth);
              statsLine = statsLeft + padding + truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          // Apply dim styling
          const dimStatsLeft = theme.fg("dim", statsLeft);
          const remainder = statsLine.slice(statsLeft.length);
          const dimRemainder = theme.fg("dim", remainder.replace(rightSide, "")) + rightSide;

          const lines = [theme.fg("dim", pwd), dimStatsLeft + dimRemainder];

          // Add extension statuses
          const extensionStatuses = footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
            const statusLine = sortedStatuses.join(" ");
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          }

          return lines;
        },
      };
    });
  };

  // Auto-enable on session start
  pi.on("session_start", async (_e, ctx) => {
    if (modelDisplayEnabled) {
      enableModelDisplayFooter(ctx);
    }
  });

  // Command to toggle model display
  pi.registerCommand("mu-model", {
    description: "mu: toggle enhanced model display in footer",
    handler: async (_args, ctx) => {
      modelDisplayEnabled = !modelDisplayEnabled;

      if (modelDisplayEnabled) {
        enableModelDisplayFooter(ctx);
        ctx.ui.notify("Enhanced model display enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Default footer restored", "info");
      }
    },
  });
}
