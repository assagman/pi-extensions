import { visibleWidth } from "@mariozechner/pi-tui";
import { diffWordsWithSpace } from "diff";
import { padToWidth, scrollbarThumbPos, wrapLine } from "../text-utils.js";
import type { PanelComponent } from "../types.js";

/** ANSI SGR reset — ensures no color bleed after styled text. */
const RESET = "\x1b[0m";

export interface DiffStats {
  additions: number;
  deletions: number;
  filesChanged: number;
}

interface LineInfo {
  text: string;
  oldLineNum?: number;
  newLineNum?: number;
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

/**
 * A single visual (on-screen) line produced by wrapping a raw diff line.
 * Carries enough metadata to support search-highlight + word-diff rendering.
 */
interface VisualLine {
  /** Index into the raw-lines array. */
  rawIndex: number;
  /** Starting character offset in the raw line text. */
  colStart: number;
  /** Ending character offset (exclusive) in the raw line text. */
  colEnd: number;
  /** The substring of raw text for this visual line. */
  text: string;
  /** Whether this is the first visual line of the raw line (gets line numbers). */
  isFirst: boolean;
  /** Parsed line info (for line numbers). */
  lineInfo: LineInfo;
}

export class DiffPanel implements PanelComponent {
  private content = "Loading...";
  scrollOffset = 0;
  maxLines = 0;
  totalStats: DiffStats | null = null;
  showLineNumbers = true;
  matchPositions: LineMatch[] = [];
  private matchesByRawLine: LineMatch[][] = [];
  currentMatchIndex = 0;
  enableWordDiff = true;
  private wordHighlightsByLine: (WordHighlight | undefined)[] = [];

  /** Last contentHeight seen during render — used by scrollToMatch. */
  private lastContentHeight = 20;
  /** Incremental scroll optimization state. */
  private lastScrollOffset = -1;
  private lastWidth = 0;
  private lastRenderVersion = -1;
  /** Cached wrapping state. */
  private cachedWidth = 0;
  private cachedVisualLines: VisualLine[] = [];
  private cachedLineInfos: LineInfo[] = [];
  /** Cached raw lines — avoids content.split("\n") on every render frame. */
  private cachedRawLines: string[] = [];

  /** Render output cache — avoids re-rendering when inputs haven't changed. */
  private renderVersion = 0;
  private cachedRenderOutput: string[] = [];
  private renderCacheKey = "";

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
    this.renderVersion++;
    this.computeWordHighlights();

    // Eagerly recompute wrapping if we know the panel width from a prior render.
    // This ensures maxLines is accurate BEFORE the next nav call (prevents "stuck").
    if (this.cachedWidth > 0) {
      this.recomputeWrapping(this.cachedWidth);
    } else {
      // First call — no width known yet. Use raw line count as estimate.
      this.cachedVisualLines = [];
      this.cachedLineInfos = [];
      this.maxLines = this.cachedRawLines.length;
    }
  }

  private invalidateCache(): void {
    this.cachedWidth = 0;
    this.cachedVisualLines = [];
    this.cachedLineInfos = [];
  }

  // ── Wrapping cache ──────────────────────────────────────────────────

  /**
   * Ensure the visual-line cache is up-to-date for the given panel width.
   * Called at the start of render() and also from scrollToMatch (with the
   * last known width) so navigation works between renders.
   */
  private ensureCache(width: number): void {
    if (width === this.cachedWidth && this.cachedVisualLines.length > 0) return;
    this.recomputeWrapping(width);
  }

  private recomputeWrapping(width: number): void {
    this.cachedWidth = width;
    const lineNumWidth = this.showLineNumbers ? 8 : 0;
    const contentWidth = Math.max(1, width - lineNumWidth);

    // Parse line numbers once
    this.cachedLineInfos = this.showLineNumbers
      ? this.parseLineNumbers(this.cachedRawLines)
      : this.cachedRawLines.map((text) => ({ text }));

    // Wrap each raw line
    const visual: VisualLine[] = [];
    for (let ri = 0; ri < this.cachedLineInfos.length; ri++) {
      const info = this.cachedLineInfos[ri];
      const wrapped = wrapLine(info.text, contentWidth);
      let colStart = 0;
      for (let wi = 0; wi < wrapped.length; wi++) {
        const colEnd = colStart + wrapped[wi].length;
        visual.push({
          rawIndex: ri,
          colStart,
          colEnd,
          text: wrapped[wi],
          isFirst: wi === 0,
          lineInfo: info,
        });
        colStart = colEnd;
      }
    }

    this.cachedVisualLines = visual;
    this.maxLines = visual.length;
  }

