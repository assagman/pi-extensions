/**
 * Gamma Charts — ASCII Chart Renderers
 *
 * Provides bar charts, progress bars, and pie charts for TUI display.
 */

// =============================================================================
// COLOR UTILITIES
// =============================================================================

const rgb = (r: number, g: number, b: number, text: string): string =>
  `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;

// =============================================================================
// PROGRESS BAR
// =============================================================================

/**
 * Gradient progress bar: green (0%) → yellow (50%) → red (100%)
 *
 * @param percent - Fill percentage (0-100)
 * @param width - Total bar width in characters
 * @returns Colored progress bar string
 */
export function renderProgressBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  // Gradient color based on percentage
  const color = getGradientColor(clamped);

  const filledStr = "█".repeat(filled);
  const emptyStr = "░".repeat(empty);

  return rgb(color.r, color.g, color.b, filledStr) + rgb(70, 70, 70, emptyStr);
}

/**
 * Get gradient color: green → yellow → red
 */
function getGradientColor(percent: number): { r: number; g: number; b: number } {
  if (percent <= 50) {
    // Green (38, 222, 129) → Yellow (254, 211, 48)
    const t = percent / 50;
    return {
      r: Math.round(38 + (254 - 38) * t),
      g: Math.round(222 + (211 - 222) * t),
      b: Math.round(129 + (48 - 129) * t),
    };
  }
  // Yellow (254, 211, 48) → Red (238, 90, 82)
  const t = (percent - 50) / 50;
  return {
    r: Math.round(254 + (238 - 254) * t),
    g: Math.round(211 + (90 - 211) * t),
    b: Math.round(48 + (82 - 48) * t),
  };
}

// =============================================================================
// HORIZONTAL BAR CHART
// =============================================================================

/** Block characters for smooth bar rendering */
const BAR_CHARS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

/**
 * Render a horizontal bar with smooth sub-character fills.
 *
 * @param percent - Fill percentage (0-100)
 * @param width - Total bar width in characters
 * @param color - Optional RGB color (defaults to teal)
 * @returns Colored bar string
 */
export function renderBarChart(
  percent: number,
  width: number,
  color?: { r: number; g: number; b: number }
): string {
  const c = color ?? { r: 84, g: 160, b: 160 }; // Default teal
  const clamped = Math.max(0, Math.min(100, percent));

  // Calculate fill with sub-character precision
  const fillWidth = (clamped / 100) * width;
  const fullBlocks = Math.floor(fillWidth);
  const remainder = fillWidth - fullBlocks;
  const partialIdx = Math.round(remainder * 8);

  // Build bar
  let bar = "█".repeat(fullBlocks);
  if (partialIdx > 0 && fullBlocks < width) {
    bar += BAR_CHARS[partialIdx];
  }

  // Pad with empty
  const currentLen = fullBlocks + (partialIdx > 0 ? 1 : 0);
  const empty = width - currentLen;
  bar += "░".repeat(Math.max(0, empty));

  return rgb(c.r, c.g, c.b, bar.slice(0, width));
}
