/**
 * Prune TUI — Full-screen dashboard for delta memory pruning.
 */

import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
  batchDeleteEpisodes,
  batchDeleteKV,
  batchDeleteNotes,
  getAllEpisodes,
  getAllKV,
  getAllNotes,
  getSessionId,
} from "../db.js";
import { type AnalyzeInput, analyze } from "./analyzer.js";
import type { PruneAnalysis, PruneCandidate } from "./types.js";
import { REASON_LABELS, REASON_RISK } from "./types.js";

// ============ Constants ============

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const _DIM = "\x1b[2m";
const _ITALIC = "\x1b[3m";

// Colors
const FG_WHITE = "\x1b[38;2;255;255;255m";
const FG_GRAY = "\x1b[38;2;150;150;150m";
const FG_DIM = "\x1b[38;2;100;100;100m";
const FG_GREEN = "\x1b[38;2;100;220;100m";
const FG_YELLOW = "\x1b[38;2;230;200;80m";
const FG_RED = "\x1b[38;2;230;80;80m";
const FG_CYAN = "\x1b[38;2;80;200;220m";
const _FG_PURPLE = "\x1b[38;2;180;100;220m";

const BG_SELECTED = "\x1b[48;2;40;45;60m";
const BG_HEADER = "\x1b[48;2;30;35;50m";

// Type colors
const TYPE_COLORS: Record<string, string> = {
  episode: "\x1b[38;2;100;180;230m",
  note: "\x1b[38;2;180;140;220m",
  kv: "\x1b[38;2;140;200;140m",
};

// Risk colors
const RISK_COLORS: Record<string, string> = {
  low: FG_GREEN,
  medium: FG_YELLOW,
  high: FG_RED,
};

// ============ View States ============

type ViewMode = "list" | "detail" | "confirm";

// ============ Dashboard Component ============

export class PruneDashboard implements Component {
  private analysis: PruneAnalysis | null = null;
  private isLoading = true;
  private error: string | null = null;

  private viewMode: ViewMode = "list";
  private selectedIndex = 0;
  private scrollOffset = 0;
  private contentHeight = 20;

  // Detail view
  private detailScrollOffset = 0;
  private detailMaxScroll = 0;

  // Confirm view
  private confirmSelection: "yes" | "no" = "no";

  constructor(
    private tui: TUI,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported
    private theme: any,
    // biome-ignore lint/suspicious/noExplicitAny: Keybindings type not exported
    private keybindings: any,
    // biome-ignore lint/suspicious/noExplicitAny: Callback type varies
    private done: (result: any) => void
  ) {
    this.init();
  }

  async init(): Promise<void> {
    try {
      // Gather all data
      const episodes = getAllEpisodes();
      const notes = getAllNotes();
      const kv = getAllKV();

      const input: AnalyzeInput = {
        episodes,
        notes,
        kv,
        currentSessionId: getSessionId(),
      };

      this.analysis = await analyze(input);
      this.isLoading = false;
      this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Analysis failed";
      this.isLoading = false;
      this.refresh();
    }
  }

  private refresh(): void {
    this.tui.requestRender(true);
  }

  // ============ Rendering ============

  render(width: number): string[] {
    const rows = this.tui.terminal.rows;
    this.contentHeight = rows - 6; // Header + footer

    if (this.isLoading) {
      return this.renderLoading(width, rows);
    }

    if (this.error) {
      return this.renderError(width, rows);
    }

    if (!this.analysis || this.analysis.candidates.length === 0) {
      return this.renderEmpty(width, rows);
    }

    switch (this.viewMode) {
      case "list":
        return this.renderList(width, rows);
      case "detail":
        return this.renderDetail(width, rows);
      case "confirm":
        return this.renderConfirm(width, rows);
    }
  }

  private renderLoading(width: number, rows: number): string[] {
    const lines: string[] = [];
    const msg = "⏳ Analyzing memory...";
    const padTop = Math.floor((rows - 3) / 2);

    for (let i = 0; i < padTop; i++) lines.push("");
    lines.push(this.centerText(msg, width, FG_CYAN));
    lines.push("");
    lines.push(this.centerText("Checking staleness, paths, branches...", width, FG_DIM));

    while (lines.length < rows) lines.push("");
    return lines;
  }

  private renderError(width: number, rows: number): string[] {
    const lines: string[] = [];
    const padTop = Math.floor((rows - 3) / 2);

    for (let i = 0; i < padTop; i++) lines.push("");
    lines.push(this.centerText(`❌ Error: ${this.error}`, width, FG_RED));
    lines.push("");
    lines.push(this.centerText("Press q to exit", width, FG_DIM));

    while (lines.length < rows) lines.push("");
    return lines;
  }

