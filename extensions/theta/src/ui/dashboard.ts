import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey } from "@mariozechner/pi-tui";
import { type CommitInfo, DiffService } from "../services/diff-service.js";
import { CommitPanel } from "./panels/commit-panel.js";
import { DiffPanel } from "./panels/diff-panel.js";
import { FilePanel } from "./panels/file-panel.js";
import { padToWidth } from "./text-utils.js";
import { type Panel, UNCOMMITTED_SHA } from "./types.js";

const COMMIT_BATCH_SIZE = 50;

export class Dashboard implements Component {
  private activePanel: Panel = "commits";
  private contentHeight = 10;

  private readonly commitPanel = new CommitPanel();
  private readonly filePanel = new FilePanel();
  private readonly diffPanel = new DiffPanel();
  private readonly diffService = new DiffService();

  constructor(
    private tui: TUI,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
    private theme: any,
    // biome-ignore lint/suspicious/noExplicitAny: Callback result type varies
    private done: (result: any) => void
  ) {
    this.init();
  }

  // ── Initialization ──────────────────────────────────────────────────

  private async init() {
    try {
      const hasUncommitted = await this.diffService.hasUncommittedChanges();
      const commits = await this.diffService.getCommits(0, COMMIT_BATCH_SIZE);
      this.commitPanel.hasMore = commits.length === COMMIT_BATCH_SIZE;

      if (hasUncommitted) {
        this.commitPanel.commits = [
          {
            sha: UNCOMMITTED_SHA,
            shortSha: "———",
            subject: "Uncommitted changes",
            isUncommitted: true,
          },
          ...commits,
        ];
      } else {
        this.commitPanel.commits = commits;
      }

      if (this.commitPanel.commits.length > 0) {
        await this.selectCommit(0);
      } else {
        this.diffPanel.content = "No commits or changes found.";
        this.refresh();
      }
    } catch {
      this.diffPanel.content = "Error loading commits.";
      this.refresh();
    }
  }

  // ── Selection ───────────────────────────────────────────────────────

  private async selectCommit(index: number) {
    this.commitPanel.index = index;
    this.filePanel.index = 0;
    this.filePanel.scrollOffset = 0;
    this.diffPanel.scrollOffset = 0;

    const commit = this.commitPanel.commits[index];
    if (!commit) return;

    this.diffPanel.content = "Loading...";
    this.filePanel.files = [];
    this.refresh();

    try {
      const result = commit.isUncommitted
        ? await this.diffService.getDiff()
        : await this.diffService.getCommitDiff(commit.sha);

      if (this.commitPanel.index !== index) return; // stale
      this.filePanel.files = result.files;

      if (this.filePanel.files.length > 0) {
        await this.selectFile(0, commit);
      } else {
        this.diffPanel.content = "No changes in this commit.";
        this.refresh();
      }
    } catch {
      if (this.commitPanel.index === index) {
        this.diffPanel.content = "Error loading commit diff.";
        this.refresh();
      }
    }
  }

