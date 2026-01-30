/**
 * ANSI escape sequence constants and factory functions.
 *
 * Low-level terminal control primitives used by TerminalWriter
 * and direct-write rendering paths.
 */

// ── Cursor positioning (1-indexed) ─────────────────────────────────────────

/** Move cursor to absolute row/col (1-indexed). */
export const moveTo = (row: number, col: number): string => `\x1b[${row};${col}H`;

/** Move cursor to column (1-indexed) on current row. */
export const moveToCol = (col: number): string => `\x1b[${col}G`;

// ── Screen control ─────────────────────────────────────────────────────────

export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const EXIT_ALT_SCREEN = "\x1b[?1049l";
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const CLEAR_SCREEN = "\x1b[2J";
export const HOME = "\x1b[H";
export const CLEAR_LINE = "\x1b[2K";

// ── SGR (Select Graphic Rendition) ─────────────────────────────────────────

export const RESET = "\x1b[0m";
export const RESET_FG = "\x1b[39m";
export const RESET_BG = "\x1b[49m";

/** 24-bit foreground color. */
export const fg24 = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`;

/** 24-bit background color. */
export const bg24 = (r: number, g: number, b: number): string => `\x1b[48;2;${r};${g};${b}m`;
