/**
 * App — Main application controller for the Theta code review dashboard.
 *
 * 2-band layout:
 *   Top band:    COMMITS (left ~50%) │ FILES (right ~50%)
 *   Bottom band: Side-by-side DIFF (old │ new, full width)
 *
 * Performance characteristics:
 *   - DimmedOverlay eliminated: ~50% less per-frame work
 *   - DiffPanel uses pre-computed styled lines: scroll = array slice
 *   - Scroll coalescing: rapid j/k batched into single render frame
 *   - Per-panel render caches: unchanged panels skip rendering
 */

import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey } from "@mariozechner/pi-tui";
import { type CommitInfo, DiffService } from "../services/diff-service.js";
import { type Layout, calculateLayout } from "./layout.js";
import { CommitPanel } from "./panels/commit-panel.js";
import { DiffPanel } from "./panels/diff-panel.js";
import { FilePanel } from "./panels/file-panel.js";
import { padToWidth } from "./text-utils.js";
import { type Panel, type PanelComponent, type ThemeLike, UNCOMMITTED_SHA } from "./types.js";

const COMMIT_BATCH_SIZE = 50;

interface SearchState {
  active: boolean;
  panel: Panel;
  query: string;
  caseSensitive: boolean;
}

export class App implements Component {
  private activePanel: Panel = "commits";
  private showHelp = false;
  private branchMode: { base: string; head: string } | null = null;
  private layout: Layout;
  private searchState: SearchState = {
    active: false,
    panel: "commits",
    query: "",
    caseSensitive: false,
  };

  private readonly commitPanel = new CommitPanel();
  private readonly filePanel = new FilePanel();
  private readonly diffPanel = new DiffPanel();
  private readonly diffService = new DiffService();

  // Deferred diff scroll batching
  private pendingScrollDelta = 0;
  private pendingScrollTarget: number | null = null;
  private scrollFlushScheduled = false;
  private destroyed = false;

  private readonly panelMap: Record<Panel, PanelComponent> = {
    commits: this.commitPanel,
    files: this.filePanel,
    diff: this.diffPanel,
  };

  /** Derive selected commit from panel state. */
  private get selectedCommit(): CommitInfo | null {
    const commits = this.commitPanel.getDisplayCommits();
    return commits[this.commitPanel.index] ?? null;
  }

  private cancelPendingScroll(): void {
    this.pendingScrollDelta = 0;
    this.pendingScrollTarget = null;
  }

  constructor(
    private tui: TUI,
    private theme: ThemeLike,
    // biome-ignore lint/suspicious/noExplicitAny: Callback result type varies
    private done: (result: any) => void,
    base?: string,
    head?: string
  ) {
    if (base && head) {
      this.branchMode = { base, head };
    }
    this.layout = calculateLayout(tui.terminal.columns, tui.terminal.rows);
    this.init();
  }

  // ── Initialization ──────────────────────────────────────────────────

  private async init() {
    try {
      if (this.branchMode) {
        const branchCommit: CommitInfo = {
          sha: "",
          shortSha: "—",
          subject: `${this.branchMode.base}..${this.branchMode.head}`,
        };
        this.commitPanel.setCommits([branchCommit]);
        this.diffPanel.setContent("Loading...");
        this.refresh();

        const result = await this.diffService.getDiff(this.branchMode.base, this.branchMode.head);
        this.filePanel.setFiles(result.files);
        this.diffPanel.totalStats = {
          additions: result.files.reduce((sum, f) => sum + f.additions, 0),
          deletions: result.files.reduce((sum, f) => sum + f.deletions, 0),
          filesChanged: result.files.length,
        };

        if (this.filePanel.files.length > 0) {
          await this.selectFileBranchMode(0);
        } else {
          this.diffPanel.setContent("No differences between refs.");
          this.refresh();
        }
        return;
      }

      // Normal commit history mode
      const hasUncommitted = await this.diffService.hasUncommittedChanges();
      const commits = await this.diffService.getCommits(0, COMMIT_BATCH_SIZE);
      this.commitPanel.hasMore = commits.length === COMMIT_BATCH_SIZE;

      if (hasUncommitted) {
        this.commitPanel.setCommits([
          {
            sha: UNCOMMITTED_SHA,
            shortSha: "———",
            subject: "Uncommitted changes",
            isUncommitted: true,
          },
          ...commits,
        ]);
      } else {
        this.commitPanel.setCommits(commits);
      }

      if (this.commitPanel.commits.length > 0) {
        await this.selectCommit(0);
      } else {
        this.diffPanel.setContent("No commits or changes found.");
        this.refresh();
      }
    } catch {
      this.diffPanel.setContent("Error loading commits.");
      this.refresh();
    }
  }

