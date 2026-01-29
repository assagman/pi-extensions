/**
 * Prune types — shared types for delta memory pruning.
 */

// ============ Prune Reasons ============

/** Why an item is a candidate for pruning */
export type PruneReason =
  | "stale" // Never accessed or very old
  | "orphaned_path" // References non-existent file/dir
  | "orphaned_branch" // References non-existent branch
  | "old_session" // Episode from a different session
  | "low_importance" // Low importance + stale
  | "duplicate" // Near-duplicate of another item
  | "completed_context" // References completed task/PR
  | "low_content"; // Trivially short content (likely test/junk)

/** Human-readable reason descriptions */
export const REASON_LABELS: Record<PruneReason, string> = {
  stale: "Stale (never accessed or old)",
  orphaned_path: "Orphaned file reference",
  orphaned_branch: "Orphaned branch reference",
  old_session: "Old session episode",
  low_importance: "Low importance + stale",
  duplicate: "Duplicate content",
  completed_context: "Completed context reference",
  low_content: "Minimal content (likely test/junk)",
};

/** Risk level for each reason (affects default selection) */
export const REASON_RISK: Record<PruneReason, "low" | "medium" | "high"> = {
  stale: "low",
  orphaned_path: "medium",
  orphaned_branch: "medium",
  old_session: "low",
  low_importance: "low",
  duplicate: "medium",
  completed_context: "low",
  low_content: "low", // Safe to delete — trivially short content
};

// ============ Prune Candidates ============

/** Source type for a prune candidate */
export type PrunableSourceType = "episode" | "note" | "kv";

/** A single item that may be pruned */
export interface PruneCandidate {
  /** Source type */
  type: PrunableSourceType;

  /** Source ID (episode id, note id, or kv key) */
  id: string;

  /** Display summary (truncated content) */
  summary: string;

  /** Full content for detail view */
  content: string;

  /** Reasons this item is a prune candidate */
  reasons: PruneReason[];

  /** Relevance score (0-100, lower = more likely to prune) */
  score: number;

  /** Timestamps */
  createdAt: number;
  updatedAt: number;
  lastAccessed: number;

  /** Original importance (for notes) */
  importance?: string;

  /** Tags (for episodes) */
  tags?: string[];

  /** Detected file paths in content */
  detectedPaths?: string[];

  /** Detected branch names in content */
  detectedBranches?: string[];

  /** Whether user has selected this for pruning */
  selected: boolean;
}

// ============ Analysis Results ============

/** Statistics for a prune analysis run */
export interface PruneStats {
  /** Total items analyzed */
  total: {
    episodes: number;
    notes: number;
    kv: number;
  };

  /** Candidates by reason */
  byReason: Record<PruneReason, number>;

  /** Candidates by type */
  byType: Record<PrunableSourceType, number>;

  /** Total prune candidates */
  totalCandidates: number;

  /** Analysis duration in ms */
  analysisTimeMs: number;
}

/** Full analysis result */
export interface PruneAnalysis {
  /** All prune candidates */
  candidates: PruneCandidate[];

  /** Statistics */
  stats: PruneStats;

  /** Current session ID (for old_session detection) */
  currentSessionId: string;

  /** Timestamp of analysis */
  timestamp: number;
}

// ============ Configuration ============

/** Pruning configuration options */
export interface PruneConfig {
  /** Age threshold in days for staleness (default: 30) */
  staleAgeDays: number;

  /** Minimum score to NOT be a candidate (default: 30) */
  minScoreThreshold: number;

  /** Whether to check file existence (default: true) */
  checkFiles: boolean;

  /** Whether to check branch existence (default: true) */
  checkBranches: boolean;

  /** Whether to detect duplicates (default: true) */
  detectDuplicates: boolean;

  /** Similarity threshold for duplicates (0-1, default: 0.8) */
  duplicateSimilarity: number;

  /** Minimum content length to NOT be flagged as low_content (default: 10) */
  minContentLength: number;
}

/** Default configuration */
export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
  staleAgeDays: 30,
  minScoreThreshold: 30,
  checkFiles: true,
  checkBranches: true,
  detectDuplicates: true,
  duplicateSimilarity: 0.8,
  minContentLength: 10,
};
