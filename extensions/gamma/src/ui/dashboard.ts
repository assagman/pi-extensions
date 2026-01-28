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
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { Analyzer } from "../analyzer.js";
import type { NormalizedToolSchema } from "../schema-capture.js";
import type { DashboardState, TokenAnalysis, TokenCategory } from "../types.js";
import { CATEGORY_META } from "../types.js";
import { renderBarChart, renderProgressBar } from "./charts.js";

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

function padRight(text: string, width: number): string {
  const vis = visibleWidth(text);
  if (vis >= width) return text;
  return text + " ".repeat(width - vis);
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
  private showDiscrepancy = false;

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
  }

  handleInput(key: string): boolean {
    if (matchesKey(key, "q") || matchesKey(key, "escape")) {
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
    if (matchesKey(key, "up") || matchesKey(key, "k")) {
      this.selectPrevCategory();
      return true;
    }
    if (matchesKey(key, "down") || matchesKey(key, "j")) {
      this.selectNextCategory();
      return true;
    }
    if (matchesKey(key, "pageUp")) {
      this.scrollDetail(-5);
      return true;
    }
    if (matchesKey(key, "pageDown")) {
      this.scrollDetail(5);
      return true;
    }
    return false;
  }

  private selectPrevCategory(): void {
    if (!this.state.analysis) return;
    const cats = this.state.analysis.categories;
    if (this.selectedIndex > 0) {
      this.selectedIndex--;
      this.state.selectedCategory = cats[this.selectedIndex].category;
      this.detailScrollOffset = 0;
      this._invalidate?.();
    }
  }

  private selectNextCategory(): void {
    if (!this.state.analysis) return;
    const cats = this.state.analysis.categories;
    if (this.selectedIndex < cats.length - 1) {
      this.selectedIndex++;
      this.state.selectedCategory = cats[this.selectedIndex].category;
      this.detailScrollOffset = 0;
      this._invalidate?.();
    }
  }

  private scrollDetail(delta: number): void {
    this.detailScrollOffset = Math.max(0, this.detailScrollOffset + delta);
    this._invalidate?.();
  }

  render(width: number): string[] {
    const height = this.tui.terminal.rows || 24;

    if (this.state.isLoading) {
      return this.renderCentered(width, height, dim("⏳ Analyzing context window..."));
    }
    if (this.state.error || !this.state.analysis) {
      return this.renderCentered(width, height, red(`❌ ${this.state.error ?? "Unknown error"}`));
    }

    if (this.showDiscrepancy && this.state.analysis.discrepancy) {
      return this.renderDiscrepancyView(width, height, this.state.analysis);
    }

    return this.renderMain(width, height, this.state.analysis);
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
        `${muted(V)} ${padRight(left, LEFT_W - 2)}${muted(V)} ${padRight(right, rightW - 3)} ${muted(V)}`
      );
    }

    // ── Bottom border ──
    lines.push(muted(BL + H.repeat(LEFT_W - 1) + T_UP + H.repeat(rightW - 1) + BR));

    // ── Footer ──
    lines.push(this.renderFooter(width, analysis));

    return lines;
  }

  private renderHeaderLeft(_w: number, _analysis: TokenAnalysis): string {
    return bold(white("󰊤 GAMMA"));
  }

  private renderHeaderRight(w: number, analysis: TokenAnalysis): string {
    const model = `${analysis.model.provider}:${analysis.model.modelId}`;
    return padRight(dim(model), w);
  }

  private renderUsageLeft(w: number, analysis: TokenAnalysis): string {
    const pct = `${analysis.usagePercent.toFixed(1)}%`;
    const barW = Math.max(8, w - 8);
    const bar = renderProgressBar(analysis.usagePercent, barW);
    return `${bar} ${colorPct(analysis.usagePercent, pct)}`;
  }

  private renderUsageRight(w: number, analysis: TokenAnalysis): string {
    const used = analysis.totalTokens.toLocaleString();
    const max = formatCompact(analysis.contextWindow);
    const remaining = analysis.contextWindow - analysis.totalTokens;
    const remStr = formatCompact(remaining);
    const text = `${white(used)} / ${dim(max)}  ${dim("remaining:")} ${green(remStr)}`;
    return padRight(text, w);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEFT BODY: Categories + Timeline
  // ─────────────────────────────────────────────────────────────────────────

  private renderLeftBody(w: number, h: number, analysis: TokenAnalysis): string[] {
    const lines: string[] = [];

    // Section: CATEGORIES
    lines.push(dim("CATEGORIES"));

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
    const sources = analysis.sources
      .filter((s) => s.category === selectedCat)
      .sort((a, b) => b.tokens - a.tokens);

    // Header
    const headerIcon = categoryColor(selectedCat, meta.icon);
    const headerLabel = categoryColor(selectedCat, bold(meta.label));
    const headerStats = dim(
      `${catStat?.tokens.toLocaleString() ?? 0} tokens · ${catStat?.percent.toFixed(1) ?? 0}%`
    );
    lines.push(`${headerIcon} ${headerLabel}  ${headerStats}`);
    lines.push(dim(H.repeat(w)));

    // Column header
    const nameW = Math.max(20, w - 28);
    const barW = Math.max(8, w - nameW - 20);
    lines.push(
      `${dim("Source".padEnd(nameW))} ${dim("Tokens".padStart(8))} ${dim("%".padStart(6))}  ${dim("Share")}`
    );

    // Sources list
    if (sources.length === 0) {
      lines.push(dim("(no sources)"));
    } else {
      const viewH = h - 4; // header + divider + column header + scroll hint
      const maxScroll = Math.max(0, sources.length - viewH);
      this.detailScrollOffset = Math.min(this.detailScrollOffset, maxScroll);

      const visible = sources.slice(this.detailScrollOffset, this.detailScrollOffset + viewH);

      for (const src of visible) {
        const name = src.label.slice(0, nameW - 1).padEnd(nameW);
        const tokens = src.tokens.toLocaleString().padStart(8);
        const pct = `${src.percent.toFixed(1).padStart(5)}%`;
        const shareOfCat = catStat && catStat.tokens > 0 ? (src.tokens / catStat.tokens) * 100 : 0;
        const bar = renderBarChart(shareOfCat, barW, meta.color);

        lines.push(`${white(name)} ${white(tokens)} ${dim(pct)}  ${bar}`);
      }

      // Scroll indicator
      if (sources.length > viewH) {
        const from = this.detailScrollOffset + 1;
        const to = Math.min(this.detailScrollOffset + viewH, sources.length);
        lines.push(dim(`[PgUp/Dn] ${from}-${to} of ${sources.length}`));
      }
    }

    // Pad to height
    while (lines.length < h) {
      lines.push("");
    }

    return lines.slice(0, h);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FOOTER
  // ─────────────────────────────────────────────────────────────────────────

  private renderFooter(width: number, analysis: TokenAnalysis): string {
    const keys = dim("[↑↓/jk] nav  [PgUp/Dn] scroll  [q] quit");

    let discHint = "";
    if (analysis.discrepancy) {
      const diff = analysis.discrepancy.difference;
      const sign = diff > 0 ? "+" : "";
      discHint = yellow(`⚠ ${sign}${diff.toLocaleString()} tokens unmapped `) + dim("[d] details");
    }

    const left = ` ${keys}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(discHint) - 2);
    return `${left}${" ".repeat(gap)}${discHint} `;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DISCREPANCY VIEW
  // ─────────────────────────────────────────────────────────────────────────

  private renderDiscrepancyView(width: number, height: number, analysis: TokenAnalysis): string[] {
    const disc = analysis.discrepancy;
    if (!disc) return this.renderCentered(width, height, dim("No discrepancy data"));
    const lines: string[] = [];

    // Top border
    lines.push(muted(TL + H.repeat(width - 2) + TR));

    // Title
    const title = bold(yellow(" ⚠ Token Count Discrepancy Analysis"));
    lines.push(
      muted(V) + title + " ".repeat(Math.max(0, width - visibleWidth(title) - 3)) + muted(V)
    );
    lines.push(muted(V) + " ".repeat(width - 2) + muted(V));

    // Summary
    const counted = `Counted:   ${white(disc.counted.toLocaleString())}`;
    const reported = `Reported:  ${white(disc.reported.toLocaleString())}`;
    const diffSign = disc.difference > 0 ? "+" : "";
    const diffLine = `Delta:     ${yellow(diffSign + disc.difference.toLocaleString())} ${dim(`(${disc.percentDiff.toFixed(1)}%)`)}`;

    lines.push(
      `${muted(V)}  ${counted}${" ".repeat(Math.max(0, width - visibleWidth(counted) - 5))}${muted(V)}`
    );
    lines.push(
      `${muted(V)}  ${reported}${" ".repeat(Math.max(0, width - visibleWidth(reported) - 5))}${muted(V)}`
    );
    lines.push(
      `${muted(V)}  ${diffLine}${" ".repeat(Math.max(0, width - visibleWidth(diffLine) - 5))}${muted(V)}`
    );
    lines.push(muted(V) + " ".repeat(width - 2) + muted(V));

    // Sources header
    const sourcesHeader = dim("  Potential Sources:");
    lines.push(
      muted(V) +
        sourcesHeader +
        " ".repeat(Math.max(0, width - visibleWidth(sourcesHeader) - 3)) +
        muted(V)
    );
    lines.push(muted(V) + " ".repeat(width - 2) + muted(V));

    // Sources list
    for (const src of disc.sources) {
      const confColor =
        src.confidence === "high" ? red : src.confidence === "medium" ? yellow : dim;
      const badge = confColor(`[${src.confidence[0].toUpperCase()}]`);
      const name = white(src.name);
      const impact = dim(`±${src.estimatedImpact.toLocaleString()} tokens`);

      const line1 = `  ${badge} ${name}  ${impact}`;
      lines.push(
        muted(V) + line1 + " ".repeat(Math.max(0, width - visibleWidth(line1) - 3)) + muted(V)
      );

      const reasonLine = `      ${dim(src.reason.slice(0, width - 10))}`;
      lines.push(
        muted(V) +
          reasonLine +
          " ".repeat(Math.max(0, width - visibleWidth(reasonLine) - 3)) +
          muted(V)
      );
    }

    // Fill remaining space
    while (lines.length < height - 2) {
      lines.push(muted(V) + " ".repeat(width - 2) + muted(V));
    }

    // Bottom border
    lines.push(muted(BL + H.repeat(width - 2) + BR));

    // Footer
    lines.push(dim(" [d] back  [q] quit"));

    return lines;
  }
}
