/**
 * Mu theme integration — theme-aware color helpers.
 * Uses pi's Theme singleton via globalThis Symbol.
 */
import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { MuColor } from "./types.js";

const PI_THEME_KEY = Symbol.for("@mariozechner/pi-coding-agent:theme");

/** Get the current pi theme instance */
export const getTheme = (): Theme => {
  const t = (globalThis as Record<symbol, Theme | undefined>)[PI_THEME_KEY];
  if (!t) throw new Error("Theme not initialized — mu requires pi theme.");
  return t;
};

/** Mu semantic color → ThemeColor mapping */
export const MU_THEME_MAP: Record<MuColor, ThemeColor> = {
  accent: "accent",
  success: "success",
  error: "error",
  warning: "warning",
  dim: "dim",
  muted: "muted",
  text: "text",
  info: "syntaxType",
  keyword: "syntaxKeyword",
  variable: "syntaxVariable",
};

/** Apply mu semantic color via pi theme. */
export const mu = (c: MuColor, text: string): string => getTheme().fg(MU_THEME_MAP[c], text);

// =============================================================================
// PULSE ANIMATION
// =============================================================================

/** Cache for parsed RGB values from theme colors */
const rgbCache = new Map<ThemeColor, { r: number; g: number; b: number }>();

/** Parse RGB values from theme ANSI escape. Cached, auto-clears on theme switch. */
const parseThemeRgb = (tc: ThemeColor): { r: number; g: number; b: number } => {
  const cached = rgbCache.get(tc);
  if (cached) return cached;
  const ansi = getTheme().getFgAnsi(tc);
  const m = ansi.match(/38;2;(\d+);(\d+);(\d+)/);
  const result = m
    ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
    : { r: 200, g: 200, b: 200 }; // fallback
  rgbCache.set(tc, result);
  return result;
};

/**
 * Call when theme changes to refresh cached RGB values.
 * Not connected yet — onThemeChange() is not exported from pi.
 */
export const clearThemeCache = (): void => {
  rgbCache.clear();
};

/** Pulse animation: scale theme color brightness for running indicators. */
export const muPulse = (c: MuColor, text: string, brightness: number): string => {
  const { r, g, b } = parseThemeRgb(MU_THEME_MAP[c]);
  const f = Math.max(0.3, Math.min(1, brightness));
  return `\x1b[38;2;${Math.round(r * f)};${Math.round(g * f)};${Math.round(b * f)}m${text}\x1b[0m`;
};
