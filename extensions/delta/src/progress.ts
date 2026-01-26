/**
 * Delta Progress Manager
 * Persists workflow state to ~/.local/share/pi/delta/<session-id>.json
 * Tracks gated workflow phases + artifacts/evidence for resumability.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// --- Constants ---
const DELTA_DIR = path.join(os.homedir(), ".local", "share", "pi", "delta");
const SCHEMA_VERSION = 3;
const DEFAULT_MAX_LOOPS = 4;
const DEFAULT_MAX_GATE_REJECTIONS = 12;
const MAX_RECENT_GATE_ENTRIES = 8;
const MAX_REASON_LENGTH = 160;
const MAX_GOAL_PREVIEW_LENGTH = 80;

// --- Types ---
export type Phase =
  | "idle"
  | "requirements"
  | "review_requirements"
  | "design"
  | "review_design"
  | "plan"
  | "review_plan"
  | "implement"
  | "test"
  | "review_impl"
  | "deliver"
  | "done"
  | "failed";

export type GateVerdict = "approved" | "needs_changes" | "blocked" | "abandoned";

export type IssueClass = "fix_only" | "test_gap" | "plan_gap" | "design_gap" | "req_gap";

export interface Evidence {
  commands?: string[];
  outputs?: string[];
}

export interface GateChecks {
  checklist?: Record<string, boolean>;
  notes?: string[];
}

export interface PhaseEntry {
  phase: Phase;
  loop: number;
  summary: string;
  verdict?: GateVerdict;
  issueClass?: IssueClass;
  reasons?: string[];
  checks?: GateChecks;
  artifacts?: Record<string, string>;
  evidence?: Evidence;
  startedAt: number;
  endedAt: number;
}

export interface GateStats {
  phase: Phase;
  needsChanges: number;
  blocked: number;
  abandoned: number;
}

export interface ProgressData {
  sessionId: string;
  goal: string;
  currentPhase: Phase;
  currentPhaseStartedAt: number;
  loopCount: number;
  maxLoops: number;
  gateRejectionCount: number;
  maxGateRejections: number;
  phaseSummaries: Partial<Record<Phase, string>>;
  phaseArtifacts: Partial<Record<Phase, string>>;
  // Legacy fields (kept for backward compatibility)
  requirements: string;
  requirementsReview: string;
  design: string;
  designReview: string;
  plan: string;
  planReview: string;
  implementationLog: string[];
  testResults: string;
  deliveryNotes: string;
  history: PhaseEntry[];
  gateStats: Record<string, GateStats>;
  startedAt: number;
  updatedAt: number;
  schemaVersion: number;
}

export interface RecordPhaseParams {
  phase: Phase;
  summary: string;
  verdict?: GateVerdict;
  issueClass?: IssueClass;
  reasons?: string[];
  checks?: GateChecks;
  artifacts?: Record<string, string>;
  evidence?: Evidence;
}

// --- Helper Functions ---

function ensureDir(dir: string): void {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
  } catch (err) {
    console.warn(`[delta] Failed to create directory ${dir}: ${err}`);
  }
}

function extractSessionId(sessionFile: string | null): string {
  if (!sessionFile) return `ephemeral-${Date.now()}`;
  return path.basename(sessionFile, path.extname(sessionFile));
}

function nowMs(): number {
  return Date.now();
}

export function isGatePhase(phase: Phase): boolean {
  return (
    phase === "review_requirements" ||
    phase === "review_design" ||
    phase === "review_plan" ||
    phase === "review_impl"
  );
}

function defaultGateStats(phase: Phase): GateStats {
  return { phase, needsChanges: 0, blocked: 0, abandoned: 0 };
}

function bumpGateStats(data: ProgressData, phase: Phase, verdict: GateVerdict | undefined): void {
  if (!verdict || !isGatePhase(phase)) return;
  const key = phase;
  const stats = data.gateStats[key] ?? defaultGateStats(phase);
  if (verdict === "needs_changes") stats.needsChanges++;
  if (verdict === "blocked") stats.blocked++;
  if (verdict === "abandoned") stats.abandoned++;
  data.gateStats[key] = stats;

  if (verdict !== "approved") {
    data.gateRejectionCount++;
  }
}

/**
 * Type guard to validate parsed JSON is a valid object
 */
function isValidObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Safely read and parse JSON file, returning null on any error
 */
