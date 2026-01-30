/**
 * TerminalWriter — Buffered, cursor-addressed terminal write helper.
 *
 * Wraps pi-tui's Terminal interface to provide:
 *   - Buffered writes (batch multiple operations, flush once)
 *   - Cursor-addressed line updates
 *   - Alt-screen lifecycle management
 *
 * All writes accumulate in an internal buffer until flush() is called,
 * producing a single process.stdout.write() for minimal syscall overhead.
 */

import type { Terminal } from "@mariozechner/pi-tui";
import * as ansi from "./ansi.js";

export class TerminalWriter {
  private buf = "";

  constructor(private readonly terminal: Terminal) {}

  // ── Buffered output ────────────────────────────────────────────────

  /** Append raw data to the write buffer. */
  write(data: string): void {
    this.buf += data;
  }

  /** Flush the buffer to the terminal in a single write. */
  flush(): void {
    if (this.buf.length > 0) {
      this.terminal.write(this.buf);
      this.buf = "";
    }
  }

  // ── Cursor-addressed writes ────────────────────────────────────────

  /** Move cursor to absolute row/col (1-indexed). */
  moveTo(row: number, col: number): void {
    this.write(ansi.moveTo(row, col));
  }

  /** Write content at a specific row/col position. */
  writeLine(row: number, col: number, content: string): void {
    this.write(ansi.moveTo(row, col) + content);
  }

  /** Clear an entire row. */
  clearLine(row: number): void {
    this.write(ansi.moveTo(row, 1) + ansi.CLEAR_LINE);
  }

  // ── Alt-screen lifecycle ───────────────────────────────────────────

  /** Enter alternate screen buffer, hide cursor, clear screen. */
  enterAltScreen(): void {
    this.write(ansi.ENTER_ALT_SCREEN + ansi.HIDE_CURSOR + ansi.CLEAR_SCREEN + ansi.HOME);
    this.flush();
  }

  /** Exit alternate screen buffer, restore cursor. */
  exitAltScreen(): void {
    this.write(ansi.EXIT_ALT_SCREEN + ansi.SHOW_CURSOR);
    this.flush();
  }

  // ── Terminal dimensions ────────────────────────────────────────────

  get rows(): number {
    return this.terminal.rows;
  }

  get cols(): number {
    return this.terminal.columns;
  }
}
