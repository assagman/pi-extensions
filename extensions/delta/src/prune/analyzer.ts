/**
 * Prune analyzer — core analysis and scoring logic for delta memory pruning.
 * Delta v4 — Unified memory model (tag-based classification).
 */

import type { Memory } from "../db.js";
import {
  checkBranchesExist,
  checkPathsExist,
  detectBranchRefs,
  detectFilePaths,
} from "./detector.js";
import {
  DEFAULT_PRUNE_CONFIG,
  type PrunableSourceType,
  type PruneAnalysis,
  type PruneCandidate,
  type PruneConfig,
  type PruneReason,
  type PruneStats,
} from "./types.js";

// ============ Classification ============

/** Classify memory type based on tags (for display/grouping) */
function classifyMemory(memory: Memory): PrunableSourceType {
  const tags = memory.tags;

  // KV memories have 'kv' tag
  if (tags.includes("kv")) return "kv";

  // Note-like memories have category tags
  const noteTags = ["issue", "convention", "workflow", "reminder", "general"];
  if (tags.some((t) => noteTags.includes(t))) return "note";

  // Default to episode for commit/auto-captured/general memories
  return "episode";
}

// ============ Scoring Weights ============

/** Importance weight multipliers */
const IMPORTANCE_WEIGHTS: Record<string, number> = {
  critical: 1.0,
  high: 0.8,
  normal: 0.5,
  low: 0.2,
};

/** Days since update scoring curve (newer = higher score) */
function recencyScore(daysSinceUpdate: number): number {
  if (daysSinceUpdate <= 1) return 1.0;
  if (daysSinceUpdate <= 7) return 0.9;
  if (daysSinceUpdate <= 14) return 0.7;
  if (daysSinceUpdate <= 30) return 0.5;
  if (daysSinceUpdate <= 60) return 0.3;
  if (daysSinceUpdate <= 90) return 0.2;
  return 0.1;
}

/** Access frequency score (higher access = higher score) */
function accessScore(lastAccessed: number, createdAt: number): number {
  if (lastAccessed === 0) return 0.1; // Never accessed
  const accessAge = Date.now() - lastAccessed;
  const totalAge = Date.now() - createdAt;
  if (totalAge <= 0) return 1.0;
  // Ratio of time since access vs total age
  // If accessed recently relative to age, score higher
  const ratio = 1 - accessAge / totalAge;
  return Math.max(0.1, Math.min(1.0, ratio + 0.3)); // Slight boost
}

// ============ Candidate Analysis ============

/** Analyze a single memory for prune candidacy */
function analyzeMemory(
  memory: Memory,
  currentSessionId: string,
  config: PruneConfig
): Omit<PruneCandidate, "detectedPaths" | "detectedBranches"> | null {
  const reasons: PruneReason[] = [];
  const now = Date.now();
  const daysSinceUpdate = (now - memory.updated_at) / (1000 * 60 * 60 * 24);
  const type = classifyMemory(memory);

  // Check low content (likely test/junk data)
  const contentLength = memory.content.trim().length;
  if (contentLength < config.minContentLength) {
    reasons.push("low_content");
  }

  // Check staleness
  if (memory.last_accessed === 0) {
    reasons.push("stale");
  } else if (daysSinceUpdate > config.staleAgeDays) {
    reasons.push("stale");
  }

  // Check old session (for session-tagged memories)
  if (memory.session_id && memory.session_id !== currentSessionId) {
    // Only flag as old_session if also somewhat stale (> 1 day)
    if (daysSinceUpdate > 1) {
      reasons.push("old_session");
    }
  }

  // Check low importance + stale (for note-like memories)
  if (type === "note" && memory.importance === "low" && daysSinceUpdate > 14) {
    reasons.push("low_importance");
  }

  // Check archived tag (old inactive notes)
  if (memory.tags.includes("archived") && daysSinceUpdate > 7) {
    reasons.push("stale");
  }

  // Calculate score based on type and attributes
  const importanceWeight = IMPORTANCE_WEIGHTS[memory.importance] ?? 0.5;
  const recency = recencyScore(daysSinceUpdate);
  const access = accessScore(memory.last_accessed, memory.created_at);

  let score: number;
  if (type === "note") {
    // Notes: importance matters more
    score = Math.round((importanceWeight * 0.3 + recency * 0.35 + access * 0.35) * 100);
  } else {
    // Episodes/KV: recency and access matter more
    score = Math.round((importanceWeight * 0.1 + recency * 0.45 + access * 0.45) * 100);
  }

  // Skip high/critical importance memories unless very stale OR low_content
  const hasLowContent = reasons.includes("low_content");
  if (
    (memory.importance === "high" || memory.importance === "critical") &&
    daysSinceUpdate < 60 &&
    !hasLowContent
  ) {
    return null;
  }

  // Only return as candidate if has reasons and below threshold
  if (reasons.length === 0 && score >= config.minScoreThreshold) {
    return null;
  }

  // If score is low enough, add as candidate even without explicit reasons
  if (reasons.length === 0 && score < config.minScoreThreshold) {
    reasons.push("stale");
  }

  // Extract display summary (first line or full content if short)
  const firstLine = memory.content.split("\n")[0].trim();
  const summary = truncate(firstLine || memory.content, 80);

  return {
    type,
    id: String(memory.id),
    summary,
    content: memory.content,
    reasons,
    score,
    createdAt: memory.created_at,
    updatedAt: memory.updated_at,
    lastAccessed: memory.last_accessed,
    importance: memory.importance,
    tags: memory.tags,
    selected: false,
  };
}

