import { createHash } from "node:crypto";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  type AgentEndEvent,
  type AgentStartEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionStartEvent,
  type Theme,
  type ThemeColor,
  type ToolCallEvent,
  type ToolResultEvent,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  getMarkdownTheme,
  highlightCode,
} from "@mariozechner/pi-coding-agent";
import {
  type Component,
  type KeyId,
  Markdown,
  type TUI,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { DimmedOverlay } from "shared-tui";

// =============================================================================
// THEME INTEGRATION
// =============================================================================
// Access pi's Theme singleton via globalThis Symbol (not directly exported).
// All mu colors map to ThemeColor semantic names for theme-awareness.

const PI_THEME_KEY = Symbol.for("@mariozechner/pi-coding-agent:theme");

const getTheme = (): Theme => {
  const t = (globalThis as Record<symbol, Theme | undefined>)[PI_THEME_KEY];
  if (!t) throw new Error("Theme not initialized — mu requires pi theme.");
  return t;
};

// Mu semantic color → ThemeColor mapping
type MuColor =
  | "accent" // brand, running state (was orange)
  | "success" // success status (was green)
  | "error" // error status (was red)
  | "warning" // highlights, numbers (was amber/yellow)
  | "dim" // muted text, operators
  | "muted" // canceled, secondary (was gray)
  | "text" // normal text (was white)
  | "info" // info, key names, dividers (was teal)
  | "keyword" // keywords (was violet)
  | "variable"; // flags, variables (was cyan)

const MU_THEME_MAP: Record<MuColor, ThemeColor> = {
  accent: "accent",
  success: "success",
  error: "error",
  warning: "warning",
  dim: "dim",
  muted: "muted",
  text: "text",
  info: "syntaxType",
  keyword: "syntaxKeyword",
  variable: "syntaxVariable",
};

/** Apply mu semantic color via pi theme. */
const mu = (c: MuColor, text: string): string => getTheme().fg(MU_THEME_MAP[c], text);

/** Pulse animation: scale theme color brightness for running indicators. */
const rgbCache = new Map<ThemeColor, { r: number; g: number; b: number }>();

/** Parse RGB values from theme ANSI escape. Cached, auto-clears on theme switch. */
const parseThemeRgb = (tc: ThemeColor): { r: number; g: number; b: number } => {
  const cached = rgbCache.get(tc);
  if (cached) return cached;
  const ansi = getTheme().getFgAnsi(tc);
  const m = ansi.match(/38;2;(\d+);(\d+);(\d+)/);
  const result = m
    ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
    : { r: 200, g: 200, b: 200 }; // fallback
  rgbCache.set(tc, result);
  return result;
};

/** Call when theme changes to refresh cached RGB values.
 *  Not connected yet — onThemeChange() is not exported from pi. */
const _clearThemeCache = (): void => {
  rgbCache.clear();
};

const muPulse = (c: MuColor, text: string, brightness: number): string => {
  const { r, g, b } = parseThemeRgb(MU_THEME_MAP[c]);
  const f = Math.max(0.3, Math.min(1, brightness));
  return `\x1b[38;2;${Math.round(r * f)};${Math.round(g * f)};${Math.round(b * f)}m${text}\x1b[0m`;
};

// =============================================================================
// STATUS CONFIGURATION
// =============================================================================
type ToolStatus = "pending" | "running" | "success" | "failed" | "canceled";

const STATUS: Record<ToolStatus, { sym: string; color: MuColor }> = {
  pending: { sym: "◌", color: "dim" },
  running: { sym: "●", color: "accent" },
  success: { sym: "", color: "success" },
  failed: { sym: "", color: "error" },
  canceled: { sym: "", color: "muted" },
};

const TOOL_ICONS: Record<string, string> = {
  bash: "󰆍",
  read: "󰈙",
  write: "󰷈",
  edit: "󰏫",
  grep: "󰍉",
  find: "󰍉",
  ls: "󰉋",
};

// =============================================================================
// MU CONFIG
// =============================================================================
const MU_CONFIG = {
  MAX_TOOL_RESULTS: 200,
  MAX_COMPLETED_DURATIONS: 500,
  PREVIEW_LENGTH: 140,
  VIEWER_OPTION_MAX_LENGTH: 200,
  SIGNATURE_HASH_LENGTH: 16,
  PULSE_INTERVAL_MS: 50,
  PULSE_SPEED: 0.2,
  PULSE_MIN_BRIGHTNESS: 0.4,
  MAX_ERROR_LINES: 10,
  MAX_BASH_LINES: 10,
} as const;

const MU_TOOL_VIEWER_SHORTCUT = "ctrl+alt+o";

// =============================================================================
// UTILITIES
// =============================================================================
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Safety clamp: ensure every line in array fits within maxWidth. */
const clampLines = (lines: string[], maxWidth: number): string[] =>
  lines.map((l) => (visibleWidth(l) > maxWidth ? truncateToWidth(l, maxWidth) : l));

/** Extract text content from a tool result object. */
const extractResultText = (result: unknown): string => {
  if (!isRecord(result)) return "";
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((c: unknown) => isRecord(c) && c.type === "text")
    .map((c: unknown) => (isRecord(c) && typeof c.text === "string" ? c.text : ""))
    .join("\n");
};

const preview = (text: string, max = 140): string => {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
};

const formatReadLoc = (offset?: number, limit?: number): string => {
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  const end = limit === undefined ? "end" : start + Math.max(0, Number(limit) - 1);
  return `@L${start}-${end}`;
};

const computeSignature = (name: string, args: Record<string, unknown>): string => {
  const hash = createHash("sha256");
  hash.update(name);
  hash.update(JSON.stringify(args));
  return hash.digest("hex").slice(0, MU_CONFIG.SIGNATURE_HASH_LENGTH);
};

// =============================================================================
// TOOL STATE TRACKING
// =============================================================================
interface ToolState {
  toolCallId: string;
  sig: string;
  toolName: string;
  args: Record<string, unknown>;
  startTime: number;
  status: ToolStatus;
  exitCode?: number;
  duration?: number;
}

const activeToolsById = new Map<string, ToolState>();
const toolStatesBySig = new Map<string, ToolState[]>();
const cardInstanceCountBySig = new Map<string, number>();

const getToolStateByIndex = (sig: string, index: number): ToolState | undefined => {
  const states = toolStatesBySig.get(sig);
  return states?.[index];
};

const getToolState = (sig: string): ToolState | undefined => {
  const states = toolStatesBySig.get(sig);
  return states?.[states.length - 1];
};

// Track if next tool card should have leading space (after user message)
let nextToolNeedsLeadingSpace = false;
const _toolLeadingSpaceByToolCallId = new Map<string, boolean>();

// =============================================================================
// WORKING TIMER
// =============================================================================
const MIN_ELAPSED_FOR_NOTIFICATION_MS = 1000;

/**
 * Formats elapsed milliseconds as human-readable duration.
 * Returns empty string for durations < 1 second (intentional — avoids
 * flickering UI updates during the first second of operation).
 */
const formatWorkingElapsed = (ms: number): string => {
  const s = ms / 1000;
  if (s < 1) return "";
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`;
};

class WorkingTimer {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startMs = 0;
  private ctx: ExtensionContext | null = null;

  /** Stop the timer, clear UI message, return elapsed ms. */
  stop(): number {
    const elapsed = this.startMs > 0 ? Date.now() - this.startMs : 0;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.startMs = 0;
    if (this.ctx?.hasUI) {
      this.ctx.ui.setWorkingMessage();
    }
    this.ctx = null;
    return elapsed;
  }

  /** Start (or restart) the timer, updating the working message every 100ms. */
  start(ctx: ExtensionContext): void {
    this.stop();
    this.startMs = Date.now();
    this.ctx = ctx;
    this.interval = setInterval(() => {
      if (!this.ctx?.hasUI) return;
      const ms = Date.now() - this.startMs;
      const elapsed = formatWorkingElapsed(ms);
      if (elapsed) {
        this.ctx.ui.setWorkingMessage(`Working... ⏱ ${elapsed}`);
      }
    }, 100);
  }
}

const workingTimer = new WorkingTimer();

// =============================================================================
// MU THEME INTERFACE
// =============================================================================
interface MuTheme {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
}

// biome-ignore lint/suspicious/noExplicitAny: Tool types require any
type Tool<T = any> = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    id: string,
    params: T,
    signal?: AbortSignal,
    onUpdate?: (e: ToolResultEvent) => void
  ) => Promise<ToolResultEvent>;
  renderCall?: (args: T, theme: MuTheme) => Component;
  renderResult?: (result: unknown, options: unknown, theme: MuTheme) => Component;
};

type ToolParams = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: Factory return type varies
type ToolFactory = (cwd: string) => any;

// =============================================================================
// MODEL DISPLAY COLORS
// =============================================================================
const MODEL_COLORS = {
  provider: { r: 23, g: 145, b: 127 },
  model: { r: 133, g: 176, b: 106 },
  thinking: {
    off: null,
    minimal: { r: 161, g: 126, b: 87 },
    low: { r: 181, g: 114, b: 79 },
    medium: { r: 202, g: 101, b: 72 },
    high: { r: 222, g: 89, b: 64 },
    xhigh: { r: 242, g: 76, b: 56 },
  },
} as const;

type ThinkingLevel = keyof typeof MODEL_COLORS.thinking;

const rgbRaw = (r: number, g: number, b: number, text: string): string =>
  `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;

// Progress bar with green→yellow→red gradient based on percentage
const progressBar = (percent: number, width = 5): string => {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;

  // Gradient color: green (0%) → yellow (50%) → red (100%)
  const getColor = (p: number): { r: number; g: number; b: number } => {
    if (p <= 50) {
      // Green to Yellow (0-50%)
      const t = p / 50;
      return {
        r: Math.round(38 + (254 - 38) * t), // green.r → yellow.r
        g: Math.round(222 + (211 - 222) * t), // green.g → yellow.g
        b: Math.round(129 + (48 - 129) * t), // green.b → yellow.b
      };
    }
    // Yellow to Red (50-100%)
    const t = (p - 50) / 50;
    return {
      r: Math.round(254 + (238 - 254) * t), // yellow.r → red.r
      g: Math.round(211 + (90 - 211) * t), // yellow.g → red.g
      b: Math.round(48 + (82 - 48) * t), // yellow.b → red.b
    };
  };

  const color = getColor(percent);
  const filledStr = "█".repeat(filled);
  const emptyStr = "░".repeat(empty);

  return rgbRaw(color.r, color.g, color.b, filledStr) + mu("dim", emptyStr);
};

const formatModelDisplay = (
  provider: string | undefined,
  modelId: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  hasReasoning: boolean
): string => {
  const parts: string[] = [];
  if (provider) {
    const { r, g, b } = MODEL_COLORS.provider;
    parts.push(rgbRaw(r, g, b, provider));
  }
  if (modelId) {
    const { r, g, b } = MODEL_COLORS.model;
    parts.push(rgbRaw(r, g, b, modelId));
  } else {
    parts.push("no-model");
  }
  if (hasReasoning && thinkingLevel && thinkingLevel !== "off") {
    const c = MODEL_COLORS.thinking[thinkingLevel];
    if (c) parts.push(rgbRaw(c.r, c.g, c.b, thinkingLevel));
  }
  return parts.join(":");
};

// =============================================================================
// BOXED TOOL CARD COMPONENT
// =============================================================================
class BoxedToolCard implements Component {
  private textGenerator: () => string;
  private toolName: string;
  private args: Record<string, unknown>;
  private theme: MuTheme;
  private sig: string;
  private instanceIndex: number;
  private pulsePhase = 0;
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private _invalidate?: () => void;
  private lastWidth = 0;
  private cachedLines: string[] = [];
  private needsLeadingSpace: boolean;

  constructor(
    textGenerator: () => string,
    toolName: string,
    args: Record<string, unknown>,
    theme: MuTheme
  ) {
    this.textGenerator = textGenerator;
    this.toolName = toolName;
    this.args = args;
    this.theme = theme;
    this.sig = computeSignature(toolName, args);
    this.instanceIndex = cardInstanceCountBySig.get(this.sig) ?? 0;
    cardInstanceCountBySig.set(this.sig, this.instanceIndex + 1);
    this.needsLeadingSpace = nextToolNeedsLeadingSpace;
    nextToolNeedsLeadingSpace = false;
  }

  private getStatus(): ToolStatus {
    const state = getToolStateByIndex(this.sig, this.instanceIndex);
    return state?.status ?? "pending";
  }

  private getElapsed(): number {
    const state = getToolStateByIndex(this.sig, this.instanceIndex);
    if (!state) return 0;
    if (state.duration !== undefined) return state.duration;
    return Date.now() - state.startTime;
  }

  private formatElapsed(): string {
    const ms = this.getElapsed();
    if (ms < 1000) return "";
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`;
  }

  private startPulse(): void {
    if (this.pulseTimer) return;
    this.pulseTimer = setInterval(() => {
      this.pulsePhase += MU_CONFIG.PULSE_SPEED;
      this._invalidate?.();
    }, MU_CONFIG.PULSE_INTERVAL_MS);
  }

  private stopPulse(): void {
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }

  render(width: number): string[] {
    const status = this.getStatus();
    const { sym, color } = STATUS[status];
    const elapsed = this.formatElapsed();

    if (status === "running") {
      this.startPulse();
    } else {
      this.stopPulse();
    }

    const icon = TOOL_ICONS[this.toolName] ?? "⚙";
    const content = this.textGenerator();
    const innerW = width - 2;

    let statusStr: string;
    if (status === "running") {
      const brightness =
        MU_CONFIG.PULSE_MIN_BRIGHTNESS +
        (1 - MU_CONFIG.PULSE_MIN_BRIGHTNESS) * (0.5 + 0.5 * Math.sin(this.pulsePhase));
      statusStr = muPulse(color, sym, brightness);
    } else {
      statusStr = mu(color, sym);
    }

    const timerStr = elapsed ? mu("dim", ` ${elapsed}`) : "";
    const rightPart = `${statusStr}${timerStr}`;
    const rightLen = visibleWidth(rightPart);

    // For bash: render multiline, cap height
    if (this.toolName === "bash") {
      const rawCmd = typeof this.args.command === "string" ? this.args.command : "";
      let lines = clampLines(
        this.renderBashMultiline(rawCmd, icon, color, rightPart, rightLen, innerW),
        width
      );
      if (lines.length > MU_CONFIG.MAX_BASH_LINES) {
        const total = lines.length;
        lines = lines.slice(0, MU_CONFIG.MAX_BASH_LINES);
        lines.push(mu("dim", `  … ${total - MU_CONFIG.MAX_BASH_LINES} more lines`));
      }
      this.lastWidth = width;
      this.cachedLines = this.needsLeadingSpace ? ["", ...lines] : lines;
      return this.cachedLines;
    }

    // Non-bash tools: multiline rendering with full args, no truncation
    const iconColored = mu(color, icon);
    const toolLabel = this.toolName;
    const prefix = `${iconColored} ${mu(color, toolLabel)} `;
    const prefixLen = visibleWidth(prefix);
    const indent = " ".repeat(prefixLen);

    const firstLineWidth = innerW - prefixLen - rightLen - 1;
    const contLineWidth = innerW - prefixLen;

    if (firstLineWidth <= 0 || contLineWidth <= 0) {
      const fallback = `${prefix}${mu("dim", truncateToWidth(content, Math.max(1, innerW - prefixLen - rightLen - 1)))}`;
      const fallbackLen = visibleWidth(fallback);
      const pad = " ".repeat(Math.max(0, innerW - fallbackLen - rightLen));
      const line = `${fallback}${pad}${rightPart}`;
      this.lastWidth = width;
      this.cachedLines = this.needsLeadingSpace ? ["", line] : [line];
      return this.cachedLines;
    }

    const segments = content.split("\n");
    const allWrapped: string[] = [];

    for (const seg of segments) {
      if (allWrapped.length === 0) {
        const wrapped = wrapTextWithAnsi(seg, firstLineWidth);
        if (wrapped.length === 0) {
          allWrapped.push("");
        } else {
          allWrapped.push(wrapped[0]);
          if (wrapped.length > 1) {
            const rewrapped = wrapTextWithAnsi(wrapped.slice(1).join(" "), contLineWidth);
            allWrapped.push(...rewrapped);
          }
        }
      } else {
        const wrapped = wrapTextWithAnsi(seg, contLineWidth);
        allWrapped.push(...(wrapped.length > 0 ? wrapped : [""]));
      }
    }

    const resultLines: string[] = [];
    for (let i = 0; i < allWrapped.length; i++) {
      const wl = allWrapped[i];
      if (i === 0) {
        const lineContent = `${prefix}${mu("dim", wl)}`;
        const lineLen = visibleWidth(lineContent);
        const pad = " ".repeat(Math.max(0, innerW - lineLen - rightLen));
        resultLines.push(`${lineContent}${pad}${rightPart}`);
      } else {
        resultLines.push(`${indent}${mu("dim", wl)}`);
      }
    }

    if (resultLines.length === 0) {
      resultLines.push(
        `${prefix}${" ".repeat(Math.max(0, innerW - prefixLen - rightLen))}${rightPart}`
      );
    }

    this.lastWidth = width;
    const clamped = clampLines(resultLines, width);
    this.cachedLines = this.needsLeadingSpace ? ["", ...clamped] : clamped;
    return this.cachedLines;
  }

  private renderBashMultiline(
    rawCmd: string,
    icon: string,
    color: MuColor,
    rightPart: string,
    rightLen: number,
    innerW: number
  ): string[] {
    const iconColored = mu(color, icon);

    // Line 1: header with $ prompt — no command text on this line
    const header = `${iconColored} ${mu(color, "bash")} ${mu("dim", "$")}`;
    const headerLen = visibleWidth(header);
    const headerPad = " ".repeat(Math.max(0, innerW - headerLen - rightLen));
    const resultLines: string[] = [`${header}${headerPad}${rightPart}`];

    // Line 2+: 2-space indent for new statements, 4-space for chain continuations & wraps
    const stmtIndent = "  ";
    const contIndent = "    ";
    const stmtWidth = innerW - 2;
    const contWidth = innerW - 4;

    if (stmtWidth <= 0) {
      resultLines.push(`${stmtIndent}${mu("text", rawCmd)}`);
      return resultLines;
    }

    const cmdLines = rawCmd.split("\n");
    let prevChained = false;
    let inSQ = false;
    let inDQ = false;

    for (const cmdLine of cmdLines) {
      const highlighted = highlightBashLine(cmdLine, inSQ, inDQ);
      const inQuote = inSQ || inDQ;
      // Continuation if: inside a quoted string, or previous line ended with chain operator
      const isCont = inQuote || prevChained;
      const indent = isCont ? contIndent : stmtIndent;
      const lineWidth = isCont ? contWidth : stmtWidth;

      const wrapped = wrapTextWithAnsi(highlighted, lineWidth);
      if (wrapped.length === 0) {
        resultLines.push(indent);
      } else {
        resultLines.push(`${indent}${wrapped[0]}`);
        if (wrapped.length > 1) {
          // Wrap continuations always at 4-space indent
          const rewrapped = wrapTextWithAnsi(wrapped.slice(1).join(" "), contWidth);
          for (const rw of rewrapped) {
            resultLines.push(`${contIndent}${rw}`);
          }
        }
      }

      [inSQ, inDQ] = bashUpdateQuoteState(cmdLine, inSQ, inDQ);
      // Only check chain operators when not inside a quote
      prevChained = !(inSQ || inDQ) && bashLineIsChained(cmdLine);
    }

    return resultLines;
  }

  invalidate(): void {
    this._invalidate?.();
  }

  setInvalidate(fn: () => void): void {
    this._invalidate = fn;
  }

  dispose(): void {
    this.stopPulse();
  }
}

// =============================================================================
// TOOL RESULT DETAIL VIEWER
// =============================================================================
interface ToolResultOption {
  key: string;
  toolName: string;
  sig: string;
  label: string;
  args: Record<string, unknown>;
  result: unknown;
  startTime: number;
  duration?: number;
  isError: boolean;
}

const toolResultOptions: ToolResultOption[] = [];

const GRAPHEME_SEGMENTER =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

const _splitGraphemes = (value: string): string[] => {
  if (!value) return [];
  if (GRAPHEME_SEGMENTER) {
    return Array.from(GRAPHEME_SEGMENTER.segment(value), (s) => s.segment);
  }
  return Array.from(value);
};

/** Card body background — dark surface matching ask extension's card. */
const OVERLAY_CARD_BG = "\x1b[48;2;22;22;32m";
const OVERLAY_RESET = "\x1b[0m";

/** Apply card background to a line, persisting through any ANSI resets. */
const applyCardBg = (text: string, width: number): string => {
  const vis = visibleWidth(text);
  const padded = vis < width ? text + " ".repeat(width - vis) : text;
  return (
    OVERLAY_CARD_BG + padded.replaceAll("\x1b[0m", `\x1b[0m${OVERLAY_CARD_BG}`) + OVERLAY_RESET
  );
};

class ToolResultDetailViewer implements Component {
  private option: ToolResultOption;
  private scrollOffset = 0;
  private allLines: string[] = [];
  private tui: TUI;
  private lastWidth = 0;

  constructor(option: ToolResultOption, tui: TUI) {
    this.option = option;
    this.tui = tui;
  }

  /** Available viewport height (lines for scrollable content). */
  private viewportHeight(): number {
    // Reserve: scroll-up indicator (1) + scroll-down indicator (1) + help line (1) + blank (1) = 4
    return Math.max(5, Math.floor(this.tui.terminal.rows * 0.85) - 4);
  }

  private buildLines(width: number): void {
    const { toolName, args, result, duration, isError } = this.option;
    const out: string[] = [];

    const header = `${mu("warning", "─")} ${mu("warning", toolName)} ${mu("dim", "─".repeat(Math.max(0, width - toolName.length - 4)))}`;
    out.push(header);

    for (const [k, v] of Object.entries(args)) {
      const val = typeof v === "string" ? preview(v, 80) : JSON.stringify(v);
      out.push(truncateToWidth(`  ${mu("info", k)}: ${mu("text", val)}`, width));
    }

    if (duration !== undefined) {
      out.push(`  ${mu("dim", `duration: ${(duration / 1000).toFixed(2)}s`)}`);
    }

    out.push("");

    const content = Array.isArray((result as { content?: unknown[] })?.content)
      ? (result as { content: unknown[] }).content
      : [];
    const text = content
      .filter((c) => isRecord(c) && c.type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join("\n");

    const resultColor: MuColor = isError ? "error" : "success";
    out.push(mu(resultColor, isError ? "─ Error ─" : "─ Result ─"));

    for (const line of text.split("\n")) {
      const wrapped = wrapTextWithAnsi(line, width - 2);
      for (const w of wrapped) {
        out.push(`  ${w}`);
      }
    }

    this.allLines = clampLines(out, width);
  }

  render(width: number): string[] {
    // Rebuild content lines when width changes
    if (width !== this.lastWidth) {
      this.buildLines(width);
      this.lastWidth = width;
    }

    const vh = this.viewportHeight();
    const maxScroll = Math.max(0, this.allLines.length - vh);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

    const visible = this.allLines.slice(this.scrollOffset, this.scrollOffset + vh);
    const out: string[] = [];

    // Scroll-up indicator
    if (this.scrollOffset > 0) {
      out.push(applyCardBg(mu("dim", `  ↑ ${this.scrollOffset} more lines`), width));
    } else {
      out.push(applyCardBg("", width));
    }

    for (const line of visible) {
      out.push(applyCardBg(line, width));
    }

    // Scroll-down indicator
    const remaining = this.allLines.length - this.scrollOffset - vh;
    if (remaining > 0) {
      out.push(applyCardBg(mu("dim", `  ↓ ${remaining} more lines`), width));
    } else {
      out.push(applyCardBg("", width));
    }

    // Help
    out.push(
      applyCardBg(mu("dim", "↑↓/jk C-n/C-p scroll  pgup/pgdn page  g/G top/end  h back"), width)
    );

    return out;
  }

  handleInput(key: KeyId): boolean {
    const vh = this.viewportHeight();
    const maxScroll = Math.max(0, this.allLines.length - vh);

    if (matchesKey(key, "down") || matchesKey(key, "j") || matchesKey(key, "ctrl+n")) {
      this.scrollOffset = Math.min(this.scrollOffset + 1, maxScroll);
      return true;
    }
    if (matchesKey(key, "up") || matchesKey(key, "k") || matchesKey(key, "ctrl+p")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      return true;
    }
    if (matchesKey(key, "pageDown") || matchesKey(key, "ctrl+d")) {
      this.scrollOffset = Math.min(this.scrollOffset + vh, maxScroll);
      return true;
    }
    if (matchesKey(key, "pageUp") || matchesKey(key, "ctrl+u")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - vh);
      return true;
    }
    if (matchesKey(key, "g")) {
      this.scrollOffset = 0;
      return true;
    }
    if (matchesKey(key, "shift+g")) {
      this.scrollOffset = maxScroll;
      return true;
    }
    return false;
  }

  invalidate(): void {}
}

// =============================================================================
// MU TOOLS OVERLAY (Unified List + Preview)
// =============================================================================
class MuToolsOverlay implements Component {
  private options: ToolResultOption[];
  private selectedIndex = 0;
  private tui: TUI;
  private onSelect: (opt: ToolResultOption) => void;
  private onClose: () => void;
  private scrollOffset = 0;

  constructor(
    options: ToolResultOption[],
    tui: TUI,
    onSelect: (opt: ToolResultOption) => void,
    onClose: () => void
  ) {
    this.options = options;
    this.tui = tui;
    this.onSelect = onSelect;
    this.onClose = onClose;
  }

  /** Max visible list items — scales with terminal height. */
  private listHeight(): number {
    // Chrome: title (1) + divider (1) + preview pane (~6) + divider (1) + help (1) = 10
    return Math.max(3, Math.floor(this.tui.terminal.rows * 0.85) - 10);
  }

  render(width: number): string[] {
    const raw: string[] = [];
    const innerW = width - 2;

    // Title with count
    const count = this.options.length;
    const titleText = `μ Tools (${count})`;
    const titleLine = `${mu("warning", titleText)} ${mu("info", "─".repeat(Math.max(0, innerW - titleText.length - 1)))}`;
    raw.push(titleLine);

    if (count === 0) {
      raw.push(mu("dim", "No tool results yet"));
    } else {
      const visibleCount = Math.min(this.listHeight(), count);
      const maxScroll = Math.max(0, count - visibleCount);
      this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
      if (this.selectedIndex < this.scrollOffset) {
        this.scrollOffset = this.selectedIndex;
      } else if (this.selectedIndex >= this.scrollOffset + visibleCount) {
        this.scrollOffset = this.selectedIndex - visibleCount + 1;
      }

      // Scroll-up indicator
      if (this.scrollOffset > 0) {
        raw.push(mu("dim", `  ↑ ${this.scrollOffset} more`));
      }

      for (let i = 0; i < visibleCount; i++) {
        const idx = this.scrollOffset + i;
        const opt = this.options[idx];
        if (!opt) continue;

        const isSelected = idx === this.selectedIndex;
        const pointer = isSelected ? mu("accent", "▸") : " ";
        const status = opt.isError ? STATUS.failed : STATUS.success;
        const statusSym = mu(status.color, status.sym);
        const icon = TOOL_ICONS[opt.toolName] ?? "⚙";

        const dur = opt.duration !== undefined ? `${(opt.duration / 1000).toFixed(1)}s` : "";
        const durStr = mu("dim", dur.padStart(6));

        const label = truncateToWidth(opt.label, innerW - 14);
        const line = `${pointer}${statusSym} ${mu("info", icon)} ${label}${" ".repeat(Math.max(0, innerW - visibleWidth(label) - 12))}${durStr}`;
        raw.push(line);
      }

      // Scroll-down indicator
      const remaining = count - this.scrollOffset - visibleCount;
      if (remaining > 0) {
        raw.push(mu("dim", `  ↓ ${remaining} more`));
      }
    }

    raw.push(mu("info", "─".repeat(innerW)));

    // Preview pane: args + result snippet
    const selected = this.options[this.selectedIndex];
    if (selected) {
      const args = Object.entries(selected.args).slice(0, 3);
      for (const [k, v] of args) {
        const val = typeof v === "string" ? preview(v, innerW - k.length - 4) : JSON.stringify(v);
        raw.push(truncateToWidth(`${mu("dim", k)}: ${mu("text", val)}`, innerW));
      }
      if (args.length === 0) {
        raw.push(mu("dim", "(no args)"));
      }

      // Result snippet
      const resultText = extractResultText(selected.result);
      if (resultText) {
        raw.push("");
        const snippetLines = resultText
          .split("\n")
          .filter((l: string) => l.trim())
          .slice(0, 3);
        for (const sl of snippetLines) {
          raw.push(truncateToWidth(`  ${mu("dim", sl)}`, innerW));
        }
        const totalLines = resultText.split("\n").length;
        if (totalLines > 3) {
          raw.push(mu("dim", `  … ${totalLines - 3} more lines`));
        }
      }
    } else {
      raw.push("");
    }

    raw.push(mu("info", "─".repeat(innerW)));
    raw.push(mu("dim", "↑↓/jk/C-n/C-p nav  l view  pgup/pgdn page  g/G top/end  h/esc close"));

    return raw.map((line) => applyCardBg(line, width));
  }

  handleInput(key: KeyId): boolean {
    if (matchesKey(key, "escape") || matchesKey(key, "q") || matchesKey(key, "h")) {
      this.onClose();
      return true;
    }
    if (matchesKey(key, "down") || matchesKey(key, "j") || matchesKey(key, "ctrl+n")) {
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.options.length - 1);
      return true;
    }
    if (matchesKey(key, "up") || matchesKey(key, "k") || matchesKey(key, "ctrl+p")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return true;
    }
    if (matchesKey(key, "pageDown") || matchesKey(key, "ctrl+d")) {
      const page = this.listHeight();
      this.selectedIndex = Math.min(this.selectedIndex + page, this.options.length - 1);
      return true;
    }
    if (matchesKey(key, "pageUp") || matchesKey(key, "ctrl+u")) {
      const page = this.listHeight();
      this.selectedIndex = Math.max(0, this.selectedIndex - page);
      return true;
    }
    if (matchesKey(key, "g")) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      return true;
    }
    if (matchesKey(key, "shift+g")) {
      this.selectedIndex = this.options.length - 1;
      return true;
    }
    if (matchesKey(key, "enter") || matchesKey(key, "l")) {
      const opt = this.options[this.selectedIndex];
      if (opt) this.onSelect(opt);
      return true;
    }
    return false;
  }

  invalidate(): void {}
}

// =============================================================================
// OPEN MU TOOLS OVERLAY
// =============================================================================
async function openMuToolsOverlay(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) return;

  const options = [...toolResultOptions].reverse();

  await DimmedOverlay.show<void>(
    ctx.ui,
    (tui, _theme, done) => {
      let listView: MuToolsOverlay | null = null;
      let detailViewer: ToolResultDetailViewer | null = null;

      const closeOverlay = () => done();

      const openDetail = (opt: ToolResultOption) => {
        detailViewer = new ToolResultDetailViewer(opt, tui);
      };

      listView = new MuToolsOverlay(options, tui, openDetail, closeOverlay);

      return {
        render(width: number): string[] {
          if (detailViewer) return detailViewer.render(width);
          return listView?.render(width) ?? [];
        },
        handleInput(key: KeyId): boolean {
          if (detailViewer) {
            if (matchesKey(key, "escape") || matchesKey(key, "q") || matchesKey(key, "h")) {
              detailViewer = null;
              return true;
            }
            return detailViewer.handleInput(key);
          }
          return listView?.handleInput(key) ?? false;
        },
        invalidate(): void {},
        dispose(): void {},
      };
    },
    {
      scrim: { stars: true },
      dialog: { width: "75%", maxHeight: "90%", glow: { enabled: true } },
    }
  );
}

// =============================================================================
// UI MONKEY-PATCHING
// =============================================================================
const setupUIPatching = (ctx: ExtensionContext) => {
  if (!ctx.hasUI) return;

  ctx.ui.custom((tui, _theme, _kb, done) => {
    const isAssistant = (c: unknown): boolean => {
      const x = c as {
        constructor?: { name?: string };
        updateContent?: unknown;
        setHideThinkingBlock?: unknown;
      };
      return (
        x.constructor?.name === "AssistantMessageComponent" ||
        (typeof x.updateContent === "function" && typeof x.setHideThinkingBlock === "function")
      );
    };

    const isTool = (c: unknown): boolean => {
      const x = c as {
        constructor?: { name?: string };
        updateResult?: unknown;
        updateArgs?: unknown;
      };
      return (
        x.constructor?.name === "ToolExecutionComponent" ||
        (typeof x.updateResult === "function" && typeof x.updateArgs === "function")
      );
    };

    const isUser = (c: unknown): boolean => {
      const x = c as { constructor?: { name?: string } };
      return x.constructor?.name === "UserMessageComponent";
    };

    // Remove all backgrounds from a component and its children recursively
    // biome-ignore lint/suspicious/noExplicitAny: Patching Pi internals
    const stripBackgrounds = (comp: any) => {
      if (!comp) return;

      // Remove background functions
      if (typeof comp.setBgFn === "function") comp.setBgFn((s: string) => s);
      if (typeof comp.setCustomBgFn === "function") comp.setCustomBgFn((s: string) => s);
      if (comp.bgColor) comp.bgColor = (s: string) => s;
      if (comp.options?.bgColor) comp.options.bgColor = (s: string) => s;

      // Remove padding
      if (typeof comp.paddingX === "number") comp.paddingX = 0;
      if (typeof comp.paddingY === "number") comp.paddingY = 0;

      // Recursively process children
      if (Array.isArray(comp.children)) {
        for (const child of comp.children) {
          stripBackgrounds(child);
        }
      }
    };

    // biome-ignore lint/suspicious/noExplicitAny: Patching Pi internals
    const patchUser = (comp: any) => {
      if (comp._mu_patched) return;
      comp._mu_patched = true;

      // Strip all backgrounds recursively
      stripBackgrounds(comp);

      // Patch the Markdown children to remove styling
      for (const child of comp.children ?? []) {
        if (child.constructor?.name === "Markdown") {
          if (child.options) {
            child.options.bgColor = (s: string) => s;
            child.options.color = (s: string) => s;
          }
          child.paddingX = 0;
          child.paddingY = 0;
        }
      }

      // Find the Markdown child and extract its text for proper rendering
      let markdownText = "";
      for (const child of comp.children ?? []) {
        if (child.constructor?.name === "Markdown" && child.text) {
          markdownText = child.text;
          break;
        }
      }

      // Override render to use Markdown component with teal default text color
      comp.render = (w: number): string[] => {
        if (!markdownText) return [];

        const mdTheme = getMarkdownTheme();
        const defaultTextStyle = { color: (s: string) => mu("info", s) };
        const md = new Markdown(markdownText, 0, 0, mdTheme, defaultTextStyle);
        const lines = md.render(w);

        // Add blank line before user message for separation
        return ["", ...lines];
      };
    };

    // biome-ignore lint/suspicious/noExplicitAny: Patching Pi internals
    const patchAssistant = (comp: any) => {
      if (comp._mu_patched) return;
      comp._mu_patched = true;

      stripBackgrounds(comp);

      const container = comp.children?.[0];
      if (!container) return;

      // biome-ignore lint/suspicious/noExplicitAny: Patching Pi internals
      const isThinkingBlock = (block: any): boolean => {
        return (
          block.defaultTextStyle?.italic === true ||
          block.options?.italic === true ||
          block.italic === true
        );
      };

      // Block styles
      const THINKING_STYLE = {
        icon: "󰛨",
        color: "keyword" as MuColor,
      };

      // biome-ignore lint/suspicious/noExplicitAny: Patching Pi internals
      const wrapBlock = (block: any) => {
        if (block._mu_wrapped) return;
        block._mu_wrapped = true;

        stripBackgrounds(block);

        const orig = block.render?.bind(block);
        if (!orig) return;

        const isThinking = isThinkingBlock(block);

        if (isThinking) {
          // Thinking blocks: icon prefix on first line
          block.render = (w: number): string[] => {
            const lines: string[] = orig(w - 2);
            const iconStyled = mu(THINKING_STYLE.color, THINKING_STYLE.icon);

            return lines.map((line: string, i: number) => {
              if (i === 0) {
                return `${iconStyled} ${line}`;
              }
              return `  ${line}`;
            });
          };
        } else {
          // Final answer blocks: no border, just content
          block.render = (w: number): string[] => {
            const lines: string[] = orig(w);
            return lines;
          };
        }
      };

      for (const child of container.children ?? []) {
        const name = child.constructor?.name;
        if (name === "Markdown" || name === "Text") {
          wrapBlock(child);
        }
      }

      const origAdd = container.addChild?.bind(container);
      if (origAdd) {
        // biome-ignore lint/suspicious/noExplicitAny: Patching Pi internals
        container.addChild = (child: any) => {
          const name = child.constructor?.name;
          if (name === "Markdown" || name === "Text") {
            wrapBlock(child);
          }
          stripBackgrounds(child);
          return origAdd(child);
        };
      }
    };

    // Render bash command as multiline (for patchTool path)
    const renderBashMultilineForPatch = (
      rawCmd: string,
      icon: string,
      color: MuColor,
      rightPart: string,
      rightLen: number,
      innerW: number,
      status: ToolStatus,
      pulsePhase: number
    ): string[] => {
      let iconColored: string;
      let bashColored: string;
      if (status === "running") {
        const brightness =
          MU_CONFIG.PULSE_MIN_BRIGHTNESS +
          (1 - MU_CONFIG.PULSE_MIN_BRIGHTNESS) * (0.5 + 0.5 * Math.sin(pulsePhase));
        iconColored = muPulse(color, icon, brightness);
        bashColored = muPulse(color, "bash", brightness);
      } else {
        iconColored = mu(color, icon);
        bashColored = mu(color, "bash");
      }

      // Line 1: header with $ prompt — no command text on this line
      const header = `${iconColored} ${bashColored} ${mu("dim", "$")}`;
      const headerLen = visibleWidth(header);
      const headerPad = " ".repeat(Math.max(0, innerW - headerLen - rightLen));
      const resultLines: string[] = [`${header}${headerPad}${rightPart}`];

      // Line 2+: 2-space indent for new statements, 4-space for chain continuations & wraps
      const stmtIndent = "  ";
      const contIndent = "    ";
      const stmtWidth = innerW - 2;
      const contWidth = innerW - 4;

      if (stmtWidth <= 0) {
        resultLines.push(`${stmtIndent}${mu("text", rawCmd)}`);
        return resultLines;
      }

      const srcLines = rawCmd.split("\n");
      let prevChained = false;
      let inSQ = false;
      let inDQ = false;

      for (const srcLine of srcLines) {
        const highlighted = highlightBashLine(srcLine, inSQ, inDQ);
        const inQuote = inSQ || inDQ;
        // Continuation if: inside a quoted string, or previous line ended with chain operator
        const isCont = inQuote || prevChained;
        const indent = isCont ? contIndent : stmtIndent;
        const lineWidth = isCont ? contWidth : stmtWidth;

        const wrapped = wrapTextWithAnsi(highlighted, lineWidth);
        if (wrapped.length === 0) {
          resultLines.push(indent);
        } else {
          resultLines.push(`${indent}${wrapped[0]}`);
          if (wrapped.length > 1) {
            // Wrap continuations always at 4-space indent
            const rewrapped = wrapTextWithAnsi(wrapped.slice(1).join(" "), contWidth);
            for (const rw of rewrapped) {
              resultLines.push(`${contIndent}${rw}`);
            }
          }
        }

        [inSQ, inDQ] = bashUpdateQuoteState(srcLine, inSQ, inDQ);
        // Only check chain operators when not inside a quote
        prevChained = !(inSQ || inDQ) && bashLineIsChained(srcLine);
      }

      return resultLines;
    };

    // biome-ignore lint/suspicious/noExplicitAny: Patching Pi internals
    const patchTool = (tool: any, addLeadingSpace = false) => {
      if (tool._mu_patched) return;
      tool._mu_patched = true;
      tool._mu_leading_space = addLeadingSpace;

      stripBackgrounds(tool);

      // Pulse state for this tool
      let pulsePhase = 0;
      let pulseTimer: ReturnType<typeof setInterval> | null = null;

      const startPulse = () => {
        if (pulseTimer) return;
        pulseTimer = setInterval(() => {
          pulsePhase += MU_CONFIG.PULSE_SPEED;
          tool.invalidate?.();
        }, MU_CONFIG.PULSE_INTERVAL_MS);
      };

      const stopPulse = () => {
        if (pulseTimer) {
          clearInterval(pulseTimer);
          pulseTimer = null;
        }
      };

      const origUpdate = tool.updateDisplay?.bind(tool);
      if (origUpdate) {
        tool.updateDisplay = () => {
          origUpdate();
          stripBackgrounds(tool);
          if (tool.contentBox) {
            tool.contentBox.paddingX = 0;
            tool.contentBox.paddingY = 0;
          }
        };
        tool.updateDisplay();
      }

      const origRender = tool.render?.bind(tool);
      if (!origRender) return;

      tool.render = (width: number): string[] => {
        const lines = _renderStreamingTool(tool, width);
        const res = tool.result as { isError?: boolean; content?: unknown[] } | undefined;
        if (res?.isError) {
          const errText = extractResultText(res);
          if (errText) {
            const innerW = width - 2;
            const errLines = errText.split("\n").filter((l: string) => l.length > 0);
            const capped = errLines.slice(0, MU_CONFIG.MAX_ERROR_LINES);
            for (const el of capped) {
              lines.push(truncateToWidth(`  ${mu("error", el)}`, innerW));
            }
            if (errLines.length > MU_CONFIG.MAX_ERROR_LINES) {
              lines.push(
                mu("dim", `  … ${errLines.length - MU_CONFIG.MAX_ERROR_LINES} more lines`)
              );
            }
          }
        }
        return clampLines(lines, width);
      };

      const _renderStreamingTool = (
        tool: Component & Record<string, unknown>,
        width: number
      ): string[] => {
        const toolName = tool.toolName as string;
        const args = (tool.args ?? {}) as Record<string, unknown>;
        const isPartial = tool.isPartial as boolean;
        const result = tool.result as { isError?: boolean } | undefined;

        const icon = TOOL_ICONS[toolName] ?? "⚙";
        const sig = computeSignature(toolName, args);
        const state = getToolState(sig);

        let status: ToolStatus;
        if (isPartial) {
          status = "running";
        } else if (result === undefined) {
          status = state?.status ?? "pending";
        } else if (result.isError) {
          status = "failed";
        } else {
          status = "success";
        }

        // Start/stop pulse based on status
        if (status === "running") {
          startPulse();
        } else {
          stopPulse();
        }

        const { sym, color } = STATUS[status];

        const elapsed = state ? Date.now() - state.startTime : 0;
        const dur = state?.duration ?? (status !== "running" ? 0 : elapsed);
        const timerStr = dur >= 1000 ? ` ${(dur / 1000).toFixed(1)}s` : "";

        const innerW = width - 2;

        const statusStr = mu(color, sym);
        const timerColored = mu("dim", timerStr);
        const rightPart = `${statusStr}${timerColored}`;
        const rightLen = visibleWidth(rightPart);

        // For bash: render multiline, cap height
        if (toolName === "bash") {
          const rawCmd = typeof args.command === "string" ? args.command : "";
          let lines = renderBashMultilineForPatch(
            rawCmd,
            icon,
            color,
            rightPart,
            rightLen,
            innerW,
            status,
            pulsePhase
          );
          if (lines.length > MU_CONFIG.MAX_BASH_LINES) {
            const total = lines.length;
            lines = lines.slice(0, MU_CONFIG.MAX_BASH_LINES);
            lines.push(mu("dim", `  … ${total - MU_CONFIG.MAX_BASH_LINES} more lines`));
          }
          if (tool._mu_leading_space) {
            return ["", ...lines];
          }
          return lines;
        }

        // Non-bash tools: pretty-printed with syntax highlighting
        let iconColored: string;
        let nameColored: string;
        if (status === "running") {
          const brightness =
            MU_CONFIG.PULSE_MIN_BRIGHTNESS +
            (1 - MU_CONFIG.PULSE_MIN_BRIGHTNESS) * (0.5 + 0.5 * Math.sin(pulsePhase));
          iconColored = muPulse(color, icon, brightness);
          nameColored = muPulse(color, toolName, brightness);
        } else {
          iconColored = mu(color, icon);
          nameColored = mu(color, toolName);
        }

        // Special case: ask tool — suppress args, show only user's answer
        if (toolName === "ask") {
          const headerContent = `${iconColored} ${nameColored}`;
          const headerLen = visibleWidth(headerContent);

          const resultData = tool.result as { content?: unknown[] } | undefined;
          let answerText = "";
          if (resultData?.content && Array.isArray(resultData.content)) {
            answerText = resultData.content
              .filter((c: unknown) => isRecord(c) && c.type === "text")
              .map((c: unknown) => (c as { text?: string }).text ?? "")
              .join("\n");
          }

          if (answerText) {
            const answerLines = answerText.split("\n").filter((l: string) => l.trim());
            const pad = " ".repeat(Math.max(0, innerW - headerLen - rightLen));
            const lines: string[] = [`${headerContent}${pad}${rightPart}`];
            for (const aLine of answerLines) {
              lines.push(truncateToWidth(`  ${mu("text", aLine)}`, innerW));
            }
            if (tool._mu_leading_space) return ["", ...lines];
            return lines;
          }

          // Running or no result yet — just tool name
          const pad = " ".repeat(Math.max(0, innerW - headerLen - rightLen));
          const line = `${headerContent}${pad}${rightPart}`;
          if (tool._mu_leading_space) return ["", line];
          return [line];
        }

        const hasComplex = Object.values(args).some(isComplexValue);

        if (hasComplex) {
          // Pretty-print mode: tool name on first line, args below with highlighting
          const headerContent = `${iconColored} ${nameColored}`;
          const headerLen = visibleWidth(headerContent);
          const pad = " ".repeat(Math.max(0, innerW - headerLen - rightLen));
          const resultLines: string[] = [`${headerContent}${pad}${rightPart}`];

          const BLOCK_INDENT = "  ";
          for (const [k, v] of Object.entries(args)) {
            const keyStr = `${mu("info", k)}${mu("dim", "=")}`;

            if (isComplexValue(v)) {
              const highlighted = highlightValue(v);
              for (let i = 0; i < highlighted.length; i++) {
                const raw =
                  i === 0
                    ? `${BLOCK_INDENT}${keyStr}${highlighted[i]}`
                    : `${BLOCK_INDENT}${highlighted[i]}`;
                resultLines.push(truncateToWidth(raw, innerW));
              }
            } else {
              const valStr =
                v === null
                  ? mu("keyword", "null")
                  : v === undefined
                    ? mu("dim", "undefined")
                    : typeof v === "boolean"
                      ? mu("keyword", String(v))
                      : typeof v === "number"
                        ? mu("warning", String(v))
                        : mu("text", String(v));
              resultLines.push(truncateToWidth(`${BLOCK_INDENT}${keyStr}${valStr}`, innerW));
            }
          }

          if (tool._mu_leading_space) return ["", ...resultLines];
          return resultLines;
        }

        // Simple mode: inline args with multiline wrapping
        const argsStr = formatToolArgsPreview(toolName, args);
        const prefix = `${iconColored} ${nameColored} `;
        const prefixLen = visibleWidth(prefix);
        const indent = " ".repeat(prefixLen);

        const firstLineWidth = innerW - prefixLen - rightLen - 1;
        const contLineWidth = innerW - prefixLen;

        if (firstLineWidth <= 0 || contLineWidth <= 0) {
          const fallback = `${prefix}${mu("dim", truncateToWidth(argsStr, Math.max(1, innerW - prefixLen - rightLen - 1)))}`;
          const fallbackLen = visibleWidth(fallback);
          const pad = " ".repeat(Math.max(0, innerW - fallbackLen - rightLen));
          const lines = [`${fallback}${pad}${rightPart}`];
          if (tool._mu_leading_space) return ["", ...lines];
          return lines;
        }

        const argsSegments = argsStr.split("\n");
        const allWrapped: string[] = [];

        for (const seg of argsSegments) {
          if (allWrapped.length === 0) {
            const wrapped = wrapTextWithAnsi(seg, firstLineWidth);
            if (wrapped.length === 0) {
              allWrapped.push("");
            } else {
              allWrapped.push(wrapped[0]);
              if (wrapped.length > 1) {
                const rewrapped = wrapTextWithAnsi(wrapped.slice(1).join(" "), contLineWidth);
                allWrapped.push(...rewrapped);
              }
            }
          } else {
            const wrapped = wrapTextWithAnsi(seg, contLineWidth);
            allWrapped.push(...(wrapped.length > 0 ? wrapped : [""]));
          }
        }

        const resultLines: string[] = [];
        for (let i = 0; i < allWrapped.length; i++) {
          const wl = allWrapped[i];
          if (i === 0) {
            const lineContent = `${prefix}${mu("dim", wl)}`;
            const lineLen = visibleWidth(lineContent);
            const pad = " ".repeat(Math.max(0, innerW - lineLen - rightLen));
            resultLines.push(`${lineContent}${pad}${rightPart}`);
          } else {
            resultLines.push(`${indent}${mu("dim", wl)}`);
          }
        }

        if (resultLines.length === 0) {
          resultLines.push(
            `${prefix}${" ".repeat(Math.max(0, innerW - prefixLen - rightLen))}${rightPart}`
          );
        }

        if (tool._mu_leading_space) return ["", ...resultLines];
        return resultLines;
      }; // end _renderStreamingTool

      // Cleanup on dispose
      const origDispose = tool.dispose?.bind(tool);
      tool.dispose = () => {
        stopPulse();
        origDispose?.();
      };
    };

    // biome-ignore lint/suspicious/noExplicitAny: Accessing TUI internals
    const tuiAny = tui as any;
    for (const child of tuiAny.children ?? []) {
      if (child.constructor?.name === "Container") {
        // Track last component type
        let lastWasUser = false;
        for (const gc of child.children ?? []) {
          if (isUser(gc)) {
            patchUser(gc);
            lastWasUser = true;
          } else if (isAssistant(gc)) {
            patchAssistant(gc);
            lastWasUser = false;
          } else if (isTool(gc)) {
            patchTool(gc, lastWasUser);
            lastWasUser = false;
          }
        }

        if (!child._mu_patched_container) {
          child._mu_patched_container = true;
          child._mu_lastWasUser = lastWasUser;
          const origAdd = child.addChild?.bind(child);
          if (origAdd) {
            // biome-ignore lint/suspicious/noExplicitAny: Patching Pi internals
            child.addChild = (newChild: any) => {
              const addSpace = child._mu_lastWasUser;
              if (isUser(newChild)) {
                patchUser(newChild);
                child._mu_lastWasUser = true;
              } else if (isAssistant(newChild)) {
                patchAssistant(newChild);
                child._mu_lastWasUser = false;
              } else if (isTool(newChild)) {
                patchTool(newChild, addSpace);
                child._mu_lastWasUser = false;
              }
              return origAdd(newChild);
            };
          }
        }
      }
    }

    done(true);
    return { render: () => [], invalidate: () => {}, handleInput: () => {} };
  });
};

// =============================================================================
// BASH SYNTAX HIGHLIGHTING (Custom Tokenizer)
// =============================================================================
// Full custom tokenizer — colors commands, keywords, builtins, strings,
// variables, flags, pipes, redirections, and arguments.

const BASH_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "in",
  "function",
  "select",
  "time",
  "coproc",
]);
const BASH_FLOW_RESUME = new Set(["do", "then", "else", "elif"]);
const BASH_BUILTINS = new Set([
  "cd",
  "echo",
  "printf",
  "read",
  "export",
  "source",
  "alias",
  "unalias",
  "set",
  "unset",
  "shift",
  "return",
  "exit",
  "exec",
  "eval",
  "trap",
  "wait",
  "kill",
  "jobs",
  "fg",
  "bg",
  "declare",
  "local",
  "readonly",
  "typeset",
  "let",
  "test",
  "true",
  "false",
  "pwd",
  "pushd",
  "popd",
  "dirs",
  "getopts",
  "hash",
  "type",
  "command",
  "builtin",
  "enable",
  "help",
  "logout",
  "mapfile",
  "readarray",
  "shopt",
  "bind",
  "ulimit",
  "umask",
]);

/** Apply a pi syntax theme color directly. */
const syn = (c: ThemeColor, text: string): string => getTheme().fg(c, text);

/** Check if a bash line ends with a chain operator (&&, ||, |, \) */
function bashLineIsChained(line: string): boolean {
  const trimmed = line.trimEnd();
  return (
    trimmed.endsWith("&&") ||
    trimmed.endsWith("||") ||
    trimmed.endsWith("|") ||
    trimmed.endsWith("\\")
  );
}

/**
 * Track quote state across a bash line.
 * Returns updated [inSingle, inDouble] state after processing the line.
 */
function bashUpdateQuoteState(
  line: string,
  inSingle: boolean,
  inDouble: boolean
): [boolean, boolean] {
  let sq = inSingle;
  let dq = inDouble;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    // Backslash escapes next char inside double quotes (not single quotes)
    if (ch === "\\" && dq && !sq) {
      i++;
      continue;
    }
    if (ch === "'" && !dq) sq = !sq;
    if (ch === '"' && !sq) dq = !dq;
  }
  return [sq, dq];
}

function highlightBashLine(line: string, startInSQ = false, startInDQ = false): string {
  let result = "";
  let i = 0;
  let cmdPos = !startInSQ && !startInDQ; // inside a quote = not command position

  // If continuing inside a single-quoted string from a previous line
  if (startInSQ) {
    const end = line.indexOf("'", i);
    if (end === -1) {
      return syn("syntaxString", line);
    }
    result += syn("syntaxString", line.slice(0, end + 1));
    i = end + 1;
    cmdPos = false;
  } else if (startInDQ) {
    // Continuing inside a double-quoted string from a previous line
    let closed = false;
    let j = 0;
    while (j < line.length) {
      if (line[j] === "\\" && j + 1 < line.length) {
        j += 2;
        continue;
      }
      if (line[j] === '"') {
        result += syn("syntaxString", line.slice(0, j + 1));
        i = j + 1;
        cmdPos = false;
        closed = true;
        break;
      }
      j++;
    }
    if (!closed) {
      return syn("syntaxString", line);
    }
  }

  while (i < line.length) {
    // Whitespace
    if (line[i] === " " || line[i] === "\t") {
      result += line[i];
      i++;
      continue;
    }

    // Comment
    if (line[i] === "#" && (i === 0 || line[i - 1] === " ")) {
      result += syn("syntaxComment", line.slice(i));
      break;
    }

    // Single-quoted string
    if (line[i] === "'") {
      const end = line.indexOf("'", i + 1);
      const s = end === -1 ? line.slice(i) : line.slice(i, end + 1);
      result += syn("syntaxString", s);
      i += s.length;
      cmdPos = false;
      continue;
    }

    // Double-quoted string
    if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if (line[j] === "\\") j++;
        j++;
      }
      const s = line.slice(i, j + 1);
      result += syn("syntaxString", s);
      i = j + 1;
      cmdPos = false;
      continue;
    }

    // Variable
    if (line[i] === "$") {
      const m = line.slice(i).match(/^\$(\{[^}]*\}|[A-Za-z_]\w*|\(.*?\)|\d|[?!#$@*-])/);
      if (m) {
        result += syn("syntaxVariable", m[0]);
        i += m[0].length;
      } else {
        result += line[i];
        i++;
      }
      cmdPos = false;
      continue;
    }

    // Backtick command substitution
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      const s = end === -1 ? line.slice(i) : line.slice(i, end + 1);
      result += syn("syntaxVariable", s);
      i += s.length;
      cmdPos = false;
      continue;
    }

    // Operators: &&, ||
    if (line[i] === "&" && line[i + 1] === "&") {
      result += syn("syntaxOperator", "&&");
      i += 2;
      cmdPos = true;
      continue;
    }
    if (line[i] === "|" && line[i + 1] === "|") {
      result += syn("syntaxOperator", "||");
      i += 2;
      cmdPos = true;
      continue;
    }

    // Pipe
    if (line[i] === "|") {
      result += syn("syntaxOperator", "|");
      i++;
      cmdPos = true;
      continue;
    }

    // Semicolon
    if (line[i] === ";") {
      result += syn("syntaxPunctuation", ";");
      i++;
      cmdPos = true;
      continue;
    }

    // Heredoc <<
    if (line[i] === "<" && line[i + 1] === "<") {
      result += syn("syntaxOperator", "<<");
      i += 2;
      if (i < line.length && line[i] === "-") {
        result += syn("syntaxOperator", "-");
        i++;
      }
      cmdPos = false;
      continue;
    }

    // Redirections: 2>&1, &>>, &>, >>, 2>, <, >
    const redir = line.slice(i).match(/^(2>&1|&>>|&>|>>|2>|[<>])/);
    if (redir) {
      result += syn("syntaxOperator", redir[0]);
      i += redir[0].length;
      cmdPos = false;
      continue;
    }

    // Background &
    if (line[i] === "&") {
      result += syn("syntaxOperator", "&");
      i++;
      cmdPos = true;
      continue;
    }

    // Parentheses / braces
    if (line[i] === "(" || line[i] === ")" || line[i] === "{" || line[i] === "}") {
      result += syn("syntaxPunctuation", line[i]);
      i++;
      if (line[i - 1] === "(" || line[i - 1] === "{") cmdPos = true;
      continue;
    }

    // Word token
    let word = "";
    while (i < line.length && " \t|&;<>\"'`$#(){}".indexOf(line[i]) === -1) {
      // Break before redirection: digit followed by > or <
      if ((line[i] === ">" || line[i] === "<") && word.length > 0 && /^\d+$/.test(word)) {
        break;
      }
      word += line[i];
      i++;
    }

    if (!word) {
      // Safety: consume one char to avoid infinite loop
      result += line[i] ?? "";
      i++;
      continue;
    }

    // Classify word
    if (cmdPos) {
      if (BASH_KEYWORDS.has(word)) {
        result += syn("syntaxKeyword", word);
      } else if (BASH_BUILTINS.has(word)) {
        result += syn("syntaxFunction", word);
      } else {
        result += syn("syntaxType", word);
      }
      cmdPos = BASH_FLOW_RESUME.has(word);
    } else if (word.startsWith("--") || (word.startsWith("-") && word.length > 1)) {
      result += syn("syntaxVariable", word);
    } else if (/^\d+(\.\d+)?$/.test(word)) {
      result += syn("syntaxNumber", word);
    } else {
      result += syn("syntaxOperator", word);
    }
  }

  return result;
}

// =============================================================================
// PRETTY-PRINT & SYNTAX HIGHLIGHTING FOR TOOL ARGS
// =============================================================================

function isComplexValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "object") return true;
  if (typeof v === "string") {
    const t = v.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        JSON.parse(t);
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

function highlightValue(v: unknown): string[] {
  if (v === null) return highlightCode("null", "json");
  if (v === undefined) return [mu("dim", "undefined")];
  if (typeof v === "boolean" || typeof v === "number") {
    return highlightCode(JSON.stringify(v), "json");
  }
  if (typeof v === "object") {
    return highlightCode(JSON.stringify(v, null, 2), "json");
  }
  if (typeof v === "string") {
    const t = v.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        const parsed = JSON.parse(t);
        return highlightCode(JSON.stringify(parsed, null, 2), "json");
      } catch {
        /* not JSON */
      }
    }
    return [v];
  }
  return [String(v)];
}