function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const rawText = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(rawText);
    if (!isValidObject(parsed)) {
      console.warn(`[delta] Invalid JSON structure in ${filePath}`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`[delta] Failed to read/parse ${filePath}: ${err}`);
    return null;
  }
}

/**
 * Best-effort migration from Delta v2.0.0 schema
 */
function migrateFromV1(raw: Record<string, unknown>, sessionId: string): ProgressData {
  const now = nowMs();
  const goal = String(raw.goal ?? "");

  const phaseMap: Record<string, Phase> = {
    idle: "idle",
    explore: "requirements",
    plan: "plan",
    review_plan: "review_plan",
    implement: "implement",
    test: "test",
    review_impl: "review_impl",
    done: "done",
    failed: "failed",
  };

  const currentPhase = phaseMap[String(raw.currentPhase)] ?? "requirements";

  const data: ProgressData = {
    sessionId,
    goal,
    currentPhase,
    currentPhaseStartedAt: Number(raw.updatedAt ?? now),
    loopCount: Number(raw.loopCount ?? 0),
    maxLoops: Number(raw.maxLoops ?? DEFAULT_MAX_LOOPS),
    gateRejectionCount: 0,
    maxGateRejections: DEFAULT_MAX_GATE_REJECTIONS,
    phaseSummaries: {},
    phaseArtifacts: {},
    requirements: String(raw.exploration ?? ""),
    requirementsReview: "",
    design: "",
    designReview: "",
    plan: String(raw.plan ?? ""),
    planReview: String(raw.planReview ?? ""),
    implementationLog: Array.isArray(raw.implementationLog)
      ? (raw.implementationLog as unknown[]).map(String)
      : [],
    testResults: String(raw.testResults ?? ""),
    deliveryNotes: "",
    history: [],
    gateStats: {},
    startedAt: Number(raw.startedAt ?? now),
    updatedAt: Number(raw.updatedAt ?? now),
    schemaVersion: SCHEMA_VERSION,
  };

  // Preserve old history best-effort
  if (Array.isArray(raw.history)) {
    for (const e of raw.history as Record<string, unknown>[]) {
      if (!isValidObject(e)) continue;
      const oldPhase = String(e.phase);
      const mapped = phaseMap[oldPhase] ?? "requirements";
      const verdict = e.verdict as GateVerdict | undefined;
      const ts = Number(e.timestamp ?? now);
      const entry: PhaseEntry = {
        phase: mapped,
        loop: mapped === "review_impl" && verdict === "needs_changes" ? data.loopCount : 0,
        summary: String(e.summary ?? ""),
        verdict,
        startedAt: ts,
        endedAt: ts,
      };
      data.history.push(entry);
      bumpGateStats(data, mapped, verdict);
    }
  }

  return data;
}

// --- Ordered phases for context building ---
const ORDERED_PHASES: Phase[] = [
  "requirements",
  "review_requirements",
  "design",
  "review_design",
  "plan",
  "review_plan",
  "implement",
  "test",
  "review_impl",
  "deliver",
];

// --- ProgressManager Class ---

export class ProgressManager {
  private data: ProgressData | null = null;
  private readonly sessionId: string;

  constructor(sessionFile: string | null) {
    this.sessionId = extractSessionId(sessionFile);
  }

