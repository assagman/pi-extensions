// @ts-nocheck
/**
 * Delta Extension - Structured gated workflow for pi coding agent
 *
 * Drives the main agent through a deterministic phase-gate lifecycle with feedback loops:
 *   requirements → review(req) → design → review(design) → plan → review(plan) →
 *   implement ↔ test → review(impl) → deliver → done
 *
 * No subagents. The main agent does all the work.
 * Delta only steers it phase-by-phase via system prompt injection.
 *
 * Toggle: Ctrl+Alt+L | Command: /delta [status|cancel]
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { ProgressManager, type Phase, type GateVerdict, type IssueClass } from "./progress.js";
import {
  DEFAULT_ARTIFACT_DIR,
  getDefaultArtifactPath,
  getPhaseGoal,
  getPhaseInstructions,
  getPhaseEmoji,
  getPhaseLabel,
} from "./phases.js";

export default function delta(pi: ExtensionAPI) {
  let progress: ProgressManager;
  let enabled = false;
  let active = false;
  let pendingPhaseResetCompaction: { customInstructions: string } | null = null;
  let suppressNextUserTurn = false;

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
        ctx.ui.notify(`Δ resumed: ${getPhaseLabel(data.currentPhase)} (loop ${data.loopCount})`, "info");
      }
    }

    // Restore from session entries
    const entries = ctx.sessionManager.getEntries();
    const deltaEntry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "delta-state")
      .pop() as { data?: { enabled: boolean } } | undefined;

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

        // Append a minimal in-context marker message so we can keep ONLY this message after compaction.
        const phase = progress.getPhase();
        const resetMessage = `## Δ Phase Boundary Reset\n\n**Current phase:** ${phase}\n**Phase goal:** ${getPhaseGoal(phase)}\n\n${progress.getContextForPhase(phase)}\n\n---\n\nInstruction: Treat this as the ONLY authoritative context. If more detail is needed, read the artifact files listed above.`;

        pi.sendMessage({
          customType: "delta-phase-reset",
          content: resetMessage,
          display: false,
          details: { phase },
        });

        // Use the same instruction marker so session_before_compact picks it up
        const compactInstructions = `[DELTA_PHASE_RESET]\nManual compaction triggered by user. Replace prior conversational context with ONLY phase goal, summaries, and artifact paths.`;

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

  pi.on("before_agent_start", async (event, ctx) => {
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
      systemPrompt: event.systemPrompt + "\n" + deltaBlock,
    };
  });

  // --- Start workflow on first user message when delta is enabled ---

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (suppressNextUserTurn) {
      // Drop the first input after compaction was requested; user can retry.
      // Prevents agent from running with stale pre-compaction context.
      if (ctx.hasUI) ctx.ui.notify("Δ compacting context, please retry your message", "info");
      return { action: "handled" as const };
    }
    if (!enabled || active) return;

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
    // We removed the ctx.isIdle() check here because turn_end implies the turn is finishing,
    // and we want to force compaction even if there's a race condition on the idle flag.
    // ctx.compact() handles aborting any lingering operations anyway.

    const req = pendingPhaseResetCompaction;
    pendingPhaseResetCompaction = null;

    // Append a minimal in-context marker message so we can keep ONLY this message after compaction.
    // This is what the next phase should see (fresh-start effect).
    const phase = progress.getPhase();
    const resetMessage = `## Δ Phase Boundary Reset\n\n**Current phase:** ${phase}\n**Phase goal:** ${getPhaseGoal(phase)}\n\n${progress.getContextForPhase(phase)}\n\n---\n\nInstruction: Treat this as the ONLY authoritative context. If more detail is needed, read the artifact files listed above.`;

    pi.sendMessage({
      customType: "delta-phase-reset",
      content: resetMessage,
      display: false,
      details: { phase },
    });

    // Compacting aborts current operation and will usually trigger a reload.
    // The immediate next user input can be suppressed to avoid running with stale context.
    suppressNextUserTurn = true;

    // Defer compaction to ensure the marker message is appended to the session branch first.
    setTimeout(() => {
      ctx.compact({
        customInstructions: req.customInstructions,
        onComplete: () => {
          if (ctx.hasUI) ctx.ui.notify("Δ compacted context for next phase", "info");
          suppressNextUserTurn = false;
          // Auto-advance to keep momentum and prevent agent from stopping
          pi.sendUserMessage("Context compacted. Proceeding to next phase...");
        },
        onError: (error) => {
          if (ctx.hasUI) ctx.ui.notify(`Δ compaction failed: ${error.message}`, "warning");
          suppressNextUserTurn = false;
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

    // Keep only our last delta-phase-reset marker message (if present) to remove the entire prior phase conversation.
    const marker = [...event.branchEntries]
      .reverse()
      .find((e: any) => e?.type === "custom_message" && e?.customType === "delta-phase-reset") as any;

    const firstKeptEntryId = (marker?.id as string | undefined) || event.preparation.firstKeptEntryId;

    // Build a minimal phase-oriented summary (NOT a conversation summary).
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
        StringEnum(["approved", "needs_changes", "blocked", "abandoned"] as const, {
          description: "Gate decision (review_* phases only)",
        })
      ),

      issueClass: Type.Optional(
        StringEnum(["fix_only", "test_gap", "plan_gap", "design_gap", "req_gap"] as const, {
          description: "For review_impl when verdict=needs_changes: classify the issue for routing",
        })
      ),

      reasons: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: "Actionable reasons for needs_changes/blocked/abandoned",
        })
      ),

      checks: Type.Optional(
        Type.Object({}, { additionalProperties: Type.Boolean(), description: "Gate checklist booleans" })
      ),

      evidence: Type.Optional(
        Type.Object({
          commands: Type.Optional(Type.Array(Type.String())),
          outputs: Type.Optional(Type.Array(Type.String())),
        })
      ),

      artifacts: Type.Optional(
        Type.Object({}, { additionalProperties: Type.String(), description: "Artifacts inline or as pointers" })
      ),
    }),

    async execute(_toolCallId, params, _onUpdate, ctx) {
      if (!active) {
        return {
          content: [{ type: "text" as const, text: "Error: No active Delta workflow" }],
          isError: true,
        };
      }

      const currentPhase = progress.getPhase();
      const isReviewPhase =
        currentPhase === "review_requirements" ||
        currentPhase === "review_design" ||
        currentPhase === "review_plan" ||
        currentPhase === "review_impl";

      // Validate gate fields
      if (isReviewPhase && !params.verdict) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: verdict ("approved" | "needs_changes" | "blocked" | "abandoned") is required for gate phases.`,
            },
          ],
          isError: true,
        };
      }

      const verdict = params.verdict as GateVerdict | undefined;
      const issueClass = params.issueClass as IssueClass | undefined;

      if (currentPhase === "review_impl" && verdict === "needs_changes" && !issueClass) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: issueClass is required for review_impl when verdict="needs_changes" (fix_only|test_gap|plan_gap|design_gap|req_gap).`,
            },
          ],
          isError: true,
        };
      }

      if (isReviewPhase && verdict && verdict !== "approved" && (!params.reasons || params.reasons.length === 0)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: reasons[] is required for non-approved verdicts on gate phases.`,
            },
          ],
          isError: true,
        };
      }

      // Validate artifact pointer (required for all actionable phases)
      ensureArtifactDir(ctx);
      const expected = getDefaultArtifactPath(currentPhase);
      const phaseFile = (params.artifacts as any)?.phaseFile as string | undefined;
      const needsPhaseFile = currentPhase !== "idle" && currentPhase !== "done" && currentPhase !== "failed";

      if (needsPhaseFile) {
        if (!phaseFile || !phaseFile.trim()) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: artifacts.phaseFile is required for this phase. Write your phase output to ${
                  expected ? `\`${expected}\`` : "a phase artifact file"
                } and call delta_advance with artifacts: { phaseFile: "..." }`,
              },
            ],
            isError: true,
          };
        }

        // Enforce that the agent is using the canonical artifact path for this phase.
        // This prevents reusing a previous phase's artifact (e.g. passing requirements.md for design phase).
        // We allow some flexibility (absolute/relative), but the filename should match.
        if (expected && !phaseFile.endsWith(path.basename(expected))) {
           return {
            content: [
              {
                type: "text" as const,
                text: `Error: Incorrect artifact file. For phase '${currentPhase}', you MUST write to \`${expected}\` and reference it.\nYou provided: \`${phaseFile}\`.`,
              },
            ],
            isError: true,
          };
        }

        // Best-effort check: ensure the artifact file exists at the provided path.
        if (!path.isAbsolute(phaseFile)) {
          try {
            const resolved = path.resolve(ctx.cwd, phaseFile);
            if (!fs.existsSync(resolved)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Error: Artifact file not found: \`${phaseFile}\`. You must WRITE the file using the \`write\` tool before advancing.`,
                  },
                ],
                isError: true,
              };
            }
            // Check for empty files
            const stats = fs.statSync(resolved);
            if (stats.size < 10) {
               return {
                content: [
                  {
                    type: "text" as const,
                    text: `Error: Artifact file \`${phaseFile}\` is empty or too small. Write meaningful content to it.`,
                  },
                ],
                isError: true,
              };
            }
          } catch {
            // ignore fs errors, allow agent to proceed if we can't verify (e.g. permission issues)
          }
        }
      }

      // Record this phase's output
      progress.recordPhase({
        phase: currentPhase,
        summary: params.summary,
        verdict,
        issueClass,
        reasons: params.reasons as string[] | undefined,
        checks: params.checks as any,
        evidence: params.evidence as any,
        artifacts: params.artifacts as any,
      });

      // Determine next phase
      const nextPhase = progress.getNextPhase(currentPhase, { verdict, issueClass });

      // Handle completion
      if (nextPhase === "done" || nextPhase === "failed") {
        progress.setPhase(nextPhase);
        active = false;
        persistState();
        updateUI(ctx);

        const data = progress.getData();

        // Most runs complete via deliver→done. Other paths: abandoned/blocked or gate rejection cap.
        const completedViaDeliver = currentPhase === "deliver";
        const abandoned = isReviewPhase && verdict === "abandoned";
        const blocked = isReviewPhase && verdict === "blocked";
        const capped = isReviewPhase && verdict === "needs_changes" && (data?.gateRejectionCount ?? 0) >= (data?.maxGateRejections ?? 0);

        let text = `✅ Δ workflow completed. ${data?.loopCount ?? 0} loop(s) used.`;
        if (!completedViaDeliver) {
          if (abandoned) text = `⚠️ Δ workflow ended (abandoned). ${data?.loopCount ?? 0} loop(s) used.`;
          else if (blocked) text = `✗ Δ workflow ended (blocked). ${data?.loopCount ?? 0} loop(s) used.`;
          else if (capped) text = `⚠️ Δ workflow ended (gate rejection cap reached). ${data?.loopCount ?? 0} loop(s) used.`;
        }

        return {
          content: [{ type: "text" as const, text }],
        };
      }

      // Advance
      progress.setPhase(nextPhase);
      updateUI(ctx);

      // Trigger compaction to reduce context inertia between phases.
      // This keeps review phases "fresh" and forces reliance on persisted artifacts.
      const compactInstructions = `[DELTA_PHASE_RESET]\nDelta phase boundary reached. Replace prior conversational context with ONLY:\n- Current phase goal: ${getPhaseGoal(nextPhase)}\n- Per-phase summaries (3–4 sentences max each)\n- Artifact file paths (read files as needed)\n\nSTRICT: Do not include raw conversation, tool outputs, or long transcripts. Keep it minimal and phase-oriented.`;

      // Schedule compaction right after this prompt ends.
      // (Calling ctx.compact() inside a tool would abort the active agent operation.)
      pendingPhaseResetCompaction = { customInstructions: compactInstructions };

      if (ctx.hasUI) ctx.ui.notify("Δ will compact context after this phase", "info");

      const forcedToDeliver = currentPhase === "review_impl" && verdict === "needs_changes" && nextPhase === "deliver";
      const msg = forcedToDeliver
        ? `⚠️ Max rework loops reached. Advancing to: ${getPhaseEmoji(nextPhase)} ${getPhaseLabel(nextPhase).toUpperCase()}\n\nDelta will compact/reset context now. STOP after this. Continue with the new phase only after the next user prompt.`
        : `→ Phase advanced to: ${getPhaseEmoji(nextPhase)} ${getPhaseLabel(nextPhase).toUpperCase()}\n\nDelta will compact/reset context now. STOP after this. Continue with the new phase only after the next user prompt.`;

      return { content: [{ type: "text" as const, text: msg }] };
    },

    renderCall(args: Record<string, unknown>, theme: any) {
      const summary = ((args.summary as string) || "").slice(0, 60);
      const verdict = args.verdict ? ` [${args.verdict}]` : "";
      let text = theme.fg("toolTitle", theme.bold("delta_advance"));
      if (verdict) {
        const v = String(args.verdict);
        const color = v === "approved" ? "success" : v === "needs_changes" ? "warning" : "error";
        text += ` ${theme.fg(color, verdict)}`;
      }
      text += `\n ${theme.fg("dim", summary + (summary.length >= 60 ? "..." : ""))}`;
      return new Text(text, 0, 0);
    },

    renderResult(result: any, _options: { expanded: boolean }, theme: any) {
      const textContent = result.content?.[0];
      const text = textContent?.type === "text" ? textContent.text : "(no output)";
      const isError = result.isError;
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "→");
      return new Text(`${icon} ${text}`, 0, 0);
    },
  });

  // --- Helpers ---

  function ensureArtifactDir(ctx: ExtensionContext): void {
    try {
      const dir = path.join(ctx.cwd, DEFAULT_ARTIFACT_DIR);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      }
    } catch {
      // best-effort; artifacts are still agent-written via tools
    }
  }

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

  function updateUI(ctx: ExtensionContext): void {
    if (!enabled) {
      ctx.ui.setStatus("delta", undefined);
      ctx.ui.setWidget("delta", undefined);
      return;
    }

    if (!active) {
      ctx.ui.setStatus("delta", ctx.ui.theme.fg("muted", "[Δ]"));
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
        "accent",
        `[Δ ${step}/${total} ${getPhaseEmoji(phase)} ${getPhaseLabel(phase)}${loop} | rej ${data.gateRejectionCount}/${data.maxGateRejections}]`
      )
    );

    const pipeline = ALL_PHASES.map((p, i) => {
      const label = getPhaseLabel(p);
      if (i < currentIdx) return ctx.ui.theme.fg("success", `✓ ${label}`);
      if (i === currentIdx) return ctx.ui.theme.fg("accent", `▶ ${label}`);
      return ctx.ui.theme.fg("muted", `○ ${label}`);
    });

    const lines = [pipeline.join("  ")];
    if (data.loopCount > 0) lines.push(ctx.ui.theme.fg("warning", `⟳ Loop ${data.loopCount}/${data.maxLoops}`));
    if (data.gateRejectionCount > 0)
      lines.push(ctx.ui.theme.fg("warning", `rej ${data.gateRejectionCount}/${data.maxGateRejections}`));

    ctx.ui.setWidget("delta", lines);
  }

  function persistState(): void {
    pi.appendEntry("delta-state", { enabled });
  }
}
