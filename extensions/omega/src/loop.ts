/**
 * Omega loop engine — executes user-defined steps with compaction.
 *
 * Runs entirely within a command handler context (has waitForIdle).
 * Uses agent_end event as a reliable completion signal.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { OMEGA_ENTRY_TYPE, type OmegaState } from "./types.js";

/**
 * Awaiter for agent_end events.
 *
 * Solves the race condition where waitForIdle() returns before
 * the agent enters processing state after sendUserMessage().
 *
 * Usage: create promise via next() BEFORE sending the message,
 * then await it. Resolves when agent_end fires.
 */
export class AgentEndAwaiter {
  private resolve: (() => void) | null = null;

  /** Call from pi.on("agent_end") handler. */
  signal(): void {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r();
    }
  }

  /** Returns a promise that resolves on the next agent_end event.
   *  If called again before signal(), the previous promise is resolved
   *  to prevent memory leaks. */
  next(): Promise<void> {
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }
}

/**
 * Compact and wait for session reload to settle.
 */
async function compactAndSettle(ctx: ExtensionCommandContext, instructions: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ctx.compact({
      customInstructions: instructions,
      onComplete: () => resolve(),
      onError: (err) => reject(err),
    });
  });
  await ctx.waitForIdle();
}

/**
 * Persist state for session resume.
 */
function persistState(pi: ExtensionAPI, state: OmegaState): void {
  pi.appendEntry(OMEGA_ENTRY_TYPE, { ...state });
}

/**
 * Build compaction instructions — ultra-minimal.
 */
export function compactionInstructions(state: OmegaState): string {
  const stepList = state.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n");

  return `OMEGA LOOP COMPACTION — ULTRA-MINIMAL SUMMARY.

Keep ONLY:
- Omega loop active
- Steps:
${stepList}
- Progress: repetition ${state.currentRepetition}/${state.totalRepetitions}, step ${state.currentStep + 1}/${state.steps.length} just completed
- Next: ${nextStepDescription(state)}

DISCARD everything else. All work product is on disk.
The next prompt will provide the step instruction. No conversation context needed.`;
}

/**
 * Describe what comes next for compaction context.
 */
export function nextStepDescription(state: OmegaState): string {
  const nextStep = state.currentStep + 1;
  if (nextStep < state.steps.length) {
    return `step ${nextStep + 1}/${state.steps.length} of repetition ${state.currentRepetition}`;
  }
  if (state.currentRepetition < state.totalRepetitions) {
    return `step 1/${state.steps.length} of repetition ${state.currentRepetition + 1}`;
  }
  return "done";
}

/**
 * Build the prompt for a step — includes step context so the agent
 * knows where it is in the loop after compaction.
 */
export function stepPrompt(state: OmegaState): string {
  if (state.currentStep < 0 || state.currentStep >= state.steps.length) {
    throw new RangeError(
      `stepPrompt: currentStep ${state.currentStep} out of bounds [0, ${state.steps.length})`
    );
  }
  const step = state.steps[state.currentStep];
  return `# Omega Loop — Repetition ${state.currentRepetition}/${state.totalRepetitions}, Step ${state.currentStep + 1}/${state.steps.length}

## Your Task
${step}

## Context
This is part of an automated loop. Focus only on the task above.
Work directly with the codebase and files. Be thorough.`;
}

/**
 * Run the omega step loop.
 */
export async function runLoop(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: OmegaState,
  awaiter: AgentEndAwaiter,
  onStateChange: (state: OmegaState) => void
): Promise<void> {
  while (state.currentRepetition <= state.totalRepetitions && state.active) {
    while (state.currentStep < state.steps.length && state.active) {
      const stepNum = state.currentStep + 1;
      const stepTotal = state.steps.length;
      const rep = state.currentRepetition;
      const repTotal = state.totalRepetitions;

      ctx.ui.notify(
        `Omega — rep ${rep}/${repTotal}, step ${stepNum}/${stepTotal}: ${state.steps[state.currentStep].slice(0, 80)}`,
        "info"
      );
      onStateChange(state);
      persistState(pi, state);

      // Send step prompt and wait for agent to finish
      const done = awaiter.next();
      pi.sendUserMessage(stepPrompt(state));
      await done;

      // Advance to next step
      state.currentStep += 1;
      persistState(pi, state);
      onStateChange(state);

      // Compact between steps (skip after the very last step)
      const isLastStep =
        state.currentStep >= state.steps.length &&
        state.currentRepetition >= state.totalRepetitions;

      if (!isLastStep && state.active) {
        try {
          await compactAndSettle(ctx, compactionInstructions(state));
        } catch (err) {
          ctx.ui.notify(`Compaction warning: ${err}. Continuing.`, "warning");
        }
      }
    }

    // Reset step index, advance repetition
    if (state.currentRepetition < state.totalRepetitions) {
      state.currentStep = 0;
      state.currentRepetition += 1;
      persistState(pi, state);
      onStateChange(state);
    } else {
      break;
    }
  }

  // Done
  state.active = false;
  persistState(pi, state);
  onStateChange(state);

  ctx.ui.notify(
    `✅ Omega complete — ${state.totalRepetitions} repetition(s) × ${state.steps.length} step(s)`,
    "info"
  );
}