  private renderEmpty(width: number, rows: number): string[] {
    const lines: string[] = [];
    const padTop = Math.floor((rows - 3) / 2);

    for (let i = 0; i < padTop; i++) lines.push("");
    lines.push(this.centerText("✨ Memory is clean!", width, FG_GREEN));
    lines.push("");
    lines.push(this.centerText("No prune candidates found.", width, FG_DIM));
    lines.push("");
    lines.push(this.centerText("Press q to exit", width, FG_DIM));

    while (lines.length < rows) lines.push("");
    return lines;
  }

  private renderList(width: number, rows: number): string[] {
    const lines: string[] = [];
    const analysis = this.analysis;
    const candidates = analysis.candidates;

    // Header
    lines.push(this.renderHeader(width));
    lines.push(this.renderStats(width));
    lines.push(this.renderDivider(width, "─"));

    // Candidate list
    const listHeight = rows - 6;
    const visible = candidates.slice(this.scrollOffset, this.scrollOffset + listHeight);

    for (let i = 0; i < visible.length; i++) {
      const idx = this.scrollOffset + i;
      const candidate = visible[i];
      const isSelected = idx === this.selectedIndex;
      lines.push(this.renderCandidateRow(candidate, isSelected, width));
    }

    // Pad if needed
    while (lines.length < rows - 3) {
      lines.push("");
    }

    // Scroll indicator
    if (candidates.length > listHeight) {
      const pct = Math.round((this.scrollOffset / (candidates.length - listHeight)) * 100);
      lines.push(this.centerText(`${FG_DIM}${pct}% ↓${RESET}`, width, ""));
    } else {
      lines.push("");
    }

    // Footer
    lines.push(this.renderDivider(width, "─"));
    lines.push(this.renderFooter(width));

    return lines;
  }

  private renderDetail(width: number, rows: number): string[] {
    const lines: string[] = [];
    const candidate = this.analysis.candidates[this.selectedIndex];

    // Header
    lines.push(this.renderDetailHeader(candidate, width));
    lines.push(this.renderDivider(width, "─"));

    // Content
    const contentHeight = rows - 6;
    const contentLines = this.wrapContent(candidate.content, width - 4);
    this.detailMaxScroll = Math.max(0, contentLines.length - contentHeight);

    const visibleContent = contentLines.slice(
      this.detailScrollOffset,
      this.detailScrollOffset + contentHeight
    );

    for (const line of visibleContent) {
      lines.push(`  ${line}`);
    }

    while (lines.length < rows - 3) {
      lines.push("");
    }

    // Scroll indicator
    if (contentLines.length > contentHeight) {
      const pct = Math.round((this.detailScrollOffset / this.detailMaxScroll) * 100);
      lines.push(this.centerText(`${FG_DIM}${pct}% ↓${RESET}`, width, ""));
    } else {
      lines.push("");
    }

    // Footer
    lines.push(this.renderDivider(width, "─"));
    lines.push(this.renderDetailFooter(width));

    return lines;
  }

  private renderConfirm(width: number, rows: number): string[] {
    const lines: string[] = [];
    const selected = this.analysis.candidates.filter((c) => c.selected);
    const padTop = Math.floor((rows - 10) / 2);

    for (let i = 0; i < padTop; i++) lines.push("");

    lines.push(this.centerText(`${BOLD}${FG_YELLOW}⚠ Confirm Pruning${RESET}`, width, ""));
    lines.push("");
    lines.push(
      this.centerText(
        `You are about to delete ${FG_RED}${selected.length}${RESET} items:`,
        width,
        ""
      )
    );
    lines.push("");

    // Summary by type
    const byType = { episode: 0, note: 0, kv: 0 };
    for (const c of selected) byType[c.type]++;
    const parts: string[] = [];
    if (byType.episode > 0) parts.push(`${byType.episode} episodes`);
    if (byType.note > 0) parts.push(`${byType.note} notes`);
    if (byType.kv > 0) parts.push(`${byType.kv} kv`);
    lines.push(this.centerText(parts.join(", "), width, FG_GRAY));
    lines.push("");
    lines.push(this.centerText(`${FG_RED}This action cannot be undone!${RESET}`, width, ""));
    lines.push("");

    // Yes/No buttons
    const yesStyle = this.confirmSelection === "yes" ? `${BG_SELECTED}${FG_GREEN}` : FG_DIM;
    const noStyle = this.confirmSelection === "no" ? `${BG_SELECTED}${FG_RED}` : FG_DIM;
    lines.push(
      this.centerText(
        `${yesStyle}[ Yes, delete ]${RESET}    ${noStyle}[ No, cancel ]${RESET}`,
        width,
        ""
      )
    );

    while (lines.length < rows - 1) lines.push("");
    lines.push(this.centerText(`${FG_DIM}← → to select • Enter to confirm${RESET}`, width, ""));

    return lines;
  }

  // ============ Row Renderers ============