function formatToolArgsPreview(name: string, args: Record<string, unknown>): string {
  if (!args) return "";
  const p = (args.path ?? args.file_path ?? "") as string;
  const relPath = p.startsWith("/") ? p.split("/").slice(-2).join("/") : p;

  switch (name) {
    case "bash":
      return preview((args.command as string) ?? "", 60);
    case "read":
    case "write":
    case "ls":
    case "edit":
      return relPath;
    case "grep":
    case "find":
      return `${args.pattern ?? ""} ${relPath}`;
    default:
      return Object.entries(args)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
  }
}

// =============================================================================
// MAIN EXTENSION
// =============================================================================
export default function (pi: ExtensionAPI) {
  // Setup UI patching on session start
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    workingTimer.stop(); // defensive cleanup from any prior session
    setupUIPatching(ctx);

    // Enable enhanced model display footer
    if (modelDisplayEnabled) {
      enableModelDisplayFooter(ctx);
    }
  });

  // Working timer: start on agent_start, stop on agent_end
  pi.on("agent_start", (_event: AgentStartEvent, ctx: ExtensionContext) => {
    workingTimer.start(ctx);
  });

  pi.on("agent_end", (_event: AgentEndEvent, ctx: ExtensionContext) => {
    const elapsed = workingTimer.stop();
    if (elapsed >= MIN_ELAPSED_FOR_NOTIFICATION_MS && ctx.hasUI) {
      ctx.ui.notify(`⏱ Completed in ${formatWorkingElapsed(elapsed)}`, "info");
    }

    // Mark any still-active tools as canceled (orphaned by abort/timeout)
    for (const [id, state] of activeToolsById) {
      state.status = "canceled";
      state.duration = Date.now() - state.startTime;
      activeToolsById.delete(id);
    }
  });

  // When a turn starts (user message sent), set flag for next tool to add leading space
  pi.on("turn_start", () => {
    nextToolNeedsLeadingSpace = true;
  });

  // Track tool execution state
  pi.on("tool_call", (event: ToolCallEvent, _ctx: ExtensionContext) => {
    const { toolCallId, toolName, input } = event;
    const args = input as Record<string, unknown>;
    const sig = computeSignature(toolName, args);

    const state: ToolState = {
      toolCallId,
      sig,
      toolName,
      args,
      startTime: Date.now(),
      status: "running",
    };

    activeToolsById.set(toolCallId, state);
    const states = toolStatesBySig.get(sig) ?? [];
    states.push(state);
    toolStatesBySig.set(sig, states);
  });

  pi.on("tool_result", (event: ToolResultEvent, _ctx: ExtensionContext) => {
    const { toolCallId, isError, content } = event;
    const state = activeToolsById.get(toolCallId);
    if (!state) return;

    const duration = Date.now() - state.startTime;
    state.duration = duration;
    state.status = isError ? "failed" : "success";
    activeToolsById.delete(toolCallId);

    const label = `${state.toolName} ${formatToolArgsPreview(state.toolName, state.args)}`;
    toolResultOptions.push({
      key: toolCallId,
      toolName: state.toolName,
      sig: state.sig,
      label: preview(label, MU_CONFIG.VIEWER_OPTION_MAX_LENGTH),
      args: state.args,
      result: { content, isError },
      startTime: state.startTime,
      duration,
      isError: isError ?? false,
    });

    if (toolResultOptions.length > MU_CONFIG.MAX_TOOL_RESULTS) {
      toolResultOptions.shift();
    }

    if (toolStatesBySig.size > MU_CONFIG.MAX_COMPLETED_DURATIONS) {
      const first = toolStatesBySig.keys().next().value;
      if (first) {
        toolStatesBySig.delete(first);
        cardInstanceCountBySig.delete(first);
      }
    }
  });

  // Register shortcut and command
  pi.registerShortcut(MU_TOOL_VIEWER_SHORTCUT, {
    description: "mu: open tool results overlay",
    handler: async (ctx: ExtensionCommandContext) => {
      await openMuToolsOverlay(ctx);
    },
  });

  pi.registerCommand("mu-tools", {
    description: "mu: open tool results overlay",
    handler: async (_args, ctx) => {
      await openMuToolsOverlay(ctx);
    },
  });

  // Tool overrides
  const throwIfAborted = (signal?: AbortSignal) => {
    if (!signal?.aborted) return;
    const error = new Error("Tool execution aborted");
    (error as { name?: string }).name = "AbortError";
    throw error;
  };

  function override(
    name: string,
    factory: ToolFactory,
    renderCondensed: (args: ToolParams, t: MuTheme) => string
  ) {
    const dummy = factory(process.cwd());

    type ExecutableTool = Tool<ToolParams> & {
      execute: (
        id: string,
        params: ToolParams,
        signal?: AbortSignal,
        onUpdate?: (e: ToolResultEvent) => void
      ) => Promise<ToolResultEvent>;
    };

    pi.registerTool({
      name,
      label: dummy.label,
      description: dummy.description,
      // biome-ignore lint/suspicious/noExplicitAny: Type coercion for pi tool registration
      parameters: dummy.parameters as any,

      async execute(id, params, _onUpdate, ctx, signal) {
        throwIfAborted(signal);
        const realTool = factory(ctx.cwd) as ExecutableTool;
        const result = await realTool.execute(id, params, signal);
        throwIfAborted(signal);

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

          const details = isRecord(result.details) ? result.details : undefined;
          const exitCode = details?.exitCode;
          const exitPrefix = typeof exitCode === "number" ? `[exit:${exitCode}] ` : "";

          throw new Error(`${exitPrefix}${errorText}`);
        }

        return result;
      },

      renderCall(args: ToolParams, theme: MuTheme) {
        const textGen = () => renderCondensed(args, theme).trimEnd();
        return new BoxedToolCard(textGen, name, args, theme);
      },

      renderResult(result, options, theme: MuTheme) {
        const { expanded } = options;
        const content = Array.isArray(result.content) ? result.content : [];
        const extractText = (item: unknown): string =>
          isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : "";

        if (expanded) {
          if (dummy.renderResult) return dummy.renderResult(result, options, theme);
          const text = content.map(extractText).join("\n");
          return new Markdown(text, 0, 0, getMarkdownTheme());
        }

        return new Text("", 0, 0);
      },
    });
  }

  const _muTheme: MuTheme = {
    fg: (color, text) => {
      try {
        return getTheme().fg(color as ThemeColor, text);
      } catch {
        return text;
      }
    },
    bg: (_color, text) => text,
  };

  const tools: [string, ToolFactory, (a: ToolParams, t: MuTheme) => string][] = [
    [
      "bash",
      createBashTool,
      (args, t) => {
        const cmd = typeof args.command === "string" ? args.command : "";
        return `${t.fg("accent", "bash")} ${t.fg("dim", "$")} ${t.fg("text", cmd)}`;
      },
    ],
    [
      "read",
      createReadTool,
      (args, t) => {
        const offset = typeof args.offset === "number" ? args.offset : undefined;
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const info = formatReadLoc(offset, limit);
        const path = typeof args.path === "string" ? args.path : "";
        return `${t.fg("accent", "read")} ${t.fg("text", path)} ${info ? t.fg("dim", info) : ""}`.trimEnd();
      },
    ],
    [
      "grep",
      createGrepTool,
      (args, t) => {
        const pattern = args.pattern !== undefined ? String(args.pattern) : "";
        const where = typeof args.path === "string" ? args.path : ".";
        return `${t.fg("accent", "grep")} ${t.fg("text", JSON.stringify(pattern))} ${t.fg("text", where)}`;
      },
    ],
    [
      "find",
      createFindTool,
      (args, t) => {
        const pattern = args.pattern !== undefined ? String(args.pattern) : "";
        const where = typeof args.path === "string" ? args.path : ".";
        return `${t.fg("accent", "find")} ${t.fg("text", JSON.stringify(pattern))} ${t.fg("text", where)}`;
      },
    ],
    [
      "ls",
      createLsTool,
      (args, t) => {
        const path = typeof args.path === "string" ? args.path : ".";
        return `${t.fg("accent", "ls")} ${t.fg("text", path)}`;
      },
    ],
    [
      "write",
      createWriteTool,
      (args, t) => {
        const path = typeof args.path === "string" ? args.path : "";
        const content = typeof args.content === "string" ? args.content : "";
        const lines = content ? content.split("\n").length : 0;
        return `${t.fg("accent", "write")} ${t.fg("text", path)} ${lines > 0 ? t.fg("dim", `(${lines} lines)`) : ""}`.trimEnd();
      },
    ],
    [
      "edit",
      createEditTool,
      (args, t) => {
        const path = typeof args.path === "string" ? args.path : "";
        const oldText = typeof args.oldText === "string" ? args.oldText : "";
        const newText = typeof args.newText === "string" ? args.newText : "";
        const oldLines = oldText ? oldText.split("\n").length : 0;
        const newLines = newText ? newText.split("\n").length : 0;
        const delta = newLines - oldLines;
        const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "±0";
        return `${t.fg("accent", "edit")} ${t.fg("text", path)} ${t.fg("dim", `(${oldLines}→${newLines}, ${deltaStr})`)}`;
      },
    ],
  ];

  for (const [name, factory, render] of tools) {
    override(name, factory, render);
  }

  // ---------------------------------------------------------------------------
  // Enhanced Model Display Footer
  // ---------------------------------------------------------------------------
  // Format: provider:model:thinkingLevel with custom colors
  // - Provider: #17917F (teal)
  // - Model: #85B06A (green)
  // - Thinking: gradient #A17E57 (tan) → #F24C38 (bright red)

  let modelDisplayEnabled = true;

  const enableModelDisplayFooter = (ctx: ExtensionContext | ExtensionCommandContext) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // Compute tokens from session (single pass)
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;
          let lastAssistant: AssistantMessage | null = null;

          for (const e of ctx.sessionManager.getBranch()) {
            if (e.type === "message" && e.message.role === "assistant") {
              const m = e.message as AssistantMessage;
              totalInput += m.usage.input;
              totalOutput += m.usage.output;
              totalCacheRead += m.usage.cacheRead;
              totalCacheWrite += m.usage.cacheWrite;
              totalCost += m.usage.cost.total;
              lastAssistant = m;
            }
          }

          const contextTokens = lastAssistant
            ? lastAssistant.usage.input +
              lastAssistant.usage.output +
              lastAssistant.usage.cacheRead +
              lastAssistant.usage.cacheWrite
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
            if (half > 1) {
              const start = pwd.slice(0, half);
              const endLen = half - 1;
              const end = pwd.slice(pwd.length - endLen);
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

          // Build stats line with bracketed groups and semantic colors
          const statsParts: string[] = [];

          // Tokens group (cyan): [↑in ↓out]
          if (totalInput || totalOutput) {
            const tokenParts: string[] = [];
            if (totalInput) tokenParts.push(`↑${fmt(totalInput)}`);
            if (totalOutput) tokenParts.push(`↓${fmt(totalOutput)}`);
            statsParts.push(mu("dim", "[") + mu("variable", tokenParts.join(" ")) + mu("dim", "]"));
          }

          // Cache group (green): [Rread Wwrite]
          if (totalCacheRead || totalCacheWrite) {
            const cacheParts: string[] = [];
            if (totalCacheRead) cacheParts.push(`R${fmt(totalCacheRead)}`);
            if (totalCacheWrite) cacheParts.push(`W${fmt(totalCacheWrite)}`);
            statsParts.push(mu("dim", "[") + mu("success", cacheParts.join(" ")) + mu("dim", "]"));
          }

          // Cost group (amber): [$cost sub]
          const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          if (totalCost || usingSubscription) {
            const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " sub" : ""}`;
            statsParts.push(mu("dim", "[") + mu("warning", costStr) + mu("dim", "]"));
          }

          // Context group with gradient progress bar: [█▓░░░ 29k/200k (14.5%)]
          const bar = progressBar(contextPercentValue, 5);
          const contextInfo = `${fmt(contextTokens)}/${fmt(contextWindow)} (${contextPercent}%)`;
          statsParts.push(`${mu("dim", "[")}${bar} ${mu("text", contextInfo)}${mu("dim", "]")}`);

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
              .map(([, text]) =>
                text
                  .replace(/[\r\n\t]/g, " ")
                  .replace(/ +/g, " ")
                  .trim()
              );
            const statusLine = sortedStatuses.join(" ");
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          }

          return lines;
        },
      };
    });
  };

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
