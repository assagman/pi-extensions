/**
 * Gamma Dashboard — Full-screen TUI Component
 *
 * Clean card-inspired design with:
 * - Header: Model + Usage bar
 * - Left pane: Category nav (selectable) + Timeline
 * - Right pane: Sources for selected category
 * - Footer: Keybindings + Discrepancy hint
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Analyzer } from "../analyzer.js";
import type { NormalizedToolSchema } from "../schema-capture.js";
import type { DashboardState, TokenAnalysis, TokenCategory, TokenSource } from "../types.js";
import { CATEGORY_META } from "../types.js";
import { renderBarChart, renderProgressBar } from "./charts.js";

// =============================================================================
// DISPLAY ROW (flattened source with hierarchy info)
// =============================================================================

interface DisplayRow {
  label: string;
  tokens: number;
  percent: number;
  isChild: boolean;
  isGroupHeader: boolean;
  /** Reference to the source for content viewing */
  source: TokenSource;
}

// =============================================================================
// VISUAL CONSTANTS
// =============================================================================

const REVERSE = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";

// Left pane width (fixed)
const LEFT_W = 26;

// =============================================================================
// COLOR UTILITIES
// =============================================================================

const rgb = (r: number, g: number, b: number, text: string): string =>
  `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;

const dim = (text: string): string => rgb(100, 100, 100, text);
const muted = (text: string): string => rgb(140, 140, 140, text);
const white = (text: string): string => rgb(220, 220, 220, text);
const yellow = (text: string): string => rgb(254, 211, 48, text);
const red = (text: string): string => rgb(238, 90, 82, text);
const green = (text: string): string => rgb(38, 222, 129, text);
const _cyan = (text: string): string => rgb(34, 211, 238, text);
const bold = (text: string): string => `\x1b[1m${text}\x1b[22m`;

const categoryColor = (category: TokenCategory, text: string): string => {
  const { r, g, b } = CATEGORY_META[category].color;
  return rgb(r, g, b, text);
};

// Box drawing
const H = "─";
const V = "│";
const TL = "╭";
const TR = "╮";
const BL = "╰";
const BR = "╯";
const T_DOWN = "┬";
const T_UP = "┴";
const T_RIGHT = "├";
const T_LEFT = "┤";

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Fit text to exact visible width: truncate if too long, pad if too short.
 * Handles ANSI escape codes correctly.
 */
function fitToWidth(text: string, width: number): string {
  return truncateToWidth(text, width, "…", true);
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function colorPct(pct: number, text: string): string {
  if (pct >= 90) return red(text);
  if (pct >= 70) return yellow(text);
  return green(text);
}

// =============================================================================
// DASHBOARD COMPONENT
// =============================================================================

export class Dashboard implements Component {
  private state: DashboardState;
  private _invalidate?: () => void;
  private selectedIndex = 0;
  private detailScrollOffset = 0;
  private detailSelectedIndex = 0;
  private showDiscrepancy = false;
  private focusedPane: "left" | "right" = "left";
  private cachedDisplayRowCount = 0;
  /** Currently displayed content source (null = not in content view) */
  private contentViewSource: TokenSource | null = null;
  private contentScrollOffset = 0;
  /** Cached display rows for source resolution */
  private cachedDisplayRows: DisplayRow[] = [];

  constructor(
    private tui: TUI,
    private _theme: unknown,
    private _keybindings: unknown,
    private done: (result: unknown) => void,
    private ctx: ExtensionContext,
    private analyzer: Analyzer,
    private systemPrompt: string | null,
    private capturedSchemas: Map<string, NormalizedToolSchema> | null
  ) {
    this.state = {
      viewMode: "summary",
      scrollOffset: 0,
      selectedCategory: null,
      analysis: null,
      isLoading: true,
      error: null,
    };

    this.runAnalysis();
  }

  private async runAnalysis(): Promise<void> {
    try {
      const analysis = await this.analyzer.analyze(this.ctx, this.systemPrompt, {
        capturedSchemas: this.capturedSchemas,
      });
      this.state.analysis = analysis;
      this.state.isLoading = false;
      if (analysis.categories.length > 0) {
        this.state.selectedCategory = analysis.categories[0].category;
        this.selectedIndex = 0;
      }
      this._invalidate?.();
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : "Analysis failed";
      this.state.isLoading = false;
      this._invalidate?.();
    }
  }

  setInvalidate(fn: () => void): void {
    this._invalidate = fn;
  }

  invalidate(): void {
    this.detailScrollOffset = 0;
    this.detailSelectedIndex = 0;
  }

  handleInput(key: string): boolean {
    // ── Content view mode ──
    if (this.contentViewSource) {
      if (matchesKey(key, "escape") || matchesKey(key, "q")) {
        this.contentViewSource = null;
        this.contentScrollOffset = 0;
        this._invalidate?.();
        return true;
      }
      if (matchesKey(key, "up") || matchesKey(key, "k")) {
        if (this.contentScrollOffset > 0) {
          this.contentScrollOffset--;
          this._invalidate?.();
        }
        return true;
      }
      if (matchesKey(key, "down") || matchesKey(key, "j")) {
        this.contentScrollOffset++;
        this._invalidate?.();
        return true;
      }
      if (matchesKey(key, "pageUp")) {
        this.contentScrollOffset = Math.max(0, this.contentScrollOffset - 20);
        this._invalidate?.();
        return true;
      }
      if (matchesKey(key, "pageDown")) {
        this.contentScrollOffset += 20;
        this._invalidate?.();
        return true;
      }
      if (matchesKey(key, "g")) {
        this.contentScrollOffset = 0;
        this._invalidate?.();
        return true;
      }
      return true; // Consume all keys in content view
    }

    // ── Discrepancy view / main view ──
    if (matchesKey(key, "q") || matchesKey(key, "escape")) {
      if (this.showDiscrepancy) {
        this.showDiscrepancy = false;
        this._invalidate?.();
        return true;
      }
      this.done(null);
      return true;
    }
    if (matchesKey(key, "d")) {
      if (this.state.analysis?.discrepancy) {
        this.showDiscrepancy = !this.showDiscrepancy;
        this._invalidate?.();
      }
      return true;
    }

    // Enter: open content viewer for selected source
    if (matchesKey(key, "return")) {
      if (this.focusedPane === "right" && this.cachedDisplayRows.length > 0) {
        const row = this.cachedDisplayRows[this.detailSelectedIndex];
        if (row?.source) {
          // For tools, we can show schema even without content
          const isTool = row.source.category === "tools";
          const hasContent = row.source.content;
          const hasSchema = isTool && this.capturedSchemas?.has(row.source.label);

          if (hasContent || hasSchema) {
            this.contentViewSource = row.source;
            this.contentScrollOffset = 0;
            this._invalidate?.();
          }
        }
      }
      return true;
    }

    // Pane focus: h/← → left, l/→ → right
    if (matchesKey(key, "h") || matchesKey(key, "left")) {
      if (this.focusedPane !== "left") {
        this.focusedPane = "left";
        this._invalidate?.();
      }
      return true;
    }
    if (matchesKey(key, "l") || matchesKey(key, "right")) {
      if (this.focusedPane !== "right") {
        this.focusedPane = "right";
        this._invalidate?.();
      }
      return true;
    }

    // Vertical nav: routed by focused pane
    if (matchesKey(key, "up") || matchesKey(key, "k")) {
      if (this.focusedPane === "left") {
        this.selectPrevCategory();
      } else {
        this.selectPrevDetailRow();
      }
      return true;
    }
    if (matchesKey(key, "down") || matchesKey(key, "j")) {
      if (this.focusedPane === "left") {
        this.selectNextCategory();
      } else {
        this.selectNextDetailRow();
      }
      return true;
    }
    if (matchesKey(key, "pageUp")) {
      if (this.focusedPane === "left") {
        this.selectCategoryPage(-5);
      } else {
        this.selectDetailPage(-10);
      }
      return true;
    }
    if (matchesKey(key, "pageDown")) {
      if (this.focusedPane === "left") {
        this.selectCategoryPage(5);
      } else {
        this.selectDetailPage(10);
      }
      return true;
    }
    return false;
  }

  // ── Left pane navigation ──

  private selectPrevCategory(): void {
    if (!this.state.analysis) return;
    const cats = this.state.analysis.categories;
    if (this.selectedIndex > 0) {
      this.selectedIndex--;
      this.state.selectedCategory = cats[this.selectedIndex].category;
      this.resetDetailSelection();
      this._invalidate?.();
    }
  }

  private selectNextCategory(): void {
    if (!this.state.analysis) return;
    const cats = this.state.analysis.categories;
    if (this.selectedIndex < cats.length - 1) {
      this.selectedIndex++;
      this.state.selectedCategory = cats[this.selectedIndex].category;
      this.resetDetailSelection();
      this._invalidate?.();
    }
  }

  private selectCategoryPage(delta: number): void {
    if (!this.state.analysis) return;
    const cats = this.state.analysis.categories;
    const maxIdx = cats.length - 1;
    const newIdx = Math.max(0, Math.min(maxIdx, this.selectedIndex + delta));
    if (newIdx !== this.selectedIndex) {
      this.selectedIndex = newIdx;
      this.state.selectedCategory = cats[newIdx].category;
      this.resetDetailSelection();
      this._invalidate?.();
    }
  }

  // ── Right pane navigation ──

  private selectPrevDetailRow(): void {
    if (this.detailSelectedIndex > 0) {
      this.detailSelectedIndex--;
      this._invalidate?.();
    }
  }

  private selectNextDetailRow(): void {
    const maxIdx = Math.max(0, this.cachedDisplayRowCount - 1);
    if (this.detailSelectedIndex < maxIdx) {
      this.detailSelectedIndex++;
      this._invalidate?.();
    }
  }

  private selectDetailPage(delta: number): void {
    const maxIdx = Math.max(0, this.cachedDisplayRowCount - 1);
    this.detailSelectedIndex = Math.max(0, Math.min(maxIdx, this.detailSelectedIndex + delta));
    this._invalidate?.();
  }

  private resetDetailSelection(): void {
    this.detailScrollOffset = 0;
    this.detailSelectedIndex = 0;
  }

  render(width: number): string[] {
    const height = this.tui.terminal.rows || 24;

    let lines: string[];

    if (this.state.isLoading) {
      lines = this.renderCentered(width, height, dim("⏳ Analyzing context window..."));
    } else if (this.state.error || !this.state.analysis) {
      lines = this.renderCentered(width, height, red(`❌ ${this.state.error ?? "Unknown error"}`));
    } else if (this.contentViewSource) {
      lines = this.renderContentView(width, height, this.contentViewSource);
    } else if (this.showDiscrepancy && this.state.analysis.discrepancy) {
      lines = this.renderDiscrepancyView(width, height, this.state.analysis);
    } else {
      lines = this.renderMain(width, height, this.state.analysis);
    }

    // Safety net: ensure no line exceeds terminal width
    return lines.map((line) => {
      if (visibleWidth(line) > width) {
        return truncateToWidth(line, width, "…");
      }
      return line;
    });
  }

  private renderCentered(width: number, height: number, msg: string): string[] {
    const lines: string[] = [];
    const cy = Math.floor(height / 2);
    for (let i = 0; i < height; i++) {
      if (i === cy) {
        const pad = Math.max(0, Math.floor((width - visibleWidth(msg)) / 2));
        lines.push(" ".repeat(pad) + msg);
      } else {
        lines.push("");
      }
    }
    return lines;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN VIEW
  // ─────────────────────────────────────────────────────────────────────────

  private renderMain(width: number, height: number, analysis: TokenAnalysis): string[] {
    const lines: string[] = [];
    const rightW = width - LEFT_W - 1; // -1 for vertical divider

    // ── Row 0: Top border ──
    lines.push(muted(TL + H.repeat(LEFT_W - 1) + T_DOWN + H.repeat(rightW - 1) + TR));

    // ── Row 1: Header ──
    const headerLeft = this.renderHeaderLeft(LEFT_W - 2, analysis);
    const headerRight = this.renderHeaderRight(rightW - 3, analysis);
    lines.push(`${muted(V)} ${headerLeft}${muted(V)} ${headerRight} ${muted(V)}`);

    // ── Row 2: Usage bar ──
    const usageLeft = this.renderUsageLeft(LEFT_W - 2, analysis);
    const usageRight = this.renderUsageRight(rightW - 3, analysis);
    lines.push(`${muted(V)} ${usageLeft}${muted(V)} ${usageRight} ${muted(V)}`);

    // ── Row 3: Section divider ──
    lines.push(muted(`${T_RIGHT}${H.repeat(LEFT_W - 1)}┼${H.repeat(rightW - 1)}${T_LEFT}`));

    // ── Body rows ──
    const bodyHeight = height - 6; // header(3) + footer(2) + borders
    const leftBody = this.renderLeftBody(LEFT_W - 2, bodyHeight, analysis);
    const rightBody = this.renderRightBody(rightW - 3, bodyHeight, analysis);

    for (let i = 0; i < bodyHeight; i++) {
      const left = leftBody[i] ?? "";
      const right = rightBody[i] ?? "";
      lines.push(
        `${muted(V)} ${fitToWidth(left, LEFT_W - 2)}${muted(V)} ${fitToWidth(right, rightW - 3)} ${muted(V)}`
      );
    }

    // ── Bottom border ──
    lines.push(muted(BL + H.repeat(LEFT_W - 1) + T_UP + H.repeat(rightW - 1) + BR));

    // ── Footer ──
    lines.push(this.renderFooter(width, analysis));

    return lines;
  }

  private renderHeaderLeft(w: number, _analysis: TokenAnalysis): string {
    return fitToWidth(bold(white("󰊤 GAMMA")), w);
  }

  private renderHeaderRight(w: number, analysis: TokenAnalysis): string {
    const model = `${analysis.model.provider}:${analysis.model.modelId}`;
    return fitToWidth(dim(model), w);
  }

  private renderUsageLeft(w: number, analysis: TokenAnalysis): string {
    const pct = `${analysis.usagePercent.toFixed(1)}%`;
    const barW = Math.max(8, w - 8);
    const bar = renderProgressBar(analysis.usagePercent, barW);
    return fitToWidth(`${bar} ${colorPct(analysis.usagePercent, pct)}`, w);
  }

  private renderUsageRight(w: number, analysis: TokenAnalysis): string {
    const used = analysis.totalTokens.toLocaleString();
    const max = formatCompact(analysis.contextWindow);
    const remaining = analysis.contextWindow - analysis.totalTokens;
    const remStr = formatCompact(remaining);
    const text = `${white(used)} / ${dim(max)}  ${dim("remaining:")} ${green(remStr)}`;
    return fitToWidth(text, w);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEFT BODY: Categories + Timeline
  // ─────────────────────────────────────────────────────────────────────────

  private renderLeftBody(w: number, h: number, analysis: TokenAnalysis): string[] {
    const lines: string[] = [];

    // Section: CATEGORIES
    lines.push(this.focusedPane === "left" ? white("CATEGORIES") : dim("CATEGORIES"));

    for (let i = 0; i < analysis.categories.length; i++) {
      const cat = analysis.categories[i];
      const meta = CATEGORY_META[cat.category];
      const isSelected = i === this.selectedIndex;

      const tokens = formatCompact(cat.tokens);
      const pct = `${cat.percent.toFixed(0)}%`;
      let line = `${meta.icon} ${meta.label.padEnd(9)} ${tokens.padStart(5)} ${dim(pct.padStart(4))}`;

      if (isSelected) {
        line = `${REVERSE}${categoryColor(cat.category, line)}${REVERSE_OFF}`;
      } else {
        line = categoryColor(cat.category, line);
      }

      lines.push(line);
    }

    // Gap before timeline
    const timelineStart = Math.max(lines.length + 1, h - 7);
    while (lines.length < timelineStart) {
      lines.push("");
    }

    // Section: TIMELINE
    lines.push(dim("TIMELINE"));

    const turns = analysis.turnBreakdown.slice(-5); // Last 5 turns
    const maxCum = analysis.contextWindow;
    const barW = w - 8;

    for (const turn of turns) {
      const cumPct = (turn.cumulativeTokens / maxCum) * 100;
      const bar = renderProgressBar(cumPct, barW);
      const label = turn.label.slice(0, 4).padEnd(4);
      lines.push(`${dim(label)} ${bar}`);
    }

    // Pad to height
    while (lines.length < h) {
      lines.push("");
    }

    return lines.slice(0, h);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RIGHT BODY: Sources for selected category
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build a flat display list from sources, expanding children inline.
   * Sources with children produce: group header row + indented child rows.
   */
  private buildDisplayRows(sources: TokenSource[]): DisplayRow[] {
    const rows: DisplayRow[] = [];
    for (const src of sources) {
      if (src.children && src.children.length > 0) {
        // Group header — shows aggregate, visually distinct
        rows.push({
          label: src.label,
          tokens: src.tokens,
          percent: src.percent,
          isChild: false,
          isGroupHeader: true,
          source: src,
        });
        // Children — indented, sorted by tokens desc (already sorted in analyzer)
        for (const child of src.children) {
          rows.push({
            label: child.label,
            tokens: child.tokens,
            percent: child.percent,
            isChild: true,
            isGroupHeader: false,
            source: child,
          });
        }
      } else {
        rows.push({
          label: src.label,
          tokens: src.tokens,
          percent: src.percent,
          isChild: false,
          isGroupHeader: false,
          source: src,
        });
      }
    }
    return rows;
  }

  private renderRightBody(w: number, h: number, analysis: TokenAnalysis): string[] {
    const lines: string[] = [];
    const selectedCat = this.state.selectedCategory;

    if (!selectedCat) {
      lines.push(dim("Select a category"));
      while (lines.length < h) lines.push("");
      return lines;
    }

    const meta = CATEGORY_META[selectedCat];
    const catStat = analysis.categories.find((c) => c.category === selectedCat);
    const catTokens = catStat?.tokens ?? 0;
    const sources = analysis.sources
      .filter((s) => s.category === selectedCat)
      .sort((a, b) => b.tokens - a.tokens);

    // Header (brighter divider when focused)
    const headerIcon = categoryColor(selectedCat, meta.icon);
    const headerLabel = categoryColor(selectedCat, bold(meta.label));
    const headerStats = dim(
      `${catStat?.tokens.toLocaleString() ?? 0} tokens · ${catStat?.percent.toFixed(1) ?? 0}%`
    );
    lines.push(truncateToWidth(`${headerIcon} ${headerLabel}  ${headerStats}`, w, "…"));
    const dividerColor = this.focusedPane === "right" ? muted : dim;
    lines.push(dividerColor(H.repeat(w)));

    // Column header
    const nameW = Math.max(20, w - 28);
    const barW = Math.max(8, w - nameW - 20);
    lines.push(
      truncateToWidth(
        `${dim("Source".padEnd(nameW))} ${dim("Tokens".padStart(8))} ${dim("%".padStart(6))}  ${dim("Share")}`,
        w,
        "…"
      )
    );

    // Build flattened display rows (expands children inline)
    const displayRows = this.buildDisplayRows(sources);
    this.cachedDisplayRows = displayRows;
    this.cachedDisplayRowCount = displayRows.length;

    // Sources list
    if (displayRows.length === 0) {
      lines.push(dim("(no sources)"));
    } else {
      const viewH = h - 4; // header + divider + column header + scroll hint

      // Clamp selection to valid range
      this.detailSelectedIndex = Math.min(
        this.detailSelectedIndex,
        Math.max(0, displayRows.length - 1)
      );

      // Auto-scroll to keep selection visible when right pane focused
      if (this.focusedPane === "right") {
        if (this.detailSelectedIndex < this.detailScrollOffset) {
          this.detailScrollOffset = this.detailSelectedIndex;
        } else if (this.detailSelectedIndex >= this.detailScrollOffset + viewH) {
          this.detailScrollOffset = this.detailSelectedIndex - viewH + 1;
        }
      }

      const maxScroll = Math.max(0, displayRows.length - viewH);
      this.detailScrollOffset = Math.min(this.detailScrollOffset, maxScroll);

      const visible = displayRows.slice(this.detailScrollOffset, this.detailScrollOffset + viewH);
      const rightFocused = this.focusedPane === "right";

      for (let i = 0; i < visible.length; i++) {
        const row = visible[i];
        const absIdx = this.detailScrollOffset + i;
        const isCursor = rightFocused && absIdx === this.detailSelectedIndex;

        const indent = row.isGroupHeader ? "▾ " : row.isChild ? "  " : "";
        const labelW = nameW - indent.length;
        const name = indent + truncateToWidth(row.label, Math.max(1, labelW - 1), "…");
        const paddedName = fitToWidth(name, nameW);
        const tokensStr = row.tokens.toLocaleString();
        const tokens =
          tokensStr.length > 8 ? formatCompact(row.tokens).padStart(8) : tokensStr.padStart(8);
        const pct = `${row.percent.toFixed(1).padStart(5)}%`;
        const shareOfCat = catTokens > 0 ? (row.tokens / catTokens) * 100 : 0;
        const bar = renderBarChart(shareOfCat, barW, meta.color);

        let sourceLine: string;
        if (isCursor) {
          // Cursor row: reverse-video name in category color
          const highlighted = `${REVERSE}${categoryColor(selectedCat, paddedName)}${REVERSE_OFF}`;
          sourceLine = `${highlighted} ${white(tokens)} ${dim(pct)}  ${bar}`;
        } else if (row.isGroupHeader) {
          sourceLine = `${muted(paddedName)} ${muted(tokens)} ${dim(pct)}  ${bar}`;
        } else {
          sourceLine = `${white(paddedName)} ${white(tokens)} ${dim(pct)}  ${bar}`;
        }
        lines.push(truncateToWidth(sourceLine, w, "…"));
      }

      // Scroll indicator
      if (displayRows.length > viewH) {
        const from = this.detailScrollOffset + 1;
        const to = Math.min(this.detailScrollOffset + viewH, displayRows.length);
        lines.push(dim(`${from}-${to} of ${displayRows.length}`));
      }
    }

    // Pad to height
    while (lines.length < h) {
      lines.push("");
    }

    return lines.slice(0, h);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONTENT VIEW
  // ─────────────────────────────────────────────────────────────────────────

  private renderContentView(width: number, height: number, source: TokenSource): string[] {
    const lines: string[] = [];
    const innerW = width - 2; // borders

    // Top border
    lines.push(muted(TL + H.repeat(innerW) + TR));

    // Title bar
    const cat = source.category;
    const icon = CATEGORY_META[cat].icon;
    const title = categoryColor(cat, `${icon} ${bold(source.label)}`);
    const stats = dim(`${source.tokens.toLocaleString()} tokens · ${source.percent.toFixed(1)}%`);
    const titleLine = ` ${title}  ${stats}`;
    lines.push(`${muted(V)}${fitToWidth(titleLine, innerW)}${muted(V)}`);

    // Separator
    lines.push(muted(`${T_RIGHT}${H.repeat(innerW)}${T_LEFT}`));

    // Content area
    const contentH = height - 5; // top border + title + separator + bottom border + footer

    // ── Special handling for tool sources ──
    if (source.category === "tools") {
      let formatted: string[] = [];

      if (this.capturedSchemas) {
        const toolName = source.label; // Tool label is the tool name
        const schema = this.capturedSchemas.get(toolName);

        if (schema) {
          formatted = this.renderToolSchema(schema, innerW - 2, contentH);
        } else {
          // Schema not found - show available schemas for debugging
          const available = Array.from(this.capturedSchemas.keys()).join(", ");
          formatted = [
            red("Schema not found"),
            "",
            `Looking for: ${yellow(toolName)}`,
            "",
            dim("Available schemas:"),
            ...available.split(", ").map((name) => `  ${name}`),
          ];
        }
      } else {
        formatted = [
          yellow("No schemas captured"),
          "",
          dim("Tool schemas are captured from the first API request."),
          dim("If you're seeing this, schema capture may have failed."),
        ];
      }

      const maxScroll = Math.max(0, formatted.length - contentH);
      this.contentScrollOffset = Math.min(this.contentScrollOffset, maxScroll);
      const visible = formatted.slice(
        this.contentScrollOffset,
        this.contentScrollOffset + contentH
      );

      for (let i = 0; i < contentH; i++) {
        if (i < visible.length) {
          const row = ` ${visible[i]}`;
          lines.push(`${muted(V)}${fitToWidth(row, innerW)}${muted(V)}`);
        } else {
          lines.push(`${muted(V)}${" ".repeat(innerW)}${muted(V)}`);
        }
      }

      // Bottom border
      lines.push(muted(BL + H.repeat(innerW) + BR));

      // Footer
      const scrollInfo =
        formatted.length > contentH
          ? dim(
              ` ${this.contentScrollOffset + 1}-${Math.min(this.contentScrollOffset + contentH, formatted.length)} of ${formatted.length} lines`
            )
          : dim(` ${formatted.length} lines`);
      const footerKeys = dim("[j/k] scroll  [PgUp/Dn] page  [g] top  [Esc] back");
      const footerGap = Math.max(
        1,
        width - visibleWidth(scrollInfo) - visibleWidth(footerKeys) - 2
      );
      lines.push(
        truncateToWidth(`${scrollInfo}${" ".repeat(footerGap)}${footerKeys} `, width, "…")
      );

      return lines;
    }

    // ── Default content rendering ──
    const content = source.content ?? "(no content available)";
    const contentLines = content.split("\n");

    // Clamp scroll offset
    const maxScroll = Math.max(0, contentLines.length - contentH);
    this.contentScrollOffset = Math.min(this.contentScrollOffset, maxScroll);

    const lineNumW = String(contentLines.length).length;
    const textW = innerW - lineNumW - 3; // lineNum + " │ " + text

    const visible = contentLines.slice(
      this.contentScrollOffset,
      this.contentScrollOffset + contentH
    );

    for (let i = 0; i < contentH; i++) {
      if (i < visible.length) {
        const lineIdx = this.contentScrollOffset + i;
        const lineNum = dim(String(lineIdx + 1).padStart(lineNumW));
        const text = visible[i];
        const displayText = fitToWidth(text, textW);
        const row = ` ${lineNum} ${dim(V)} ${displayText}`;
        lines.push(`${muted(V)}${fitToWidth(row, innerW)}${muted(V)}`);
      } else {
        lines.push(`${muted(V)}${" ".repeat(innerW)}${muted(V)}`);
      }
    }

    // Bottom border
    lines.push(muted(BL + H.repeat(innerW) + BR));

    // Footer
    const scrollInfo =
      contentLines.length > contentH
        ? dim(
            ` ${this.contentScrollOffset + 1}-${Math.min(this.contentScrollOffset + contentH, contentLines.length)} of ${contentLines.length} lines`
          )
        : dim(` ${contentLines.length} lines`);
    const footerKeys = dim("[j/k] scroll  [PgUp/Dn] page  [g] top  [Esc] back");
    const footerGap = Math.max(1, width - visibleWidth(scrollInfo) - visibleWidth(footerKeys) - 2);
    lines.push(truncateToWidth(`${scrollInfo}${" ".repeat(footerGap)}${footerKeys} `, width, "…"));

    return lines;
  }

  /**
   * Render a formatted tool schema.
   */
  private renderToolSchema(schema: NormalizedToolSchema, width: number, _height: number): string[] {
    const lines: string[] = [];
    const indent = "  ";

    // Tool name
    lines.push(yellow(bold(schema.name)));
    lines.push("");

    // Description
    if (schema.description) {
      lines.push(white("Description:"));
      const descLines = this.wrapText(schema.description, width - indent.length);
      for (const line of descLines) {
        lines.push(indent + dim(line));
      }
      lines.push("");
    }

    // Schema tokens
    lines.push(white("Token cost: ") + green(schema.tokens.toString()));
    lines.push("");

    // Parameters
    const schemaObj = schema.schema as Record<string, unknown>;
    if (schemaObj && typeof schemaObj === "object") {
      lines.push(white("Parameters:"));

      const properties = (schemaObj.properties || {}) as Record<string, Record<string, unknown>>;
      const required = (schemaObj.required || []) as string[];

      if (Object.keys(properties).length === 0) {
        lines.push(indent + dim("(no parameters)"));
      } else {
        for (const [key, value] of Object.entries(properties)) {
          const isRequired = required.includes(key);
          const reqBadge = isRequired ? red("[required]") : dim("[optional]");
          const type = value.type ? dim(`<${value.type}>`) : "";

          lines.push(`${indent}${yellow(key)} ${type} ${reqBadge}`);

          if (value.description) {
            const descLines = this.wrapText(value.description, width - indent.length * 2);
            for (const line of descLines) {
              lines.push(indent + indent + dim(line));
            }
          }

          if (value.enum) {
            const enumStr = `Options: ${value.enum.join(", ")}`;
            const enumLines = this.wrapText(enumStr, width - indent.length * 2);
            for (const line of enumLines) {
              lines.push(indent + indent + muted(line));
            }
          }

          lines.push("");
        }
      }
    }

    return lines;
  }

  /**
   * Wrap text to fit within specified width.
   */
  private wrapText(text: string, width: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = "";

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (visibleWidth(testLine) <= width) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        currentLine = word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [""];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FOOTER
  // ─────────────────────────────────────────────────────────────────────────

  private renderFooter(width: number, analysis: TokenAnalysis): string {
    const paneHint = this.focusedPane === "left" ? "categories" : "sources";
    const enterHint = this.focusedPane === "right" ? "  [↵] view" : "";
    const keys = dim(`[h/l] pane  [j/k] ${paneHint}${enterHint}  [PgUp/Dn] page  [q] quit`);

    let discHint = "";
    if (analysis.discrepancy) {
      const diff = analysis.discrepancy.difference;
      const sign = diff > 0 ? "+" : "";
      discHint = yellow(`⚠ ${sign}${diff.toLocaleString()} tokens unmapped `) + dim("[d] details");
    }

    const left = ` ${keys}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(discHint) - 2);
    return truncateToWidth(`${left}${" ".repeat(gap)}${discHint} `, width, "…");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DISCREPANCY VIEW
  // ─────────────────────────────────────────────────────────────────────────

  private renderDiscrepancyView(width: number, height: number, analysis: TokenAnalysis): string[] {
    const disc = analysis.discrepancy;
    if (!disc) return this.renderCentered(width, height, dim("No discrepancy data"));
    const lines: string[] = [];
    const innerW = width - 2;

    /** Build a bordered line: │content│ fitted to exact width */
    const boxLine = (content: string): string =>
      `${muted(V)}${fitToWidth(content, innerW)}${muted(V)}`;

    // Top border
    lines.push(muted(TL + H.repeat(innerW) + TR));

    // Title
    const title = bold(yellow(" ⚠ Token Count Discrepancy Analysis"));
    lines.push(boxLine(title));
    lines.push(boxLine(""));

    // Summary
    const counted = `  Counted:   ${white(disc.counted.toLocaleString())}`;
    const reported = `  Reported:  ${white(disc.reported.toLocaleString())}`;
    const diffSign = disc.difference > 0 ? "+" : "";
    const diffLine = `  Delta:     ${yellow(diffSign + disc.difference.toLocaleString())} ${dim(`(${disc.percentDiff.toFixed(1)}%)`)}`;

    lines.push(boxLine(counted));
    lines.push(boxLine(reported));
    lines.push(boxLine(diffLine));
    lines.push(boxLine(""));

    // Sources header
    lines.push(boxLine(dim("  Potential Sources:")));
    lines.push(boxLine(""));

    // Sources list
    for (const src of disc.sources) {
      const confColor =
        src.confidence === "high" ? red : src.confidence === "medium" ? yellow : dim;
      const badge = confColor(`[${src.confidence[0].toUpperCase()}]`);
      const name = white(src.name);
      const impact = dim(`±${src.estimatedImpact.toLocaleString()} tokens`);

      lines.push(boxLine(`  ${badge} ${name}  ${impact}`));
      lines.push(
        boxLine(`      ${dim(truncateToWidth(src.reason, Math.max(1, innerW - 8), "…"))}`)
      );
    }

    // Fill remaining space
    while (lines.length < height - 2) {
      lines.push(boxLine(""));
    }

    // Bottom border
    lines.push(muted(BL + H.repeat(innerW) + BR));

    // Footer
    lines.push(truncateToWidth(dim(" [d] back  [q] quit"), width, "…"));

    return lines;
  }
}
