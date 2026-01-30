/**
 * DiffPanel — Side-by-side diff viewer with pre-computed styled lines.
 *
 * Layout: OLD (left) │ NEW (right) + scrollbar gutter
 *
 * Performance strategy:
 *   1. On setContent(): parse raw lines → SideBySideRow[] + compute word-diffs
 *   2. On first render (or width/theme change): pre-compute ALL styled rows
 *   3. On scroll: viewport = array slice of pre-computed lines + scrollbar gutter
 *      → O(viewportHeight) lookups, zero per-line styling
 *   4. Search highlighting: applied dynamically only for rows with matches
 */

import { visibleWidth } from "@mariozechner/pi-tui";
import { diffWordsWithSpace } from "diff";
import { padToWidth, scrollbarThumbPos } from "../text-utils.js";
import type { PanelComponent, ThemeLike } from "../types.js";

/** ANSI SGR reset — ensures no color bleed after styled text. */
const RESET = "\x1b[0m";

/** Line-number column width: 3 digits + 1 space. */
const LINE_NUM_W = 4;

// ── Types ─────────────────────────────────────────────────────────────────

export interface DiffStats {
  additions: number;
  deletions: number;
  filesChanged: number;
}

interface SideBySideLine {
  text: string;
  lineNum?: number;
}

interface SideBySideRow {
  old?: SideBySideLine;
  new?: SideBySideLine;
  type: "context" | "change" | "header";
  headerText?: string;
  /** Raw line index for the old/header side. */
  rawOldIndex?: number;
  /** Raw line index for the new side. */
  rawNewIndex?: number;
}

interface LineMatch {
  lineIndex: number;
  startCol: number;
  length: number;
}

interface LinePair {
  deletionIndex: number;
  additionIndex: number;
  deletionLine: string;
  additionLine: string;
}

interface WordSegment {
  text: string;
  highlight: boolean;
}

interface WordHighlight {
  lineIndex: number;
  type: "deletion" | "addition";
  segments: WordSegment[];
}

// ── DiffPanel ─────────────────────────────────────────────────────────────

export class DiffPanel implements PanelComponent {
  // ── Content state ───────────────────────────────────────────────────
  private content = "Loading...";
  scrollOffset = 0;
  maxLines = 0;
  totalStats: DiffStats | null = null;
  showLineNumbers = true;
  enableWordDiff = true;

  // ── Search state ────────────────────────────────────────────────────
  matchPositions: LineMatch[] = [];
  private matchesByRawLine: LineMatch[][] = [];
  currentMatchIndex = 0;
  private matchIndexMap = new Map<LineMatch, number>();

  // ── Parsed data ─────────────────────────────────────────────────────
  private cachedRawLines: string[] = [];
  private sbsRows: SideBySideRow[] = [];
  /** Map raw line index → SBS row index (for search navigation). */
  private rawLineToSbsRow: number[] = [];
  private wordHighlightsByLine: (WordHighlight | undefined)[] = [];

  // ── Pre-computed styled lines ───────────────────────────────────────
  private precomputedLines: string[] = [];
  private precomputedLeftW = 0;
  private precomputedRightW = 0;
  private precomputedTheme: ThemeLike = null;
  private blankLine = "";
  private stylesDirty = true;

  // ── Render cache ────────────────────────────────────────────────────
  private lastContentHeight = 20;
  private renderVersion = 0;
  private renderCacheKey = "";
  private cachedRenderOutput: string[] = [];

  // ── PanelComponent (search interface) ───────────────────────────────

  get filterMatchCount(): number {
    return this.matchPositions.length;
  }

  get filterCurrentIndex(): number {
    return this.currentMatchIndex;
  }

  // ── Content ─────────────────────────────────────────────────────────

  setContent(content: string): void {
    this.content = content;
    this.scrollOffset = 0;
    this.cachedRawLines = content.split("\n");
    this.matchesByRawLine = [];
    this.matchIndexMap = new Map();
    this.matchPositions = [];
    this.currentMatchIndex = 0;
    this.stylesDirty = true;
    this.renderVersion++;
    this.renderCacheKey = "";
    this.cachedRenderOutput = [];

    this.computeWordHighlights();
    this.parseSideBySide();
  }

