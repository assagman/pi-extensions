/**
 * Mu types — shared type definitions for the mu extension.
 */

/** Tool execution status */
export type ToolStatus = "pending" | "running" | "success" | "failed" | "canceled";

/** Mu semantic color names (maps to ThemeColor via MU_THEME_MAP) */
export type MuColor =
  | "accent" // brand, running state (was orange)
  | "success" // success status (was green)
  | "error" // error status (was red)
  | "warning" // highlights, numbers (was amber/yellow)
  | "dim" // muted text, operators
  | "muted" // canceled, secondary (was gray)
  | "text" // normal text (was white)
  | "info" // info, key names, dividers (was teal)
  | "keyword" // keywords (was violet)
  | "variable"; // flags, variables (was cyan)

/** Tool state tracking during execution */
export interface ToolState {
  toolCallId: string;
  sig: string;
  toolName: string;
  args: Record<string, unknown>;
  startTime: number;
  status: ToolStatus;
  exitCode?: number;
  duration?: number;
}
