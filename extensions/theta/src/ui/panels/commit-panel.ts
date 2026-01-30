import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { CommitInfo } from "../../services/diff-service.js";
import { padToWidth } from "../text-utils.js";
import type { Panel } from "../types.js";

export class CommitPanel {
  commits: CommitInfo[] = [];
  filteredCommits: CommitInfo[] = [];
  matchIndices: number[] = [];
  index = 0;
  scrollOffset = 0;
  isLoading = false;
  hasMore = true;

  applyFilter(query: string, caseSensitive: boolean): void {
    if (!query) {
      this.filteredCommits = this.commits;
      this.matchIndices = [];
      return;
    }

    const needle = caseSensitive ? query : query.toLowerCase();
    this.filteredCommits = [];
    this.matchIndices = [];

    for (let idx = 0; idx < this.commits.length; idx++) {
      const commit = this.commits[idx];
      const haystack = caseSensitive
        ? `${commit.sha} ${commit.shortSha} ${commit.subject} ${commit.author || ""} ${commit.body || ""}`
        : `${commit.sha} ${commit.shortSha} ${commit.subject} ${commit.author || ""} ${commit.body || ""}`.toLowerCase();

      if (haystack.includes(needle)) {
        this.matchIndices.push(this.filteredCommits.length);
        this.filteredCommits.push(commit);
      }
    }
  }

  clearFilter(): void {
    this.filteredCommits = this.commits;
    this.matchIndices = [];
    this.index = 0;
    this.scrollOffset = 0;
  }

  getDisplayCommits(): CommitInfo[] {
    return this.filteredCommits.length > 0 || this.matchIndices.length > 0
      ? this.filteredCommits
      : this.commits;
  }

  render(
    width: number,
    contentHeight: number,
    activePanel: Panel,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
    theme: any
  ): string[] {
    const lines: string[] = [];
    const visibleCount = contentHeight;

    // Adjust scroll to keep selection visible
    if (this.index < this.scrollOffset) {
      this.scrollOffset = this.index;
    } else if (this.index >= this.scrollOffset + visibleCount) {
      this.scrollOffset = this.index - visibleCount + 1;
    }

    const displayCommits = this.getDisplayCommits();
    const visible = displayCommits.slice(this.scrollOffset, this.scrollOffset + visibleCount);

    for (let i = 0; i < visible.length; i++) {
      const commit = visible[i];
      if (!commit?.shortSha) continue;
      const realIndex = this.scrollOffset + i;
      const selected = realIndex === this.index;
      const focused = activePanel === "commits";

      const prefix = selected ? "▸ " : "  ";
      const sha = commit.shortSha.padEnd(7);
      const maxSubject = Math.max(0, width - visibleWidth(prefix) - 8);
      const subject = truncateToWidth(commit.subject, maxSubject, "…");

      let line = `${prefix}${sha} ${subject}`;
      line = padToWidth(line, width);

      if (selected && focused) {
        line = theme.bg("selectedBg", theme.fg("accent", line));
      } else if (selected) {
        line = theme.fg("accent", line);
      } else if (commit.isUncommitted) {
        line = theme.fg("warning", line);
      } else {
        line = theme.fg("text", line);
      }

      lines.push(line);
    }

    // Show load more indicator
    if (this.hasMore && lines.length < visibleCount) {
      const loadMore = padToWidth("  ↓ more...", width);
      lines.push(theme.fg("dim", loadMore));
    }

    return lines;
  }
}
