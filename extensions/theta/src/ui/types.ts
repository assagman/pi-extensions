export type Panel = "commits" | "files" | "diff";

export const UNCOMMITTED_SHA = "__uncommitted__";

/**
 * Opaque theme handle — pi-tui does not export the Theme type.
 * Using a branded alias keeps `any` confined to one declaration.
 */
// biome-ignore lint/suspicious/noExplicitAny: Theme type not exported from pi-tui
export type ThemeLike = any;

/** Shared interface for all theta panels. */
export interface PanelComponent {
  /** Number of matches found by the last filter/search. */
  readonly filterMatchCount: number;
  /** Index of the currently focused match (0-based). */
  readonly filterCurrentIndex: number;
  applyFilter(query: string, caseSensitive: boolean): void;
  clearFilter(): void;
  render(width: number, contentHeight: number, ...args: unknown[]): string[];
}
