/**
 * Omega — Generic step looper with compaction.
 *
 * User defines steps + repetition count. Omega executes them
 * in order, compacting between each step for fresh context.
 *
 * Registers:
 *   /omega              — start (opens step collection UI)
 *   /omega stop         — abort the current loop
 *   /omega status       — show current progress
 *
 * Event hooks:
 *   agent_end           — signals step completion to the awaiter
 *   context             — strips stale omega messages
 *   session_start       — restores persisted state on resume
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { AgentEndAwaiter, runLoop } from "./loop.js";
import { OMEGA_ENTRY_TYPE, type OmegaState, createInitialState } from "./types.js";

export default function omega(pi: ExtensionAPI): void {
  let state: OmegaState | null = null;
  const awaiter = new AgentEndAwaiter();

  // Wire agent_end to the awaiter
  pi.on("agent_end", () => {
    awaiter.signal();
  });

  // ── UI ──
  function updateUI(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    if (!state || !state.active) {
      ctx.ui.setStatus("omega", undefined);
      ctx.ui.setWidget("omega", undefined);
      return;
    }

    // Clamp to valid index — currentStep can equal steps.length between repetitions
    const stepIdx = Math.min(state.currentStep, state.steps.length - 1);
    const stepNum = state.currentStep + 1;
    const statusText = `🔄 omega ${state.currentRepetition}/${state.totalRepetitions} [${stepNum}/${state.steps.length}]`;
    ctx.ui.setStatus("omega", ctx.ui.theme.fg("accent", statusText));

    const lines: string[] = [];
    lines.push(ctx.ui.theme.fg("accent", ctx.ui.theme.bold("─── Omega Loop ───")));
    lines.push(
      ctx.ui.theme.fg("muted", "Repetition: ") +
        ctx.ui.theme.fg("accent", `${state.currentRepetition}/${state.totalRepetitions}`) +
        ctx.ui.theme.fg("muted", " │ Step: ") +
        ctx.ui.theme.fg("accent", `${stepNum}/${state.steps.length}`)
    );

    for (let i = 0; i < state.steps.length; i++) {
      const prefix =
        i === stepIdx && state.active
          ? ctx.ui.theme.fg("warning", "▸ ")
          : i < state.currentStep
            ? ctx.ui.theme.fg("success", "✓ ")
            : ctx.ui.theme.fg("muted", "○ ");
      const stepText =
        state.steps[i].length > 60 ? `${state.steps[i].slice(0, 57)}...` : state.steps[i];
      lines.push(
        prefix + ctx.ui.theme.fg(i === stepIdx && state.active ? "warning" : "muted", stepText)
      );
    }

    ctx.ui.setWidget("omega", lines);
  }

  function clearUI(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("omega", undefined);
    ctx.ui.setWidget("omega", undefined);
  }

  // ── /omega command ──
  pi.registerCommand("omega", {
    description: "Omega loop — repeat user-defined steps with compaction between each",
    getArgumentCompletions: (prefix: string) => {
      const commands = [
        { value: "stop", label: "stop", description: "Abort the current loop" },
        { value: "status", label: "status", description: "Show current progress" },
      ];
      const filtered = commands.filter((c) => c.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },

    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // ── /omega stop ──
      if (trimmed === "stop") {
        if (!state || !state.active) {
          ctx.ui.notify("No active omega loop.", "info");
          return;
        }
        state.active = false;
        pi.appendEntry(OMEGA_ENTRY_TYPE, { ...state });
        ctx.ui.notify(
          `⏹ Omega stopped at rep ${state.currentRepetition}/${state.totalRepetitions}, ` +
            `step ${state.currentStep + 1}/${state.steps.length}.`,
          "info"
        );
        clearUI(ctx);
        state = null;
        return;
      }

      // ── /omega status ──
      if (trimmed === "status") {
        if (!state || !state.active) {
          ctx.ui.notify("No active omega loop.", "info");
          return;
        }
        const stepList = state.steps.map((s, i) => `  ${i + 1}. ${s.slice(0, 80)}`).join("\n");
        ctx.ui.notify(
          `Omega loop\n  Repetition: ${state.currentRepetition}/${state.totalRepetitions}\n  Step: ${state.currentStep + 1}/${state.steps.length}\n  Steps:\n${stepList}`,
          "info"
        );
        return;
      }

      // ── /omega — start new loop ──
      if (state?.active) {
        const ok = await ctx.ui.confirm(
          "Omega Active",
          "A loop is already running. Stop it and start a new one?"
        );
        if (!ok) return;
        state.active = false;
        pi.appendEntry(OMEGA_ENTRY_TYPE, { ...state });
        clearUI(ctx);
      }

      // ── Step collection ──

      // If user provided inline text, use it as a single step hint in the editor
      const prefill = trimmed || "";

      const stepsText = await ctx.ui.editor("Omega — Enter steps (one per line):", prefill);
      if (!stepsText?.trim()) {
        ctx.ui.notify("Omega cancelled — no steps provided.", "info");
        return;
      }

      const steps = stepsText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      if (steps.length === 0) {
        ctx.ui.notify("Omega cancelled — no steps provided.", "info");
        return;
      }

      // Show collected steps, ask for repetitions
      const stepPreview = steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
      ctx.ui.notify(`Steps:\n${stepPreview}`, "info");

      const repChoice = await ctx.ui.select("How many repetitions?", [
        "1",
        "2",
        "3",
        "4",
        "5",
        "10",
      ]);
      if (!repChoice) {
        ctx.ui.notify("Omega cancelled.", "info");
        return;
      }
      const totalRepetitions = Number.parseInt(repChoice, 10);

      // ── Launch ──
      state = createInitialState(steps, totalRepetitions);
      updateUI(ctx);

      ctx.ui.notify(
        `🚀 Omega started — ${steps.length} step(s) × ${totalRepetitions} repetition(s)`,
        "info"
      );

      try {
        await runLoop(pi, ctx, state, awaiter, (s) => {
          state = s;
          updateUI(ctx);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`❌ Omega error: ${msg}`, "error");
        if (state) {
          state.active = false;
          pi.appendEntry(OMEGA_ENTRY_TYPE, { ...state });
        }
      } finally {
        clearUI(ctx);
      }
    },
  });

  // ── Context filter: strip stale omega messages ──
  pi.on("context", async (event) => {
    if (!state?.active) return;

    const messages = event.messages;
    const staleIndices = new Set<number>();
    let lastOmegaIdx = -1;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (
        msg.role === "user" &&
        Array.isArray(msg.content) &&
        msg.content.some((c) => {
          const text = c.type === "text" && "text" in c ? (c as { text: string }).text : undefined;
          return (
            text !== undefined &&
            (text.includes("# Omega Loop") || text.includes("OMEGA LOOP COMPACTION"))
          );
        })
      ) {
        if (lastOmegaIdx === -1) {
          lastOmegaIdx = i;
        } else {
          staleIndices.add(i);
        }
      }
    }

    if (staleIndices.size === 0) return;
    return { messages: messages.filter((_, i) => !staleIndices.has(i)) };
  });

  // ── Restore state on session resume ──
  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();

    const omegaEntry = [...entries]
      .reverse()
      .find(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === OMEGA_ENTRY_TYPE
      ) as { data?: OmegaState } | undefined;

    if (omegaEntry?.data) {
      const restored = omegaEntry.data;
      if (restored.active) {
        // Loop cannot auto-resume — session_start has no ExtensionCommandContext.
        // Show what was interrupted, mark dead.
        restored.active = false;
        state = null;
        pi.appendEntry(OMEGA_ENTRY_TYPE, { ...restored });

        if (ctx.hasUI) {
          const stepList = restored.steps.map((s, i) => `  ${i + 1}. ${s.slice(0, 80)}`).join("\n");
          ctx.ui.notify(
            `⚠️ Omega was interrupted at rep ${restored.currentRepetition}/${restored.totalRepetitions}, step ${restored.currentStep + 1}/${restored.steps.length}.\nSteps:\n${stepList}\nUse /omega to restart.`,
            "warning"
          );
        }
      }
    }
  });
}