  private renderHeader(width: number): string {
    const title = "🧹 Delta Prune";
    const analysis = this.analysis;
    const selectedCount = analysis.candidates.filter((c) => c.selected).length;
    const right = selectedCount > 0 ? `${FG_GREEN}${selectedCount} selected${RESET}` : "";

    const titleWidth = visibleWidth(title);
    const rightWidth = visibleWidth(right);
    const pad = width - titleWidth - rightWidth - 2;

    return `${BG_HEADER}${BOLD}${FG_WHITE} ${title}${RESET}${BG_HEADER}${" ".repeat(Math.max(0, pad))}${right} ${RESET}`;
  }

  private renderStats(_width: number): string {
    const s = this.analysis.stats;
    const parts = [
      `${FG_DIM}Total:${RESET} ${s.total.episodes}e/${s.total.notes}n/${s.total.kv}k`,
      `${FG_DIM}Candidates:${RESET} ${FG_YELLOW}${s.totalCandidates}${RESET}`,
      `${FG_DIM}Analysis:${RESET} ${s.analysisTimeMs}ms`,
    ];
    return ` ${parts.join("  ")}`;
  }

  private renderCandidateRow(
    candidate: PruneCandidate,
    isSelected: boolean,
    width: number
  ): string {
    const bg = isSelected ? BG_SELECTED : "";
    const pointer = isSelected ? `${FG_CYAN}▸${RESET}` : " ";
    const check = candidate.selected ? `${FG_GREEN}✓${RESET}` : `${FG_DIM}○${RESET}`;

    // Type badge
    const typeColor = TYPE_COLORS[candidate.type] || FG_GRAY;
    const typeBadge = `${typeColor}${candidate.type.slice(0, 1).toUpperCase()}${RESET}`;

    // Score with color
    const scoreColor = candidate.score < 20 ? FG_RED : candidate.score < 40 ? FG_YELLOW : FG_GREEN;
    const score = `${scoreColor}${String(candidate.score).padStart(2)}${RESET}`;

    // Reasons
    const reasonBadges = candidate.reasons
      .slice(0, 2)
      .map((r) => {
        const color = RISK_COLORS[REASON_RISK[r]] || FG_GRAY;
        return `${color}${r.slice(0, 4)}${RESET}`;
      })
      .join(" ");

    // Summary
    const usedWidth = 2 + 2 + 2 + 3 + 12 + 2; // pointer, check, type, score, reasons, padding
    const summaryWidth = width - usedWidth;
    const summary = truncateToWidth(candidate.summary, summaryWidth);

    return `${bg}${pointer}${check} ${typeBadge} ${score} ${summary.padEnd(summaryWidth)} ${reasonBadges}${RESET}`;
  }

  private renderDetailHeader(candidate: PruneCandidate, width: number): string {
    const typeColor = TYPE_COLORS[candidate.type] || FG_GRAY;
    const title = `${typeColor}${candidate.type.toUpperCase()}${RESET} #${candidate.id}`;

    const reasons = candidate.reasons
      .map((r) => {
        const color = RISK_COLORS[REASON_RISK[r]] || FG_GRAY;
        return `${color}${REASON_LABELS[r]}${RESET}`;
      })
      .join(", ");

    return `${BG_HEADER}${BOLD} ${title} ${RESET}${BG_HEADER}${FG_DIM}${reasons}${RESET}${BG_HEADER}${" ".repeat(Math.max(0, width - visibleWidth(title) - visibleWidth(reasons) - 4))}${RESET}`;
  }

  private renderFooter(_width: number): string {
    const help = [
      `${FG_DIM}j/k${RESET} move`,
      `${FG_DIM}space${RESET} toggle`,
      `${FG_DIM}a${RESET} all`,
      `${FG_DIM}n${RESET} none`,
      `${FG_DIM}Enter${RESET} detail`,
      `${FG_DIM}d${RESET} delete`,
      `${FG_DIM}q${RESET} quit`,
    ].join("  ");
    return ` ${help}`;
  }

  private renderDetailFooter(_width: number): string {
    const help = [
      `${FG_DIM}j/k${RESET} scroll`,
      `${FG_DIM}space${RESET} toggle`,
      `${FG_DIM}Esc${RESET} back`,
    ].join("  ");
    return ` ${help}`;
  }

  private renderDivider(width: number, char: string): string {
    return `${FG_DIM}${char.repeat(width)}${RESET}`;
  }

  // ============ Helpers ============

  private centerText(text: string, width: number, color: string): string {
    const textWidth = visibleWidth(text);
    const pad = Math.max(0, Math.floor((width - textWidth) / 2));
    return `${" ".repeat(pad)}${color}${text}${color ? RESET : ""}`;
  }