  private async selectFile(index: number, commit?: CommitInfo) {
    this.filePanel.index = index;
    this.diffPanel.scrollOffset = 0;

    const file = this.filePanel.files[index];
    if (!file) return;

    const currentCommit = commit || this.commitPanel.commits[this.commitPanel.index];
    if (!currentCommit) return;

    this.diffPanel.content = `Loading diff for ${file.path}...`;
    this.refresh();

    try {
      const result = currentCommit.isUncommitted
        ? await this.diffService.getDiff(undefined, undefined, file.path)
        : await this.diffService.getCommitDiff(currentCommit.sha, file.path);

      if (
        this.filePanel.index === index &&
        this.commitPanel.commits[this.commitPanel.index]?.sha === currentCommit.sha
      ) {
        this.diffPanel.content = result.raw || "No changes in file.";
        this.refresh();
      }
    } catch {
      if (this.filePanel.index === index) {
        this.diffPanel.content = "Error loading diff.";
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
      this.commitPanel.commits.push(...newCommits);
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

  render(width: number): string[] {
    const commitWidth = Math.floor(width * 0.2);
    const fileWidth = Math.floor(width * 0.2);
    const diffWidth = width - commitWidth - fileWidth - 2;
    const sep = this.theme.fg("dim", "│");

    const lines: string[] = [];

    // Header
    const mkHeader = (label: string, panel: Panel, w: number) =>
      this.activePanel === panel
        ? this.theme.bg("selectedBg", this.theme.fg("accent", padToWidth(` ${label}`, w)))
        : this.theme.fg("dim", padToWidth(` ${label}`, w));

    lines.push(
      mkHeader("COMMITS", "commits", commitWidth) +
        sep +
        mkHeader("FILES", "files", fileWidth) +
        sep +
        mkHeader("DIFF", "diff", diffWidth)
    );

    // Content height
    const termRows = this.tui.terminal.rows || 24;
    this.contentHeight = Math.max(10, termRows - 3);

    // Panel contents
    const commitLines = this.commitPanel.render(
      commitWidth,
      this.contentHeight,
      this.activePanel,
      this.theme
    );
    const fileLines = this.filePanel.render(
      fileWidth,
      this.contentHeight,
      this.activePanel,
      this.theme
    );
    const diffLines = this.diffPanel.render(diffWidth, this.contentHeight, this.theme);

    for (let i = 0; i < this.contentHeight; i++) {
      const left = commitLines[i] || padToWidth("", commitWidth);
      const mid = fileLines[i] || padToWidth("", fileWidth);
      const right = diffLines[i] || "";
      lines.push(left + sep + mid + sep + right);
    }

    // Footer
    const scrollInfo =
      this.diffPanel.maxLines > this.contentHeight
        ? ` (${this.diffPanel.scrollOffset + 1}-${Math.min(this.diffPanel.scrollOffset + this.contentHeight, this.diffPanel.maxLines)}/${this.diffPanel.maxLines})`
        : "";
    const loadingIndicator = this.commitPanel.isLoading ? " [loading...]" : "";
    lines.push(
      this.theme.fg(
        "dim",
        ` [h/l] Panel  [j/k] Navigate  [PgUp/PgDn] Fast  [q] Quit${scrollInfo}${loadingIndicator}`
      )
    );

    return lines;
  }

  // ── Input handling ──────────────────────────────────────────────────

  handleInput(data: string) {
    if (matchesKey(data, "q") || matchesKey(data, "escape")) {
      this.done(null);
      return;
    }

    // Panel switching: h/l
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

    if (this.activePanel === "commits") this.navCommits(down, up, pgDown, pgUp);
    else if (this.activePanel === "files") this.navFiles(down, up, pgDown, pgUp);
    else this.navDiff(down, up, pgDown, pgUp);
  }

  private navCommits(down: boolean, up: boolean, pgDown: boolean, pgUp: boolean) {
    const len = this.commitPanel.commits.length;
    if (len === 0) return;

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
      const next = Math.min(this.commitPanel.index + 20, len - 1);
      if (next !== this.commitPanel.index) {
        this.selectCommit(next);
        if (next >= len - 5 && this.commitPanel.hasMore) this.loadMoreCommits();
      }
      return;
    }
    if (pgUp) {
      const prev = Math.max(0, this.commitPanel.index - 20);
      if (prev !== this.commitPanel.index) this.selectCommit(prev);
      return;
    }
  }

  private navFiles(down: boolean, up: boolean, pgDown: boolean, pgUp: boolean) {
    const len = this.filePanel.files.length;
    if (len === 0) return;

    if (down && this.filePanel.index < len - 1) {
      this.selectFile(this.filePanel.index + 1);
      return;
    }
    if (up && this.filePanel.index > 0) {
      this.selectFile(this.filePanel.index - 1);
      return;
    }
    if (pgDown) {
      const n = Math.min(this.filePanel.index + 20, len - 1);
      if (n !== this.filePanel.index) this.selectFile(n);
      return;
    }
    if (pgUp) {
      const p = Math.max(0, this.filePanel.index - 20);
      if (p !== this.filePanel.index) this.selectFile(p);
      return;
    }
  }

  private navDiff(down: boolean, up: boolean, pgDown: boolean, pgUp: boolean) {
    const maxScroll = Math.max(0, this.diffPanel.maxLines - this.contentHeight);

    if (down && this.diffPanel.scrollOffset < maxScroll) {
      this.diffPanel.scrollOffset++;
      this.refresh();
      return;
    }
    if (up && this.diffPanel.scrollOffset > 0) {
      this.diffPanel.scrollOffset--;
      this.refresh();
      return;
    }
    if (pgDown) {
      this.diffPanel.scrollOffset = Math.min(this.diffPanel.scrollOffset + 20, maxScroll);
      this.refresh();
      return;
    }
    if (pgUp) {
      this.diffPanel.scrollOffset = Math.max(0, this.diffPanel.scrollOffset - 20);
      this.refresh();
      return;
    }
  }
}
