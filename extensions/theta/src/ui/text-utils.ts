import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

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
