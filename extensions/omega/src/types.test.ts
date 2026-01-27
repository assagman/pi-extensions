import { describe, expect, it } from "vitest";
import { createInitialState } from "./types.js";

describe("createInitialState", () => {
  it("creates state with correct defaults", () => {
    const state = createInitialState(["step1", "step2"], 3);
    expect(state.active).toBe(true);
    expect(state.steps).toEqual(["step1", "step2"]);
    expect(state.totalRepetitions).toBe(3);
    expect(state.currentRepetition).toBe(1);
    expect(state.currentStep).toBe(0);
    expect(state.startedAt).toBeGreaterThan(0);
  });
});
