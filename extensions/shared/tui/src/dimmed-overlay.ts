/**
 * DimmedOverlay — Full-screen scrim + centered dialog overlay.
 *
 * Renders a single overlay that fills the entire terminal with a dark
 * background (scrim) and composites a dialog component at a configurable
 * position. The dialog receives keyboard focus.
 *
 * Usage:
 *   // Quick — static method with defaults
 *   const result = await DimmedOverlay.show(ctx.ui, (tui, theme, done) => myDialog);
 *
 *   // Configured — instance with custom settings
 *   const overlay = new DimmedOverlay({ scrim: { color: [20, 10, 30] } });
 *   const result = await overlay.show(ctx.ui, factory);
 */

import type { Component, TUI } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";

// ─── Public types ───────────────────────────────────────────────────────────

/** RGB color tuple [r, g, b], each 0–255. */
export type RGB = [number, number, number];

/** Absolute columns/rows or "N%" of terminal dimension. */
export type SizeValue = number | `${number}%`;

/** Vertical alignment for the dialog within the scrim. */
export type VAlign = "center" | "top" | "bottom";

/** Horizontal alignment for the dialog within the scrim. */
export type HAlign = "center" | "left" | "right";

export interface ScrimConfig {
  /** Background color [r, g, b]. Default: [10, 10, 15] (near-black). */
  color?: RGB;
}

export interface DialogConfig {
  /** Width: absolute columns or "N%" of terminal. Default: "60%". */
  width?: SizeValue;
  /** Minimum width in columns. Default: 40. */
  minWidth?: number;
  /** Maximum width in columns. Default: terminal width. */
  maxWidth?: number;
  /** Maximum height: absolute rows or "N%" of terminal. Default: "80%". */
  maxHeight?: SizeValue;
  /** Vertical alignment. Default: "center". */
  verticalAlign?: VAlign;
  /** Row offset from vertical alignment (positive = down). Default: 0. */
  verticalOffset?: number;
  /** Horizontal alignment. Default: "center". */
  horizontalAlign?: HAlign;
  /** Column offset from horizontal alignment (positive = right). Default: 0. */
  horizontalOffset?: number;
}

export interface DimmedOverlayConfig {
  /** Scrim (backdrop) configuration. */
  scrim?: ScrimConfig;
  /** Dialog positioning and sizing. */
  dialog?: DialogConfig;
}

/**
 * Factory function that creates the inner dialog component.
 * Receives TUI, theme (typed `any` — avoids coupling to pi-coding-agent Theme),
 * and a `done` callback to close the overlay.
 */
// biome-ignore lint/suspicious/noExplicitAny: theme type comes from Pi runtime, not our dep
export type DialogFactory<T> = (tui: TUI, theme: any, done: (result: T) => void) => Component;

/**
 * Minimal UI surface — the subset of `ctx.ui` that DimmedOverlay needs.
 * Compatible with both ExtensionCommandContext.ui and tool execute context.ui.
 */
export interface UICustom {
  custom<T>(
    factory: (
      tui: TUI,
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void
    ) => Component,
    options?: {
      overlay?: boolean;
      overlayOptions?: Record<string, unknown>;
    }
  ): Promise<T>;
}

// ─── Resolved (internal) ────────────────────────────────────────────────────

interface ResolvedScrim {
  color: RGB;
}

interface ResolvedDialog {
  width: SizeValue;
  minWidth: number;
  maxWidth: number | undefined;
  maxHeight: SizeValue;
  verticalAlign: VAlign;
  verticalOffset: number;
  horizontalAlign: HAlign;
  horizontalOffset: number;
}

