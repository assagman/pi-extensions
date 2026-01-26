import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { DiffService, type DiffFile, type CommitInfo } from "../services/diff-service.js";

type Panel = "commits" | "files" | "diff";

const UNCOMMITTED_SHA = "__uncommitted__";

export class Dashboard implements Component {
  // Panel state
  private activePanel: Panel = "commits";

  // Commits state
  private commits: CommitInfo[] = [];
  private commitIndex = 0;
  private commitScrollOffset = 0;
  private isLoadingCommits = false;
  private hasMoreCommits = true;
  private readonly COMMIT_BATCH_SIZE = 50;

  // Files state
  private files: DiffFile[] = [];
  private fileIndex = 0;
  private fileScrollOffset = 0;

  // Diff state
  private diffContent = "Loading...";
  private diffScrollOffset = 0;
  private maxDiffLines = 0;

  // Layout
  private contentHeight = 10;
  private diffService: DiffService;

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
      // Check for uncommitted changes first
      const hasUncommitted = await this.diffService.hasUncommittedChanges();

      // Load commits
      const commits = await this.diffService.getCommits(0, this.COMMIT_BATCH_SIZE);
      this.hasMoreCommits = commits.length === this.COMMIT_BATCH_SIZE;

      // Build commit list
      if (hasUncommitted) {
        this.commits = [
          { sha: UNCOMMITTED_SHA, shortSha: "———", subject: "Uncommitted changes", isUncommitted: true },
          ...commits,
        ];
      } else {
        this.commits = commits;
      }