  // ── Side-by-side parsing ────────────────────────────────────────────

  /**
   * Parse unified diff lines into SideBySideRow[].
   *
   * Algorithm:
   *   - Context lines → same text on both sides
   *   - Consecutive - then + lines → paired as change block
   *   - @@ / diff / index / etc → header rows spanning both columns
   */
  private parseSideBySide(): void {
    const lines = this.cachedRawLines;
    const rows: SideBySideRow[] = [];
    this.rawLineToSbsRow = new Array(lines.length).fill(-1);

    let oldLineNum = 0;
    let newLineNum = 0;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Hunk header
      if (line.startsWith("@@ ")) {
        const hunkMatch = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (hunkMatch) {
          oldLineNum = Number.parseInt(hunkMatch[1], 10);
          newLineNum = Number.parseInt(hunkMatch[2], 10);
        }
        const rowIdx = rows.length;
        rows.push({ type: "header", headerText: line, rawOldIndex: i });
        this.rawLineToSbsRow[i] = rowIdx;
        i++;
        continue;
      }

      // Other header lines
      if (
        line.startsWith("diff ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("Binary ") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("rename") ||
        line.startsWith("similarity") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode")
      ) {
        const rowIdx = rows.length;
        rows.push({ type: "header", headerText: line, rawOldIndex: i });
        this.rawLineToSbsRow[i] = rowIdx;
        i++;
        continue;
      }

      // Deletion block (possibly followed by addition block)
      if (line.startsWith("-")) {
        const deletions: { rawIndex: number; text: string; lineNum: number }[] = [];
        while (i < lines.length && lines[i].startsWith("-") && !lines[i].startsWith("---")) {
          deletions.push({ rawIndex: i, text: lines[i].substring(1), lineNum: oldLineNum++ });
          i++;
        }

        const additions: { rawIndex: number; text: string; lineNum: number }[] = [];
        while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) {
          additions.push({ rawIndex: i, text: lines[i].substring(1), lineNum: newLineNum++ });
          i++;
        }

        const maxLen = Math.max(deletions.length, additions.length);
        for (let j = 0; j < maxLen; j++) {
          const del = deletions[j];
          const add = additions[j];
          const rowIdx = rows.length;
          rows.push({
            type: "change",
            old: del ? { text: del.text, lineNum: del.lineNum } : undefined,
            new: add ? { text: add.text, lineNum: add.lineNum } : undefined,
            rawOldIndex: del?.rawIndex,
            rawNewIndex: add?.rawIndex,
          });
          if (del) this.rawLineToSbsRow[del.rawIndex] = rowIdx;
          if (add) this.rawLineToSbsRow[add.rawIndex] = rowIdx;
        }
        continue;
      }

      // Pure addition (no preceding deletion)
      if (line.startsWith("+")) {
        const rowIdx = rows.length;
        rows.push({
          type: "change",
          new: { text: line.substring(1), lineNum: newLineNum++ },
          rawNewIndex: i,
        });
        this.rawLineToSbsRow[i] = rowIdx;
        i++;
        continue;
      }

      // Context line (starts with space)
      if (line.startsWith(" ")) {
        const rowIdx = rows.length;
        rows.push({
          type: "context",
          old: { text: line.substring(1), lineNum: oldLineNum++ },
          new: { text: line.substring(1), lineNum: newLineNum++ },
          rawOldIndex: i,
          rawNewIndex: i,
        });
        this.rawLineToSbsRow[i] = rowIdx;
        i++;
        continue;
      }

      // Unknown / empty line → header
      const rowIdx = rows.length;
      rows.push({ type: "header", headerText: line, rawOldIndex: i });
      this.rawLineToSbsRow[i] = rowIdx;
      i++;
    }