  // ── Selection ───────────────────────────────────────────────────────

  private async selectCommit(index: number) {
    this.cancelPendingScroll();
    this.commitPanel.index = index;
    this.filePanel.index = 0;
    this.filePanel.scrollOffset = 0;
    this.diffPanel.scrollOffset = 0;

    const commit = this.commitPanel.getDisplayCommits()[index];
    if (!commit) return;

    this.diffPanel.setContent("Loading...");
    this.filePanel.setFiles([]);
    this.refresh();

    try {
      const result = commit.isUncommitted
        ? await this.diffService.getDiff()
        : await this.diffService.getCommitDiff(commit.sha);

      if (this.commitPanel.index !== index) return;
      this.filePanel.setFiles(result.files);
      this.diffPanel.totalStats = {
        additions: result.files.reduce((sum, f) => sum + f.additions, 0),
        deletions: result.files.reduce((sum, f) => sum + f.deletions, 0),
        filesChanged: result.files.length,
      };

      if (this.filePanel.files.length > 0) {
        await this.selectFile(0, commit);
      } else {
        this.diffPanel.setContent("No changes in this commit.");
        this.refresh();
      }
    } catch {
      if (this.commitPanel.index === index) {
        this.diffPanel.setContent("Error loading commit diff.");
        this.refresh();
      }
    }
  }

  private async selectFile(index: number, commit?: CommitInfo) {
    this.cancelPendingScroll();
    this.filePanel.index = index;
    this.diffPanel.scrollOffset = 0;

    const file = this.filePanel.getDisplayFiles()[index];
    if (!file) return;

    const currentCommit = commit || this.commitPanel.getDisplayCommits()[this.commitPanel.index];
    if (!currentCommit) return;

    this.diffPanel.setContent(`Loading diff for ${file.path}...`);
    this.refresh();

    try {
      const result = currentCommit.isUncommitted
        ? await this.diffService.getDiff(undefined, undefined, file.path)
        : await this.diffService.getCommitDiff(currentCommit.sha, file.path);

      if (
        this.filePanel.index === index &&
        this.commitPanel.getDisplayCommits()[this.commitPanel.index]?.sha === currentCommit.sha
      ) {
        this.diffPanel.setContent(result.raw || "No changes in file.");
        this.refresh();
      }
    } catch {
      if (this.filePanel.index === index) {
        this.diffPanel.setContent("Error loading diff.");
        this.refresh();
      }
    }
  }

  private async selectFileBranchMode(index: number) {
    if (!this.branchMode) return;

    this.cancelPendingScroll();
    this.filePanel.index = index;
    this.diffPanel.scrollOffset = 0;

    const file = this.filePanel.getDisplayFiles()[index];
    if (!file) return;

    this.diffPanel.setContent(`Loading diff for ${file.path}...`);
    this.refresh();

    try {
      const result = await this.diffService.getDiff(
        this.branchMode.base,
        this.branchMode.head,
        file.path
      );

      if (this.filePanel.index === index) {
        this.diffPanel.setContent(result.raw || "No changes in file.");
        this.refresh();
      }
    } catch {
      if (this.filePanel.index === index) {
        this.diffPanel.setContent("Error loading diff.");
        this.refresh();
      }
    }
  }