  // ── Scroll clamping ─────────────────────────────────────────────────

  /** Clamp scrollOffset to valid range. Call after any mutation. */
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

    // Pre-allocate the index array
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
        const m: LineMatch = {
          lineIndex: i,
          startCol: index,
          length: query.length,
        };
        this.matchPositions.push(m);
        this.matchesByRawLine[i].push(m);
        startIndex = index + 1;
      }
    }

    this.currentMatchIndex = 0;
    this.renderVersion++;
    if (this.matchPositions.length > 0) {
      this.scrollToMatch(0);
    }
  }

  /**
   * Scroll viewport to center a search match.
   * Uses the wrapping cache to find the correct visual line position.
   */
  scrollToMatch(matchIndex: number): void {
    if (matchIndex < 0 || matchIndex >= this.matchPositions.length) return;
    this.currentMatchIndex = matchIndex;

    const match = this.matchPositions[matchIndex];
    const ch = this.lastContentHeight;

    // Ensure cache is available (use last known width)
    if (this.cachedWidth > 0) {
      this.ensureCache(this.cachedWidth);
    }

    // Find the visual line containing this match
    let targetVisualLine = match.lineIndex; // fallback: raw index
    for (let v = 0; v < this.cachedVisualLines.length; v++) {
      const vl = this.cachedVisualLines[v];
      if (
        vl.rawIndex === match.lineIndex &&
        match.startCol >= vl.colStart &&
        match.startCol < vl.colEnd
      ) {
        targetVisualLine = v;
        break;
      }
    }

    // Center in viewport
    const halfPage = Math.floor(ch / 2);
    const maxScroll = Math.max(0, this.maxLines - ch);
    this.scrollOffset = Math.max(0, Math.min(targetVisualLine - halfPage, maxScroll));
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
    this.currentMatchIndex = 0;
    this.renderVersion++;
  }

  applyFilter(query: string, caseSensitive: boolean): void {
    this.findMatches(query, caseSensitive);
  }

  clearFilter(): void {
    this.clearMatches();
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

    // Convert Map to array indexed by line number for faster lookup
    this.wordHighlightsByLine = new Array(this.cachedRawLines.length);
    for (const [lineIndex, highlight] of highlights) {
      this.wordHighlightsByLine[lineIndex] = highlight;
    }
  }

  // ── Line number parsing ─────────────────────────────────────────────

  private parseLineNumbers(lines: string[]): LineInfo[] {
    const result: LineInfo[] = [];
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      const hunkMatch = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (hunkMatch) {
        oldLine = Number.parseInt(hunkMatch[1], 10);
        newLine = Number.parseInt(hunkMatch[2], 10);
        result.push({ text: line });
        continue;
      }

      if (line.startsWith("+")) {
        result.push({ text: line, newLineNum: newLine });
        newLine++;
      } else if (line.startsWith("-")) {
        result.push({ text: line, oldLineNum: oldLine });
        oldLine++;
      } else if (line.startsWith(" ")) {
        result.push({ text: line, oldLineNum: oldLine, newLineNum: newLine });
        oldLine++;
        newLine++;
      } else {
        result.push({ text: line });
      }
    }

    return result;
  }

  // ── Rendering helpers ───────────────────────────────────────────────

  /**
   * Pad styled text to exact visible width, inserting an ANSI reset before
   * the padding spaces so trailing colors never bleed.
   */
  private padStyled(text: string, width: number): string {
    const vw = visibleWidth(text);
    if (vw >= width) return text;
    // Reset ANSI state, then pad with clean spaces
    return text + RESET + " ".repeat(width - vw);
  }

  /**
   * Render a portion of a word-highlight for a visual-line column range.
   * `colStart`/`colEnd` are string offsets into the raw line text.
   */
  private renderWordHighlightSlice(
    highlight: WordHighlight,
    colStart: number,
    colEnd: number,
    isFirst: boolean,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
    theme: any
  ): string {
    const fgColor = highlight.type === "deletion" ? "error" : "success";
    const bgColor = highlight.type === "deletion" ? "toolErrorBg" : "toolSuccessBg";
    const parts: string[] = [];

    // The prefix (+/-) is at column 0. Segments start at column 1.
    const prefixChar = highlight.type === "deletion" ? "-" : "+";

    if (isFirst && colStart === 0) {
      parts.push(theme.fg(fgColor, prefixChar));
    }

    // Map segments to column offsets (1-based, after prefix)
    let segCol = 1; // segments start after the prefix character
    for (const segment of highlight.segments) {
      const segEnd = segCol + segment.text.length;

      // Overlap between [segCol, segEnd) and [colStart, colEnd)
      const overlapStart = Math.max(segCol, colStart);
      const overlapEnd = Math.min(segEnd, colEnd);

      if (overlapStart < overlapEnd) {
        const sliceStart = overlapStart - segCol;
        const sliceEnd = overlapEnd - segCol;
        const sliceText = segment.text.substring(sliceStart, sliceEnd);

        if (segment.highlight) {
          parts.push(theme.bg(bgColor, theme.fg("text", sliceText)));
        } else {
          parts.push(theme.fg(fgColor, sliceText));
        }
      }

      segCol = segEnd;
      if (segCol >= colEnd) break;
    }

    return parts.join("");
  }

  /**
   * Render a visual line's text portion with search-match highlighting.
   * The visual line covers raw-line columns [colStart, colEnd).
   */
  private renderSearchHighlightSlice(
    rawText: string,
    lineMatches: LineMatch[],
    colStart: number,
    colEnd: number,
    lineColor: string,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
    theme: any
  ): string {
    // Filter to only overlapping matches (lineMatches is already for this line)
    const matches = lineMatches.filter(
      (m) => m.startCol < colEnd && m.startCol + m.length > colStart
    );

    if (matches.length === 0) {
      const sliceText = rawText.substring(colStart, colEnd);
      return theme.fg(lineColor, sliceText);
    }

    const sorted = matches.sort((a, b) => a.startCol - b.startCol);
    const parts: string[] = [];
    let cursor = colStart;

    for (const match of sorted) {
      const isCurrentMatch = this.matchPositions.indexOf(match) === this.currentMatchIndex;
      const mStart = Math.max(match.startCol, colStart);
      const mEnd = Math.min(match.startCol + match.length, colEnd);

      // Text before match
      if (mStart > cursor) {
        parts.push(theme.fg(lineColor, rawText.substring(cursor, mStart)));
      }

      // Highlighted match portion
      const matchText = rawText.substring(mStart, mEnd);
      if (isCurrentMatch) {
        parts.push(theme.bg("selectedBg", theme.fg("accent", matchText)));
      } else {
        parts.push(theme.bg("warning", theme.fg("text", matchText)));
      }

      cursor = mEnd;
    }

    // Remaining text after last match
    if (cursor < colEnd) {
      parts.push(theme.fg(lineColor, rawText.substring(cursor, colEnd)));
    }

    return parts.join("");
  }

  // ── Single-line rendering helper ────────────────────────────────────

  private renderSingleLine(
    lineIdx: number,
    contentWidth: number,
    _lineNumWidth: number,
    thumbPos: number,
    viewportRow: number,
    blankGutter: string,
    blankContent: string,
    blankLineGutter: string,
    gutterThumb: string,
    gutterSpace: string,
    hasMatches: boolean,
    hasWordHighlights: boolean,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported
    theme: any
  ): string {
    const suffix = thumbPos >= 0 && viewportRow === thumbPos ? gutterThumb : gutterSpace;

    if (lineIdx >= this.cachedVisualLines.length) {
      return blankLineGutter + blankContent + suffix;
    }

    const vl = this.cachedVisualLines[lineIdx];
    const rawText = this.cachedRawLines[vl.rawIndex] || "";

    let lineNumStr = "";
    if (this.showLineNumbers) {
      if (vl.isFirst) {
        const info = vl.lineInfo;
        if (info.oldLineNum !== undefined && info.newLineNum !== undefined) {
          lineNumStr = theme.fg(
            "dim",
            `${String(info.oldLineNum).padStart(3)}|${String(info.newLineNum).padStart(3)} `
          );
        } else if (info.oldLineNum !== undefined) {
          lineNumStr = theme.fg("error", `${String(info.oldLineNum).padStart(3)}|    `);
        } else if (info.newLineNum !== undefined) {
          lineNumStr = theme.fg("success", `   |${String(info.newLineNum).padStart(3)} `);
        } else {
          lineNumStr = blankGutter;
        }
      } else {
        lineNumStr = blankGutter;
      }
    }

    let matchesOnSlice = false;
    let lineMatches: LineMatch[] | undefined;
    if (hasMatches) {
      lineMatches = this.matchesByRawLine[vl.rawIndex];
      if (lineMatches && lineMatches.length > 0) {
        matchesOnSlice = lineMatches.some(
          (m) => m.startCol < vl.colEnd && m.startCol + m.length > vl.colStart
        );
      }
    }
    const wordHighlight = hasWordHighlights ? this.wordHighlightsByLine[vl.rawIndex] : undefined;
    let styledLine: string;

    let lineColor: string;
    if (rawText.startsWith("+")) lineColor = "success";
    else if (rawText.startsWith("-")) lineColor = "error";
    else if (rawText.startsWith("@@")) lineColor = "accent";
    else if (rawText.startsWith("diff ") || rawText.startsWith("index ")) lineColor = "dim";
    else lineColor = "text";

    if (matchesOnSlice && lineMatches) {
      styledLine = this.padStyled(
        this.renderSearchHighlightSlice(
          rawText,
          lineMatches,
          vl.colStart,
          vl.colEnd,
          lineColor,
          theme
        ),
        contentWidth
      );
    } else if (wordHighlight) {
      styledLine = this.padStyled(
        this.renderWordHighlightSlice(wordHighlight, vl.colStart, vl.colEnd, vl.isFirst, theme),
        contentWidth
      );
    } else {
      styledLine = theme.fg(lineColor, padToWidth(vl.text, contentWidth));
    }

    return lineNumStr + styledLine + suffix;
  }

  // ── Main render ─────────────────────────────────────────────────────

  render(
    width: number,
    contentHeight: number,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
    theme: any
  ): string[] {
    this.lastContentHeight = contentHeight;

    // Always reserve 1 char for scrollbar gutter — eliminates width oscillation
    const effectiveWidth = Math.max(1, width - 1);

    // Recompute wrapping if width changed
    this.ensureCache(effectiveWidth);

    // Clamp scroll
    const maxScroll = Math.max(0, this.maxLines - contentHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    // ── Render output cache — skip full render if inputs unchanged ────
    const cacheKey = `${width}|${contentHeight}|${this.scrollOffset}|${this.renderVersion}`;
    if (cacheKey === this.renderCacheKey && this.cachedRenderOutput.length > 0) {
      return this.cachedRenderOutput;
    }

    const lineNumWidth = this.showLineNumbers ? 8 : 0;
    const contentWidth = Math.max(1, effectiveWidth - lineNumWidth);

    // Scrollbar thumb
    const thumbPos = scrollbarThumbPos(this.scrollOffset, this.maxLines, contentHeight);

    // Pre-compute themed constants used across all lines
    const blankGutter = this.showLineNumbers ? theme.fg("dim", "        ") : "";
    const gutterThumb = theme.fg("dim", "█");
    const gutterSpace = theme.fg("dim", " ");

    // Hoist invariant checks out of the per-line loop
    const hasMatches = this.matchPositions.length > 0;
    const hasWordHighlights = this.wordHighlightsByLine.length > 0;

    const blankContent = " ".repeat(contentWidth);
    const blankLineGutter = this.showLineNumbers ? "        " : "";

    // ── Incremental scroll optimization — shift by 1 line ────────────
    const canIncrementalScroll =
      this.cachedRenderOutput.length === contentHeight &&
      width === this.lastWidth &&
      contentHeight === this.lastContentHeight &&
      this.renderVersion === this.lastRenderVersion &&
      Math.abs(this.scrollOffset - this.lastScrollOffset) === 1;

    if (canIncrementalScroll) {
      if (this.scrollOffset === this.lastScrollOffset + 1) {
        // Scrolled down: shift array up, render new bottom line
        this.cachedRenderOutput.shift();
        const newLineIdx = this.scrollOffset + contentHeight - 1;
        const newLine = this.renderSingleLine(
          newLineIdx,
          contentWidth,
          lineNumWidth,
          thumbPos,
          contentHeight - 1,
          blankGutter,
          blankContent,
          blankLineGutter,
          gutterThumb,
          gutterSpace,
          hasMatches,
          hasWordHighlights,
          theme
        );
        this.cachedRenderOutput.push(newLine);
      } else {
        // Scrolled up: pop last, unshift new top line
        this.cachedRenderOutput.pop();
        const newLineIdx = this.scrollOffset;
        const newLine = this.renderSingleLine(
          newLineIdx,
          contentWidth,
          lineNumWidth,
          thumbPos,
          0,
          blankGutter,
          blankContent,
          blankLineGutter,
          gutterThumb,
          gutterSpace,
          hasMatches,
          hasWordHighlights,
          theme
        );
        this.cachedRenderOutput.unshift(newLine);
      }

      // Update scrollbar on shifted lines (thumb position may have changed)
      for (let i = 0; i < contentHeight; i++) {
        const line = this.cachedRenderOutput[i];
        const shouldHaveThumb = thumbPos >= 0 && i === thumbPos;
        const hasThumb = line.endsWith("█\x1b[0m") || line.endsWith("█");

        if (shouldHaveThumb !== hasThumb) {
          const suffix = shouldHaveThumb ? gutterThumb : gutterSpace;
          if (line.endsWith(" ")) {
            this.cachedRenderOutput[i] = line.slice(0, -1) + (shouldHaveThumb ? "█" : " ");
          } else if (line.includes("\x1b[2m█\x1b[0m")) {
            // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences intentionally
            this.cachedRenderOutput[i] = line.replace(/\x1b\[2m[█ ]\x1b\[0m$/, suffix);
          }
        }
      }

      this.lastScrollOffset = this.scrollOffset;
      this.renderCacheKey = cacheKey;
      return this.cachedRenderOutput;
    }

    // Render visible lines — always exactly contentHeight lines to prevent visual tearing
    const start = this.scrollOffset;
    const result: string[] = new Array(contentHeight);

    for (let i = 0; i < contentHeight; i++) {
      const lineIdx = start + i;
      const suffix = thumbPos >= 0 && i === thumbPos ? gutterThumb : gutterSpace;

      // Beyond content: render blank filler line
      if (lineIdx >= this.cachedVisualLines.length) {
        result[i] = blankLineGutter + blankContent + suffix;
        continue;
      }

      const vl = this.cachedVisualLines[lineIdx];
      const rawText = this.cachedRawLines[vl.rawIndex] || "";

      // ── Line number prefix ───────────────────────────────────────────
      let lineNumStr = "";
      if (this.showLineNumbers) {
        if (vl.isFirst) {
          const info = vl.lineInfo;
          if (info.oldLineNum !== undefined && info.newLineNum !== undefined) {
            lineNumStr = theme.fg(
              "dim",
              `${String(info.oldLineNum).padStart(3)}|${String(info.newLineNum).padStart(3)} `
            );
          } else if (info.oldLineNum !== undefined) {
            lineNumStr = theme.fg("error", `${String(info.oldLineNum).padStart(3)}|    `);
          } else if (info.newLineNum !== undefined) {
            lineNumStr = theme.fg("success", `   |${String(info.newLineNum).padStart(3)} `);
          } else {
            lineNumStr = blankGutter;
          }
        } else {
          lineNumStr = blankGutter;
        }
      }

      // ── Styled content ───────────────────────────────────────────────
      let matchesOnSlice = false;
      let lineMatches: LineMatch[] | undefined;
      if (hasMatches) {
        lineMatches = this.matchesByRawLine[vl.rawIndex];
        if (lineMatches && lineMatches.length > 0) {
          matchesOnSlice = lineMatches.some(
            (m) => m.startCol < vl.colEnd && m.startCol + m.length > vl.colStart
          );
        }
      }
      const wordHighlight = hasWordHighlights ? this.wordHighlightsByLine[vl.rawIndex] : undefined;
      let styledLine: string;

      // Determine line-type color
      let lineColor: string;
      if (rawText.startsWith("+")) lineColor = "success";
      else if (rawText.startsWith("-")) lineColor = "error";
      else if (rawText.startsWith("@@")) lineColor = "accent";
      else if (rawText.startsWith("diff ") || rawText.startsWith("index ")) lineColor = "dim";
      else lineColor = "text";

      if (matchesOnSlice && lineMatches) {
        styledLine = this.padStyled(
          this.renderSearchHighlightSlice(
            rawText,
            lineMatches,
            vl.colStart,
            vl.colEnd,
            lineColor,
            theme
          ),
          contentWidth
        );
      } else if (wordHighlight) {
        styledLine = this.padStyled(
          this.renderWordHighlightSlice(wordHighlight, vl.colStart, vl.colEnd, vl.isFirst, theme),
          contentWidth
        );
      } else {
        styledLine = theme.fg(lineColor, padToWidth(vl.text, contentWidth));
      }

      result[i] = lineNumStr + styledLine + suffix;
    }

    this.lastScrollOffset = this.scrollOffset;
    this.lastWidth = width;
    this.lastContentHeight = contentHeight;
    this.lastRenderVersion = this.renderVersion;
    this.renderCacheKey = cacheKey;
    this.cachedRenderOutput = result;
    return result;
  }
}