// ============ Path/Branch Detection ============

/** Enrich candidates with path/branch detection and existence checks */
async function enrichWithDetection(
  candidates: Array<Omit<PruneCandidate, "detectedPaths" | "detectedBranches">>,
  config: PruneConfig
): Promise<PruneCandidate[]> {
  const enriched: PruneCandidate[] = [];

  for (const candidate of candidates) {
    const paths = config.checkFiles ? detectFilePaths(candidate.content) : [];
    const branches = config.checkBranches ? detectBranchRefs(candidate.content) : [];

    const enrichedCandidate: PruneCandidate = {
      ...candidate,
      detectedPaths: paths,
      detectedBranches: branches,
    };

    // Check path existence
    if (config.checkFiles && paths.length > 0) {
      const existing = await checkPathsExist(paths);
      const orphaned = paths.filter((p) => !existing.has(p));
      if (orphaned.length > 0) {
        enrichedCandidate.reasons = [
          ...new Set([...enrichedCandidate.reasons, "orphaned_path" as PruneReason]),
        ];
      }
    }

    // Check branch existence
    if (config.checkBranches && branches.length > 0) {
      const existing = await checkBranchesExist(branches);
      const orphaned = branches.filter((b) => !existing.has(b));
      if (orphaned.length > 0) {
        enrichedCandidate.reasons = [
          ...new Set([...enrichedCandidate.reasons, "orphaned_branch" as PruneReason]),
        ];
      }
    }

    enriched.push(enrichedCandidate);
  }

  return enriched;
}

// ============ Duplicate Detection ============

/** Simple similarity check using Jaccard index on word tokens */
function similarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Detect duplicates among candidates */
function detectDuplicates(candidates: PruneCandidate[], threshold: number): void {
  // Group by type to avoid cross-type duplicate detection
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];

      if (a.type !== b.type) continue;
      if (similarity(a.content, b.content) >= threshold) {
        // Mark the one with lower score as duplicate
        if (a.score <= b.score) {
          a.reasons = [...new Set([...a.reasons, "duplicate" as PruneReason])];
        } else {
          b.reasons = [...new Set([...b.reasons, "duplicate" as PruneReason])];
        }
      }
    }
  }
}

// ============ Main Analysis ============

export interface AnalyzeInput {
  memories: Memory[];
  currentSessionId: string;
  config?: Partial<PruneConfig>;
}

/** Run full prune analysis */
export async function analyze(input: AnalyzeInput): Promise<PruneAnalysis> {
  const start = Date.now();
  const config = { ...DEFAULT_PRUNE_CONFIG, ...input.config };
  const rawCandidates: Array<Omit<PruneCandidate, "detectedPaths" | "detectedBranches">> = [];

  // Analyze all memories
  for (const memory of input.memories) {
    const candidate = analyzeMemory(memory, input.currentSessionId, config);
    if (candidate) rawCandidates.push(candidate);
  }

  // Enrich with path/branch detection
  let candidates = await enrichWithDetection(rawCandidates, config);

  // Detect duplicates
  if (config.detectDuplicates) {
    detectDuplicates(candidates, config.duplicateSimilarity);
  }

  // Sort by score ascending (lowest score = best prune candidate first)
  candidates = candidates.sort((a, b) => a.score - b.score);

  // Build stats
  const stats = buildStats(input, candidates);
  stats.analysisTimeMs = Date.now() - start;

  return {
    candidates,
    stats,
    currentSessionId: input.currentSessionId,
    timestamp: Date.now(),
  };
}

function buildStats(input: AnalyzeInput, candidates: PruneCandidate[]): PruneStats {
  const byReason: Record<PruneReason, number> = {
    stale: 0,
    orphaned_path: 0,
    orphaned_branch: 0,
    old_session: 0,
    low_importance: 0,
    duplicate: 0,
    completed_context: 0,
    low_content: 0,
  };

  const byType: Record<PrunableSourceType, number> = {
    episode: 0,
    note: 0,
    kv: 0,
  };

  for (const c of candidates) {
    byType[c.type]++;
    for (const reason of c.reasons) {
      byReason[reason]++;
    }
  }

  // Count total memories by type
  const totalByType: Record<PrunableSourceType, number> = {
    episode: 0,
    note: 0,
    kv: 0,
  };
  for (const memory of input.memories) {
    const type = classifyMemory(memory);
    totalByType[type]++;
  }

  return {
    total: {
      episodes: totalByType.episode,
      notes: totalByType.note,
      kv: totalByType.kv,
    },
    byReason,
    byType,
    totalCandidates: candidates.length,
    analysisTimeMs: 0,
  };
}

// ============ Helpers ============

function truncate(s: string, max: number): string {
  const clean = s.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
