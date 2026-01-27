/**
 * DimmedOverlay — Full-screen scrim + centered dialog overlay.
 *
 * Renders a single overlay that fills the entire terminal with a dark
 * background (scrim) and composites a dialog component at a configurable
 * position. The dialog receives keyboard focus.
 *
 * Features:
 *   - Configurable scrim color (RGB)
 *   - Optional static star field on scrim (decorative, no animation)
 *   - Optional accent glow halo around the dialog
 *   - Configurable dialog positioning and sizing
 *
 * Usage:
 *   const result = await DimmedOverlay.show(ctx.ui, (tui, theme, done) => myDialog);
 *
 *   const result = await DimmedOverlay.show(ctx.ui, factory, {
 *     scrim: { stars: true },
 *     dialog: { glow: { enabled: true } },
 *   });
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
  /** Show static star field on the scrim. Default: false. */
  stars?: boolean;
}

export interface GlowConfig {
  /** Enable glow halo around the dialog. Default: false. */
  enabled?: boolean;
  /** Glow color [r, g, b]. Default: [18, 15, 35] (faint purple). */
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
  /** Glow halo configuration. */
  glow?: GlowConfig;
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
  stars: boolean;
}

interface ResolvedGlow {
  enabled: boolean;
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
  glow: ResolvedGlow;
}

interface ResolvedConfig {
  scrim: ResolvedScrim;
  dialog: ResolvedDialog;
}

// ─── Star types ─────────────────────────────────────────────────────────────

/** Depth layer determines brightness ceiling and character pool. */
type StarLayer = "far" | "mid" | "near";

interface Star {
  row: number;
  col: number;
  char: string;
  /** Fixed brightness value (computed once at creation). */
  brightness: number;
  layer: StarLayer;
}

// ─── Defaults & constants ───────────────────────────────────────────────────

const DEFAULT_SCRIM_COLOR: RGB = [10, 10, 15];
const DEFAULT_DIALOG_WIDTH: SizeValue = "60%";
const DEFAULT_DIALOG_MIN_WIDTH = 40;
const DEFAULT_DIALOG_MAX_HEIGHT: SizeValue = "80%";
const DEFAULT_GLOW_COLOR: RGB = [18, 15, 35];

/** Min brightness (shared across all layers). */
const MIN_STAR_B = 12;

/** Per-layer max brightness: far=dim dust, mid=moderate, near=bright. */
const LAYER_MAX_B: Record<StarLayer, number> = { far: 45, mid: 80, near: 115 };

/** Weighted layer distribution: 60% far, 30% mid, 10% near. */
const LAYER_THRESHOLDS: [number, StarLayer][] = [
  [0.6, "far"],
  [0.9, "mid"],
  [1.0, "near"],
];