      // Select first item and load its diff
      if (this.commits.length > 0) {
        await this.selectCommit(0);
      } else {
        this.diffContent = "No commits or changes found.";
        this.refresh();
      }
    } catch (_e) {
      this.diffContent = "Error loading commits.";
      this.refresh();
    }
  }

  async selectCommit(index: number) {
    this.commitIndex = index;
    this.fileIndex = 0;
    this.fileScrollOffset = 0;
    this.diffScrollOffset = 0;

    const commit = this.commits[index];
    if (!commit) return;

    this.diffContent = "Loading...";
    this.files = [];
    this.refresh();

    try {
      let result: { raw: string; files: DiffFile[] };
      if (commit.isUncommitted) {
        result = await this.diffService.getDiff();
      } else {
        result = await this.diffService.getCommitDiff(commit.sha);
      }

      // Guard: only update if still selected
      if (this.commitIndex === index) {
        this.files = result.files;
        if (this.files.length > 0) {
          await this.selectFile(0, commit);
        } else {
          this.diffContent = "No changes in this commit.";
          this.refresh();
        }
      }
    } catch (_e) {
      if (this.commitIndex === index) {
        this.diffContent = "Error loading commit diff.";
        this.refresh();
      }
    }
  }

  async selectFile(index: number, commit?: CommitInfo) {
    this.fileIndex = index;
    this.diffScrollOffset = 0;

    const file = this.files[index];
    if (!file) return;

    const currentCommit = commit || this.commits[this.commitIndex];
    if (!currentCommit) return;

    this.diffContent = `Loading diff for ${file.path}...`;
    this.refresh();

    try {
      let raw: string;
      if (currentCommit.isUncommitted) {
        const result = await this.diffService.getDiff(undefined, undefined, file.path);
        raw = result.raw;
      } else {
        const result = await this.diffService.getCommitDiff(currentCommit.sha, file.path);
        raw = result.raw;
      }

      // Guard: still selected
      if (this.fileIndex === index && this.commits[this.commitIndex]?.sha === currentCommit.sha) {
        this.diffContent = raw || "No changes in file.";
        this.refresh();
      }
    } catch (_e) {
      if (this.fileIndex === index) {
        this.diffContent = "Error loading diff.";
        this.refresh();
      }
    }
  }

  async loadMoreCommits() {
    if (this.isLoadingCommits || !this.hasMoreCommits) return;

    this.isLoadingCommits = true;
    this.refresh();

    try {
      // Calculate skip (exclude uncommitted entry)
      const hasUncommitted = this.commits[0]?.isUncommitted;
      const skip = hasUncommitted ? this.commits.length - 1 : this.commits.length;

      const newCommits = await this.diffService.getCommits(skip, this.COMMIT_BATCH_SIZE);
      this.hasMoreCommits = newCommits.length === this.COMMIT_BATCH_SIZE;
      this.commits.push(...newCommits);
    } finally {
      this.isLoadingCommits = false;
      this.refresh();
    }
  }

  invalidate() {
    // No internal cache to clear
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

    const target = Math.max(0, width - 1);
    let tail = "";
    for (let i = text.length - 1; i >= 0; i--) {
      tail = text[i] + tail;
      if (visibleWidth(tail) >= target) break;
    }
    tail = truncateToWidth(tail, target, "");
    return "…" + tail;
  }

  handleInput(data: string) {
    // Exit
    if (matchesKey(data, "q") || matchesKey(data, "escape")) {
      this.done(null);
      return;
    }

    // Panel navigation: h/l
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

    // Vertical navigation: j/k, arrows
    const isDown = matchesKey(data, "j") || matchesKey(data, "down");
    const isUp = matchesKey(data, "k") || matchesKey(data, "up");
    const isPageDown = matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d");
    const isPageUp = matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u");

    if (this.activePanel === "commits") {
      this.handleCommitNav(isDown, isUp, isPageDown, isPageUp);
    } else if (this.activePanel === "files") {
      this.handleFileNav(isDown, isUp, isPageDown, isPageUp);
    } else {
      this.handleDiffNav(isDown, isUp, isPageDown, isPageUp);
    }
  }

  private handleCommitNav(down: boolean, up: boolean, pgDown: boolean, pgUp: boolean) {
    const len = this.commits.length;
    if (len === 0) return;

    if (down) {
      if (this.commitIndex < len - 1) {
        this.selectCommit(this.commitIndex + 1);
        // Trigger load more when near bottom
        if (this.commitIndex >= len - 5 && this.hasMoreCommits) {
          this.loadMoreCommits();
        }
      }
      return;
    }
    if (up && this.commitIndex > 0) {
      this.selectCommit(this.commitIndex - 1);
      return;
    }
    if (pgDown) {
      const next = Math.min(this.commitIndex + 20, len - 1);
      if (next !== this.commitIndex) {
        this.selectCommit(next);
        if (next >= len - 5 && this.hasMoreCommits) {
          this.loadMoreCommits();
        }
      }
      return;
    }
    if (pgUp) {
      const prev = Math.max(0, this.commitIndex - 20);
      if (prev !== this.commitIndex) {
        this.selectCommit(prev);
      }
      return;
    }
  }

  private handleFileNav(down: boolean, up: boolean, pgDown: boolean, pgUp: boolean) {
    const len = this.files.length;
    if (len === 0) return;

    if (down && this.fileIndex < len - 1) {
      this.selectFile(this.fileIndex + 1);
      return;
    }
    if (up && this.fileIndex > 0) {
      this.selectFile(this.fileIndex - 1);
      return;
    }
    if (pgDown) {
      const next = Math.min(this.fileIndex + 20, len - 1);
      if (next !== this.fileIndex) this.selectFile(next);
      return;
    }
    if (pgUp) {
      const prev = Math.max(0, this.fileIndex - 20);
      if (prev !== this.fileIndex) this.selectFile(prev);
      return;
    }
  }

  private handleDiffNav(down: boolean, up: boolean, pgDown: boolean, pgUp: boolean) {
    const maxScroll = Math.max(0, this.maxDiffLines - this.contentHeight);

    if (down && this.diffScrollOffset < maxScroll) {
      this.diffScrollOffset++;
      this.refresh();
      return;
    }
    if (up && this.diffScrollOffset > 0) {
      this.diffScrollOffset--;
      this.refresh();
      return;
    }
    if (pgDown) {
      this.diffScrollOffset = Math.min(this.diffScrollOffset + 20, maxScroll);
      this.refresh();
      return;
    }
    if (pgUp) {
      this.diffScrollOffset = Math.max(0, this.diffScrollOffset - 20);
      this.refresh();
      return;
    }
  }

  render(width: number): string[] {
    // Column widths: 20-20-60 distribution
    const commitWidth = Math.floor(width * 0.2);
    const fileWidth = Math.floor(width * 0.2);
    const diffWidth = width - commitWidth - fileWidth - 4; // 4 for separators

    const lines: string[] = [];

    // Header row with focus indication
    const commitHeader = this.activePanel === "commits" 
      ? this.theme.bg("selectedBg", this.theme.fg("accent", this.padToWidth(" COMMITS", commitWidth)))
      : this.theme.fg("dim", this.padToWidth(" COMMITS", commitWidth));
    
    const fileHeader = this.activePanel === "files"
      ? this.theme.bg("selectedBg", this.theme.fg("accent", this.padToWidth(" FILES", fileWidth)))
      : this.theme.fg("dim", this.padToWidth(" FILES", fileWidth));
    
    const diffHeader = this.activePanel === "diff"
      ? this.theme.bg("selectedBg", this.theme.fg("accent", this.padToWidth(" DIFF", diffWidth)))
      : this.theme.fg("dim", this.padToWidth(" DIFF", diffWidth));

    const sep = this.theme.fg("dim", "│");
    lines.push(commitHeader + sep + fileHeader + sep + diffHeader);

    // Calculate content height
    const termRows = this.tui.terminal.rows || 24;
    this.contentHeight = Math.max(10, termRows - 3);

    // Prepare commit lines
    const commitLines = this.renderCommitColumn(commitWidth);

    // Prepare file lines
    const fileLines = this.renderFileColumn(fileWidth);

    // Prepare diff lines
    const diffLines = this.renderDiffColumn(diffWidth);

    // Render content rows
    for (let i = 0; i < this.contentHeight; i++) {
      const left = commitLines[i] || this.padToWidth("", commitWidth);
      const mid = fileLines[i] || this.padToWidth("", fileWidth);
      const right = diffLines[i] || "";
      lines.push(left + sep + mid + sep + right);
    }

    // Footer
    const scrollInfo = this.maxDiffLines > this.contentHeight
      ? ` (${this.diffScrollOffset + 1}-${Math.min(this.diffScrollOffset + this.contentHeight, this.maxDiffLines)}/${this.maxDiffLines})`
      : "";
    const loadingIndicator = this.isLoadingCommits ? " [loading...]" : "";
    lines.push(this.theme.fg("dim", ` [h/l] Panel  [j/k] Navigate  [PgUp/PgDn] Fast  [q] Quit${scrollInfo}${loadingIndicator}`));

    return lines;
  }

  private renderCommitColumn(width: number): string[] {
    const lines: string[] = [];

    // Calculate visible window
    const visibleCount = this.contentHeight;
    
    // Adjust scroll to keep selection visible
    if (this.commitIndex < this.commitScrollOffset) {
      this.commitScrollOffset = this.commitIndex;
    } else if (this.commitIndex >= this.commitScrollOffset + visibleCount) {
      this.commitScrollOffset = this.commitIndex - visibleCount + 1;
    }

    const visibleCommits = this.commits.slice(
      this.commitScrollOffset,
      this.commitScrollOffset + visibleCount
    );

    for (let i = 0; i < visibleCommits.length; i++) {
      const commit = visibleCommits[i];
      const realIndex = this.commitScrollOffset + i;
      const selected = realIndex === this.commitIndex;
      const focused = this.activePanel === "commits";

      const prefix = selected ? "▸ " : "  ";
      const sha = commit.shortSha.padEnd(7);
      const maxSubject = Math.max(0, width - visibleWidth(prefix) - 8);
      const subject = truncateToWidth(commit.subject, maxSubject, "…");

      let line = `${prefix}${sha} ${subject}`;
      line = this.padToWidth(line, width);

      if (selected && focused) {
        line = this.theme.bg("selectedBg", this.theme.fg("accent", line));
      } else if (selected) {
        line = this.theme.fg("accent", line);
      } else if (commit.isUncommitted) {
        line = this.theme.fg("warning", line);
      } else {
        line = this.theme.fg("text", line);
      }

      lines.push(line);
    }

    // Show load more indicator
    if (this.hasMoreCommits && lines.length < visibleCount) {
      const loadMore = this.padToWidth("  ↓ more...", width);
      lines.push(this.theme.fg("dim", loadMore));
    }

    return lines;
  }

  private renderFileColumn(width: number): string[] {
    const lines: string[] = [];

    // Calculate visible window
    const visibleCount = this.contentHeight;

    // Adjust scroll to keep selection visible
    if (this.fileIndex < this.fileScrollOffset) {
      this.fileScrollOffset = this.fileIndex;
    } else if (this.fileIndex >= this.fileScrollOffset + visibleCount) {
      this.fileScrollOffset = this.fileIndex - visibleCount + 1;
    }

    const visibleFiles = this.files.slice(
      this.fileScrollOffset,
      this.fileScrollOffset + visibleCount
    );

    for (let i = 0; i < visibleFiles.length; i++) {
      const file = visibleFiles[i];
      const realIndex = this.fileScrollOffset + i;
      const selected = realIndex === this.fileIndex;
      const focused = this.activePanel === "files";

      const prefix = selected ? "▸ " : "  ";
      const statsRaw = `+${file.additions} -${file.deletions} `;
      const maxName = Math.max(0, width - visibleWidth(prefix) - visibleWidth(statsRaw));
      const name = this.truncateStartToWidth(file.path, maxName);

      const statsStyled = this.theme.fg("success", `+${file.additions}`) + 
                          this.theme.fg("error", ` -${file.deletions}`) + " ";

      let nameStyled: string;
      if (selected && focused) {
        nameStyled = this.theme.fg("accent", name);
      } else if (selected) {
        nameStyled = this.theme.fg("accent", name);
      } else {
        nameStyled = this.theme.fg("text", name);
      }

      const prefixStyled = selected 
        ? this.theme.fg("accent", prefix) 
        : this.theme.fg("dim", prefix);

      let line = this.padToWidth(prefixStyled + statsStyled + nameStyled, width);

      if (selected && focused) {
        // Apply background highlight
        line = this.theme.bg("selectedBg", line);
      }

      lines.push(line);
    }

    return lines;
  }

  private renderDiffColumn(width: number): string[] {
    const diffLinesRaw = this.diffContent.split("\n");
    this.maxDiffLines = diffLinesRaw.length;

    const visibleDiffLines = diffLinesRaw.slice(
      this.diffScrollOffset,
      this.diffScrollOffset + this.contentHeight
    );

    return visibleDiffLines.map((l) => {
      const truncated = visibleWidth(l) > width ? truncateToWidth(l, width, "…") : l;

      if (l.startsWith("+")) return this.theme.fg("success", truncated);
      if (l.startsWith("-")) return this.theme.fg("error", truncated);
      if (l.startsWith("@@")) return this.theme.fg("accent", truncated);
      if (l.startsWith("diff ") || l.startsWith("index ")) return this.theme.fg("dim", truncated);
      return this.theme.fg("text", truncated);
    });
  }
}
