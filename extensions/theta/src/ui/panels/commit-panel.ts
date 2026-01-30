import type { CommitInfo } from "../../services/diff-service.js";
import { padToWidth, scrollbarThumbPos, wrapLine } from "../text-utils.js";
import type { Panel, PanelComponent } from "../types.js";

export class CommitPanel implements PanelComponent {
  commits: CommitInfo[] = [];
  filteredCommits: CommitInfo[] = [];
  matchIndices: number[] = [];
  index = 0;
  scrollOffset = 0;
  isLoading = false;
  hasMore = true;
  isFiltered = false;
  private dataVersion = 0;

  /** Total visual lines after wrapping (set during render). */
  totalVisualLines = 0;

  /** Render output cache — avoids re-rendering when inputs haven't changed. */
  private cachedRenderOutput: string[] = [];
  private renderCacheKey = "";

  get filterMatchCount(): number {
    return this.isFiltered ? this.filteredCommits.length : 0;
  }

  get filterCurrentIndex(): number {
    return this.index;
  }

  setCommits(commits: CommitInfo[]): void {
    this.commits = commits;
    this.filteredCommits = [];
    this.matchIndices = [];
    this.isFiltered = false;
    this.index = 0;
    this.scrollOffset = 0;
    this.dataVersion++;
    this.renderCacheKey = "";
    this.cachedRenderOutput = [];
  }

  addCommits(commits: CommitInfo[]): void {
    this.commits.push(...commits);
    this.dataVersion++;
    this.renderCacheKey = "";
    this.cachedRenderOutput = [];
  }

  applyFilter(query: string, caseSensitive: boolean): void {
    if (!query) {
      this.filteredCommits = this.commits;
      this.matchIndices = [];
      this.isFiltered = false;
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
    this.isFiltered = true;
  }

  clearFilter(): void {
    this.filteredCommits = this.commits;
    this.matchIndices = [];
    this.isFiltered = false;
    this.index = 0;
    this.scrollOffset = 0;
  }

  getDisplayCommits(): CommitInfo[] {
    return this.isFiltered ? this.filteredCommits : this.commits;
  }

  /** Clamp index and scrollOffset to valid ranges. */
  clampScroll(contentHeight: number): void {
    const displayCommits = this.getDisplayCommits();
    const len = displayCommits.length;
    if (len === 0) {
      this.index = 0;
      this.scrollOffset = 0;
      this.totalVisualLines = 0;
      return;
    }
    this.index = Math.max(0, Math.min(this.index, len - 1));
    if (this.totalVisualLines > 0) {
      const maxScroll = Math.max(0, this.totalVisualLines - contentHeight);
      this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
    }
  }

  render(
    width: number,
    contentHeight: number,
    activePanel: Panel,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
    theme: any
  ): string[] {
    const displayCommits = this.getDisplayCommits();

    // Always reserve 1 char for scrollbar gutter — eliminates width oscillation
    const contentW = Math.max(1, width - 1);

    // ── Render output cache — skip full render if inputs unchanged ────
    const cacheKey = `${width}|${contentHeight}|${activePanel}|${this.index}|${this.scrollOffset}|${this.dataVersion}|${this.isLoading ? 1 : 0}|${this.hasMore ? 1 : 0}`;
    if (cacheKey === this.renderCacheKey && this.cachedRenderOutput.length > 0) {
      return this.cachedRenderOutput;
    }

    // ── Step 1: Build wrapped entries ──────────────────────────────────
    interface Entry {
      commit: CommitInfo;
      logicalIndex: number;
      visualOffset: number;
      wrappedLines: string[];
    }

    const entries: Entry[] = [];
    // Map from logical index → entry index for O(1) lookup
    const logicalToEntry = new Map<number, number>();
    let totalVis = 0;

    for (let i = 0; i < displayCommits.length; i++) {
      const commit = displayCommits[i];
      const sha = commit?.shortSha || "???";
      const prefix = i === this.index ? "▸ " : "  ";
      const rawText = `${prefix}${sha.padEnd(7)} ${commit.subject}`;
      const wrapped = wrapLine(rawText, contentW);

      logicalToEntry.set(i, entries.length);
      entries.push({ commit, logicalIndex: i, visualOffset: totalVis, wrappedLines: wrapped });
      totalVis += wrapped.length;
    }

    this.totalVisualLines = totalVis;

    // ── Step 2: Ensure selected item visible ───────────────────────────
    const selIdx = logicalToEntry.get(this.index);
    if (selIdx !== undefined) {
      const sel = entries[selIdx];
      const selStart = sel.visualOffset;
      const selEnd = selStart + sel.wrappedLines.length;

      if (selStart < this.scrollOffset) {
        this.scrollOffset = selStart;
      } else if (selEnd > this.scrollOffset + contentHeight) {
        this.scrollOffset = selEnd - contentHeight;
      }
    }

    // Clamp scrollOffset
    const maxScroll = Math.max(0, totalVis - contentHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    // ── Step 3: Render visible visual lines ────────────────────────────
    const thumbPos = scrollbarThumbPos(this.scrollOffset, totalVis, contentHeight);
    const lines: string[] = [];
    let visLine = 0;

    for (const entry of entries) {
      if (visLine >= this.scrollOffset + contentHeight) break;

      for (let w = 0; w < entry.wrappedLines.length; w++) {
        if (visLine >= this.scrollOffset + contentHeight) break;

        if (visLine >= this.scrollOffset) {
          const selected = entry.logicalIndex === this.index;
          const focused = activePanel === "commits";

          let line = padToWidth(entry.wrappedLines[w], contentW);

          if (selected && focused) {
            line = theme.bg("selectedBg", theme.fg("accent", line));
          } else if (selected) {
            line = theme.fg("accent", line);
          } else if (entry.commit.isUncommitted) {
            line = theme.fg("warning", line);
          } else {
            line = theme.fg("text", line);
          }

          // Gutter: always 1 char — shows █ at thumb pos or space
          const rowInViewport = visLine - this.scrollOffset;
          line += thumbPos >= 0 && rowInViewport === thumbPos ? theme.fg("dim", "█") : " ";

          lines.push(line);
        }
        visLine++;
      }
    }

    // Show load more indicator if room available
    if (this.hasMore && lines.length < contentHeight) {
      lines.push(`${theme.fg("dim", padToWidth("  ↓ more...", contentW))} `);
    }

    // Pad to exactly contentHeight lines
    while (lines.length < contentHeight) {
      lines.push(`${padToWidth("", contentW)} `);
    }

    this.renderCacheKey = cacheKey;
    this.cachedRenderOutput = lines;
    return lines;
  }
}
