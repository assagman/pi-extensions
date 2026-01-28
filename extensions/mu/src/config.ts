/**
 * Mu configuration — constants and configuration for the mu extension.
 */
import type { MuColor, ToolStatus } from "./types.js";

/** Mu configuration constants */
export const MU_CONFIG = {
  MAX_TOOL_RESULTS: 200,
  MAX_COMPLETED_DURATIONS: 500,
  PREVIEW_LENGTH: 140,
  VIEWER_OPTION_MAX_LENGTH: 200,
  SIGNATURE_HASH_LENGTH: 16,
  PULSE_INTERVAL_MS: 50,
  PULSE_SPEED: 0.2,
  PULSE_MIN_BRIGHTNESS: 0.4,
  MAX_ERROR_LINES: 10,
  MAX_BASH_LINES: 10,
} as const;

/** Keyboard shortcut for tool viewer overlay */
export const MU_TOOL_VIEWER_SHORTCUT = "ctrl+alt+o";

/** Status indicator configuration */
export const STATUS: Record<ToolStatus, { sym: string; color: MuColor }> = {
  pending: { sym: "◌", color: "dim" },
  running: { sym: "●", color: "accent" },
  success: { sym: "", color: "success" },
  failed: { sym: "", color: "error" },
  canceled: { sym: "", color: "muted" },
};

/** Tool name to icon mapping (Nerd Fonts) */
export const TOOL_ICONS: Record<string, string> = {
  bash: "󰆍",
  read: "󰈙",
  write: "󰷈",
  edit: "󰏫",
  grep: "󰍉",
  find: "󰍉",
  ls: "󰉋",
  sigma: "❓",
};

/** Skill loaded indicator */
export const SKILL_ICON = "󱕦"; // nf-md-head_lightbulb

/** Skill loaded color: #E4C7FF (light lavender) */
export const SKILL_COLOR = { r: 237, g: 180, b: 232 } as const;
