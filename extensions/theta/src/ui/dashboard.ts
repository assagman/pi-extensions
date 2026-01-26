import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { DiffService, type DiffFile } from "../services/diff-service.js";

export class Dashboard implements Component {
  private files: DiffFile[] = [];
  private selectedIndex = 0;
  private diffContent = "Loading...";
  private diffService: DiffService;
  private diffScrollOffset = 0;
  private maxDiffLines = 0;
  private contentHeight = 10;

  constructor(
    private tui: TUI,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
    private theme: any,
    // biome-ignore lint/suspicious/noExplicitAny: Keybindings type not exported
    private keybindings: any,
    // biome-ignore lint/suspicious/noExplicitAny: Callback result type varies
    private done: (result: any) => void
  ) {
    this.diffService = new DiffService();
    this.init();
  }

  async init() {
    try {
      const result = await this.diffService.getDiff();
      this.files = result.files;
      if (this.files.length > 0) {
        await this.selectFile(0);
      } else {
        this.diffContent = "No changes found.";
        this.refresh();
      }
    } catch (_e) {
      this.diffContent = "Error loading files.";
      this.refresh();
    }
  }

  async selectFile(index: number) {
    this.selectedIndex = index;
    const file = this.files[index];
    this.diffContent = `Loading diff for ${file.path}...`;
    this.diffScrollOffset = 0;
    this.refresh();

    try {
      const { raw } = await this.diffService.getDiff(undefined, undefined, file.path);
      // Guard: only update if this file is still selected
      if (this.selectedIndex === index) {
        this.diffContent = raw || "No changes in file.";
        this.refresh();
      }
    } catch (_e) {
      // Guard: only show error if this file is still selected
      if (this.selectedIndex === index) {
        this.diffContent = "Error loading diff.";
        this.refresh();
      }
    }
  }

  invalidate() {
    // No internal cache to clear, relying on render() to generate fresh lines
  }

  private refresh() {
    this.tui.requestRender();
  }

  private padToWidth(text: string, width: number): string {
    const truncated = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
    const pad = width - visibleWidth(truncated);
    return pad > 0 ? truncated + " ".repeat(pad) : truncated;
  }

  private truncateStartToWidth(text: string, width: number): string {
    if (width <= 0) return "";
    if (visibleWidth(text) <= width) return text;
    if (width === 1) return "…";

    const ellipsis = "…";
    const target = Math.max(0, width - visibleWidth(ellipsis));

    // Keep the tail of the string (paths are usually more useful at the end)
    let tail = "";
    for (let i = text.length - 1; i >= 0; i--) {
      tail = text[i] + tail;
      if (visibleWidth(tail) >= target) break;
    }

    tail = truncateToWidth(tail, target, "");
    return ellipsis + tail;
  }

  handleInput(data: string) {
    // Exit
    if (matchesKey(data, "q") || matchesKey(data, "escape")) {
      this.done(null);
      return;
    }
    
    // File navigation (C-n/C-p)
    if (matchesKey(data, "ctrl+n")) {
      if (this.files.length > 0) {
        const next = (this.selectedIndex + 1) % this.files.length;
        this.selectFile(next);
      }
      return;
    }
    if (matchesKey(data, "ctrl+p")) {
      if (this.files.length > 0) {
        const prev = (this.selectedIndex - 1 + this.files.length) % this.files.length;
        this.selectFile(prev);
      }
      return;
    }
    
    // Diff scrolling (j/k, arrows)
    const maxScroll = Math.max(0, this.maxDiffLines - this.contentHeight);

    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      if (this.diffScrollOffset < maxScroll) {
        this.diffScrollOffset++;
        this.refresh();
      }
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      if (this.diffScrollOffset > 0) {
        this.diffScrollOffset--;
        this.refresh();
      }
      return;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
      this.diffScrollOffset = Math.min(this.diffScrollOffset + 20, maxScroll);
      this.refresh();
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
      this.diffScrollOffset = Math.max(0, this.diffScrollOffset - 20);
      this.refresh();
      return;
    }
  }

  render(width: number): string[] {
    const sidebarWidth = Math.min(40, Math.floor(width * 0.35));
    const diffWidth = Math.max(10, width - sidebarWidth - 3);

    const lines: string[] = [];

    // Header
    const title = " Theta Code Review ";
    lines.push(this.theme.bg("selectedBg", this.theme.fg("text", title.padEnd(width))));

    // Calculate available content height (reserve 2 for header + footer)
    const termRows = this.tui.terminal.rows || 24;
    this.contentHeight = Math.max(10, termRows - 3);

    // Prepare file list with stats (ANSI-aware padding/truncation)
    const fileLines = this.files.map((f, i) => {
      const selected = i === this.selectedIndex;
      const prefix = selected ? "▸ " : "  ";

      const statsRaw = `+${f.additions} -${f.deletions} `;
      const statsStyled =
        this.theme.fg("success", `+${f.additions}`) + this.theme.fg("error", ` -${f.deletions}`) + " ";

      const maxNameWidth = Math.max(0, sidebarWidth - visibleWidth(prefix) - visibleWidth(statsRaw));
      const name = visibleWidth(f.path) > maxNameWidth ? this.truncateStartToWidth(f.path, maxNameWidth) : f.path;

      const nameStyled = selected ? this.theme.fg("accent", name) : this.theme.fg("text", name);
      const prefixStyled = selected ? this.theme.fg("accent", prefix) : this.theme.fg("dim", prefix);

      return this.padToWidth(prefixStyled + statsStyled + nameStyled, sidebarWidth);
    });

    // Prepare diff content with scrolling
    const diffLinesRaw = this.diffContent.split("\n");
    this.maxDiffLines = diffLinesRaw.length;
    
    const visibleDiffLines = diffLinesRaw.slice(
      this.diffScrollOffset, 
      this.diffScrollOffset + this.contentHeight
    );
    
    const diffViewLines = visibleDiffLines.map((l) => {
      const truncated = visibleWidth(l) > diffWidth ? truncateToWidth(l, diffWidth, "…") : l;

      if (l.startsWith("+")) return this.theme.fg("success", truncated);
      if (l.startsWith("-")) return this.theme.fg("error", truncated);
      if (l.startsWith("@@")) return this.theme.fg("accent", truncated);
      if (l.startsWith("diff ") || l.startsWith("index ")) return this.theme.fg("dim", truncated);
      return this.theme.fg("text", truncated);
    });

    // Render content rows
    for (let i = 0; i < this.contentHeight; i++) {
      const left = this.padToWidth(fileLines[i] || "", sidebarWidth);
      const right = diffViewLines[i] || "";
      const separator = this.theme.fg("dim", " │ ");
      lines.push(left + separator + right);
    }

    // Footer with scroll indicator
    const scrollInfo = this.maxDiffLines > this.contentHeight 
      ? ` (${this.diffScrollOffset + 1}-${Math.min(this.diffScrollOffset + this.contentHeight, this.maxDiffLines)}/${this.maxDiffLines})` 
      : "";
    lines.push(this.theme.fg("dim", ` [C-n/C-p] Files  [j/k] Scroll  [q] Quit${scrollInfo}`));

    return lines;
  }
}
