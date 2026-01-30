/**
 * Layout calculator — computes panel positions and dimensions.
 *
 * Theta uses a 2-band layout:
 *
 *   ┌──────────────────────┬──────────────────────┐
 *   │ COMMITS              │ FILES                │  ← top header (row 1)
 *   ├──────────────────────┼──────────────────────┤
 *   │                      │                      │  ← top content area
 *   │  ~50%                │  ~50%                │
 *   │                      │                      │
 *   ├──────────────────────┴──────────────────────┤
 *   │ DIFF  path/to/file.ts                       │  ← diff header
 *   ├──────────────┬┄┄┄┄┄┄┄┄┄┄┬───────────────────┤
 *   │  old         ┊          │  new              │  ← diff content
 *   │              ┊          │                   │
 *   │  side-by-side diff (~70% of content)        │
 *   ├─────────────────────────────────────────────┤
 *   │ metadata line                               │  ← footer meta
 *   │ keybinds / stats / scroll info              │  ← footer bar
 *   └─────────────────────────────────────────────┘
 */

export interface PanelRect {
  /** First row (1-indexed, inclusive). */
  top: number;
  /** Last row (1-indexed, inclusive). */
  bottom: number;
  /** First column (1-indexed). */
  left: number;
  /** Width in columns. */
  width: number;
}

export interface Layout {
  commits: PanelRect;
  files: PanelRect;
  diff: PanelRect;
  /** Row number for the top section header (COMMITS | FILES). */
  topHeaderRow: number;
  /** Row number for the diff section header. */
  diffHeaderRow: number;
  /** Row number for the metadata footer line (1-indexed). */
  footerMetaRow: number;
  /** Row number for the keybinds footer line (1-indexed). */
  footerBarRow: number;
  /** Number of content rows in the top section (commits/files). */
  topContentHeight: number;
  /** Number of content rows in the diff section. */
  diffContentHeight: number;
  /** Width of the left half of the diff (old side), excluding separator/gutter. */
  diffLeftWidth: number;
  /** Width of the right half of the diff (new side), excluding gutter. */
  diffRightWidth: number;
  /** Total terminal width. */
  totalWidth: number;
  /** Total terminal height. */
  totalHeight: number;
}

/**
 * Compute panel layout from terminal dimensions.
 *
 * 2-band layout:
 *   Top band (~30%): commits (left ~50%) | sep | files (right ~50%)
 *   Bottom band (~70%): side-by-side diff (full width, split old│new)
 *
 * Fixed rows: topHeader(1) + diffHeader(1) + footer(2) = 4
 */
export function calculateLayout(cols: number, rows: number): Layout {
  const availableContent = Math.max(2, rows - 4);
  const topContentHeight = Math.max(3, Math.min(15, Math.floor(availableContent * 0.3)));
  const diffContentHeight = Math.max(1, availableContent - topContentHeight);

  // Top section: commits | sep(1) | files
  const commitWidth = Math.floor((cols - 1) / 2);
  const fileWidth = cols - commitWidth - 1;

  // Row positions (1-indexed)
  const topHeaderRow = 1;
  const topContentTop = 2;
  const topContentBottom = topContentTop + topContentHeight - 1;
  const diffHeaderRow = topContentBottom + 1;
  const diffContentTop = diffHeaderRow + 1;
  const diffContentBottom = diffContentTop + diffContentHeight - 1;

  // Diff internal split: | leftW | sep(1) | rightW | gutter(1) |
  // leftW + 1 + rightW + 1 = cols  →  leftW + rightW = cols - 2
  const diffLeftWidth = Math.floor((cols - 2) / 2);
  const diffRightWidth = cols - 2 - diffLeftWidth;

  return {
    commits: { top: topContentTop, bottom: topContentBottom, left: 1, width: commitWidth },
    files: {
      top: topContentTop,
      bottom: topContentBottom,
      left: commitWidth + 2,
      width: fileWidth,
    },
    diff: { top: diffContentTop, bottom: diffContentBottom, left: 1, width: cols },
    topHeaderRow,
    diffHeaderRow,
    footerMetaRow: rows - 1,
    footerBarRow: rows,
    topContentHeight,
    diffContentHeight,
    diffLeftWidth,
    diffRightWidth,
    totalWidth: cols,
    totalHeight: rows,
  };
}