    this.sbsRows = rows;
    this.maxLines = rows.length;
  }

  // ── Pre-computation engine ──────────────────────────────────────────

  private ensurePrecomputedStyles(leftWidth: number, rightWidth: number, theme: ThemeLike): void {
    if (
      !this.stylesDirty &&
      leftWidth === this.precomputedLeftW &&
      rightWidth === this.precomputedRightW &&
      theme === this.precomputedTheme
    ) {
      return;
    }
    this.precomputeStyles(leftWidth, rightWidth, theme);
  }

  private precomputeStyles(leftWidth: number, rightWidth: number, theme: ThemeLike): void {
    this.precomputedLeftW = leftWidth;
    this.precomputedRightW = rightWidth;
    this.precomputedTheme = theme;
    this.stylesDirty = false;

    const spanW = leftWidth + 1 + rightWidth; // full content width (no gutter)
    this.blankLine = " ".repeat(spanW);

    this.precomputedLines = new Array(this.sbsRows.length);
    for (let i = 0; i < this.sbsRows.length; i++) {
      this.precomputedLines[i] = this.precomputeSbsLine(i, leftWidth, rightWidth, theme);
    }

    this.maxLines = this.precomputedLines.length;
    this.renderVersion++;
    this.renderCacheKey = "";
    this.cachedRenderOutput = [];
  }

  // ── Single-line pre-computation ─────────────────────────────────────

  private precomputeSbsLine(
    rowIdx: number,
    leftWidth: number,
    rightWidth: number,
    theme: ThemeLike
  ): string {
    const row = this.sbsRows[rowIdx];

    if (row.type === "header") {
      return this.renderSbsHeader(row, leftWidth + 1 + rightWidth, theme);
    }

    const sep = theme.fg("dim", "│");
    const oldColor = row.type === "change" && row.old ? "error" : "text";
    const newColor = row.type === "change" && row.new ? "success" : "text";

    const oldStr = this.renderSbsSide(row.old, row.rawOldIndex, leftWidth, oldColor, false, theme);
    const newStr = this.renderSbsSide(row.new, row.rawNewIndex, rightWidth, newColor, false, theme);

    return oldStr + sep + newStr;
  }

  /**
   * Render a header row spanning both columns.
   * Hunk headers (@@ ... @@) are centered between dashes.
   * Other headers are left-aligned and dimmed.
   */
  private renderSbsHeader(row: SideBySideRow, totalWidth: number, theme: ThemeLike): string {
    const text = row.headerText || "";

    if (text.startsWith("@@")) {
      // Center hunk header between dashes: ─── @@ ... @@ ───
      const vw = visibleWidth(text);
      const available = totalWidth - vw - 2; // 2 for spaces around text
      if (available > 0) {
        const leftDash = Math.floor(available / 2);
        const rightDash = available - leftDash;
        const line = `${"─".repeat(leftDash)} ${text} ${"─".repeat(rightDash)}`;
        return theme.fg("accent", padToWidth(line, totalWidth));
      }
      return theme.fg("accent", padToWidth(text, totalWidth));
    }

    return theme.fg("dim", padToWidth(text, totalWidth));
  }

  /**
   * Render one side (old or new) of a SBS row.
   * Handles line numbers, word-diff, and optionally search highlighting.
   */
  private renderSbsSide(
    line: SideBySideLine | undefined,
    rawIndex: number | undefined,
    sideWidth: number,
    lineColor: string,
    withSearch: boolean,
    theme: ThemeLike
  ): string {
    const lineNumW = this.showLineNumbers ? LINE_NUM_W : 0;
    const contentW = Math.max(1, sideWidth - lineNumW);

    if (!line) {
      return padToWidth("", sideWidth);
    }

    // Line number
    let lineNumStr = "";
    if (this.showLineNumbers) {
      lineNumStr =
        line.lineNum !== undefined
          ? theme.fg("dim", `${String(line.lineNum).padStart(3)} `)
          : theme.fg("dim", "    ");
    }

    // Content
    let content: string;

    if (withSearch && rawIndex !== undefined) {
      const matches = this.matchesByRawLine[rawIndex];
      if (matches && matches.length > 0) {
        content = this.renderSearchHighlightedText(
          line.text,
          matches,
          1, // colOffset: skip prefix char in raw line
          contentW,
          lineColor,
          theme
        );
      } else {
        content = this.renderSideContent(line.text, rawIndex, contentW, lineColor, theme);
      }
    } else {
      content = this.renderSideContent(line.text, rawIndex, contentW, lineColor, theme);
    }

    return lineNumStr + content;
  }

  /**
   * Render content for one side — applies word-diff or plain color.
   */
  private renderSideContent(
    text: string,
    rawIndex: number | undefined,
    contentW: number,
    lineColor: string,
    theme: ThemeLike
  ): string {
    const wordHL = rawIndex !== undefined ? this.wordHighlightsByLine[rawIndex] : undefined;
    if (wordHL) {
      return this.padStyled(this.renderSbsWordHighlight(wordHL, contentW, theme), contentW);
    }
    return theme.fg(lineColor, padToWidth(text, contentW));
  }

  // ── Word-diff rendering ─────────────────────────────────────────────

  /**
   * Render word-highlighted text for side-by-side display.
   * Segments are in text-space (prefix already stripped).
   */
  private renderSbsWordHighlight(
    highlight: WordHighlight,
    maxWidth: number,
    theme: ThemeLike
  ): string {
    const fgColor = highlight.type === "deletion" ? "error" : "success";
    const bgColor = highlight.type === "deletion" ? "toolErrorBg" : "toolSuccessBg";
    const parts: string[] = [];
    let col = 0;

    for (const segment of highlight.segments) {
      if (col >= maxWidth) break;
      const remaining = maxWidth - col;
      const text =
        segment.text.length > remaining ? segment.text.substring(0, remaining) : segment.text;

      if (segment.highlight) {
        parts.push(theme.bg(bgColor, theme.fg("text", text)));
      } else {
        parts.push(theme.fg(fgColor, text));
      }
      col += text.length;
    }

    return parts.join("");
  }

  // ── Word-diff computation ───────────────────────────────────────────

  private findModifiedLinePairs(lines: string[]): LinePair[] {
    const pairs: LinePair[] = [];
    let i = 0;

    while (i < lines.length) {
      const deletions: { index: number; text: string }[] = [];
      while (i < lines.length && lines[i].startsWith("-") && !lines[i].startsWith("---")) {
        deletions.push({ index: i, text: lines[i].substring(1) });
        i++;
      }

      const additions: { index: number; text: string }[] = [];
      while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) {
        additions.push({ index: i, text: lines[i].substring(1) });
        i++;
      }

      const pairCount = Math.min(deletions.length, additions.length);
      for (let j = 0; j < pairCount; j++) {
        pairs.push({
          deletionIndex: deletions[j].index,
          additionIndex: additions[j].index,
          deletionLine: deletions[j].text,
          additionLine: additions[j].text,
        });
      }

      if (deletions.length === 0 && additions.length === 0) {
        i++;
      }
    }

    return pairs;
  }

  private computeWordDiffs(pairs: LinePair[]): Map<number, WordHighlight> {
    const highlights = new Map<number, WordHighlight>();

    for (const pair of pairs) {
      const changes = diffWordsWithSpace(pair.deletionLine, pair.additionLine);

      const deletionSegments: WordSegment[] = [];
      for (const change of changes) {
        if (change.removed) {
          deletionSegments.push({ text: change.value, highlight: true });
        } else if (!change.added) {
          deletionSegments.push({ text: change.value, highlight: false });
        }
      }

      const additionSegments: WordSegment[] = [];
      for (const change of changes) {
        if (change.added) {
          additionSegments.push({ text: change.value, highlight: true });
        } else if (!change.removed) {
          additionSegments.push({ text: change.value, highlight: false });
        }
      }

      highlights.set(pair.deletionIndex, {
        lineIndex: pair.deletionIndex,
        type: "deletion",
        segments: deletionSegments,
      });

      highlights.set(pair.additionIndex, {
        lineIndex: pair.additionIndex,
        type: "addition",
        segments: additionSegments,
      });
    }

    return highlights;
  }

  private computeWordHighlights(): void {
    if (!this.enableWordDiff) {
      this.wordHighlightsByLine = [];
      return;
    }

    const pairs = this.findModifiedLinePairs(this.cachedRawLines);
    const highlights = this.computeWordDiffs(pairs);

    this.wordHighlightsByLine = new Array(this.cachedRawLines.length);
    for (const [lineIndex, highlight] of highlights) {
      this.wordHighlightsByLine[lineIndex] = highlight;
    }
  }

  // ── Scroll clamping ─────────────────────────────────────────────────

  clampScroll(contentHeight: number): void {
    const maxScroll = Math.max(0, this.maxLines - contentHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
  }

  // ── Search ──────────────────────────────────────────────────────────

  findMatches(query: string, caseSensitive: boolean): void {
    this.matchPositions = [];
    this.matchesByRawLine = [];
    if (!query) {
      this.renderVersion++;
      return;
    }

    for (let i = 0; i < this.cachedRawLines.length; i++) {
      this.matchesByRawLine[i] = [];
    }

    const needle = caseSensitive ? query : query.toLowerCase();
    for (let i = 0; i < this.cachedRawLines.length; i++) {
      const line = caseSensitive ? this.cachedRawLines[i] : this.cachedRawLines[i].toLowerCase();
      let startIndex = 0;
      while (true) {
        const index = line.indexOf(needle, startIndex);
        if (index === -1) break;
        const m: LineMatch = { lineIndex: i, startCol: index, length: query.length };
        this.matchPositions.push(m);
        this.matchesByRawLine[i].push(m);
        startIndex = index + 1;
      }
    }

    this.matchIndexMap = new Map();
    for (let idx = 0; idx < this.matchPositions.length; idx++) {
      this.matchIndexMap.set(this.matchPositions[idx], idx);
    }

    this.currentMatchIndex = 0;
    this.renderVersion++;
    if (this.matchPositions.length > 0) {
      this.scrollToMatch(0);
    }
  }

  scrollToMatch(matchIndex: number): void {
    if (matchIndex < 0 || matchIndex >= this.matchPositions.length) return;
    this.currentMatchIndex = matchIndex;

    const match = this.matchPositions[matchIndex];
    const ch = this.lastContentHeight;

    // Map raw line index → SBS row index
    const targetRow = this.rawLineToSbsRow[match.lineIndex] ?? match.lineIndex;
    const halfPage = Math.floor(ch / 2);
    const maxScroll = Math.max(0, this.maxLines - ch);
    this.scrollOffset = Math.max(0, Math.min(targetRow - halfPage, maxScroll));
  }

  nextMatch(): void {
    if (this.matchPositions.length === 0) return;
    const next = (this.currentMatchIndex + 1) % this.matchPositions.length;
    this.renderVersion++;
    this.scrollToMatch(next);
  }

  prevMatch(): void {
    if (this.matchPositions.length === 0) return;
    const prev =
      (this.currentMatchIndex - 1 + this.matchPositions.length) % this.matchPositions.length;
    this.renderVersion++;
    this.scrollToMatch(prev);
  }

  clearMatches(): void {
    this.matchPositions = [];
    this.matchesByRawLine = [];
    this.matchIndexMap = new Map();
    this.currentMatchIndex = 0;
    this.renderVersion++;
  }

  applyFilter(query: string, caseSensitive: boolean): void {
    this.findMatches(query, caseSensitive);
  }

  clearFilter(): void {
    this.clearMatches();
  }

  // ── Search rendering helpers ────────────────────────────────────────

  /**
   * Render text with search match highlighting.
   *
   * @param text      Displayed text (prefix-stripped for diff content)
   * @param matches   Matches from matchesByRawLine for the raw line
   * @param colOffset Column offset (1 for prefix-stripped lines, 0 for headers)
   * @param maxWidth  Maximum visible width to render
   * @param lineColor Base color for non-matched text
   */
  private renderSearchHighlightedText(
    text: string,
    matches: LineMatch[],
    colOffset: number,
    maxWidth: number,
    lineColor: string,
    theme: ThemeLike
  ): string {
    const sorted = [...matches].sort((a, b) => a.startCol - b.startCol);
    const parts: string[] = [];
    let cursor = 0;

    for (const match of sorted) {
      const isCurrentMatch = this.matchIndexMap.get(match) === this.currentMatchIndex;
      const mStart = Math.max(0, match.startCol - colOffset);
      const mEnd = Math.max(0, match.startCol + match.length - colOffset);

      if (mEnd <= 0 || mStart >= text.length) continue;

      const effStart = Math.max(mStart, cursor);
      const effEnd = Math.min(mEnd, text.length);

      if (effStart > cursor) {
        parts.push(theme.fg(lineColor, text.substring(cursor, effStart)));
      }

      if (effStart < effEnd) {
        const matchText = text.substring(effStart, effEnd);
        if (isCurrentMatch) {
          parts.push(theme.bg("selectedBg", theme.fg("accent", matchText)));
        } else {
          parts.push(theme.bg("warning", theme.fg("text", matchText)));
        }
      }

      cursor = effEnd;
    }

    if (cursor < text.length) {
      parts.push(theme.fg(lineColor, text.substring(cursor)));
    }

    return this.padStyled(parts.join(""), maxWidth);
  }

  /**
   * Render a SBS row with search highlighting (called when search is active).
   */
  private renderSbsLineWithSearch(
    rowIdx: number,
    leftWidth: number,
    rightWidth: number,
    theme: ThemeLike
  ): string {
    const row = this.sbsRows[rowIdx];

    if (row.type === "header") {
      // Check for matches on the header's raw line
      const rawIdx = row.rawOldIndex;
      if (rawIdx !== undefined) {
        const matches = this.matchesByRawLine[rawIdx];
        if (matches && matches.length > 0) {
          const totalW = leftWidth + 1 + rightWidth;
          const text = row.headerText || "";
          const color = text.startsWith("@@") ? "accent" : "dim";
          return this.renderSearchHighlightedText(text, matches, 0, totalW, color, theme);
        }
      }
      return this.precomputedLines[rowIdx];
    }

    const sep = theme.fg("dim", "│");
    const oldColor = row.type === "change" && row.old ? "error" : "text";
    const newColor = row.type === "change" && row.new ? "success" : "text";

    const hasOldMatch =
      row.rawOldIndex !== undefined && this.matchesByRawLine[row.rawOldIndex]?.length > 0;
    const hasNewMatch =
      row.rawNewIndex !== undefined && this.matchesByRawLine[row.rawNewIndex]?.length > 0;

    const oldStr = this.renderSbsSide(
      row.old,
      row.rawOldIndex,
      leftWidth,
      oldColor,
      hasOldMatch,
      theme
    );
    const newStr = this.renderSbsSide(
      row.new,
      row.rawNewIndex,
      rightWidth,
      newColor,
      hasNewMatch,
      theme
    );

    return oldStr + sep + newStr;
  }

  // ── Rendering helpers ───────────────────────────────────────────────

  /**
   * Pad styled text to exact visible width, inserting ANSI reset before
   * padding spaces so trailing colors never bleed.
   */
  private padStyled(text: string, width: number): string {
    const vw = visibleWidth(text);
    if (vw >= width) return text;
    return text + RESET + " ".repeat(width - vw);
  }

  // ── Main render ─────────────────────────────────────────────────────

  render(
    width: number,
    contentHeight: number,
    theme: ThemeLike,
    leftWidth: number,
    rightWidth: number
  ): string[] {
    this.lastContentHeight = contentHeight;

    // Ensure pre-computed styles are up-to-date
    this.ensurePrecomputedStyles(leftWidth, rightWidth, theme);

    // Clamp scroll
    const maxScroll = Math.max(0, this.maxLines - contentHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    // ── Render cache — skip if inputs unchanged ─────────────────────
    const cacheKey = `${width}|${contentHeight}|${leftWidth}|${rightWidth}|${this.scrollOffset}|${this.renderVersion}|${this.currentMatchIndex}`;
    if (cacheKey === this.renderCacheKey && this.cachedRenderOutput.length > 0) {
      return this.cachedRenderOutput;
    }

    // ── Build viewport ──────────────────────────────────────────────
    const thumbPos = scrollbarThumbPos(this.scrollOffset, this.maxLines, contentHeight);
    const hasMatches = this.matchPositions.length > 0;
    const gutterThumb = theme.fg("dim", "█");
    const gutterSpace = " ";

    const result = new Array<string>(contentHeight);

    for (let i = 0; i < contentHeight; i++) {
      const lineIdx = this.scrollOffset + i;
      const gutter = thumbPos >= 0 && i === thumbPos ? gutterThumb : gutterSpace;

      if (lineIdx >= this.maxLines) {
        result[i] = this.blankLine + gutter;
      } else if (hasMatches) {
        result[i] = this.renderSbsLineWithSearch(lineIdx, leftWidth, rightWidth, theme) + gutter;
      } else {
        result[i] = this.precomputedLines[lineIdx] + gutter;
      }
    }

    this.renderCacheKey = cacheKey;
    this.cachedRenderOutput = result;
    return result;
  }
}
