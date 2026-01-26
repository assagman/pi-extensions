import * as fs from "node:fs";
import * as path from "node:path";
/**
 * Delta Extension - Structured gated workflow for pi coding agent
 *
 * Drives the main agent through a deterministic phase-gate lifecycle with feedback loops:
 *   requirements → review(req) → design → review(design) → plan → review(plan) →
 *   implement ↔ test → review(impl) → deliver → done
 *
 * No subagents. The main agent does all the work.
 * Delta only steers it phase-by-page via system prompt injection.
 *
 * Toggle: Ctrl+Alt+L | Command: /delta [status|cancel]
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  DEFAULT_ARTIFACT_DIR,
  getDefaultArtifactPath,
  getPhaseEmoji,
  getPhaseGoal,
  getPhaseInstructions,
  getPhaseLabel,
} from "./phases.js";
import {
  type GateVerdict,
  type IssueClass,
  type Phase,
  ProgressManager,
  isGatePhase,
} from "./progress.js";

// --- Constants ---
const MIN_ARTIFACT_SIZE_BYTES = 10;
const SUMMARY_DISPLAY_MAX_LENGTH = 60;

// Theme color constants to avoid repeated casts
const THEME: Record<string, ThemeColor> = {
  success: "success",
  error: "error",
  warning: "warning",
  muted: "muted",
  accent: "accent",
  dim: "dim",
  toolTitle: "toolTitle",
} as const;
const ALL_PHASES: Phase[] = [
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

// --- Types ---
interface DeltaToolDetails {
  phase?: Phase;
  verdict?: GateVerdict;
  nextPhase?: Phase;
  isError?: boolean;
}

type ToolResult = AgentToolResult<DeltaToolDetails>;

interface DeltaAdvanceParams {
  summary: string;
  verdict?: GateVerdict;
  issueClass?: IssueClass;
  reasons?: string[];
  checks?: Record<string, boolean>;
  evidence?: { commands?: string[]; outputs?: string[] };
  artifacts?: Record<string, string>;
}

// --- Helpers ---

/**
 * Create a standardized tool error response
 */
function toolError(message: string, details: DeltaToolDetails = {}): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: { ...details, isError: true },
  };
}

/**
 * Create a standardized tool success response
 */
function toolSuccess(message: string, details: DeltaToolDetails = {}): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: { ...details, isError: false },
  };
}

/**
 * Ensure the artifact directory exists with proper validation.
 * Validates that the artifact directory doesn't contain path traversal patterns.
 */
function ensureArtifactDir(ctx: ExtensionContext): void {
  try {
    // Validate artifact dir constant doesn't contain traversal
    if (DEFAULT_ARTIFACT_DIR.includes("..") || path.isAbsolute(DEFAULT_ARTIFACT_DIR)) {
      console.warn("[delta] Invalid artifact directory configuration");
      return;
    }

    const dir = path.join(ctx.cwd, DEFAULT_ARTIFACT_DIR);
    const normalizedDir = path.normalize(dir);
    const normalizedCwd = path.normalize(ctx.cwd);

    // Path traversal protection
    if (!normalizedDir.startsWith(normalizedCwd)) {
      console.warn("[delta] Invalid artifact directory path detected");
      return;
    }

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
  } catch (err) {
    console.warn(`[delta] Failed to create artifact directory: ${err}`);
  }
}

/**
 * Get file stats safely, returning null if file doesn't exist or error occurs
 */
