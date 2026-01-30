import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { diffWordsWithSpace } from "diff";

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

export class DiffPanel {
  content = "Loading...";
  scrollOffset = 0;
  maxLines = 0;
  totalStats: DiffStats | null = null;
  showLineNumbers = true;
  matchPositions: LineMatch[] = [];
  currentMatchIndex = 0;
  enableWordDiff = true;
  wordHighlights: Map<number, WordHighlight> = new Map();

  findMatches(query: string, caseSensitive: boolean): void {
    this.matchPositions = [];

    if (!query) return;

    const lines = this.content.split("\n");
    const needle = caseSensitive ? query : query.toLowerCase();

    for (let i = 0; i < lines.length; i++) {
      const line = caseSensitive ? lines[i] : lines[i].toLowerCase();
      let startIndex = 0;

      while (true) {
        const index = line.indexOf(needle, startIndex);
        if (index === -1) break;

        this.matchPositions.push({
          lineIndex: i,
          startCol: index,
          length: query.length,
        });

        startIndex = index + 1;
      }
    }

    this.currentMatchIndex = 0;
    if (this.matchPositions.length > 0) {
      this.scrollToMatch(0);
    }
  }

  scrollToMatch(matchIndex: number): void {
    if (matchIndex < 0 || matchIndex >= this.matchPositions.length) return;

    const match = this.matchPositions[matchIndex];
    this.currentMatchIndex = matchIndex;

    // Center match in viewport (if possible)
    const targetOffset = Math.max(0, match.lineIndex - 5);
    this.scrollOffset = targetOffset;
  }

  nextMatch(): void {
    if (this.matchPositions.length === 0) return;
    const next = (this.currentMatchIndex + 1) % this.matchPositions.length;
    this.scrollToMatch(next);
  }

  prevMatch(): void {
    if (this.matchPositions.length === 0) return;
    const prev =
      (this.currentMatchIndex - 1 + this.matchPositions.length) % this.matchPositions.length;
    this.scrollToMatch(prev);
  }

  clearMatches(): void {
    this.matchPositions = [];
    this.currentMatchIndex = 0;
  }

  setContent(content: string): void {
    this.content = content;
    this.computeWordHighlights();
  }

  private findModifiedLinePairs(lines: string[]): LinePair[] {
    const pairs: LinePair[] = [];

    for (let i = 0; i < lines.length - 1; i++) {
      const curr = lines[i];
      const next = lines[i + 1];

      // Check if current is deletion and next is addition
      // Exclude file headers (---/+++) which also start with -/+
      if (
        curr.startsWith("-") &&
        !curr.startsWith("---") &&
        next.startsWith("+") &&
        !next.startsWith("+++")
      ) {
        pairs.push({
          deletionIndex: i,
          additionIndex: i + 1,
          deletionLine: curr.substring(1), // Strip '-' prefix
          additionLine: next.substring(1), // Strip '+' prefix
        });
        i++; // Skip next line since we paired it
      }
    }

    return pairs;
  }

  private computeWordDiffs(pairs: LinePair[]): Map<number, WordHighlight> {
    const highlights = new Map<number, WordHighlight>();

    for (const pair of pairs) {
      const changes = diffWordsWithSpace(pair.deletionLine, pair.additionLine);

      // Build segments for deletion line
      const deletionSegments: WordSegment[] = [];
      for (const change of changes) {
        if (change.removed) {
          deletionSegments.push({ text: change.value, highlight: true });
        } else if (!change.added) {
          deletionSegments.push({ text: change.value, highlight: false });
        }
      }

      // Build segments for addition line
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
      this.wordHighlights.clear();
      return;
    }

    const lines = this.content.split("\n");
    const pairs = this.findModifiedLinePairs(lines);
    this.wordHighlights = this.computeWordDiffs(pairs);
  }

