/**
 * Gamma Extension — Type Definitions
 *
 * Core types for context window token analysis.
 */

// =============================================================================
// TOKEN CATEGORIES
// =============================================================================

/**
 * Token source categories for classification.
 */
export type TokenCategory =
  | "system" // Base system prompt, AGENTS.md, project context
  | "skills" // SKILL.md files loaded during session
  | "memory" // Delta notes, epsilon tasks, KV, episodic
  | "tools" // Tool schemas (all registered tools)
  | "user" // User messages
  | "assistant" // Assistant responses
  | "tool_io" // Tool call arguments + tool outputs
  | "images" // Image tokens (if any)
  | "other"; // Anything else

/**
 * Display metadata for each category.
 */
export interface CategoryMeta {
  label: string;
  icon: string;
  color: { r: number; g: number; b: number };
}

export const CATEGORY_META: Record<TokenCategory, CategoryMeta> = {
  system: {
    label: "System",
    icon: "󰒓",
    color: { r: 100, g: 180, b: 255 },
  },
  skills: {
    label: "Skills",
    icon: "󱕦",
    color: { r: 167, g: 139, b: 250 },
  },
  memory: {
    label: "Memory",
    icon: "󰍉",
    color: { r: 38, g: 222, b: 129 },
  },
  tools: {
    label: "Tools",
    icon: "󰆍",
    color: { r: 254, g: 211, b: 48 },
  },
  user: {
    label: "User",
    icon: "󰀄",
    color: { r: 84, g: 160, b: 160 },
  },
  assistant: {
    label: "Assistant",
    icon: "󰚩",
    color: { r: 255, g: 159, b: 67 },
  },
  tool_io: {
    label: "Tool I/O",
    icon: "󰁕",
    color: { r: 254, g: 202, b: 87 },
  },
  images: {
    label: "Images",
    icon: "󰋩",
    color: { r: 34, g: 211, b: 238 },
  },
  other: {
    label: "Other",
    icon: "󰠱",
    color: { r: 140, g: 140, b: 140 },
  },
};

// =============================================================================
// TOKEN SOURCES
// =============================================================================

/**
 * Individual token source (smallest unit of analysis).
 */
export interface TokenSource {
  /** Unique identifier */
  id: string;
  /** Classification category */
  category: TokenCategory;
  /** Display name (e.g., "AGENTS.md", "delta_log call #3") */
  label: string;
  /** Token count for this source */
  tokens: number;
  /** Percentage of total context */
  percent: number;
  /** Turn index (for conversation messages) */
  turnIndex?: number;
  /** Truncated content preview */
  preview?: string;
  /** Full content (for drill-down) */
  content?: string;
  /** Sub-sources (for nested breakdown) */
  children?: TokenSource[];
}

/**
 * Aggregated statistics for a category.
 */
export interface CategoryStats {
  category: TokenCategory;
  tokens: number;
  percent: number;
  sourceCount: number;
}

// =============================================================================
// TURN BREAKDOWN
// =============================================================================

/**
 * Token statistics for a single conversation turn.
 */
export interface TurnStats {
  /** Turn index (0-based) */
  turnIndex: number;
  /** Tokens from user message */
  userTokens: number;
  /** Tokens from assistant response */
  assistantTokens: number;
  /** Tokens from tool calls + results */
  toolTokens: number;
  /** Running total up to this turn */
  cumulativeTokens: number;
  /** Turn label (e.g., "Turn 1", "Current") */
  label: string;
}

// =============================================================================
// ANALYSIS RESULT
// =============================================================================

/**
 * Potential source of token count discrepancy.
 */
export interface DiscrepancySource {
  /** Short name */
  name: string;
  /** Explanation */
  reason: string;
  /** Estimated impact (positive = we might undercount, negative = overcount) */
  estimatedImpact: number;
  /** Confidence: low/medium/high */
  confidence: "low" | "medium" | "high";
}

/**
 * Discrepancy analysis between our count and Pi's reported count.
 */
export interface DiscrepancyAnalysis {
  /** Our counted total */
  counted: number;
  /** Pi's reported total */
  reported: number;
  /** Absolute difference */
  difference: number;
  /** Percentage difference */
  percentDiff: number;
  /** Potential sources of discrepancy */
  sources: DiscrepancySource[];
}

/**
 * Complete token analysis result.
 */
export interface TokenAnalysis {
  /** Total tokens in current context */
  totalTokens: number;
  /** Maximum context window size */
  contextWindow: number;
  /** Usage percentage (0-100) */
  usagePercent: number;

  /** Model information */
  model: {
    provider: string;
    modelId: string;
  };

  /** Aggregated category breakdown */
  categories: CategoryStats[];

  /** All individual token sources */
  sources: TokenSource[];

  /** Per-turn breakdown */
  turnBreakdown: TurnStats[];

  /** Discrepancy analysis (if counts differ) */
  discrepancy: DiscrepancyAnalysis | null;

  /** Analysis timestamp */
  timestamp: number;

  /** Whether analysis is complete or partial */
  isComplete: boolean;

  /** Any warnings or notes */
  warnings: string[];
}

// =============================================================================
// UI STATE
// =============================================================================

/**
 * Dashboard view modes.
 */
export type ViewMode = "summary" | "drilldown" | "category";

/**
 * Dashboard UI state.
 */
export interface DashboardState {
  viewMode: ViewMode;
  scrollOffset: number;
  selectedCategory: TokenCategory | null;
  analysis: TokenAnalysis | null;
  isLoading: boolean;
  error: string | null;
}