  private async loadMoreCommits() {
    if (this.commitPanel.isLoading || !this.commitPanel.hasMore) return;

    this.commitPanel.isLoading = true;
    this.refresh();

    try {
      const hasUncommitted = this.commitPanel.commits[0]?.isUncommitted;
      const skip = hasUncommitted
        ? this.commitPanel.commits.length - 1
        : this.commitPanel.commits.length;

      const newCommits = await this.diffService.getCommits(skip, COMMIT_BATCH_SIZE);
      this.commitPanel.hasMore = newCommits.length === COMMIT_BATCH_SIZE;
      this.commitPanel.addCommits(newCommits);
    } finally {
      this.commitPanel.isLoading = false;
      this.refresh();
    }
  }

  // ── Render ──────────────────────────────────────────────────────────

  invalidate() {}

  private refresh() {
    this.tui.requestRender();
  }

  private get activeSearchPanel(): PanelComponent {
    return this.panelMap[this.searchState.panel];
  }

  private renderSearchBar(width: number): string {
    if (!this.searchState.active) return "";

    const panelName = this.searchState.panel.toUpperCase();
    const query = this.searchState.query;
    const cursor = "█";
    const caseSensitiveIndicator = this.searchState.caseSensitive ? " [Aa]" : "";

    const matchCount = this.activeSearchPanel.filterMatchCount;
    const currentMatch = this.activeSearchPanel.filterCurrentIndex;

    let matchInfo = "";
    if (matchCount > 0) {
      matchInfo = ` ${this.theme.fg("success", `${currentMatch + 1}/${matchCount} matches`)}`;
    } else if (query.length > 0) {
      matchInfo = ` ${this.theme.fg("error", "0 matches")}`;
    }

    const searchPrompt = `Search (${panelName.toLowerCase()}): ${query}${cursor}${caseSensitiveIndicator}${matchInfo}`;
    const helpText = " [Enter] Apply  [Esc] Cancel  [Ctrl+I] Case  [n/N] Next/Prev  [h/l] Panel";

    const line = this.theme.fg("accent", searchPrompt) + this.theme.fg("dim", helpText);
    return padToWidth(line, width);
  }

  /**
   * Render help overlay centered on screen.
   */
  private renderHelp(width: number, height: number): string[] {
    const lines: string[] = [];
    const helpContent = [
      "THETA KEYBOARD SHORTCUTS",
      "",
      "Navigation:",
      "  h/l        Switch panel left/right",
      "  j/k ↓/↑    Move selection / scroll down/up",
      "  PgUp/PgDn  Half-page scroll",
      "  Ctrl+u/d   Half-page scroll (alt)",
      "  Home/End   Jump to first/last",
      "",
      "Actions:",
      "  ?          Toggle this help",
      "  u          Toggle SBS / Unified diff view",
      "  q / Esc    Close dashboard",
      "",
      "Panels:",
      "  COMMITS    Browse commit history",
      "  FILES      View changed files",
      "  DIFF       Inspect file diffs (SBS or Unified)",
      "",
      "Press any key to close",
    ];

    const maxLineWidth = Math.max(...helpContent.map((l) => l.length));
    const boxWidth = Math.min(width - 4, maxLineWidth + 4);
    const boxHeight = Math.min(height - 2, helpContent.length + 2);

    const startRow = Math.floor((height - boxHeight) / 2);
    const startCol = Math.floor((width - boxWidth) / 2);

    for (let i = 0; i < startRow; i++) {
      lines.push("");
    }

    lines.push(" ".repeat(startCol) + this.theme.fg("accent", `┌${"─".repeat(boxWidth - 2)}┐`));

    for (let i = 0; i < boxHeight - 2 && i < helpContent.length; i++) {
      const content = helpContent[i] || "";
      const padded = content.padEnd(boxWidth - 4);
      lines.push(
        " ".repeat(startCol) +
          this.theme.fg("accent", "│ ") +
          this.theme.fg(content.startsWith(" ") ? "text" : "accent", padded) +
          this.theme.fg("accent", " │")
      );
    }

    lines.push(" ".repeat(startCol) + this.theme.fg("accent", `└${"─".repeat(boxWidth - 2)}┘`));

    return lines;
  }

