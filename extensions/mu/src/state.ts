/**
 * Mu state management — shared state for tool tracking.
 */
import type { ToolState } from "./types.js";

/** Active tools by toolCallId */
export const activeToolsById = new Map<string, ToolState>();

/** Tool states grouped by signature (for deduplication) */
export const toolStatesBySig = new Map<string, ToolState[]>();

/** Card instance count by signature (for multi-instance tracking) */
export const cardInstanceCountBySig = new Map<string, number>();

/** Get tool state by signature and instance index */
export const getToolStateByIndex = (sig: string, index: number): ToolState | undefined => {
  const states = toolStatesBySig.get(sig);
  return states?.[index];
};

/** Get latest tool state by signature */
export const getToolState = (sig: string): ToolState | undefined => {
  const states = toolStatesBySig.get(sig);
  return states?.[states.length - 1];
};

/** Track if next tool card should have leading space (after user message) */
export let nextToolNeedsLeadingSpace = false;

/** Set the leading space flag for next tool */
export const setNextToolNeedsLeadingSpace = (value: boolean): void => {
  nextToolNeedsLeadingSpace = value;
};

/** Current session ID */
export let currentSessionId: string | null = null;

/** Set current session ID */
export const setCurrentSessionId = (id: string | null): void => {
  currentSessionId = id;
};

/** Clear all tool-related state maps (call on session switch/start) */
export const clearToolStateMaps = (): void => {
  activeToolsById.clear();
  toolStatesBySig.clear();
  cardInstanceCountBySig.clear();
};
