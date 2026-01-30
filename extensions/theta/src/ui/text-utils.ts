import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/**
 * Wrap a plain-text line to fit within `width` visible columns.
 * Returns an array of substrings — one per visual line.
 * Uses truncateToWidth for correct handling of wide/multi-byte characters.
 *
 * NOTE: Uses `substring(chunk.length)` to advance through the string.
 * This is correct for BMP characters and simple emoji but may split
 * complex grapheme clusters (e.g. ZWJ sequences). Acceptable for diff
 * content which is predominantly ASCII source code.
 */
export function wrapLine(text: string, width: number): string[] {
  if (width <= 0) return [""];
  if (!text) return [""];
  if (visibleWidth(text) <= width) return [text];

  const result: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (visibleWidth(remaining) <= width) {
      result.push(remaining);
      break;
    }
    const chunk = truncateToWidth(remaining, width, "");
    if (chunk.length === 0) {
      // Single character wider than width — force include to avoid infinite loop
      result.push(remaining[0]);
      remaining = remaining.substring(1);
    } else {
      result.push(chunk);
      remaining = remaining.substring(chunk.length);
    }
  }

  return result.length > 0 ? result : [""];
}

/**
 * Compute the scrollbar thumb position for a panel.
 * Returns -1 when no scrollbar is needed (content fits viewport).
 */
export function scrollbarThumbPos(
  scrollOffset: number,
  totalLines: number,
  viewportHeight: number
): number {
  if (totalLines <= viewportHeight || viewportHeight <= 0) return -1;
  const maxScroll = totalLines - viewportHeight;
  const clamped = Math.max(0, Math.min(scrollOffset, maxScroll));
  return Math.round((clamped / maxScroll) * (viewportHeight - 1));
}

/** Pad or truncate text to exactly `width` visible columns. */
export function padToWidth(text: string, width: number): string {
  const truncated = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
  const pad = width - visibleWidth(truncated);
  return pad > 0 ? truncated + " ".repeat(pad) : truncated;
}

/** Truncate from the start, keeping trailing chars with "…" prefix. */
export function truncateStartToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width === 1) return "…";

  const target = Math.max(0, width - 1);
  let tail = "";
  for (let i = text.length - 1; i >= 0; i--) {
    tail = text[i] + tail;
    if (visibleWidth(tail) >= target) break;
  }
  tail = truncateToWidth(tail, target, "");
  return `…${tail}`;
}
