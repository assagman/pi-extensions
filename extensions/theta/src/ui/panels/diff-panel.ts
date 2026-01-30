/**
 * DiffPanel — Side-by-side diff viewer with syntax highlighting.
 *
 * Layout: OLD (left) │ NEW (right) + scrollbar gutter
 *
 * Rendering pipeline:
 *   1. setContent(): parse raw lines → SideBySideRow[] + word-diffs + detect language
 *   2. precomputeStyles(): for each row, produce styled ANSI string with:
 *      - Syntax-highlighted code (keyword/string/comment/type/function colors)
 *      - Line backgrounds (red for deletions, green for additions)
 *      - Word-diff backgrounds (brighter red/green for changed words)
 *   3. render(): viewport slice of pre-computed lines + scrollbar gutter
 *   4. Search: dynamic re-render with match highlights overlaid
 */

import { visibleWidth } from "@mariozechner/pi-tui";
import { diffWordsWithSpace } from "diff";
import {
  DIFF_BG,
  DIM_FG,
  RESET,
  SYNTAX_FG,
  type Token,
  detectLanguage,
  tokenizeLine,
} from "../syntax.js";
import { padToWidth, scrollbarThumbPos } from "../text-utils.js";
import type { PanelComponent, ThemeLike } from "../types.js";

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
  rawOldIndex?: number;
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

/** Line type determines background coloring. */
type LineType = "deletion" | "addition" | "context";

// ── DiffPanel ─────────────────────────────────────────────────────────────

export class DiffPanel implements PanelComponent {
  // ── Content state ───────────────────────────────────────────────────
  private content = "Loading...";
  scrollOffset = 0;
  maxLines = 0;
  totalStats: DiffStats | null = null;
  showLineNumbers = true;
  enableWordDiff = true;

  // ── Language ────────────────────────────────────────────────────────
  private language = "text";

  // ── Search state ────────────────────────────────────────────────────
  matchPositions: LineMatch[] = [];
  private matchesByRawLine: LineMatch[][] = [];
  currentMatchIndex = 0;
  private matchIndexMap = new Map<LineMatch, number>();

  // ── Parsed data ─────────────────────────────────────────────────────
  private cachedRawLines: string[] = [];
  private sbsRows: SideBySideRow[] = [];
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