  render(width: number): string[] {
    const termRows = this.tui.terminal.rows || 24;

    if (this.showHelp) {
      return this.renderHelp(width, termRows);
    }

    // Recompute layout for current dimensions
    this.layout = calculateLayout(width, termRows);
    const { commits, files } = this.layout;
    const topSep = this.theme.fg("dim", "│");

    const lines: string[] = [];

    // ── Top Header: COMMITS │ FILES ───────────────────────────────
    const mkTopHeader = (label: string, panel: Panel, w: number) =>
      this.activePanel === panel
        ? this.theme.bg("selectedBg", this.theme.fg("accent", padToWidth(` ${label}`, w)))
        : this.theme.fg("dim", padToWidth(` ${label}`, w));

    lines.push(
      mkTopHeader("COMMITS", "commits", commits.width) +
        topSep +
        mkTopHeader("FILES", "files", files.width)
    );

    // ── Top Content: Commits │ Files ──────────────────────────────
    const commitLines = this.commitPanel.render(
      commits.width,
      this.layout.topContentHeight,
      this.activePanel,
      this.theme
    );
    const fileLines = this.filePanel.render(
      files.width,
      this.layout.topContentHeight,
      this.activePanel,
      this.theme
    );

    const emptyCommit = padToWidth("", commits.width);
    const emptyFile = padToWidth("", files.width);

    for (let i = 0; i < this.layout.topContentHeight; i++) {
      const left = commitLines[i] || emptyCommit;
      const mid = fileLines[i] || emptyFile;
      lines.push(left + topSep + mid);
    }

    // ── Diff Header ──────────────────────────────────────────────
    const diffActive = this.activePanel === "diff";
    const currentFile = this.filePanel.getDisplayFiles()[this.filePanel.index];
    const modeLabel = this.diffPanel.viewMode === "sbs" ? "SBS" : "UNI";
    const filePath = currentFile
      ? ` DIFF · ${currentFile.path} [${modeLabel}]`
      : ` DIFF [${modeLabel}]`;
    const diffHeader = this.theme.fg(diffActive ? "accent" : "dim", padToWidth(filePath, width));
    lines.push(diffActive ? this.theme.bg("selectedBg", diffHeader) : diffHeader);

    // ── Diff Content (side-by-side) ──────────────────────────────
    const diffLines = this.diffPanel.render(
      width,
      this.layout.diffContentHeight,
      this.theme,
      this.layout.diffLeftWidth,
      this.layout.diffRightWidth
    );

    for (let i = 0; i < this.layout.diffContentHeight; i++) {
      lines.push(diffLines[i] || "");
    }

    // ── Footer: Commit metadata ──────────────────────────────────
    if (this.selectedCommit && !this.selectedCommit.isUncommitted) {
      const author = this.selectedCommit.author || "Unknown";
      const date = this.selectedCommit.date
        ? new Date(this.selectedCommit.date).toLocaleDateString()
        : "";
      const metaLine = ` ${author}${date ? ` · ${date}` : ""}`;
      lines.push(this.theme.fg("dim", padToWidth(metaLine, width)));
    } else {
      lines.push(padToWidth("", width));
    }

    // ── Footer: Search bar or stats ──────────────────────────────
    if (this.searchState.active) {
      lines.push(this.renderSearchBar(width));
    } else {
      const scrollInfo =
        this.diffPanel.maxLines > this.layout.diffContentHeight
          ? ` ${this.diffPanel.scrollOffset + 1}-${Math.min(this.diffPanel.scrollOffset + this.layout.diffContentHeight, this.diffPanel.maxLines)}/${this.diffPanel.maxLines}`
          : "";
      const stats = this.diffPanel.totalStats
        ? ` ${this.diffPanel.totalStats.filesChanged} files · ${this.theme.fg("success", `+${this.diffPanel.totalStats.additions}`)} ${this.theme.fg("error", `-${this.diffPanel.totalStats.deletions}`)}`
        : "";
      const loadingIndicator = this.commitPanel.isLoading ? " [loading...]" : "";
      const keybinds =
        "[h/l] Panel [j/k] Nav [PgUp/Dn] ½Page [u] View [/] Search [?] Help [q] Quit";

      lines.push(
        this.theme.fg("dim", ` ${keybinds}`) +
          stats +
          this.theme.fg("dim", scrollInfo + loadingIndicator)
      );
    }

    return lines;
  }

