import { createHash } from "node:crypto";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionStartEvent,
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

// =============================================================================
// THEME COLORS (Orange Premium Palette)
// =============================================================================
const C = {
  orange: { r: 255, g: 159, b: 67 },
  green: { r: 38, g: 222, b: 129 },
  red: { r: 238, g: 90, b: 82 },
  yellow: { r: 254, g: 211, b: 48 },
  dim: { r: 92, g: 92, b: 92 },
  gray: { r: 140, g: 140, b: 140 },
  teal: { r: 84, g: 160, b: 160 },
  amber: { r: 254, g: 202, b: 87 },
  white: { r: 220, g: 220, b: 220 },
  violet: { r: 167, g: 139, b: 250 },
} as const;

type ColorKey = keyof typeof C;

const rgb = (c: ColorKey, text: string): string => {
  const { r, g, b } = C[c];
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
};

const rgbPulse = (c: ColorKey, text: string, brightness: number): string => {
  const { r, g, b } = C[c];
  const f = Math.max(0.3, Math.min(1, brightness));
  return `\x1b[38;2;${Math.round(r * f)};${Math.round(g * f)};${Math.round(b * f)}m${text}\x1b[0m`;
};

// =============================================================================
// STATUS CONFIGURATION
// =============================================================================
type ToolStatus = "pending" | "running" | "success" | "failed" | "canceled";

const STATUS: Record<ToolStatus, { sym: string; color: ColorKey }> = {
  pending: { sym: "◌", color: "dim" },
  running: { sym: "●", color: "orange" },
  success: { sym: "✓", color: "green" },
  failed: { sym: "✗", color: "red" },
  canceled: { sym: "○", color: "gray" },
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
} as const;

const MU_TOOL_VIEWER_SHORTCUT = "ctrl+alt+o";

// =============================================================================
// UTILITIES
// =============================================================================
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

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
const activeToolsBySig = new Map<string, ToolState>();
const completedDurations = new Map<string, number>();
const fullToolResultContentById = new Map<string, unknown>();

const getToolState = (sig: string): ToolState | undefined => activeToolsBySig.get(sig);

// Track if next tool card should have leading space (after user message)
let nextToolNeedsLeadingSpace = false;
const _toolLeadingSpaceByToolCallId = new Map<string, boolean>();

// =============================================================================
// MU THEME INTERFACE
// =============================================================================
interface MuTheme {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
}

interface ThemeWithAnsi extends MuTheme {
  getFgAnsi?: (color: string) => string;
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

const _formatModelDisplay = (
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
    this.needsLeadingSpace = nextToolNeedsLeadingSpace;
    nextToolNeedsLeadingSpace = false;
  }

  private getStatus(): ToolStatus {
    const state = getToolState(this.sig);
    return state?.status ?? "pending";
  }

  private getElapsed(): number {
    const completed = completedDurations.get(this.sig);
    if (completed !== undefined) return completed;
    const state = getToolState(this.sig);
    if (!state) return 0;
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
    const innerW = width - 4;
    const border = rgb(color, "│");

    let statusStr: string;
    if (status === "running") {
      const brightness =
        MU_CONFIG.PULSE_MIN_BRIGHTNESS +
        (1 - MU_CONFIG.PULSE_MIN_BRIGHTNESS) * (0.5 + 0.5 * Math.sin(this.pulsePhase));
      statusStr = rgbPulse(color, sym, brightness);
    } else {
      statusStr = rgb(color, sym);
    }

    const timerStr = elapsed ? rgb("dim", ` ${elapsed}`) : "";
    const rightPart = `${statusStr}${timerStr}`;
    const rightLen = visibleWidth(rightPart);

    // For bash: render multiline with full command, no truncation
    if (this.toolName === "bash") {
      const rawCmd = typeof this.args.command === "string" ? this.args.command : "";
      const lines = this.renderBashMultiline(
        rawCmd,
        icon,
        color,
        border,
        rightPart,
        rightLen,
        innerW
      );
      this.lastWidth = width;
      this.cachedLines = this.needsLeadingSpace ? ["", ...lines] : lines;
      return this.cachedLines;
    }

    // Default: single-line truncated rendering for other tools
    const leftMax = innerW - rightLen - 1;
    const iconColored = rgb(color, icon);
    const leftContent = `${iconColored} ${content}`;
    const leftTrunc = truncateToWidth(leftContent, leftMax);
    const leftLen = visibleWidth(leftTrunc);
    const padding = " ".repeat(Math.max(0, innerW - leftLen - rightLen));

    const line = `${border} ${leftTrunc}${padding}${rightPart} ${border}`;

    this.lastWidth = width;
    this.cachedLines = this.needsLeadingSpace ? ["", line] : [line];
    return this.cachedLines;
  }