interface ResolvedConfig {
  scrim: ResolvedScrim;
  dialog: ResolvedDialog;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_SCRIM_COLOR: RGB = [10, 10, 15];
const DEFAULT_DIALOG_WIDTH: SizeValue = "60%";
const DEFAULT_DIALOG_MIN_WIDTH = 40;
const DEFAULT_DIALOG_MAX_HEIGHT: SizeValue = "80%";

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveConfig(cfg?: DimmedOverlayConfig): ResolvedConfig {
  return {
    scrim: {
      color: cfg?.scrim?.color ?? DEFAULT_SCRIM_COLOR,
    },
    dialog: {
      width: cfg?.dialog?.width ?? DEFAULT_DIALOG_WIDTH,
      minWidth: cfg?.dialog?.minWidth ?? DEFAULT_DIALOG_MIN_WIDTH,
      maxWidth: cfg?.dialog?.maxWidth ?? undefined,
      maxHeight: cfg?.dialog?.maxHeight ?? DEFAULT_DIALOG_MAX_HEIGHT,
      verticalAlign: cfg?.dialog?.verticalAlign ?? "center",
      verticalOffset: cfg?.dialog?.verticalOffset ?? 0,
      horizontalAlign: cfg?.dialog?.horizontalAlign ?? "center",
      horizontalOffset: cfg?.dialog?.horizontalOffset ?? 0,
    },
  };
}

function resolveSize(value: SizeValue, total: number): number {
  if (typeof value === "number") return value;
  const pct = Number.parseFloat(value) / 100;
  return Math.round(total * pct);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function resolveRow(align: VAlign, offset: number, termRows: number, dialogHeight: number): number {
  let row: number;
  switch (align) {
    case "top":
      row = 0;
      break;
    case "bottom":
      row = termRows - dialogHeight;
      break;
    default:
      row = Math.floor((termRows - dialogHeight) / 2);
      break;
  }
  return clamp(row + offset, 0, Math.max(0, termRows - dialogHeight));
}

function resolveCol(align: HAlign, offset: number, termCols: number, dialogWidth: number): number {
  let col: number;
  switch (align) {
    case "left":
      col = 0;
      break;
    case "right":
      col = termCols - dialogWidth;
      break;
    default:
      col = Math.floor((termCols - dialogWidth) / 2);
      break;
  }
  return clamp(col + offset, 0, Math.max(0, termCols - dialogWidth));
}

// ─── Internal component ─────────────────────────────────────────────────────

/**
 * Full-screen component that renders:
 *   1. Scrim (dark background) filling every terminal row
 *   2. Dialog content centered (or aligned per config) within the scrim
 */
class DimmedDialogComponent implements Component {
  private readonly tui: TUI;
  private readonly dialog: Component;
  private readonly cfg: ResolvedConfig;
  private readonly scrimEsc: string;

  constructor(tui: TUI, dialog: Component, cfg: ResolvedConfig) {
    this.tui = tui;
    this.dialog = dialog;
    this.cfg = cfg;
    const [r, g, b] = cfg.scrim.color;
    this.scrimEsc = `\x1b[48;2;${r};${g};${b}m`;
  }

  render(width: number): string[] {
    const rows = this.tui.terminal.rows;
    const SCRIM = this.scrimEsc;
    const RESET = "\x1b[0m";

    // ── Resolve dialog dimensions ─────────────────────────────────────
    const dialogWidth = clamp(
      resolveSize(this.cfg.dialog.width, width),
      Math.min(this.cfg.dialog.minWidth, width),
      this.cfg.dialog.maxWidth ?? width
    );
    const dialogMaxHeight = resolveSize(this.cfg.dialog.maxHeight, rows);

    // ── Render dialog component ───────────────────────────────────────
    let dialogLines = this.dialog.render(dialogWidth);
    if (dialogLines.length > dialogMaxHeight) {
      dialogLines = dialogLines.slice(0, dialogMaxHeight);
    }
    const dh = dialogLines.length;

    // ── Position ──────────────────────────────────────────────────────
    const startRow = resolveRow(
      this.cfg.dialog.verticalAlign,
      this.cfg.dialog.verticalOffset,
      rows,
      dh
    );
    const startCol = resolveCol(
      this.cfg.dialog.horizontalAlign,
      this.cfg.dialog.horizontalOffset,
      width,
      dialogWidth
    );

    // ── Composite full screen ─────────────────────────────────────────
    const scrimFull = `${SCRIM}${" ".repeat(width)}${RESET}`;
    const result: string[] = [];

    for (let r = 0; r < rows; r++) {
      if (r >= startRow && r < startRow + dh) {
        const dl = dialogLines[r - startRow] ?? "";
        const dlVis = visibleWidth(dl);
        const rightPad = Math.max(0, width - startCol - dlVis);
        result.push(
          `${SCRIM}${" ".repeat(startCol)}${RESET}${dl}${SCRIM}${" ".repeat(rightPad)}${RESET}`
        );
      } else {
        result.push(scrimFull);
      }
    }

    return result;
  }

  handleInput(data: string): void {
    this.dialog.handleInput?.(data);
  }

  invalidate(): void {
    this.dialog.invalidate();
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Dimmed overlay — shows a dialog component on a dark scrim backdrop.
 *
 * @example
 * ```ts
 * // Static convenience (default config)
 * const answer = await DimmedOverlay.show(ctx.ui, (tui, theme, done) => {
 *   return createMyDialog(tui, theme, done);
 * });
 *
 * // Configured instance
 * const overlay = new DimmedOverlay({
 *   scrim: { color: [20, 10, 30] },
 *   dialog: { width: "50%", verticalAlign: "top", verticalOffset: 5 },
 * });
 * const answer = await overlay.show(ctx.ui, myFactory);
 * ```
 */
export class DimmedOverlay {
  private readonly cfg: DimmedOverlayConfig;

  constructor(config?: DimmedOverlayConfig) {
    this.cfg = config ?? {};
  }

  /** Show the dimmed overlay with a dialog factory. Returns the dialog result. */
  async show<T>(ui: UICustom, factory: DialogFactory<T>): Promise<T> {
    return DimmedOverlay.show(ui, factory, this.cfg);
  }

  /** Static convenience — show with optional config, no instance needed. */
  static async show<T>(
    ui: UICustom,
    factory: DialogFactory<T>,
    config?: DimmedOverlayConfig
  ): Promise<T> {
    const resolved = resolveConfig(config);

    return ui.custom<T>(
      (tui, theme, _kb, done) => {
        const dialog = factory(tui, theme, done);
        return new DimmedDialogComponent(tui, dialog, resolved);
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "top-left",
          width: "100%",
        },
      }
    );
  }
}