  // ── Search handling ─────────────────────────────────────────────────

  private enterSearchMode() {
    this.searchState.active = true;
    this.searchState.panel = this.activePanel;
    this.searchState.query = "";
    this.refresh();
  }

  private exitSearchMode() {
    this.searchState.active = false;
    this.searchState.query = "";
    this.commitPanel.clearFilter();
    this.filePanel.clearFilter();
    this.diffPanel.clearFilter();
    this.refresh();
  }

  private handleSearchInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.exitSearchMode();
      return;
    }

    if (matchesKey(data, "ctrl+i")) {
      this.searchState.caseSensitive = !this.searchState.caseSensitive;
      this.applySearch();
      return;
    }

    if (matchesKey(data, "return")) {
      this.applySearchFilter();
      return;
    }

    if (matchesKey(data, "n")) {
      this.nextSearchMatch();
      return;
    }
    if (data === "N") {
      this.prevSearchMatch();
      return;
    }

    if (matchesKey(data, "h")) {
      this.switchSearchPanelLeft();
      return;
    }
    if (matchesKey(data, "l")) {
      this.switchSearchPanelRight();
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.searchState.query.length > 0) {
        this.searchState.query = this.searchState.query.slice(0, -1);
        this.applySearch();
      }
      return;
    }

    if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) <= 126) {
      this.searchState.query += data;
      this.applySearch();
      return;
    }
  }

  private applySearch() {
    const { query, caseSensitive } = this.searchState;
    this.activeSearchPanel.applyFilter(query, caseSensitive);
    this.refresh();
  }

  private applySearchFilter() {
    if (this.searchState.panel === "commits" && this.commitPanel.filterMatchCount > 0) {
      this.commitPanel.index = 0;
      this.commitPanel.scrollOffset = 0;
      this.selectCommit(0);
    } else if (this.searchState.panel === "files" && this.filePanel.filterMatchCount > 0) {
      this.filePanel.index = 0;
      this.filePanel.scrollOffset = 0;
      const selectFn = this.branchMode
        ? (idx: number) => this.selectFileBranchMode(idx)
        : (idx: number) => this.selectFile(idx);
      selectFn(0);
    }
    this.refresh();
  }

  private nextSearchMatch() {
    if (this.searchState.panel === "diff") {
      this.diffPanel.nextMatch();
      this.refresh();
    } else if (this.searchState.panel === "commits" && this.commitPanel.filterMatchCount > 0) {
      const newIndex = (this.commitPanel.index + 1) % this.commitPanel.filterMatchCount;
      this.commitPanel.index = newIndex;
      this.selectCommit(newIndex);
    } else if (this.searchState.panel === "files" && this.filePanel.filterMatchCount > 0) {
      const newIndex = (this.filePanel.index + 1) % this.filePanel.filterMatchCount;
      this.filePanel.index = newIndex;
      const selectFn = this.branchMode
        ? (idx: number) => this.selectFileBranchMode(idx)
        : (idx: number) => this.selectFile(idx);
      selectFn(newIndex);
    }
  }

  private prevSearchMatch() {
    if (this.searchState.panel === "diff") {
      this.diffPanel.prevMatch();
      this.refresh();
    } else if (this.searchState.panel === "commits" && this.commitPanel.filterMatchCount > 0) {
      const newIndex =
        (this.commitPanel.index - 1 + this.commitPanel.filterMatchCount) %
        this.commitPanel.filterMatchCount;
      this.commitPanel.index = newIndex;
      this.selectCommit(newIndex);
    } else if (this.searchState.panel === "files" && this.filePanel.filterMatchCount > 0) {
      const newIndex =
        (this.filePanel.index - 1 + this.filePanel.filterMatchCount) %
        this.filePanel.filterMatchCount;
      this.filePanel.index = newIndex;
      const selectFn = this.branchMode
        ? (idx: number) => this.selectFileBranchMode(idx)
        : (idx: number) => this.selectFile(idx);
      selectFn(newIndex);
    }
  }

  private switchSearchPanelLeft() {
    if (this.searchState.panel === "files") {
      this.searchState.panel = "commits";
    } else if (this.searchState.panel === "diff") {
      this.searchState.panel = "files";
    }
    this.searchState.query = "";
    this.refresh();
  }

  private switchSearchPanelRight() {
    if (this.searchState.panel === "commits") {
      this.searchState.panel = "files";
    } else if (this.searchState.panel === "files") {
      this.searchState.panel = "diff";
    }
    this.searchState.query = "";
    this.refresh();
  }

  // ── Input handling ──────────────────────────────────────────────────

  handleInput(data: string) {
    if (matchesKey(data, "?")) {
      this.showHelp = !this.showHelp;
      this.refresh();
      return;
    }

    if (this.showHelp) {
      this.showHelp = false;
      this.refresh();
      return;
    }

    if (this.searchState.active) {
      this.handleSearchInput(data);
      return;
    }

    if (matchesKey(data, "/")) {
      this.enterSearchMode();
      return;
    }

    if (matchesKey(data, "u")) {
      this.diffPanel.toggleViewMode();
      this.refresh();
      return;
    }

    if (matchesKey(data, "q") || matchesKey(data, "escape")) {
      this.destroyed = true;
      this.done(null);
      return;
    }

    // Panel switching
    if (matchesKey(data, "h")) {
      if (this.activePanel === "files") this.activePanel = "commits";
      else if (this.activePanel === "diff") this.activePanel = "files";
      this.refresh();
      return;
    }
    if (matchesKey(data, "l")) {
      if (this.activePanel === "commits") this.activePanel = "files";
      else if (this.activePanel === "files") this.activePanel = "diff";
      this.refresh();
      return;
    }

    // Vertical navigation
    const down = matchesKey(data, "j") || matchesKey(data, "down");
    const up = matchesKey(data, "k") || matchesKey(data, "up");
    const pgDown = matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d");
    const pgUp = matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u");
    const home = matchesKey(data, "home");
    const end = matchesKey(data, "end");

    if (this.activePanel === "commits") this.navCommits(down, up, pgDown, pgUp, home, end);
    else if (this.activePanel === "files") this.navFiles(down, up, pgDown, pgUp, home, end);
    else this.navDiff(down, up, pgDown, pgUp, home, end);
  }

  private navCommits(
    down: boolean,
    up: boolean,
    pgDown: boolean,
    pgUp: boolean,
    home: boolean,
    end: boolean
  ) {
    if (this.branchMode) return;

    const len = this.commitPanel.getDisplayCommits().length;
    if (len === 0) return;

    const halfPage = Math.max(1, Math.floor(this.layout.topContentHeight / 2));

    if (home) {
      if (this.commitPanel.index !== 0) this.selectCommit(0);
      return;
    }
    if (end) {
      if (this.commitPanel.index !== len - 1) {
        this.selectCommit(len - 1);
        if (this.commitPanel.hasMore) this.loadMoreCommits();
      }
      return;
    }
    if (down && this.commitPanel.index < len - 1) {
      this.selectCommit(this.commitPanel.index + 1);
      if (this.commitPanel.index >= len - 5 && this.commitPanel.hasMore) this.loadMoreCommits();
      return;
    }
    if (up && this.commitPanel.index > 0) {
      this.selectCommit(this.commitPanel.index - 1);
      return;
    }
    if (pgDown) {
      const next = Math.min(this.commitPanel.index + halfPage, len - 1);
      if (next !== this.commitPanel.index) {
        this.selectCommit(next);
        if (next >= len - 5 && this.commitPanel.hasMore) this.loadMoreCommits();
      }
      return;
    }
    if (pgUp) {
      const prev = Math.max(0, this.commitPanel.index - halfPage);
      if (prev !== this.commitPanel.index) this.selectCommit(prev);
      return;
    }
  }

  private navFiles(
    down: boolean,
    up: boolean,
    pgDown: boolean,
    pgUp: boolean,
    home: boolean,
    end: boolean
  ) {
    const len = this.filePanel.getDisplayFiles().length;
    if (len === 0) return;

    const halfPage = Math.max(1, Math.floor(this.layout.topContentHeight / 2));
    const selectFn = this.branchMode
      ? (idx: number) => this.selectFileBranchMode(idx)
      : (idx: number) => this.selectFile(idx);

    if (home) {
      if (this.filePanel.index !== 0) selectFn(0);
      return;
    }
    if (end) {
      if (this.filePanel.index !== len - 1) selectFn(len - 1);
      return;
    }
    if (down && this.filePanel.index < len - 1) {
      selectFn(this.filePanel.index + 1);
      return;
    }
    if (up && this.filePanel.index > 0) {
      selectFn(this.filePanel.index - 1);
      return;
    }
    if (pgDown) {
      const n = Math.min(this.filePanel.index + halfPage, len - 1);
      if (n !== this.filePanel.index) selectFn(n);
      return;
    }
    if (pgUp) {
      const p = Math.max(0, this.filePanel.index - halfPage);
      if (p !== this.filePanel.index) selectFn(p);
      return;
    }
  }

  /**
   * Queue diff scroll. Actual offset update is deferred via setImmediate
   * so rapid j/k are coalesced into a single render frame.
   */
  private navDiff(
    down: boolean,
    up: boolean,
    pgDown: boolean,
    pgUp: boolean,
    home: boolean,
    end: boolean
  ) {
    const halfPage = Math.max(1, Math.floor(this.layout.diffContentHeight / 2));

    if (home) {
      this.pendingScrollTarget = 0;
      this.pendingScrollDelta = 0;
    } else if (end) {
      this.pendingScrollTarget = Number.MAX_SAFE_INTEGER;
      this.pendingScrollDelta = 0;
    } else if (down) {
      this.pendingScrollDelta += 1;
    } else if (up) {
      this.pendingScrollDelta -= 1;
    } else if (pgDown) {
      this.pendingScrollDelta += halfPage;
    } else if (pgUp) {
      this.pendingScrollDelta -= halfPage;
    } else {
      return;
    }

    if (!this.scrollFlushScheduled) {
      this.scrollFlushScheduled = true;
      setImmediate(() => {
        this.scrollFlushScheduled = false;
        this.flushDiffScroll();
      });
    }
  }

  /** Apply accumulated scroll deltas and render once. */
  private flushDiffScroll() {
    if (this.destroyed) return;
    const maxScroll = Math.max(0, this.diffPanel.maxLines - this.layout.diffContentHeight);
    const oldOffset = this.diffPanel.scrollOffset;

    if (this.pendingScrollTarget !== null) {
      if (this.pendingScrollTarget === Number.MAX_SAFE_INTEGER) {
        this.diffPanel.scrollOffset = maxScroll;
      } else {
        this.diffPanel.scrollOffset = this.pendingScrollTarget;
      }
      this.pendingScrollTarget = null;
    }

    this.diffPanel.scrollOffset += this.pendingScrollDelta;
    this.pendingScrollDelta = 0;

    this.diffPanel.scrollOffset = Math.max(0, Math.min(this.diffPanel.scrollOffset, maxScroll));

    if (this.diffPanel.scrollOffset !== oldOffset) {
      this.refresh();
    }
  }
}