function getFileStats(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

export default function delta(pi: ExtensionAPI): void {
  let progress: ProgressManager;
  let enabled = false;
  let active = false;
  let pendingPhaseResetCompaction: { customInstructions: string } | null = null;
  let compactionInProgress = false;

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    progress = new ProgressManager(sessionFile);

    // Resume if progress file exists
    if (progress.exists()) {
      const data = progress.load();
      if (data && data.currentPhase !== "done" && data.currentPhase !== "failed") {
        enabled = true;
        active = true;
        ctx.ui.notify(
          `Δ resumed: ${getPhaseLabel(data.currentPhase)} (loop ${data.loopCount})`,
          "info"
        );
      }
    }

    // Restore from session entries
    interface DeltaStateEntry {
      type: string;
      customType?: string;
      data?: { enabled: boolean };
    }

    const entries = ctx.sessionManager.getEntries() as DeltaStateEntry[];
    const deltaEntry = entries.findLast(
      (e) => e.type === "custom" && e.customType === "delta-state"
    );

    if (deltaEntry?.data?.enabled && !active) {
      enabled = true;
    }

    ensureArtifactDir(ctx);
    updateUI(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    progress = new ProgressManager(sessionFile);

    if (progress.exists()) {
      const data = progress.load();
      if (data && data.currentPhase !== "done" && data.currentPhase !== "failed") {
        enabled = true;
        active = true;
      } else {
        active = false;
      }
    } else {
      active = false;
    }

    ensureArtifactDir(ctx);
    updateUI(ctx);
  });

  // --- Toggle ---

  pi.registerShortcut("ctrl+alt+l", {
    description: "Toggle Delta mode",
    handler: async (ctx) => {
      if (active) {
        ctx.ui.notify("Δ workflow active. Use /delta cancel to stop.", "warning");
        return;
      }
      enabled = !enabled;
      persistState();
      ctx.ui.notify(enabled ? "Δ mode ON" : "Δ mode OFF", "info");
      updateUI(ctx);
    },
  });

  // --- Command ---

  pi.registerCommand("delta", {
    description: "Delta workflow control [status|cancel|compact]",
    handler: async (args, ctx) => {
      const sub = args?.trim().split(" ")[0];

      if (sub === "cancel") {
        if (active) {
          active = false;
          progress.setPhase("failed");
          ctx.ui.notify("Δ workflow cancelled", "warning");
        } else {
          ctx.ui.notify("No active Δ workflow", "info");
        }
        updateUI(ctx);
        return;
      }

      if (sub === "compact") {
        if (!active) {
          ctx.ui.notify("No active Δ workflow to compact", "warning");
          return;
        }

        ctx.ui.notify("Triggering manual Δ compaction...", "info");

        const phase = progress.getPhase();
        const resetMessage = buildPhaseResetMessage(phase);

        pi.sendMessage({
          customType: "delta-phase-reset",
          content: resetMessage,
          display: false,
          details: { phase },
        });

        const compactInstructions =
          "[DELTA_PHASE_RESET]\nManual compaction triggered by user. Replace prior conversational context with ONLY phase goal, summaries, and artifact paths.";

        ctx.compact({
          customInstructions: compactInstructions,
          onComplete: () => ctx.ui.notify("Δ manual compaction complete", "info"),
          onError: (error) => ctx.ui.notify(`Δ compaction failed: ${error.message}`, "error"),
        });
        return;
      }

      // Default: status
      if (active && progress.getData()) {
        ctx.ui.notify(progress.getSummary(), "info");
      } else {
        ctx.ui.notify(`Δ mode: ${enabled ? "ON (idle)" : "OFF"}`, "info");
      }
    },
  });

  // --- Phase Steering (inject instructions before each agent turn) ---

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!enabled || !active) return;

    const phase = progress.getPhase();
    if (phase === "idle" || phase === "done" || phase === "failed") return;

    const phaseInstructions = getPhaseInstructions(phase);
    const context = progress.getContextForPhase(phase);
    const data = progress.getData();

    const deltaBlock = `
## ⚡ DELTA WORKFLOW ACTIVE

**Phase:** ${getPhaseEmoji(phase)} ${getPhaseLabel(phase).toUpperCase()}
**Phase Goal:** ${getPhaseGoal(phase)}
**Loop:** ${data?.loopCount ?? 0}/${data?.maxLoops ?? 4}
**Gate Rejects:** ${data?.gateRejectionCount ?? 0}/${data?.maxGateRejections ?? 12}

### Compact Context (from persisted Delta state)
${context}

### Phase Instructions
${phaseInstructions}

### CRITICAL
- You MUST call \`delta_advance\` when this phase is complete.
- Do NOT skip ahead.
- Provide evidence/checklists for review_* phases.
- Write your phase output to the required artifact file (see instructions) and pass it via artifacts.phaseFile.
- All your regular tools (read, write, edit, bash, etc.) are available.
`;

    return {
      systemPrompt: `${event.systemPrompt}\n${deltaBlock}`,
    };
  });

  // --- Start workflow on first user message when delta is enabled ---

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };

    if (compactionInProgress) {
      if (ctx.hasUI) ctx.ui.notify("Δ compacting context, please retry your message", "info");
      return { action: "handled" as const };
    }

    if (!enabled || active) return { action: "continue" as const };

    // Start workflow with this message as the goal
    progress.create(event.text);
    active = true;
    persistState();
    ensureArtifactDir(ctx);
    ctx.ui.notify("Δ workflow started: REQUIREMENTS", "info");
    updateUI(ctx);

    return { action: "continue" as const };
  });

  // --- Phase boundary compaction (runs after tool call returns) ---

  pi.on("turn_end", async (_event, ctx) => {
    if (!enabled || !active) return;
    if (!pendingPhaseResetCompaction) return;

    const req = pendingPhaseResetCompaction;
    pendingPhaseResetCompaction = null;

    const phase = progress.getPhase();
    const resetMessage = buildPhaseResetMessage(phase);

    pi.sendMessage({
      customType: "delta-phase-reset",
      content: resetMessage,
      display: false,
      details: { phase },
    });

    compactionInProgress = true;

    // Defer compaction to ensure the marker message is appended first
    setTimeout(() => {
      ctx.compact({
        customInstructions: req.customInstructions,
        onComplete: () => {
          if (ctx.hasUI) ctx.ui.notify("Δ compacted context for next phase", "info");
          compactionInProgress = false;
          pi.sendUserMessage("Context compacted. Proceeding to next phase...");
        },
        onError: (error) => {
          if (ctx.hasUI) ctx.ui.notify(`Δ compaction failed: ${error.message}`, "warning");
          compactionInProgress = false;
        },
      });
    }, 0);
  });

  // --- Delta-aware custom compaction (hard reset at phase boundaries) ---

  pi.on("session_before_compact", async (event, ctx) => {
    if (!enabled || !active) return;

    const instructions = event.customInstructions || "";
    if (!instructions.includes("[DELTA_PHASE_RESET]")) return;

    const phase = progress.getPhase();

    interface BranchEntry {
      id?: string;
      type?: string;
      customType?: string;
    }

    const marker = [...(event.branchEntries as BranchEntry[])]
      .reverse()
      .find((e) => e?.type === "custom_message" && e?.customType === "delta-phase-reset");

    const firstKeptEntryId = marker?.id || event.preparation.firstKeptEntryId;

    const summary = `## Δ Delta Phase Reset\n\n**Current phase:** ${phase}\n**Phase goal:** ${getPhaseGoal(phase)}\n\n${progress.getContextForPhase(phase)}\n\n---\n\nNotes:\n- This summary is intentionally minimal to reduce review bias/context inertia.\n- Read the referenced artifact files for details.`;

    if (ctx.hasUI) {
      ctx.ui.notify(`Δ compaction (phase reset) → keep from ${firstKeptEntryId}`, "info");
    }

    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: { delta: true, type: "phase_reset", phase, firstKeptEntryId },
      },
    };
  });

  // --- Validation helpers for delta_advance ---

  function validateGateFields(params: DeltaAdvanceParams, currentPhase: Phase): ToolResult | null {
    const isGate = isGatePhase(currentPhase);

    if (isGate && !params.verdict) {
      return toolError(
        `Error: verdict ("approved" | "needs_changes" | "blocked" | "abandoned") is required for gate phases.`
      );
    }

    if (
      currentPhase === "review_impl" &&
      params.verdict === "needs_changes" &&
      !params.issueClass
    ) {
      return toolError(
        `Error: issueClass is required for review_impl when verdict="needs_changes" (fix_only|test_gap|plan_gap|design_gap|req_gap).`
      );
    }

    if (
      isGate &&
      params.verdict &&
      params.verdict !== "approved" &&
      (!params.reasons || params.reasons.length === 0)
    ) {
      return toolError("Error: reasons[] is required for non-approved verdicts on gate phases.");
    }

    return null;
  }

  function validateArtifact(
    params: DeltaAdvanceParams,
    currentPhase: Phase,
    ctx: ExtensionContext
  ): ToolResult | null {
    const expected = getDefaultArtifactPath(currentPhase);
    const phaseFile = params.artifacts?.phaseFile;
    const needsPhaseFile =
      currentPhase !== "idle" && currentPhase !== "done" && currentPhase !== "failed";

    if (!needsPhaseFile) return null;

    if (!phaseFile || !phaseFile.trim()) {
      return toolError(
        `Error: artifacts.phaseFile is required for this phase. Write your phase output to ${
          expected ? `\`${expected}\`` : "a phase artifact file"
        } and call delta_advance with artifacts: { phaseFile: "..." }`
      );
    }

    // Enforce canonical artifact path
    if (expected && !phaseFile.endsWith(path.basename(expected))) {
      return toolError(
        `Error: Incorrect artifact file. For phase '${currentPhase}', you MUST write to \`${expected}\` and reference it.\nYou provided: \`${phaseFile}\`.`
      );
    }

    // Validate file exists and has content
    if (!path.isAbsolute(phaseFile)) {
      const resolved = path.resolve(ctx.cwd, phaseFile);

      // Path traversal protection: ensure resolved path is within cwd
      const normalizedResolved = path.normalize(resolved);
      const normalizedCwd = path.normalize(ctx.cwd);
      if (!normalizedResolved.startsWith(normalizedCwd + path.sep)) {
        return toolError("Error: Artifact path must be within project directory.");
      }

      const stats = getFileStats(resolved);

      if (!stats) {
        return toolError(
          `Error: Artifact file not found: \`${phaseFile}\`. You must WRITE the file using the \`write\` tool before advancing.`
        );
      }

      if (stats.size < MIN_ARTIFACT_SIZE_BYTES) {
        return toolError(
          `Error: Artifact file \`${phaseFile}\` is empty or too small. Write meaningful content to it.`
        );
      }
    }

    return null;
  }

  function handleCompletion(
    currentPhase: Phase,
    verdict: GateVerdict | undefined,
    data: ReturnType<typeof progress.getData>
  ): ToolResult {
    const isGate = isGatePhase(currentPhase);
    const completedViaDeliver = currentPhase === "deliver";
    const abandoned = isGate && verdict === "abandoned";
    const blocked = isGate && verdict === "blocked";
    const capped =
      isGate &&
      verdict === "needs_changes" &&
      (data?.gateRejectionCount ?? 0) >= (data?.maxGateRejections ?? 0);

    let text = `✅ Δ workflow completed. ${data?.loopCount ?? 0} loop(s) used.`;

    if (!completedViaDeliver) {
      if (abandoned) {
        text = `⚠️ Δ workflow ended (abandoned). ${data?.loopCount ?? 0} loop(s) used.`;
      } else if (blocked) {
        text = `✗ Δ workflow ended (blocked). ${data?.loopCount ?? 0} loop(s) used.`;
      } else if (capped) {
        text = `⚠️ Δ workflow ended (gate rejection cap reached). ${data?.loopCount ?? 0} loop(s) used.`;
      }
    }

    return toolSuccess(text, { phase: currentPhase, verdict, nextPhase: "done" });
  }

  function handleAdvance(
    currentPhase: Phase,
    nextPhase: Phase,
    verdict: GateVerdict | undefined,
    ctx: ExtensionContext
  ): ToolResult {
    const compactInstructions = `[DELTA_PHASE_RESET]\nDelta phase boundary reached. Replace prior conversational context with ONLY:\n- Current phase goal: ${getPhaseGoal(nextPhase)}\n- Per-phase summaries (3–4 sentences max each)\n- Artifact file paths (read files as needed)\n\nSTRICT: Do not include raw conversation, tool outputs, or long transcripts. Keep it minimal and phase-oriented.`;

    pendingPhaseResetCompaction = { customInstructions: compactInstructions };

    if (ctx.hasUI) ctx.ui.notify("Δ will compact context after this phase", "info");

    const forcedToDeliver =
      currentPhase === "review_impl" && verdict === "needs_changes" && nextPhase === "deliver";

    const msg = forcedToDeliver
      ? `⚠️ Max rework loops reached. Advancing to: ${getPhaseEmoji(nextPhase)} ${getPhaseLabel(nextPhase).toUpperCase()}\n\nDelta will compact/reset context now. STOP after this. Continue with the new phase only after the next user prompt.`
      : `→ Phase advanced to: ${getPhaseEmoji(nextPhase)} ${getPhaseLabel(nextPhase).toUpperCase()}\n\nDelta will compact/reset context now. STOP after this. Continue with the new phase only after the next user prompt.`;

    return toolSuccess(msg, { phase: currentPhase, verdict, nextPhase });
  }

  // --- delta_advance tool ---

  pi.registerTool({
    name: "delta_advance",
    label: "Delta Advance",
    description: `Signal completion of the current Delta workflow phase.
Call this when you have finished your work for the current phase.
- summary: Short phase summary (3–4 sentences or 3–8 bullets)
- artifacts: Must include { phaseFile: ".delta/<phase>.md" } (or another path) for all phases
- verdict: For review_* phases only: approved | needs_changes | blocked | abandoned
- issueClass: For review_impl when needs_changes: fix_only | test_gap | plan_gap | design_gap | req_gap
- reasons: For non-approved verdicts: list actionable reasons
- checks: Checklist results (key->true/false) for gate phases
- evidence: Commands run + short output excerpts (esp. test/typecheck/lint)`,

    parameters: Type.Object({
      summary: Type.String({ description: "Summary of work done in this phase" }),

      verdict: Type.Optional(
        Type.Union(
          [
            Type.Literal("approved"),
            Type.Literal("needs_changes"),
            Type.Literal("blocked"),
            Type.Literal("abandoned"),
          ],
          { description: "Gate decision (review_* phases only)" }
        )
      ),

      issueClass: Type.Optional(
        Type.Union(
          [
            Type.Literal("fix_only"),
            Type.Literal("test_gap"),
            Type.Literal("plan_gap"),
            Type.Literal("design_gap"),
            Type.Literal("req_gap"),
          ],
          {
            description:
              "For review_impl when verdict=needs_changes: classify the issue for routing",
          }
        )
      ),

      reasons: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: "Actionable reasons for needs_changes/blocked/abandoned",
        })
      ),

      checks: Type.Optional(
        Type.Object(
          {},
          { additionalProperties: Type.Boolean(), description: "Gate checklist booleans" }
        )
      ),

      evidence: Type.Optional(
        Type.Object({
          commands: Type.Optional(Type.Array(Type.String())),
          outputs: Type.Optional(Type.Array(Type.String())),
        })
      ),

      artifacts: Type.Optional(
        Type.Object(
          {},
          { additionalProperties: Type.String(), description: "Artifacts inline or as pointers" }
        )
      ),
    }),

    async execute(_toolCallId, params, _onUpdate, ctx) {
      const typedParams = params as DeltaAdvanceParams;

      if (!active) {
        return toolError("Error: No active Delta workflow");
      }

      const currentPhase = progress.getPhase();

      // Validate gate fields
      const gateError = validateGateFields(typedParams, currentPhase);
      if (gateError) return gateError;

      // Validate artifact
      ensureArtifactDir(ctx);
      const artifactError = validateArtifact(typedParams, currentPhase, ctx);
      if (artifactError) return artifactError;

      // Record this phase's output
      progress.recordPhase({
        phase: currentPhase,
        summary: typedParams.summary,
        verdict: typedParams.verdict,
        issueClass: typedParams.issueClass,
        reasons: typedParams.reasons,
        checks: typedParams.checks,
        evidence: typedParams.evidence,
        artifacts: typedParams.artifacts,
      });

      // Determine next phase
      const nextPhase = progress.getNextPhase(currentPhase, {
        verdict: typedParams.verdict,
        issueClass: typedParams.issueClass,
      });

      // Handle completion
      if (nextPhase === "done" || nextPhase === "failed") {
        progress.setPhase(nextPhase);
        active = false;
        persistState();
        updateUI(ctx);
        return handleCompletion(currentPhase, typedParams.verdict, progress.getData());
      }

      // Advance to next phase
      progress.setPhase(nextPhase);
      updateUI(ctx);

      return handleAdvance(currentPhase, nextPhase, typedParams.verdict, ctx);
    },

    renderCall(args: Record<string, unknown>, theme: Theme) {
      const summary = ((args.summary as string) || "").slice(0, SUMMARY_DISPLAY_MAX_LENGTH);
      const verdict = args.verdict ? ` [${args.verdict}]` : "";
      let text = theme.fg(THEME.toolTitle, theme.bold("delta_advance"));
      if (verdict) {
        const v = String(args.verdict);
        const color =
          v === "approved" ? THEME.success : v === "needs_changes" ? THEME.warning : THEME.error;
        text += ` ${theme.fg(color, verdict)}`;
      }
      text += `\n ${theme.fg(THEME.dim, summary + (summary.length >= SUMMARY_DISPLAY_MAX_LENGTH ? "..." : ""))}`;
      return new Text(text, 0, 0);
    },

    renderResult(result: ToolResult, _options: { expanded: boolean }, theme: Theme) {
      const textContent = result.content?.[0];
      const text = textContent?.type === "text" ? textContent.text : "(no output)";
      const isError = result.details?.isError === true;
      const icon = isError ? theme.fg(THEME.error, "✗") : theme.fg(THEME.success, "→");
      return new Text(`${icon} ${text}`, 0, 0);
    },
  });

  // --- Helper functions ---

  function buildPhaseResetMessage(phase: Phase): string {
    return `## Δ Phase Boundary Reset\n\n**Current phase:** ${phase}\n**Phase goal:** ${getPhaseGoal(phase)}\n\n${progress.getContextForPhase(phase)}\n\n---\n\nInstruction: Treat this as the ONLY authoritative context. If more detail is needed, read the artifact files listed above.`;
  }

  function updateUI(ctx: ExtensionContext): void {
    if (!enabled) {
      ctx.ui.setStatus("delta", undefined);
      ctx.ui.setWidget("delta", undefined);
      return;
    }

    if (!active) {
      ctx.ui.setStatus("delta", ctx.ui.theme.fg(THEME.muted, "[Δ]"));
      ctx.ui.setWidget("delta", undefined);
      return;
    }

    const data = progress.getData();
    if (!data) return;

    const phase = data.currentPhase;
    const currentIdx = ALL_PHASES.indexOf(phase as Phase);
    const step = currentIdx >= 0 ? currentIdx + 1 : 0;
    const total = ALL_PHASES.length;
    const loop = data.loopCount > 0 ? ` ⟳${data.loopCount}` : "";

    ctx.ui.setStatus(
      "delta",
      ctx.ui.theme.fg(
        THEME.accent,
        `[Δ ${step}/${total} ${getPhaseEmoji(phase)} ${getPhaseLabel(phase)}${loop} | rej ${data.gateRejectionCount}/${data.maxGateRejections}]`
      )
    );

    const pipeline = ALL_PHASES.map((p, i) => {
      const label = getPhaseLabel(p);
      if (i < currentIdx) return ctx.ui.theme.fg(THEME.success, `✓ ${label}`);
      if (i === currentIdx) return ctx.ui.theme.fg(THEME.accent, `▶ ${label}`);
      return ctx.ui.theme.fg(THEME.muted, `○ ${label}`);
    });

    const lines = [pipeline.join("  ")];
    if (data.loopCount > 0)
      lines.push(ctx.ui.theme.fg(THEME.warning, `⟳ Loop ${data.loopCount}/${data.maxLoops}`));
    if (data.gateRejectionCount > 0)
      lines.push(
        ctx.ui.theme.fg(THEME.warning, `rej ${data.gateRejectionCount}/${data.maxGateRejections}`)
      );

    ctx.ui.setWidget("delta", lines);
  }

  function persistState(): void {
    pi.appendEntry("delta-state", { enabled });
  }
}