  private parseLineNumbers(lines: string[]): LineInfo[] {
    const result: LineInfo[] = [];
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
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
        // Header lines (diff, index, etc.)
        result.push({ text: line });
      }
    }

    return result;
  }

  private renderWordHighlight(
    highlight: WordHighlight,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
    theme: any,
    maxWidth: number
  ): string {
    const baseColor = highlight.type === "deletion" ? "error" : "success";
    const parts: string[] = [];

    // Add prefix (+/-)
    const prefix = highlight.type === "deletion" ? "-" : "+";
    parts.push(theme.fg(baseColor, prefix));

    // Add segments with selective highlighting
    for (const segment of highlight.segments) {
      if (segment.highlight) {
        // Highlighted changed portion (inverse for emphasis)
        parts.push(theme.bg(baseColor, theme.fg("text", segment.text)));
      } else {
        // Normal unchanged portion
        parts.push(theme.fg(baseColor, segment.text));
      }
    }

    const full = parts.join("");
    return visibleWidth(full) > maxWidth ? truncateToWidth(full, maxWidth, "…") : full;
  }

  render(
    width: number,
    contentHeight: number,
    // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
    theme: any
  ): string[] {
    const rawLines = this.content.split("\n");
    this.maxLines = rawLines.length;

    const lineInfos: LineInfo[] = this.showLineNumbers
      ? this.parseLineNumbers(rawLines)
      : rawLines.map((text) => ({ text }));
    const lineNumWidth = this.showLineNumbers ? 8 : 0; // "123|456 " = 8 chars
    const contentWidth = width - lineNumWidth;

    const visible = lineInfos.slice(this.scrollOffset, this.scrollOffset + contentHeight);

    return visible.map((info, visibleIdx) => {
      const absoluteLineIndex = this.scrollOffset + visibleIdx;
      const l = info.text;
      let lineNumStr = "";

      if (this.showLineNumbers) {
        if (info.oldLineNum !== undefined && info.newLineNum !== undefined) {
          // Context line (both sides)
          lineNumStr = theme.fg(
            "dim",
            `${String(info.oldLineNum).padStart(3)}|${String(info.newLineNum).padStart(3)} `
          );
        } else if (info.oldLineNum !== undefined) {
          // Deletion (old side only)
          lineNumStr = theme.fg("error", `${String(info.oldLineNum).padStart(3)}|    `);
        } else if (info.newLineNum !== undefined) {
          // Addition (new side only)
          lineNumStr = theme.fg("success", `   |${String(info.newLineNum).padStart(3)} `);
        } else {
          // Header line (no numbers)
          lineNumStr = theme.fg("dim", "       ");
        }
      }

      // Check if this line has search matches or word highlights
      const matchesOnLine = this.matchPositions.filter((m) => m.lineIndex === absoluteLineIndex);
      const wordHighlight = this.wordHighlights.get(absoluteLineIndex);
      let styledLine: string;

      // Priority: search highlights > word highlights > normal
      if (matchesOnLine.length > 0) {
        // Highlight matches in this line
        const parts: string[] = [];
        let lastEnd = 0;

        // Sort matches by column
        const sortedMatches = matchesOnLine.sort((a, b) => a.startCol - b.startCol);

        for (const match of sortedMatches) {
          const isCurrentMatch = this.matchPositions.indexOf(match) === this.currentMatchIndex;

          // Add text before match
          if (match.startCol > lastEnd) {
            parts.push(l.substring(lastEnd, match.startCol));
          }

          // Add highlighted match
          const matchText = l.substring(match.startCol, match.startCol + match.length);
          if (isCurrentMatch) {
            parts.push(theme.bg("selectedBg", theme.fg("accent", matchText)));
          } else {
            parts.push(theme.bg("warning", theme.fg("text", matchText)));
          }

          lastEnd = match.startCol + match.length;
        }

        // Add remaining text
        if (lastEnd < l.length) {
          parts.push(l.substring(lastEnd));
        }

        const reconstructed = parts.join("");
        const truncated =
          visibleWidth(reconstructed) > contentWidth
            ? truncateToWidth(reconstructed, contentWidth, "…")
            : reconstructed;

        // Apply line color
        if (l.startsWith("+")) styledLine = theme.fg("success", truncated);
        else if (l.startsWith("-")) styledLine = theme.fg("error", truncated);
        else if (l.startsWith("@@")) styledLine = theme.fg("accent", truncated);
        else if (l.startsWith("diff ") || l.startsWith("index "))
          styledLine = theme.fg("dim", truncated);
        else styledLine = theme.fg("text", truncated);
      } else if (wordHighlight) {
        // Word-level highlighting for modified lines
        styledLine = this.renderWordHighlight(wordHighlight, theme, contentWidth);
      } else {
        // No matches or highlights, normal rendering
        const truncated =
          visibleWidth(l) > contentWidth ? truncateToWidth(l, contentWidth, "…") : l;

        if (l.startsWith("+")) styledLine = theme.fg("success", truncated);
        else if (l.startsWith("-")) styledLine = theme.fg("error", truncated);
        else if (l.startsWith("@@")) styledLine = theme.fg("accent", truncated);
        else if (l.startsWith("diff ") || l.startsWith("index "))
          styledLine = theme.fg("dim", truncated);
        else styledLine = theme.fg("text", truncated);
      }

      return lineNumStr + styledLine;
    });
  }
}