    this.language = this.detectLanguageFromContent();
    this.computeWordHighlights();
    this.parseSideBySide();
  }

  // ── Language detection ──────────────────────────────────────────────

  /**
   * Auto-detect language from diff headers (+++ b/path or diff --git).
   */
  private detectLanguageFromContent(): string {
    for (const line of this.cachedRawLines) {
      if (line.startsWith("+++ b/")) {
        return detectLanguage(line.substring(6));
      }
      if (line.startsWith("diff --git")) {
        const match = line.match(/b\/(.+)$/);
        if (match) return detectLanguage(match[1]);
      }
    }
    return "text";
  }

  // ── Side-by-side parsing ────────────────────────────────────────────

  private parseSideBySide(): void {
    const lines = this.cachedRawLines;
    const rows: SideBySideRow[] = [];
    this.rawLineToSbsRow = new Array(lines.length).fill(-1);

    let oldLineNum = 0;
    let newLineNum = 0;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

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

    const spanW = leftWidth + 1 + rightWidth;
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

    const oldType: LineType = row.type === "change" && row.old ? "deletion" : "context";
    const newType: LineType = row.type === "change" && row.new ? "addition" : "context";

    const oldStr = this.renderSyntaxSide(row.old, row.rawOldIndex, leftWidth, oldType);
    const newStr = this.renderSyntaxSide(row.new, row.rawNewIndex, rightWidth, newType);

    return oldStr + sep + newStr;
  }

  private renderSbsHeader(row: SideBySideRow, totalWidth: number, theme: ThemeLike): string {
    const text = row.headerText || "";

    if (text.startsWith("@@")) {
      const vw = visibleWidth(text);
      const available = totalWidth - vw - 2;
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

  // ── Syntax-highlighted side rendering ───────────────────────────────

  /**
   * Render one side of a SBS row with syntax highlighting and diff backgrounds.
   *
   * Output structure: [lineBg][dimLineNum][syntaxContent + wordDiffBg][padding][RESET]
   */
  private renderSyntaxSide(
    line: SideBySideLine | undefined,
    rawIndex: number | undefined,
    sideWidth: number,
    lineType: LineType
  ): string {
    const lineNumW = this.showLineNumbers ? LINE_NUM_W : 0;
    const contentW = Math.max(1, sideWidth - lineNumW);
    const lineBg =
      lineType === "deletion" ? DIFF_BG.deletion : lineType === "addition" ? DIFF_BG.addition : "";

    if (!line) {
      // Empty side — just spaces (no background for empty slots)
      return " ".repeat(sideWidth);
    }

    // ── Line number with background ───────────────────────────────
    let lineNumStr = "";
    if (this.showLineNumbers) {
      lineNumStr =
        line.lineNum !== undefined
          ? `${lineBg}${DIM_FG}${String(line.lineNum).padStart(3)} `
          : `${lineBg}${DIM_FG}    `;
    }

    // ── Content with syntax highlighting ──────────────────────────
    const tokens = tokenizeLine(line.text, this.language);
    const wordHL = rawIndex !== undefined ? this.wordHighlightsByLine[rawIndex] : undefined;
    const wordBg =
      lineType === "deletion"
        ? DIFF_BG.wordDeletion
        : lineType === "addition"
          ? DIFF_BG.wordAddition
          : "";

    let content: string;
    if (wordHL && wordHL.segments.length > 0) {
      content = this.renderTokensWithWordDiff(tokens, wordHL.segments, lineBg, wordBg, contentW);
    } else {
      content = this.renderTokens(tokens, lineBg, contentW);
    }

    return lineNumStr + content;
  }

  /**
   * Render syntax tokens with a uniform line background. No word-diff.
   */
  private renderTokens(tokens: Token[], lineBg: string, maxWidth: number): string {
    let result = lineBg;
    let col = 0;

    for (const token of tokens) {
      if (col >= maxWidth) break;
      const remaining = maxWidth - col;
      const text = token.text.length > remaining ? token.text.substring(0, remaining) : token.text;
      result += SYNTAX_FG[token.type] + text;
      col += text.length;
    }

    // Pad to width with line background
    if (col < maxWidth) {
      result += lineBg + " ".repeat(maxWidth - col);
    }
    result += RESET;
    return result;
  }

  /**
   * Merge syntax tokens with word-diff segments.
   *
   * Walks both lists in lockstep — at each character position:
   *   fg = syntax token color
   *   bg = word-diff highlighted ? wordBg : lineBg
   */
  private renderTokensWithWordDiff(
    tokens: Token[],
    wordSegments: WordSegment[],
    lineBg: string,
    wordBg: string,
    maxWidth: number
  ): string {
    let result = "";
    let col = 0;

    let tIdx = 0;
    let tOff = 0;
    let wIdx = 0;
    let wOff = 0;

    while (tIdx < tokens.length && wIdx < wordSegments.length && col < maxWidth) {
      const token = tokens[tIdx];
      const seg = wordSegments[wIdx];

      const tRemain = token.text.length - tOff;
      const wRemain = seg.text.length - wOff;
      const maxRemain = maxWidth - col;
      const chunkLen = Math.min(tRemain, wRemain, maxRemain);

      const fgCode = SYNTAX_FG[token.type];
      const bgCode = seg.highlight ? wordBg : lineBg;
      const text = token.text.substring(tOff, tOff + chunkLen);

      result += bgCode + fgCode + text;
      col += chunkLen;

      tOff += chunkLen;
      wOff += chunkLen;

      if (tOff >= token.text.length) {
        tIdx++;
        tOff = 0;
      }
      if (wOff >= seg.text.length) {
        wIdx++;
        wOff = 0;
      }
    }

    // Remaining tokens (word segments exhausted)
    while (tIdx < tokens.length && col < maxWidth) {
      const token = tokens[tIdx];
      const text = tOff > 0 ? token.text.substring(tOff) : token.text;
      const truncated = text.length > maxWidth - col ? text.substring(0, maxWidth - col) : text;
      result += lineBg + SYNTAX_FG[token.type] + truncated;
      col += truncated.length;
      tIdx++;
      tOff = 0;
    }

    // Pad
    if (col < maxWidth) {
      result += lineBg + " ".repeat(maxWidth - col);
    }
    result += RESET;
    return result;
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

  // ── Search rendering ────────────────────────────────────────────────

  /**
   * Render a SBS row with search highlighting overlaid on syntax.
   *
   * Non-matched regions: syntax fg + line bg (like precomputed)
   * Matched regions: high-contrast theme fg/bg (overrides syntax for visibility)
   */
  private renderSbsLineWithSearch(
    rowIdx: number,
    leftWidth: number,
    rightWidth: number,
    theme: ThemeLike
  ): string {
    const row = this.sbsRows[rowIdx];

    if (row.type === "header") {
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

    const oldType: LineType = row.type === "change" && row.old ? "deletion" : "context";
    const newType: LineType = row.type === "change" && row.new ? "addition" : "context";

    const hasOldMatch =
      row.rawOldIndex !== undefined && this.matchesByRawLine[row.rawOldIndex]?.length > 0;
    const hasNewMatch =
      row.rawNewIndex !== undefined && this.matchesByRawLine[row.rawNewIndex]?.length > 0;

    const oldStr =
      hasOldMatch && row.rawOldIndex !== undefined
        ? this.renderSearchSide(row.old, row.rawOldIndex, leftWidth, oldType, theme)
        : this.renderSyntaxSide(row.old, row.rawOldIndex, leftWidth, oldType);
    const newStr =
      hasNewMatch && row.rawNewIndex !== undefined
        ? this.renderSearchSide(row.new, row.rawNewIndex, rightWidth, newType, theme)
        : this.renderSyntaxSide(row.new, row.rawNewIndex, rightWidth, newType);

    return oldStr + sep + newStr;
  }

  /**
   * Render one side with search highlighting.
   * Uses syntax highlighting for non-matched regions, theme for matches.
   */
  private renderSearchSide(
    line: SideBySideLine | undefined,
    rawIndex: number,
    sideWidth: number,
    lineType: LineType,
    theme: ThemeLike
  ): string {
    const lineNumW = this.showLineNumbers ? LINE_NUM_W : 0;
    const contentW = Math.max(1, sideWidth - lineNumW);
    const lineBg =
      lineType === "deletion" ? DIFF_BG.deletion : lineType === "addition" ? DIFF_BG.addition : "";

    if (!line) return " ".repeat(sideWidth);

    // Line number
    let lineNumStr = "";
    if (this.showLineNumbers) {
      lineNumStr =
        line.lineNum !== undefined
          ? `${lineBg}${DIM_FG}${String(line.lineNum).padStart(3)} `
          : `${lineBg}${DIM_FG}    `;
    }

    // Build content with syntax + search highlight overlay
    const tokens = tokenizeLine(line.text, this.language);
    const matches = this.matchesByRawLine[rawIndex] || [];
    const content = this.renderTokensWithSearch(
      tokens,
      line.text,
      matches,
      lineBg,
      contentW,
      theme
    );

    return lineNumStr + content;
  }

  /**
   * Render syntax tokens with search match overlay.
   *
   * Walks tokens and match regions together:
   *   - Non-matched: syntax fg + lineBg
   *   - Matched: theme highlight fg/bg (high contrast, overrides syntax)
   */
  private renderTokensWithSearch(
    tokens: Token[],
    fullText: string,
    matches: LineMatch[],
    lineBg: string,
    maxWidth: number,
    _theme: ThemeLike
  ): string {
    // Build a match bitmap: for each char position, is it in a match?
    // Also track which match index for current-match highlighting.
    const sorted = [...matches].sort((a, b) => a.startCol - b.startCol);
    const matchAt: (LineMatch | null)[] = new Array(fullText.length).fill(null);
    for (const match of sorted) {
      const start = Math.max(0, match.startCol - 1); // -1 for prefix offset
      const end = Math.min(fullText.length, match.startCol + match.length - 1);
      for (let c = start; c < end; c++) {
        matchAt[c] = match;
      }
    }

    let result = "";
    let col = 0;
    let textPos = 0;

    for (const token of tokens) {
      if (col >= maxWidth) break;

      for (let ti = 0; ti < token.text.length && col < maxWidth; ti++) {
        const m = textPos < matchAt.length ? matchAt[textPos] : null;

        if (m) {
          const isCurrent = this.matchIndexMap.get(m) === this.currentMatchIndex;
          if (isCurrent) {
            result += "\x1b[48;2;80;80;0m\x1b[38;2;255;255;100m"; // bright yellow
          } else {
            result += "\x1b[48;2;60;60;0m\x1b[38;2;200;200;80m"; // dim yellow
          }
        } else {
          result += lineBg + SYNTAX_FG[token.type];
        }
        result += token.text[ti];

        col++;
        textPos++;
      }
    }

    if (col < maxWidth) {
      result += lineBg + " ".repeat(maxWidth - col);
    }
    result += RESET;
    return result;
  }

  /**
   * Render text with search highlighting (for headers, uses theme).
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

  // ── Rendering helpers ───────────────────────────────────────────────

  private padStyled(text: string, width: number): string {
    const vw = visibleWidth(text);
    if (vw >= width) return text;
    return `${text}${RESET}${" ".repeat(width - vw)}`;
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

    this.ensurePrecomputedStyles(leftWidth, rightWidth, theme);

    const maxScroll = Math.max(0, this.maxLines - contentHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    const cacheKey = `${width}|${contentHeight}|${leftWidth}|${rightWidth}|${this.scrollOffset}|${this.renderVersion}|${this.currentMatchIndex}`;
    if (cacheKey === this.renderCacheKey && this.cachedRenderOutput.length > 0) {
      return this.cachedRenderOutput;
    }

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
