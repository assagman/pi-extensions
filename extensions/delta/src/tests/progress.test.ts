/**
 * Tests for Delta ProgressManager
 * Covers state machine, persistence, migrations, and edge cases.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type GateVerdict, type Phase, ProgressManager, isGatePhase } from "../progress.js";

// --- Test Helpers ---

const TEST_SESSION_ID = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const DELTA_DIR = path.join(os.homedir(), ".local", "share", "pi", "delta");

function getTestFilePath(): string {
  return path.join(DELTA_DIR, `${TEST_SESSION_ID}.json`);
}

function cleanupTestFile(): void {
  const filePath = getTestFilePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// --- Tests ---

describe("isGatePhase", () => {
  it("returns true for review phases", () => {
    expect(isGatePhase("review_requirements")).toBe(true);
    expect(isGatePhase("review_design")).toBe(true);
    expect(isGatePhase("review_plan")).toBe(true);
    expect(isGatePhase("review_impl")).toBe(true);
  });

  it("returns false for non-review phases", () => {
    expect(isGatePhase("idle")).toBe(false);
    expect(isGatePhase("requirements")).toBe(false);
    expect(isGatePhase("design")).toBe(false);
    expect(isGatePhase("plan")).toBe(false);
    expect(isGatePhase("implement")).toBe(false);
    expect(isGatePhase("test")).toBe(false);
    expect(isGatePhase("deliver")).toBe(false);
    expect(isGatePhase("done")).toBe(false);
    expect(isGatePhase("failed")).toBe(false);
  });
});

describe("ProgressManager", () => {
  let manager: ProgressManager;

  beforeEach(() => {
    cleanupTestFile();
    manager = new ProgressManager(`/fake/path/${TEST_SESSION_ID}.json`);
  });

  afterEach(() => {
    cleanupTestFile();
  });

  describe("create", () => {
    it("creates initial progress with correct defaults", () => {
      const data = manager.create("Build a feature");

      expect(data.goal).toBe("Build a feature");
      expect(data.currentPhase).toBe("requirements");
      expect(data.loopCount).toBe(0);
      expect(data.maxLoops).toBe(4);
      expect(data.gateRejectionCount).toBe(0);
      expect(data.maxGateRejections).toBe(12);
      expect(data.history).toEqual([]);
      expect(data.phaseSummaries).toEqual({});
      expect(data.phaseArtifacts).toEqual({});
    });

    it("persists to file", () => {
      manager.create("Test goal");
      expect(manager.exists()).toBe(true);
    });
  });

  describe("load", () => {
    it("returns null for non-existent file", () => {
      expect(manager.load()).toBeNull();
    });

    it("loads persisted data", () => {
      manager.create("Test goal");

      const newManager = new ProgressManager(`/fake/path/${TEST_SESSION_ID}.json`);
      const loaded = newManager.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.goal).toBe("Test goal");
      expect(loaded!.currentPhase).toBe("requirements");
    });

    it("handles malformed JSON gracefully", () => {
      // Write invalid JSON
      fs.writeFileSync(getTestFilePath(), "{ invalid json }", "utf-8");

      expect(manager.load()).toBeNull();
    });

    it("handles null JSON value gracefully", () => {
      fs.writeFileSync(getTestFilePath(), "null", "utf-8");

      expect(manager.load()).toBeNull();
    });

    it("handles non-object JSON gracefully", () => {
      fs.writeFileSync(getTestFilePath(), '"just a string"', "utf-8");

      expect(manager.load()).toBeNull();
    });
  });

  describe("getNextPhase", () => {
    beforeEach(() => {
      manager.create("Test goal");
    });

    it("follows happy path: requirements → review_requirements", () => {
      expect(manager.getNextPhase("requirements")).toBe("review_requirements");
    });

    it("advances on approved verdict: review_requirements → design", () => {
      expect(manager.getNextPhase("review_requirements", { verdict: "approved" })).toBe("design");
    });

    it("loops back on needs_changes: review_requirements → requirements", () => {
      expect(manager.getNextPhase("review_requirements", { verdict: "needs_changes" })).toBe(
        "requirements"
      );
    });

    it("ends on abandoned: review_requirements → done", () => {
      expect(manager.getNextPhase("review_requirements", { verdict: "abandoned" })).toBe("done");
    });

    it("fails on blocked: review_requirements → failed", () => {
      expect(manager.getNextPhase("review_requirements", { verdict: "blocked" })).toBe("failed");
    });

    it("routes review_impl by issueClass", () => {
      expect(
        manager.getNextPhase("review_impl", { verdict: "needs_changes", issueClass: "fix_only" })
      ).toBe("implement");

      expect(
        manager.getNextPhase("review_impl", { verdict: "needs_changes", issueClass: "test_gap" })
      ).toBe("test");

      expect(
        manager.getNextPhase("review_impl", { verdict: "needs_changes", issueClass: "plan_gap" })
      ).toBe("plan");

      expect(
        manager.getNextPhase("review_impl", { verdict: "needs_changes", issueClass: "design_gap" })
      ).toBe("design");

      expect(
        manager.getNextPhase("review_impl", { verdict: "needs_changes", issueClass: "req_gap" })
      ).toBe("requirements");
    });

    it("defaults to plan when no issueClass specified", () => {
      expect(manager.getNextPhase("review_impl", { verdict: "needs_changes" })).toBe("plan");
    });

    it("completes: deliver → done", () => {
      expect(manager.getNextPhase("deliver")).toBe("done");
    });

    it("returns idle for unknown phases", () => {
      expect(manager.getNextPhase("idle")).toBe("idle");
    });
  });

  describe("gate rejection cap", () => {
    beforeEach(() => {
      manager.create("Test goal");
    });

    it("enforces maxGateRejections", () => {
      const data = manager.getData()!;

      // Simulate hitting the cap
      data.gateRejectionCount = 12;
      data.maxGateRejections = 12;

      expect(manager.canRejectMore()).toBe(false);
      expect(manager.getNextPhase("review_impl", { verdict: "needs_changes" })).toBe("done");
    });

    it("allows rejection when under cap", () => {
      expect(manager.canRejectMore()).toBe(true);
    });
  });

  describe("loop cap", () => {
    beforeEach(() => {
      manager.create("Test goal");
    });

    it("enforces maxLoops", () => {
      const data = manager.getData()!;
      data.loopCount = 4;
      data.maxLoops = 4;

      expect(manager.canLoop()).toBe(false);
      // When can't loop, review_impl needs_changes → deliver (forced progress)
      expect(manager.getNextPhase("review_impl", { verdict: "needs_changes" })).toBe("deliver");
    });

    it("allows loop when under cap", () => {
      expect(manager.canLoop()).toBe(true);
    });
  });

  describe("recordPhase", () => {
    beforeEach(() => {
      manager.create("Test goal");
    });

    it("records phase entry in history", () => {
      manager.recordPhase({
        phase: "requirements",
        summary: "Defined acceptance criteria",
        artifacts: { phaseFile: ".delta/requirements.md" },
      });

      const data = manager.getData()!;
      expect(data.history.length).toBe(1);
      expect(data.history[0].phase).toBe("requirements");
      expect(data.history[0].summary).toBe("Defined acceptance criteria");
    });

    it("updates phaseSummaries", () => {
      manager.recordPhase({
        phase: "requirements",
        summary: "Summary text",
      });

      const data = manager.getData()!;
      expect(data.phaseSummaries.requirements).toBe("Summary text");
    });

    it("updates phaseArtifacts", () => {
      manager.recordPhase({
        phase: "requirements",
        summary: "Summary",
        artifacts: { phaseFile: ".delta/requirements.md" },
      });

      const data = manager.getData()!;
      expect(data.phaseArtifacts.requirements).toBe(".delta/requirements.md");
    });

    it("increments loopCount on review_impl needs_changes", () => {
      expect(manager.getData()!.loopCount).toBe(0);

      manager.recordPhase({
        phase: "review_impl",
        summary: "Needs fixes",
        verdict: "needs_changes",
        issueClass: "fix_only",
        reasons: ["Bug found"],
      });

      expect(manager.getData()!.loopCount).toBe(1);
    });

    it("does not increment loopCount on approved", () => {
      manager.recordPhase({
        phase: "review_impl",
        summary: "Looks good",
        verdict: "approved",
      });

      expect(manager.getData()!.loopCount).toBe(0);
    });

    it("tracks gate stats", () => {
      manager.recordPhase({
        phase: "review_requirements",
        summary: "Needs work",
        verdict: "needs_changes",
        reasons: ["Unclear AC"],
      });

      const data = manager.getData()!;
      expect(data.gateStats.review_requirements?.needsChanges).toBe(1);
      expect(data.gateRejectionCount).toBe(1);
    });
  });

  describe("getContextForPhase", () => {
    beforeEach(() => {
      manager.create("Build awesome feature");
    });

    it("includes goal", () => {
      const context = manager.getContextForPhase("requirements");
      expect(context).toContain("Build awesome feature");
    });

    it("includes phase summaries from previous phases", () => {
      manager.recordPhase({
        phase: "requirements",
        summary: "Defined clear ACs",
      });
      manager.setPhase("review_requirements");

      const context = manager.getContextForPhase("review_requirements");
      expect(context).toContain("Defined clear ACs");
    });

    it("includes artifact paths", () => {
      manager.recordPhase({
        phase: "requirements",
        summary: "Done",
        artifacts: { phaseFile: ".delta/requirements.md" },
      });

      const context = manager.getContextForPhase("design");
      expect(context).toContain(".delta/requirements.md");
    });
  });

  describe("getSummary", () => {
    it("returns summary string", () => {
      manager.create("Test goal with long description that should be truncated");
      const summary = manager.getSummary();

      expect(summary).toContain("Phase: requirements");
      expect(summary).toContain("Loop: 0/4");
      expect(summary).toContain("GateRejects: 0/12");
    });

    it("returns default message when no data", () => {
      expect(manager.getSummary()).toBe("No active workflow");
    });
  });

  describe("delete", () => {
    it("removes progress file", () => {
      manager.create("Test");
      expect(manager.exists()).toBe(true);

      manager.delete();
      expect(manager.exists()).toBe(false);
    });

    it("clears internal data", () => {
      manager.create("Test");
      manager.delete();
      expect(manager.getData()).toBeNull();
    });
  });
});

describe("Full workflow simulation", () => {
  let manager: ProgressManager;

  beforeEach(() => {
    cleanupTestFile();
    manager = new ProgressManager(`/fake/path/${TEST_SESSION_ID}.json`);
  });

  afterEach(() => {
    cleanupTestFile();
  });

  it("completes happy path workflow", () => {
    manager.create("Add user authentication");

    const phases: Array<{ phase: Phase; verdict?: GateVerdict }> = [
      { phase: "requirements" },
      { phase: "review_requirements", verdict: "approved" },
      { phase: "design" },
      { phase: "review_design", verdict: "approved" },
      { phase: "plan" },
      { phase: "review_plan", verdict: "approved" },
      { phase: "implement" },
      { phase: "test" },
      { phase: "review_impl", verdict: "approved" },
      { phase: "deliver" },
    ];

    for (const { phase, verdict } of phases) {
      manager.recordPhase({
        phase,
        summary: `Completed ${phase}`,
        verdict,
        artifacts: { phaseFile: `.delta/${phase}.md` },
      });

      const next = manager.getNextPhase(phase, { verdict });
      manager.setPhase(next);
    }

    expect(manager.getPhase()).toBe("done");
    expect(manager.getData()!.history.length).toBe(10);
    expect(manager.getData()!.loopCount).toBe(0);
  });

  it("handles rework loop", () => {
    manager.create("Fix bug");

    // Requirements approved
    manager.recordPhase({ phase: "requirements", summary: "Done" });
    manager.setPhase(manager.getNextPhase("requirements"));
    manager.recordPhase({ phase: "review_requirements", summary: "OK", verdict: "approved" });
    manager.setPhase(manager.getNextPhase("review_requirements", { verdict: "approved" }));

    // Skip to implement for brevity
    manager.setPhase("implement");
    manager.recordPhase({ phase: "implement", summary: "Done" });
    manager.setPhase("test");
    manager.recordPhase({ phase: "test", summary: "Tests pass" });
    manager.setPhase("review_impl");

    // First review: needs changes
    manager.recordPhase({
      phase: "review_impl",
      summary: "Bug in edge case",
      verdict: "needs_changes",
      issueClass: "fix_only",
      reasons: ["Edge case not handled"],
    });

    expect(manager.getData()!.loopCount).toBe(1);

    // Should route back to implement
    const next = manager.getNextPhase("review_impl", {
      verdict: "needs_changes",
      issueClass: "fix_only",
    });
    expect(next).toBe("implement");
  });
});
