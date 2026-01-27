import { describe, expect, it } from "vitest";
import {
  AgentEndAwaiter,
  compactionInstructions,
  nextStepDescription,
  stepPrompt,
} from "./loop.js";
import type { OmegaState } from "./types.js";

// ── AgentEndAwaiter ──

describe("AgentEndAwaiter", () => {
  it("resolves when signal is called after next", async () => {
    const a = new AgentEndAwaiter();
    const p = a.next();
    a.signal();
    await expect(p).resolves.toBeUndefined();
  });

  it("signal before next is a no-op", () => {
    const a = new AgentEndAwaiter();
    a.signal(); // should not throw
  });

  it("double next resolves stale promise (F3 fix)", async () => {
    const a = new AgentEndAwaiter();
    const p1 = a.next();
    const p2 = a.next(); // should resolve p1
    await expect(p1).resolves.toBeUndefined();
    a.signal();
    await expect(p2).resolves.toBeUndefined();
  });
});

// ── Pure functions ──

const baseState: OmegaState = {
  active: true,
  steps: ["review code", "fix bugs"],
  totalRepetitions: 3,
  currentRepetition: 1,
  currentStep: 0,
  startedAt: 1000,
};

describe("nextStepDescription", () => {
  it("returns next step in same repetition", () => {
    expect(nextStepDescription(baseState)).toBe("step 2/2 of repetition 1");
  });

  it("returns first step of next repetition", () => {
    const s = { ...baseState, currentStep: 1 };
    expect(nextStepDescription(s)).toBe("step 1/2 of repetition 2");
  });

  it("returns done on last step of last rep", () => {
    const s = { ...baseState, currentStep: 1, currentRepetition: 3 };
    expect(nextStepDescription(s)).toBe("done");
  });
});

describe("stepPrompt", () => {
  it("includes step text and position", () => {
    const result = stepPrompt(baseState);
    expect(result).toContain("review code");
    expect(result).toContain("Step 1/2");
    expect(result).toContain("Repetition 1/3");
  });

  it("throws RangeError on out-of-bounds step (F6 fix)", () => {
    const s = { ...baseState, currentStep: 99 };
    expect(() => stepPrompt(s)).toThrow(RangeError);
  });
});

describe("compactionInstructions", () => {
  it("includes step list and progress", () => {
    const result = compactionInstructions(baseState);
    expect(result).toContain("OMEGA LOOP COMPACTION");
    expect(result).toContain("1. review code");
    expect(result).toContain("2. fix bugs");
    expect(result).toContain("repetition 1/3");
  });
});