  private wrapContent(content: string, width: number): string[] {
    const lines: string[] = [];
    for (const line of content.split("\n")) {
      if (visibleWidth(line) <= width) {
        lines.push(line);
      } else {
        // Simple word wrap
        let current = "";
        for (const word of line.split(/\s+/)) {
          if (visibleWidth(current) + visibleWidth(word) + 1 <= width) {
            current += (current ? " " : "") + word;
          } else {
            if (current) lines.push(current);
            current = word;
          }
        }
        if (current) lines.push(current);
      }
    }
    return lines;
  }

  // ============ Input Handling ============

  handleInput(data: string): void {
    switch (this.viewMode) {
      case "list":
        this.handleListInput(data);
        break;
      case "detail":
        this.handleDetailInput(data);
        break;
      case "confirm":
        this.handleConfirmInput(data);
        break;
    }
  }

  invalidate(): void {
    // No-op — we manage refresh internally
  }

  private handleListInput(data: string): void {
    if (!this.analysis) {
      if (matchesKey(data, "q")) {
        this.done({ pruned: 0 });
      }
      return;
    }

    const candidates = this.analysis.candidates;

    // Navigation
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.selectedIndex = Math.min(this.selectedIndex + 1, candidates.length - 1);
      this.ensureVisible();
      this.refresh();
    } else if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.ensureVisible();
      this.refresh();
    } else if (matchesKey(data, "g")) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.refresh();
    } else if (matchesKey(data, "shift+g")) {
      this.selectedIndex = candidates.length - 1;
      this.ensureVisible();
      this.refresh();
    }

    // Selection
    else if (matchesKey(data, "space")) {
      if (candidates[this.selectedIndex]) {
        candidates[this.selectedIndex].selected = !candidates[this.selectedIndex].selected;
        this.refresh();
      }
    } else if (matchesKey(data, "a")) {
      for (const c of candidates) c.selected = true;
      this.refresh();
    } else if (matchesKey(data, "n")) {
      for (const c of candidates) c.selected = false;
      this.refresh();
    }

    // Detail view
    else if (matchesKey(data, "enter") || matchesKey(data, "l")) {
      if (candidates.length > 0) {
        this.viewMode = "detail";
        this.detailScrollOffset = 0;
        this.refresh();
      }
    }

    // Delete
    else if (matchesKey(data, "d")) {
      const selected = candidates.filter((c) => c.selected);
      if (selected.length > 0) {
        this.viewMode = "confirm";
        this.confirmSelection = "no";
        this.refresh();
      }
    }

    // Quit
    else if (matchesKey(data, "q") || matchesKey(data, "escape")) {
      this.done({ pruned: 0 });
    }
  }

  private handleDetailInput(data: string): void {
    const candidate = this.analysis.candidates[this.selectedIndex];

    // Scroll
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.detailScrollOffset = Math.min(this.detailScrollOffset + 1, this.detailMaxScroll);
      this.refresh();
    } else if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.detailScrollOffset = Math.max(this.detailScrollOffset - 1, 0);
      this.refresh();
    }

    // Toggle selection
    else if (matchesKey(data, "space")) {
      candidate.selected = !candidate.selected;
      this.refresh();
    }

    // Back to list
    else if (matchesKey(data, "escape") || matchesKey(data, "h") || matchesKey(data, "q")) {
      this.viewMode = "list";
      this.refresh();
    }
  }

  private handleConfirmInput(data: string): void {
    // Navigation
    if (matchesKey(data, "h") || matchesKey(data, "left")) {
      this.confirmSelection = "yes";
      this.refresh();
    } else if (matchesKey(data, "l") || matchesKey(data, "right")) {
      this.confirmSelection = "no";
      this.refresh();
    }

    // Confirm
    else if (matchesKey(data, "enter")) {
      if (this.confirmSelection === "yes") {
        this.executePrune();
      } else {
        this.viewMode = "list";
        this.refresh();
      }
    }

    // Cancel
    else if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.viewMode = "list";
      this.refresh();
    }
  }

  private ensureVisible(): void {
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + this.contentHeight) {
      this.scrollOffset = this.selectedIndex - this.contentHeight + 1;
    }
  }

  // ============ Prune Execution ============

  private executePrune(): void {
    const selected = this.analysis.candidates.filter((c) => c.selected);

    const episodeIds: number[] = [];
    const noteIds: number[] = [];
    const kvKeys: string[] = [];

    for (const c of selected) {
      switch (c.type) {
        case "episode":
          episodeIds.push(Number(c.id));
          break;
        case "note":
          noteIds.push(Number(c.id));
          break;
        case "kv":
          kvKeys.push(c.id);
          break;
      }
    }

    let deleted = 0;
    deleted += batchDeleteEpisodes(episodeIds);
    deleted += batchDeleteNotes(noteIds);
    deleted += batchDeleteKV(kvKeys);

    this.done({ pruned: deleted });
  }
}