/** Chars reserved for near-layer (larger/brighter glyphs). */
const NEAR_CHARS = ["✦", "✧", "⋆", "∗", "⊹"];
/** Chars for far/mid layers (tiny dots). */
const DUST_CHARS = ["·", "·", "·", ".", ".", "˙", "˙", "∘"];
const RESET = "\x1b[0m";

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveConfig(cfg?: DimmedOverlayConfig): ResolvedConfig {
  return {
    scrim: {
      color: cfg?.scrim?.color ?? DEFAULT_SCRIM_COLOR,
      stars: cfg?.scrim?.stars ?? false,
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
      glow: {
        enabled: cfg?.dialog?.glow?.enabled ?? false,
        color: cfg?.dialog?.glow?.color ?? DEFAULT_GLOW_COLOR,
      },
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

function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

// ─── Internal component ─────────────────────────────────────────────────────

/**
 * Full-screen component that renders:
 *   1. Scrim (dark background) filling every terminal row
 *   2. Optional static star field on the scrim
 *   3. Optional glow halo around the dialog
 *   4. Dialog content centered (or aligned per config) within the scrim
 *
 * Stars are placed once and never change — no animation, no timers.
 * Rendering only occurs when the TUI requests it (user input / resize).
 */
class DimmedDialogComponent implements Component {
  private readonly tui: TUI;
  private readonly dialog: Component;
  private readonly cfg: ResolvedConfig;
  private readonly scrimEsc: string;
  private readonly glowEsc: string;

  private stars: Star[] = [];
  /** Exclusion zone (dialog + glow rect). Set on first render. */
  private exZone: { top: number; bot: number; left: number; right: number } | null = null;

  constructor(tui: TUI, dialog: Component, cfg: ResolvedConfig) {
    this.tui = tui;
    this.dialog = dialog;
    this.cfg = cfg;

    const [r, g, b] = cfg.scrim.color;
    this.scrimEsc = `\x1b[48;2;${r};${g};${b}m`;

    const [gr, gg, gb] = cfg.dialog.glow.color;
    this.glowEsc = `\x1b[48;2;${gr};${gg};${gb}m`;
  }

  // ── Star placement ────────────────────────────────────────────────────

  /**
   * Pick a random (row, col) outside the exclusion zone. Deterministic —
   * computes valid cell count, picks a random linear index, and maps it
   * back to 2D coordinates by skipping the excluded rectangle.
   */
  private randomValidPosition(rows: number, cols: number): { row: number; col: number } {
    const ez = this.exZone;
    if (!ez) {
      return { row: randomInt(rows), col: randomInt(cols) };
    }

    const ezTop = clamp(ez.top, 0, rows);
    const ezBot = clamp(ez.bot, 0, rows);
    const ezLeft = clamp(ez.left, 0, cols);
    const ezRight = clamp(ez.right, 0, cols);
    const ezRowSpan = Math.max(0, ezBot - ezTop);
    const ezColSpan = Math.max(0, ezRight - ezLeft);

    const validCount = rows * cols - ezRowSpan * ezColSpan;
    if (validCount <= 0) {
      return { row: randomInt(rows), col: randomInt(cols) };
    }

    let idx = randomInt(validCount);

    // Band 1: rows above exclusion zone (full width)
    const aboveCells = ezTop * cols;
    if (idx < aboveCells) {
      return { row: Math.floor(idx / cols), col: idx % cols };
    }
    idx -= aboveCells;

    // Band 2: rows within exclusion zone (skip excluded columns)
    const validPerRow = cols - ezColSpan;
    const midCells = ezRowSpan * validPerRow;
    if (idx < midCells) {
      const rowOffset = Math.floor(idx / validPerRow);
      let col = idx % validPerRow;
      if (col >= ezLeft) col += ezColSpan;
      return { row: ezTop + rowOffset, col };
    }
    idx -= midCells;

    // Band 3: rows below exclusion zone (full width)
    return { row: ezBot + Math.floor(idx / cols), col: idx % cols };
  }

  private createStar(rows: number, cols: number): Star {
    const r = Math.random();
    let layer: StarLayer = "far";
    for (const [threshold, l] of LAYER_THRESHOLDS) {
      if (r < threshold) {
        layer = l;
        break;
      }
    }
    const chars = layer === "near" ? NEAR_CHARS : DUST_CHARS;
    const maxB = LAYER_MAX_B[layer];
    const { row, col } = this.randomValidPosition(rows, cols);

    return {
      row,
      col,
      char: chars[randomInt(chars.length)],
      brightness: Math.round(MIN_STAR_B + Math.random() * (maxB - MIN_STAR_B)),
      layer,
    };
  }

  /** Create a dim-only star (far layer, dust chars, brightness 12–45). */
  private createDimStar(rows: number, cols: number): Star {
    const { row, col } = this.randomValidPosition(rows, cols);
    return {
      row,
      col,
      char: DUST_CHARS[randomInt(DUST_CHARS.length)],
      brightness: Math.round(MIN_STAR_B + Math.random() * (LAYER_MAX_B.far - MIN_STAR_B)),
      layer: "far",
    };
  }

  private generateStars(rows: number, cols: number): void {
    this.stars = [];
    const count = clamp(Math.floor((rows * cols) / 46), 40, 156);
    // Primary stars (layered: far/mid/near)
    for (let i = 0; i < count; i++) {
      this.stars.push(this.createStar(rows, cols));
    }
    // Extra dim-only background dust (+100% of base count)
    for (let i = 0; i < count; i++) {
      this.stars.push(this.createDimStar(rows, cols));
    }
  }

  // ── Star rendering ────────────────────────────────────────────────────

  private buildStarLookup(termWidth: number, termRows: number): Map<number, Star[]> {
    const lookup = new Map<number, Star[]>();
    for (const star of this.stars) {
      if (star.row < 0 || star.row >= termRows) continue;
      if (star.col < 0 || star.col >= termWidth) continue;
      let arr = lookup.get(star.row);
      if (!arr) {
        arr = [];
        lookup.set(star.row, arr);
      }
      arr.push(star);
    }
    return lookup;
  }

  private renderScrimRowWithStars(width: number, rowStars: Star[]): string {
    const sorted = rowStars.slice().sort((a, b) => a.col - b.col);
    const SCRIM = this.scrimEsc;

    let result = SCRIM;
    let pos = 0;

    for (const star of sorted) {
      if (star.col > pos) {
        result += " ".repeat(star.col - pos);
      }
      const b = star.brightness;
      // Blue-purple tint for deep-space feel
      const sr = Math.max(0, b - 10);
      const sg = Math.max(0, b - 5);
      const sb = Math.min(255, b + 20);
      result += `\x1b[38;2;${sr};${sg};${sb}m${star.char}\x1b[39m`;
      pos = star.col + 1;
    }

    if (pos < width) {
      result += " ".repeat(width - pos);
    }

    return result + RESET;
  }

  // ── Main render ───────────────────────────────────────────────────────

  render(width: number): string[] {
    const rows = this.tui.terminal.rows;
    const SCRIM = this.scrimEsc;
    const GLOW = this.glowEsc;
    const glowEnabled = this.cfg.dialog.glow.enabled;

    // ── Resolve dialog dimensions ─────────────────────────────────────
    const dialogWidth = clamp(
      resolveSize(this.cfg.dialog.width, width),
      Math.min(this.cfg.dialog.minWidth, width),
      this.cfg.dialog.maxWidth ?? width
    );
    const dialogMaxHeight = resolveSize(this.cfg.dialog.maxHeight, rows);

    // ── Render dialog ─────────────────────────────────────────────────
    let dialogLines = this.dialog.render(dialogWidth);
    if (dialogLines.length > dialogMaxHeight) {
      dialogLines = dialogLines.slice(0, dialogMaxHeight);
    }
    const dh = dialogLines.length;

    // ── Position ──────────────────────────────────────────────────────
    let startRow = resolveRow(
      this.cfg.dialog.verticalAlign,
      this.cfg.dialog.verticalOffset,
      rows,
      dh
    );
    let startCol = resolveCol(
      this.cfg.dialog.horizontalAlign,
      this.cfg.dialog.horizontalOffset,
      width,
      dialogWidth
    );

    if (glowEnabled) {
      startRow = clamp(startRow, 1, Math.max(1, rows - dh - 1));
      startCol = clamp(startCol, 1, Math.max(1, width - dialogWidth - 1));
    }

    // ── Generate stars once (on first render, after we know the dialog rect) ─
    if (this.exZone === null && this.cfg.scrim.stars) {
      this.exZone = {
        top: glowEnabled ? startRow - 1 : startRow,
        bot: glowEnabled ? startRow + dh + 1 : startRow + dh,
        left: glowEnabled ? startCol - 1 : startCol,
        right: glowEnabled ? startCol + dialogWidth + 1 : startCol + dialogWidth,
      };
      this.generateStars(rows, width);
    }

    // ── Star lookup ───────────────────────────────────────────────────
    const starLookup =
      this.cfg.scrim.stars && this.stars.length > 0 ? this.buildStarLookup(width, rows) : null;

    // ── Precompute scrim fill ─────────────────────────────────────────
    const scrimFull = `${SCRIM}${" ".repeat(width)}${RESET}`;

    // ── Glow row bounds ───────────────────────────────────────────────
    const glowRowAbove = glowEnabled ? startRow - 1 : -1;
    const glowRowBelow = glowEnabled ? startRow + dh : -1;
    const glowColStart = startCol - 1;
    const glowWidth = dialogWidth + 2;

    // ── Composite full screen ─────────────────────────────────────────
    const result: string[] = [];

    for (let r = 0; r < rows; r++) {
      // ── Glow rows (top/bottom halo) ─────────────────────────────────
      if (r === glowRowAbove || r === glowRowBelow) {
        const leftW = glowColStart;
        const rightW = Math.max(0, width - glowColStart - glowWidth);
        result.push(
          `${SCRIM}${" ".repeat(leftW)}${RESET}${GLOW}${" ".repeat(glowWidth)}${RESET}${SCRIM}${" ".repeat(rightW)}${RESET}`
        );
        continue;
      }

      // ── Dialog rows (with optional left/right glow) ─────────────────
      if (r >= startRow && r < startRow + dh) {
        const dl = dialogLines[r - startRow] ?? "";

        if (glowEnabled) {
          const leftScrimW = Math.max(0, startCol - 1);
          const rightScrimW = Math.max(0, width - startCol - dialogWidth - 1);
          result.push(
            `${SCRIM}${" ".repeat(leftScrimW)}${RESET}${GLOW} ${RESET}${dl}${GLOW} ${RESET}${SCRIM}${" ".repeat(rightScrimW)}${RESET}`
          );
        } else {
          const dlVis = visibleWidth(dl);
          const rightPad = Math.max(0, width - startCol - dlVis);
          result.push(
            `${SCRIM}${" ".repeat(startCol)}${RESET}${dl}${SCRIM}${" ".repeat(rightPad)}${RESET}`
          );
        }
        continue;
      }

      // ── Scrim rows (with optional stars) ────────────────────────────
      const rowStars = starLookup?.get(r);
      if (rowStars && rowStars.length > 0) {
        result.push(this.renderScrimRowWithStars(width, rowStars));
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
 * Dimmed overlay — shows a dialog on a dark scrim backdrop with optional
 * static star field and glow halo.
 *
 * @example
 * ```ts
 * const answer = await DimmedOverlay.show(ctx.ui, (tui, theme, done) => {
 *   return createMyDialog(tui, theme, done);
 * });
 *
 * const answer = await DimmedOverlay.show(ctx.ui, factory, {
 *   scrim: { stars: true },
 *   dialog: { glow: { enabled: true } },
 * });
 * ```
 */
export class DimmedOverlay {
  private readonly cfg: DimmedOverlayConfig;

  constructor(config?: DimmedOverlayConfig) {
    this.cfg = config ?? {};
  }

  async show<T>(ui: UICustom, factory: DialogFactory<T>): Promise<T> {
    return DimmedOverlay.show(ui, factory, this.cfg);
  }

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