  private renderBashMultiline(
    rawCmd: string,
    icon: string,
    color: ColorKey,
    border: string,
    rightPart: string,
    rightLen: number,
    innerW: number
  ): string[] {
    const iconColored = rgb(color, icon);
    const prefix = `${iconColored} ${rgb("orange", "bash")} ${rgb("dim", "$")} `;
    const prefixLen = visibleWidth(prefix);
    const indent = " ".repeat(prefixLen);

    // Available width for command text on first line (needs room for status)
    const firstLineWidth = innerW - prefixLen - rightLen - 1;
    // Continuation lines have full width minus indent
    const contLineWidth = innerW - prefixLen;

    if (firstLineWidth <= 0 || contLineWidth <= 0) {
      // Terminal too narrow, show truncated
      const fallback = `${prefix}${rgb("white", truncateToWidth(rawCmd, Math.max(1, innerW - prefixLen - rightLen - 1)))}`;
      const fallbackLen = visibleWidth(fallback);
      const padding = " ".repeat(Math.max(0, innerW - fallbackLen - rightLen));
      return [`${border} ${fallback}${padding}${rightPart} ${border}`];
    }

    // Split command preserving original line breaks, then wrap each segment
    const cmdLines = rawCmd.split("\n");
    const allWrapped: string[] = [];

    for (const cmdLine of cmdLines) {
      if (allWrapped.length === 0) {
        // First segment uses first-line width
        const wrapped = wrapTextWithAnsi(cmdLine, firstLineWidth);
        if (wrapped.length === 0) {
          allWrapped.push("");
        } else {
          allWrapped.push(wrapped[0]);
          // Remaining from first segment use continuation width
          if (wrapped.length > 1) {
            const rewrapped = wrapTextWithAnsi(wrapped.slice(1).join(" "), contLineWidth);
            allWrapped.push(...rewrapped);
          }
        }
      } else {
        // Subsequent segments use continuation width
        const wrapped = wrapTextWithAnsi(cmdLine, contLineWidth);
        allWrapped.push(...(wrapped.length > 0 ? wrapped : [""]));
      }
    }

    const resultLines: string[] = [];

    for (let i = 0; i < allWrapped.length; i++) {
      const line = allWrapped[i];
      if (i === 0) {
        // First line: prefix + command + padding + status
        const lineContent = `${prefix}${rgb("white", line)}`;
        const lineLen = visibleWidth(lineContent);
        const padding = " ".repeat(Math.max(0, innerW - lineLen - rightLen));
        resultLines.push(`${border} ${lineContent}${padding}${rightPart} ${border}`);
      } else {
        // Continuation: indent + command + padding
        const lineContent = `${indent}${rgb("white", line)}`;
        const lineLen = visibleWidth(lineContent);
        const padding = " ".repeat(Math.max(0, innerW - lineLen));
        resultLines.push(`${border} ${lineContent}${padding} ${border}`);
      }
    }

    return resultLines.length > 0
      ? resultLines
      : [
          `${border} ${prefix}${" ".repeat(Math.max(0, innerW - prefixLen - rightLen))}${rightPart} ${border}`,
        ];
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

class ToolResultDetailViewer implements Component {
  private option: ToolResultOption;
  private scrollOffset = 0;
  private lines: string[] = [];
  private theme: ThemeWithAnsi;

  constructor(option: ToolResultOption, theme: ThemeWithAnsi) {
    this.option = option;
    this.theme = theme;
  }

  render(width: number): string[] {
    const { toolName, args, result, duration, isError } = this.option;
    const out: string[] = [];

    const header = `${rgb("amber", "─")} ${rgb("amber", toolName)} ${rgb("dim", "─".repeat(Math.max(0, width - toolName.length - 4)))}`;
    out.push(header);

    const argLines = Object.entries(args).map(([k, v]) => {
      const val = typeof v === "string" ? preview(v, 80) : JSON.stringify(v);
      return `  ${rgb("teal", k)}: ${rgb("white", val)}`;
    });
    out.push(...argLines);

    if (duration !== undefined) {
      out.push(`  ${rgb("dim", `duration: ${(duration / 1000).toFixed(2)}s`)}`);
    }

    out.push("");

    const content = Array.isArray((result as { content?: unknown[] })?.content)
      ? (result as { content: unknown[] }).content
      : [];
    const text = content
      .filter((c) => isRecord(c) && c.type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join("\n");

    const resultColor = isError ? "red" : "green";
    out.push(rgb(resultColor, isError ? "─ Error ─" : "─ Result ─"));

    const textLines = text.split("\n");
    for (const line of textLines) {
      const wrapped = wrapTextWithAnsi(line, width - 2);
      for (const w of wrapped) {
        out.push(`  ${w}`);
      }
    }

    this.lines = out;
    return out;
  }

  handleInput(key: KeyId): boolean {
    if (matchesKey(key, "down") || matchesKey(key, "j")) {
      this.scrollOffset = Math.min(this.scrollOffset + 1, Math.max(0, this.lines.length - 10));
      return true;
    }
    if (matchesKey(key, "up") || matchesKey(key, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
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
  private theme: ThemeWithAnsi;
  private onSelect: (opt: ToolResultOption) => void;
  private onClose: () => void;
  private scrollOffset = 0;

  constructor(
    options: ToolResultOption[],
    theme: ThemeWithAnsi,
    onSelect: (opt: ToolResultOption) => void,
    onClose: () => void
  ) {
    this.options = options;
    this.theme = theme;
    this.onSelect = onSelect;
    this.onClose = onClose;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const innerW = width - 4;

    const titleText = "μ Tools";
    const titlePad = Math.max(0, Math.floor((innerW - titleText.length) / 2));
    const topBorder = `${rgb("teal", "╭")}${rgb("teal", "─".repeat(titlePad))} ${rgb("amber", titleText)} ${rgb("teal", "─".repeat(Math.max(0, innerW - titlePad - titleText.length - 2)))}${rgb("teal", "╮")}`;
    lines.push(topBorder);

    if (this.options.length === 0) {
      lines.push(
        `${rgb("teal", "│")} ${rgb("dim", "No tool results yet").padEnd(innerW)} ${rgb("teal", "│")}`
      );
    } else {
      const visibleCount = Math.min(10, this.options.length);
      const maxScroll = Math.max(0, this.options.length - visibleCount);
      this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
      if (this.selectedIndex < this.scrollOffset) {
        this.scrollOffset = this.selectedIndex;
      } else if (this.selectedIndex >= this.scrollOffset + visibleCount) {
        this.scrollOffset = this.selectedIndex - visibleCount + 1;
      }

      for (let i = 0; i < visibleCount; i++) {
        const idx = this.scrollOffset + i;
        const opt = this.options[idx];
        if (!opt) continue;

        const isSelected = idx === this.selectedIndex;
        const pointer = isSelected ? rgb("orange", "▸") : " ";
        const status = opt.isError ? STATUS.failed : STATUS.success;
        const statusSym = rgb(status.color, status.sym);
        const icon = TOOL_ICONS[opt.toolName] ?? "⚙";

        const dur = opt.duration !== undefined ? `${(opt.duration / 1000).toFixed(1)}s` : "";
        const durStr = rgb("dim", dur.padStart(6));

        const label = truncateToWidth(opt.label, innerW - 16);
        const line = `${rgb("teal", "│")} ${pointer}${statusSym} ${rgb("teal", icon)} ${label}${" ".repeat(Math.max(0, innerW - visibleWidth(label) - 14))}${durStr} ${rgb("teal", "│")}`;
        lines.push(line);
      }
    }

    const divider = `${rgb("teal", "├")}${rgb("teal", "─".repeat(innerW))}${rgb("teal", "┤")}`;
    lines.push(divider);

    const selected = this.options[this.selectedIndex];
    if (selected) {
      const args = Object.entries(selected.args).slice(0, 3);
      for (const [k, v] of args) {
        const val = typeof v === "string" ? preview(v, innerW - k.length - 6) : JSON.stringify(v);
        const argLine = `${rgb("teal", "│")} ${rgb("dim", k)}: ${rgb("white", val)}`;
        lines.push(truncateToWidth(argLine, width - 2).padEnd(width - 2) + rgb("teal", "│"));
      }
      if (args.length === 0) {
        lines.push(
          `${rgb("teal", "│")} ${rgb("dim", "(no args)").padEnd(innerW)} ${rgb("teal", "│")}`
        );
      }
    } else {
      lines.push(`${rgb("teal", "│")} ${" ".repeat(innerW)} ${rgb("teal", "│")}`);
    }

    const bottomBorder = `${rgb("teal", "╰")}${rgb("teal", "─".repeat(innerW))}${rgb("teal", "╯")}`;
    lines.push(bottomBorder);

    const help = `  ${rgb("dim", "↑↓ navigate   enter expand   esc close")}`;
    lines.push(help);

    return lines;
  }

  handleInput(key: KeyId): boolean {
    if (matchesKey(key, "escape") || matchesKey(key, "q")) {
      this.onClose();
      return true;
    }
    if (matchesKey(key, "down") || matchesKey(key, "j")) {
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.options.length - 1);
      return true;
    }
    if (matchesKey(key, "up") || matchesKey(key, "k")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
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
    if (matchesKey(key, "enter")) {
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

  const theme: ThemeWithAnsi = {
    fg: (color, text) => {
      const c = C[color as ColorKey];
      return c ? rgbRaw(c.r, c.g, c.b, text) : text;
    },
    bg: (_color, text) => text,
  };

  const options = [...toolResultOptions].reverse();

  await new Promise<void>((resolve) => {
    ctx.ui.custom((_tui, _theme, _kb, done) => {
      let currentOverlay: Component | null = null;
      let detailViewer: ToolResultDetailViewer | null = null;

      const closeOverlay = () => {
        done(true);
        resolve();
      };

      const openDetail = (opt: ToolResultOption) => {
        detailViewer = new ToolResultDetailViewer(opt, theme);
      };

      currentOverlay = new MuToolsOverlay(options, theme, openDetail, closeOverlay);

      return {
        render(width: number): string[] {
          if (detailViewer) return detailViewer.render(width);
          return currentOverlay?.render(width) ?? [];
        },
        handleInput(key: KeyId): boolean {
          if (detailViewer) {
            if (matchesKey(key, "escape") || matchesKey(key, "q")) {
              detailViewer = null;
              return true;
            }
            return detailViewer.handleInput(key);
          }
          // biome-ignore lint/suspicious/noExplicitAny: Component interface
          return (currentOverlay as any)?.handleInput?.(key) ?? false;
        },
        invalidate(): void {},
      };
    });
  });
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

      // Override render to produce compact output with prefix, no truncation
      const origRender = comp.render?.bind(comp);
      if (!origRender) return;

      comp.render = (w: number): string[] => {
        const origLines: string[] = origRender(w - 4);

        // Filter out empty/spacer lines and strip ANSI to get raw text
        const cleanLines: string[] = [];
        const ansiEscape = String.raw`\x1b\[[0-9;]*m`;
        const ansiRegex = new RegExp(ansiEscape, "g");
        for (const line of origLines) {
          const stripped = line.replace(ansiRegex, "").trim();
          if (stripped.length > 0) {
            // Keep raw text, we'll apply our own styling
            cleanLines.push(stripped);
          }
        }

        if (cleanLines.length === 0) return [];

        // Heavy left accent in teal, text in teal (bright)
        const border = rgb("teal", "┃");

        // Add blank line before user message for separation
        const result = [""];
        for (const line of cleanLines) {
          result.push(`${border} ${rgb("teal", line)}`);
        }
        return result;
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
      const wrapBlock = (block: any, eventType: EventType) => {
        if (block._mu_wrapped) return;
        block._mu_wrapped = true;

        stripBackgrounds(block);

        const orig = block.render?.bind(block);
        if (!orig) return;

        block.render = (w: number): string[] => {
          const lines: string[] = orig(w - 4);
          const { icon, color, border: borderChar } = EVENT_STYLES[eventType];
          const borderStyled = rgb(color, borderChar);
          const iconStyled = rgb(color, icon);

          return lines.map((line: string, i: number) => {
            if (i === 0) {
              return `${borderStyled} ${iconStyled} ${line}`;
            }
            return `${borderStyled}   ${line}`;
          });
        };
      };

      // Event type detection for distinct styling
      type EventType = "executing" | "preparing" | "result" | "thinking" | "response";

      const EVENT_STYLES: Record<EventType, { icon: string; color: ColorKey; border: string }> = {
        executing: { icon: "󰐊", color: "orange", border: "│" }, // play icon
        preparing: { icon: "󰦖", color: "yellow", border: "│" }, // clock icon
        result: { icon: "󰄬", color: "green", border: "│" }, // check icon
        thinking: { icon: "󰛨", color: "violet", border: "┊" }, // brain icon, violet, dotted border
        response: { icon: "󰍩", color: "green", border: "│" }, // chat bubble, green, solid
      };

      // biome-ignore lint/suspicious/noExplicitAny: Patching Pi internals
      const detectEventType = (block: any): EventType => {
        // Pi creates thinking blocks with italic: true in defaultTextStyle
        // Check all possible locations where italic flag might be set
        const isItalic =
          block.defaultTextStyle?.italic === true ||
          block.options?.italic === true ||
          block.italic === true;

        // If explicitly marked as italic, it's a thinking block
        if (isItalic) return "thinking";

        const rawText = String(block.text ?? block.content ?? block.markdown ?? "");
        const text = rawText.toLowerCase().trim();
        if (!text) return "response";

        // Short status-like messages
        if (/^(executing|running|calling|starting)/.test(text)) return "executing";
        if (/^(preparing|planning|checking|looking|reading|searching|analyzing)/.test(text))
          return "preparing";
        if (/^(result|output|complete|done|finished|command executed|ran:)/.test(text))
          return "result";

        return "response";
      };

      for (const child of container.children ?? []) {
        const name = child.constructor?.name;
        if (name === "Markdown" || name === "Text") {
          wrapBlock(child, detectEventType(child));
        }
      }

      const origAdd = container.addChild?.bind(container);
      if (origAdd) {
        // biome-ignore lint/suspicious/noExplicitAny: Patching Pi internals
        container.addChild = (child: any) => {
          const name = child.constructor?.name;
          if (name === "Markdown" || name === "Text") {
            wrapBlock(child, detectEventType(child));
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
      color: ColorKey,
      border: string,
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
        iconColored = rgbPulse(color, icon, brightness);
        bashColored = rgbPulse("orange", "bash", brightness);
      } else {
        iconColored = rgb(color, icon);
        bashColored = rgb("orange", "bash");
      }

      const prefix = `${iconColored} ${bashColored} ${rgb("dim", "$")} `;
      const prefixLen = visibleWidth(prefix);
      const indent = " ".repeat(prefixLen);

      const firstLineWidth = innerW - prefixLen - rightLen - 1;
      const contLineWidth = innerW - prefixLen;

      if (firstLineWidth <= 0 || contLineWidth <= 0) {
        const fallback = `${prefix}${rgb("white", truncateToWidth(rawCmd, Math.max(1, innerW - prefixLen - rightLen - 1)))}`;
        const fallbackLen = visibleWidth(fallback);
        const padding = " ".repeat(Math.max(0, innerW - fallbackLen - rightLen));
        return [`${border} ${fallback}${padding}${rightPart} ${border}`];
      }

      const cmdLines = rawCmd.split("\n");
      const allWrapped: string[] = [];

      for (const cmdLine of cmdLines) {
        if (allWrapped.length === 0) {
          const wrapped = wrapTextWithAnsi(cmdLine, firstLineWidth);
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
          const wrapped = wrapTextWithAnsi(cmdLine, contLineWidth);
          allWrapped.push(...(wrapped.length > 0 ? wrapped : [""]));
        }
      }

      const resultLines: string[] = [];
      for (let i = 0; i < allWrapped.length; i++) {
        const line = allWrapped[i];
        if (i === 0) {
          const lineContent = `${prefix}${rgb("white", line)}`;
          const lineLen = visibleWidth(lineContent);
          const padding = " ".repeat(Math.max(0, innerW - lineLen - rightLen));
          resultLines.push(`${border} ${lineContent}${padding}${rightPart} ${border}`);
        } else {
          const lineContent = `${indent}${rgb("white", line)}`;
          const lineLen = visibleWidth(lineContent);
          const padding = " ".repeat(Math.max(0, innerW - lineLen));
          resultLines.push(`${border} ${lineContent}${padding} ${border}`);
        }
      }

      return resultLines.length > 0
        ? resultLines
        : [
            `${border} ${prefix}${" ".repeat(Math.max(0, innerW - prefixLen - rightLen))}${rightPart} ${border}`,
          ];
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
        const dur = completedDurations.get(sig) ?? (status !== "running" ? 0 : elapsed);
        const timerStr = dur >= 1000 ? ` ${(dur / 1000).toFixed(1)}s` : "";

        const innerW = width - 4;
        const border = rgb(color, "│");

        const statusStr = rgb(color, sym);
        const timerColored = rgb("dim", timerStr);
        const rightPart = `${statusStr}${timerColored}`;
        const rightLen = visibleWidth(rightPart);

        // For bash: render multiline with full command, no truncation
        if (toolName === "bash") {
          const rawCmd = typeof args.command === "string" ? args.command : "";
          const lines = renderBashMultilineForPatch(
            rawCmd,
            icon,
            color,
            border,
            rightPart,
            rightLen,
            innerW,
            status,
            pulsePhase
          );
          if (tool._mu_leading_space) {
            return ["", ...lines];
          }
          return lines;
        }

        // Default: single-line truncated rendering for other tools
        const leftMax = innerW - rightLen - 1;

        // Apply pulsing effect to icon and name when running
        let iconColored: string;
        let nameColored: string;
        if (status === "running") {
          const brightness =
            MU_CONFIG.PULSE_MIN_BRIGHTNESS +
            (1 - MU_CONFIG.PULSE_MIN_BRIGHTNESS) * (0.5 + 0.5 * Math.sin(pulsePhase));
          iconColored = rgbPulse(color, icon, brightness);
          nameColored = rgbPulse(color, toolName, brightness);
        } else {
          iconColored = rgb(color, icon);
          nameColored = rgb(color, toolName);
        }

        const argsPreview = formatToolArgsPreview(toolName, args);
        const argsColored = rgb("dim", ` ${argsPreview}`);
        const leftContent = `${iconColored} ${nameColored}${argsColored}`;
        const leftTrunc = truncateToWidth(leftContent, leftMax);
        const leftLen = visibleWidth(leftTrunc);

        const padding = " ".repeat(Math.max(0, innerW - leftLen - rightLen));
        const line = `${border} ${leftTrunc}${padding}${rightPart} ${border}`;

        // Add leading blank line if this tool follows a user message
        if (tool._mu_leading_space) {
          return ["", line];
        }
        return [line];
      };

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
        .slice(0, 2)
        .map(([k, v]) => `${k}=${preview(String(v), 20)}`)
        .join(" ");
  }
}

// =============================================================================
// MAIN EXTENSION
// =============================================================================
export default function (pi: ExtensionAPI) {
  // Setup UI patching on session start
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    setupUIPatching(ctx);
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
    activeToolsBySig.set(sig, state);
  });

  pi.on("tool_result", (event: ToolResultEvent, _ctx: ExtensionContext) => {
    const { toolCallId, isError, content } = event;
    const state = activeToolsById.get(toolCallId);
    if (!state) return;

    const duration = Date.now() - state.startTime;
    state.duration = duration;
    state.status = isError ? "failed" : "success";

    completedDurations.set(state.sig, duration);
    fullToolResultContentById.set(toolCallId, content);

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
      const removed = toolResultOptions.shift();
      if (removed) fullToolResultContentById.delete(removed.key);
    }

    if (completedDurations.size > MU_CONFIG.MAX_COMPLETED_DURATIONS) {
      const first = completedDurations.keys().next().value;
      if (first) completedDurations.delete(first);
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
      const colorMap: Record<string, ColorKey> = {
        accent: "orange",
        text: "white",
        dim: "dim",
        success: "green",
        error: "red",
        warning: "yellow",
      };
      const c = C[colorMap[color] ?? (color as ColorKey)];
      return c ? rgbRaw(c.r, c.g, c.b, text) : text;
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
}