  get filePath(): string {
    return path.join(DELTA_DIR, `${this.sessionId}.json`);
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  create(goal: string): ProgressData {
    ensureDir(DELTA_DIR);
    const now = nowMs();
    this.data = {
      sessionId: this.sessionId,
      goal,
      currentPhase: "requirements",
      currentPhaseStartedAt: now,
      loopCount: 0,
      maxLoops: DEFAULT_MAX_LOOPS,
      gateRejectionCount: 0,
      maxGateRejections: DEFAULT_MAX_GATE_REJECTIONS,
      phaseSummaries: {},
      phaseArtifacts: {},
      requirements: "",
      requirementsReview: "",
      design: "",
      designReview: "",
      plan: "",
      planReview: "",
      implementationLog: [],
      testResults: "",
      deliveryNotes: "",
      history: [],
      gateStats: {},
      startedAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION,
    };
    this.save();
    return this.data;
  }

  load(): ProgressData | null {
    if (!this.exists()) return null;

    const raw = readJsonFile(this.filePath);
    if (!raw) {
      this.data = null;
      return null;
    }

    // If schemaVersion missing, treat as old schema
    if (typeof raw.schemaVersion !== "number") {
      this.data = migrateFromV1(raw, this.sessionId);
      this.save();
      return this.data;
    }

    // Cast to ProgressData after validation
    this.data = raw as unknown as ProgressData;
    if (!this.data.sessionId) this.data.sessionId = this.sessionId;
    if (!this.data.schemaVersion) this.data.schemaVersion = SCHEMA_VERSION;

    // Ensure v3 fields exist
    if (!this.data.phaseSummaries) this.data.phaseSummaries = {};
    if (!this.data.phaseArtifacts) this.data.phaseArtifacts = {};

    // Backfill compact summaries from legacy fields if empty
    if (Object.keys(this.data.phaseSummaries).length === 0) {
      this.backfillPhaseSummaries();
    }

    return this.data;
  }

  private backfillPhaseSummaries(): void {
    if (!this.data) return;

    const legacyMap: Partial<Record<Phase, string>> = {
      requirements: this.data.requirements,
      review_requirements: this.data.requirementsReview,
      design: this.data.design,
      review_design: this.data.designReview,
      plan: this.data.plan,
      review_plan: this.data.planReview,
      test: this.data.testResults,
      deliver: this.data.deliveryNotes,
    };

    for (const [phase, value] of Object.entries(legacyMap)) {
      if (value) {
        this.data.phaseSummaries[phase as Phase] = value;
      }
    }
  }

  save(): void {
    if (!this.data) return;
    ensureDir(DELTA_DIR);
    this.data.updatedAt = nowMs();
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), {
        encoding: "utf-8",
        mode: 0o644,
      });
    } catch (err) {
      console.warn(`[delta] Failed to save progress file: ${err}`);
    }
  }

  delete(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch (err) {
      console.warn(`[delta] Failed to delete progress file: ${err}`);
    }
    this.data = null;
  }

  getData(): ProgressData | null {
    return this.data;
  }

  getPhase(): Phase {
    return this.data?.currentPhase ?? "idle";
  }

  setPhase(phase: Phase): void {
    if (!this.data) return;
    this.data.currentPhase = phase;
    this.data.currentPhaseStartedAt = nowMs();
    this.save();
  }

  canLoop(): boolean {
    return (this.data?.loopCount ?? 0) < (this.data?.maxLoops ?? DEFAULT_MAX_LOOPS);
  }

  canRejectMore(): boolean {
    return (
      (this.data?.gateRejectionCount ?? 0) <
      (this.data?.maxGateRejections ?? DEFAULT_MAX_GATE_REJECTIONS)
    );
  }

  recordPhase(params: RecordPhaseParams): void {
    if (!this.data) return;

    const endedAt = nowMs();
    const startedAt = this.data.currentPhaseStartedAt || endedAt;

    const entry: PhaseEntry = {
      phase: params.phase,
      loop: this.data.loopCount,
      summary: params.summary,
      verdict: params.verdict,
      issueClass: params.issueClass,
      reasons: params.reasons,
      checks: params.checks,
      artifacts: params.artifacts,
      evidence: params.evidence,
      startedAt,
      endedAt,
    };

    this.data.history.push(entry);

    // v3: compact per-phase summaries + artifact pointers
    this.data.phaseSummaries[params.phase] = params.summary;
    const phaseFile = params.artifacts?.phaseFile;
    if (typeof phaseFile === "string" && phaseFile.trim()) {
      this.data.phaseArtifacts[params.phase] = phaseFile.trim();
    }

    // Update legacy fields for compatibility
    this.updateLegacyFields(params);

    bumpGateStats(this.data, params.phase, params.verdict);
    this.save();
  }

  private updateLegacyFields(params: RecordPhaseParams): void {
    if (!this.data) return;

    switch (params.phase) {
      case "requirements":
        this.data.requirements = params.summary;
        break;
      case "review_requirements":
        this.data.requirementsReview = params.summary;
        break;
      case "design":
        this.data.design = params.summary;
        break;
      case "review_design":
        this.data.designReview = params.summary;
        break;
      case "plan":
        this.data.plan = params.summary;
        break;
      case "review_plan":
        this.data.planReview = params.summary;
        break;
      case "implement":
        this.data.implementationLog.push(`[Loop ${this.data.loopCount}] ${params.summary}`);
        break;
      case "test":
        this.data.testResults = params.summary;
        break;
      case "deliver":
        this.data.deliveryNotes = params.summary;
        break;
      case "review_impl":
        if (params.verdict === "needs_changes") {
          this.data.loopCount++;
        }
        break;
    }
  }

  getNextPhase(
    currentPhase: Phase,
    params?: { verdict?: GateVerdict; issueClass?: IssueClass }
  ): Phase {
    if (!this.data) return "idle";

    const verdict = params?.verdict;
    const issueClass = params?.issueClass;

    // If we exceed gate rejection cap, end workflow
    if (isGatePhase(currentPhase) && verdict && verdict !== "approved" && !this.canRejectMore()) {
      return "done";
    }

    switch (currentPhase) {
      case "requirements":
        return "review_requirements";

      case "review_requirements":
        if (verdict === "approved") return "design";
        if (verdict === "abandoned") return "done";
        if (verdict === "blocked") return "failed";
        return "requirements";

      case "design":
        return "review_design";

      case "review_design":
        if (verdict === "approved") return "plan";
        if (verdict === "abandoned") return "done";
        if (verdict === "blocked") return "failed";
        return "design";

      case "plan":
        return "review_plan";

      case "review_plan":
        if (verdict === "approved") return "implement";
        if (verdict === "abandoned") return "done";
        if (verdict === "blocked") return "failed";
        return "plan";

      case "implement":
        return "test";

      case "test":
        return "review_impl";

      case "review_impl":
        if (verdict === "approved") return "deliver";
        if (verdict === "abandoned") return "done";
        if (verdict === "blocked") return "failed";

        if (!this.canLoop()) return "deliver";

        switch (issueClass) {
          case "fix_only":
            return "implement";
          case "test_gap":
            return "test";
          case "plan_gap":
            return "plan";
          case "design_gap":
            return "design";
          case "req_gap":
            return "requirements";
          default:
            return "plan";
        }

      case "deliver":
        return "done";

      default:
        return "idle";
    }
  }

  getContextForPhase(phase: Phase): string {
    if (!this.data) return "";

    const parts: string[] = [];
    parts.push(`## Goal\n${this.data.goal}`);

    const summaries = this.data.phaseSummaries || {};
    const artifacts = this.data.phaseArtifacts || {};

    // Phase summaries
    const summaryLines: string[] = [];
    for (const p of ORDERED_PHASES) {
      if (p === phase) continue;
      const s = summaries[p];
      if (s && String(s).trim()) {
        summaryLines.push(`- **${p}**: ${String(s).trim().replace(/\n+/g, " ")}`);
      }
    }
    if (summaryLines.length > 0) {
      parts.push(`## Phase Summaries\n${summaryLines.join("\n")}`);
    }

    // Artifact pointers
    const artifactLines: string[] = [];
    for (const p of ORDERED_PHASES) {
      const a = artifacts[p];
      if (a && String(a).trim()) {
        artifactLines.push(`- **${p}**: \`${String(a).trim()}\``);
      }
    }
    if (artifactLines.length > 0) {
      parts.push(`## Artifacts (read files as needed)\n${artifactLines.join("\n")}`);
    }

    // Recent gate decisions
    if (this.data.history.length > 0) {
      const lastGateEntries = this.data.history
        .filter((e) => isGatePhase(e.phase))
        .slice(-MAX_RECENT_GATE_ENTRIES)
        .map((e) => {
          const v = e.verdict ? `${e.verdict}` : "(no verdict)";
          const cls = e.issueClass ? `/${e.issueClass}` : "";
          const reason = e.reasons?.[0] ? ` — ${e.reasons[0].slice(0, MAX_REASON_LENGTH)}` : "";
          return `[Loop ${e.loop}] ${e.phase}: ${v}${cls}${reason}`;
        })
        .join("\n");
      parts.push(`## Recent Gate Decisions\n${lastGateEntries}`);
    }

    return parts.join("\n\n");
  }

  getSummary(): string {
    if (!this.data) return "No active workflow";
    const elapsed = Math.round((nowMs() - this.data.startedAt) / 1000);
    return [
      `Phase: ${this.data.currentPhase}`,
      `Loop: ${this.data.loopCount}/${this.data.maxLoops}`,
      `GateRejects: ${this.data.gateRejectionCount}/${this.data.maxGateRejections}`,
      `Elapsed: ${elapsed}s`,
      `Goal: ${this.data.goal.slice(0, MAX_GOAL_PREVIEW_LENGTH)}...`,
    ].join(" | ");
  }
}
