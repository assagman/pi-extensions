export type Panel = "commits" | "files" | "diff";

export const UNCOMMITTED_SHA = "__uncommitted__";

/** Shared interface for all theta panels. */
export interface PanelComponent {
  /** Number of matches found by the last filter/search. */
  readonly filterMatchCount: number;
  /** Index of the currently focused match (0-based). */
  readonly filterCurrentIndex: number;
  applyFilter(query: string, caseSensitive: boolean): void;
  clearFilter(): void;
  // biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
  render(width: number, contentHeight: number, ...args: any[]): string[];
}
