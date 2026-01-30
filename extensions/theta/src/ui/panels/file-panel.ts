import type { DiffFile } from "../../services/diff-service.js";
import { padToWidth, scrollbarThumbPos, wrapLine } from "../text-utils.js";
import type { Panel, PanelComponent } from "../types.js";

export class FilePanel implements PanelComponent {
  files: DiffFile[] = [];
  filteredFiles: DiffFile[] = [];
  matchIndices: number[] = [];
  index = 0;
  scrollOffset = 0;
  isFiltered = false;
  private dataVersion = 0;

  /** Total visual lines after wrapping (set during render). */
  totalVisualLines = 0;

  /** Render output cache — avoids re-rendering when inputs haven't changed. */
  private cachedRenderOutput: string[] = [];
  private renderCacheKey = "";

  get filterMatchCount(): number {
    return this.isFiltered ? this.filteredFiles.length : 0;
  }

  get filterCurrentIndex(): number {
    return this.index;
  }

  setFiles(files: DiffFile[]): void {
    this.files = files;
    this.filteredFiles = [];
    this.matchIndices = [];
    this.isFiltered = false;
    this.index = 0;
    this.scrollOffset = 0;
    this.dataVersion++;
    this.renderCacheKey = "";
    this.cachedRenderOutput = [];
  }

  applyFilter(query: string, caseSensitive: boolean): void {
    if (!query) {
      this.filteredFiles = this.files;
      this.matchIndices = [];
      this.isFiltered = false;
      return;
    }

    const needle = caseSensitive ? query : query.toLowerCase();
    this.filteredFiles = [];
    this.matchIndices = [];

    for (let idx = 0; idx < this.files.length; idx++) {
      const file = this.files[idx];
      const path = caseSensitive ? file.path : file.path.toLowerCase();

      if (path.includes(needle)) {
        this.matchIndices.push(this.filteredFiles.length);
        this.filteredFiles.push(file);
      }
    }
    this.isFiltered = true;
  }

  clearFilter(): void {
    this.filteredFiles = this.files;
    this.matchIndices = [];
    this.isFiltered = false;
    this.index = 0;
    this.scrollOffset = 0;
  }

  getDisplayFiles(): DiffFile[] {
    return this.isFiltered ? this.filteredFiles : this.files;
  }

  /** Clamp index and scrollOffset to valid ranges. */
  clampScroll(contentHeight: number): void {
    const displayFiles = this.getDisplayFiles();
    const len = displayFiles.length;
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
    const displayFiles = this.getDisplayFiles();

    // Always reserve 1 char for scrollbar gutter — eliminates width oscillation
    const contentW = Math.max(1, width - 1);

    // ── Render output cache — skip full render if inputs unchanged ────
    const cacheKey = `${width}|${contentHeight}|${activePanel}|${this.index}|${this.scrollOffset}|${this.dataVersion}|${this.isFiltered ? 1 : 0}`;
    if (cacheKey === this.renderCacheKey && this.cachedRenderOutput.length > 0) {
      return this.cachedRenderOutput;
    }

    // ── Step 1: Build wrapped entries ──────────────────────────────────
    interface Entry {
      file: DiffFile;
      logicalIndex: number;
      visualOffset: number;
      wrappedLines: string[];
    }

    const entries: Entry[] = [];
    const logicalToEntry = new Map<number, number>();
    let totalVis = 0;

    for (let i = 0; i < displayFiles.length; i++) {
      const file = displayFiles[i];
      const prefix = i === this.index ? "▸ " : "  ";
      const statsRaw = `+${file.additions} -${file.deletions} `;
      const rawText = `${prefix}${statsRaw}${file.path}`;
      const wrapped = wrapLine(rawText, contentW);

      logicalToEntry.set(i, entries.length);
      entries.push({ file, logicalIndex: i, visualOffset: totalVis, wrappedLines: wrapped });
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
          const focused = activePanel === "files";

          let styledLine: string;

          if (w === 0) {
            // First visual line — per-segment stats styling
            const prefix = selected ? "▸ " : "  ";
            const statsRaw = `+${entry.file.additions} -${entry.file.deletions} `;
            const afterPrefix = entry.wrappedLines[w].substring(prefix.length);

            if (afterPrefix.length >= statsRaw.length) {
              const statsStyled = `${theme.fg("success", `+${entry.file.additions}`)}${theme.fg("error", ` -${entry.file.deletions}`)} `;
              const pathPortion = afterPrefix.substring(statsRaw.length);
              const prefixStyled = selected ? theme.fg("accent", prefix) : theme.fg("dim", prefix);
              const nameStyled = selected
                ? theme.fg("accent", pathPortion)
                : theme.fg("text", pathPortion);

              styledLine = padToWidth(prefixStyled + statsStyled + nameStyled, contentW);
            } else {
              const prefixStyled = selected ? theme.fg("accent", prefix) : theme.fg("dim", prefix);
              styledLine = padToWidth(prefixStyled + theme.fg("text", afterPrefix), contentW);
            }
          } else {
            // Continuation line
            styledLine = padToWidth(
              selected
                ? theme.fg("accent", entry.wrappedLines[w])
                : theme.fg("text", entry.wrappedLines[w]),
              contentW
            );
          }

          if (selected && focused) {
            styledLine = theme.bg("selectedBg", styledLine);
          }

          // Gutter: always 1 char
          const rowInViewport = visLine - this.scrollOffset;
          styledLine += thumbPos >= 0 && rowInViewport === thumbPos ? theme.fg("dim", "█") : " ";

          lines.push(styledLine);
        }
        visLine++;
      }
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
