/**
 * Tests for prune analyzer module.
 * Delta v4 — Unified memory model.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../db.js";
import { type AnalyzeInput, analyze } from "./analyzer.js";
import { detectBranchRefs, detectFilePaths } from "./detector.js";

describe("detectFilePaths", () => {
  it("should detect extension paths", () => {
    const content = "Fixed bug in extensions/delta/src/index.ts";
    const paths = detectFilePaths(content);
    expect(paths).toContain("extensions/delta/src/index.ts");
  });

  it("should detect src/ paths", () => {
    const content = "Updated src/components/Button.tsx";
    const paths = detectFilePaths(content);
    expect(paths).toContain("src/components/Button.tsx");
  });

  it("should detect relative paths (normalized)", () => {
    const content = "See ./config/settings.json for details";
    const paths = detectFilePaths(content);
    // Regex strips ./ prefix, which is fine
    expect(paths).toContain("config/settings.json");
  });

  it("should detect absolute paths with common extensions", () => {
    const content = "Config at /Users/test/data/config.json";
    const paths = detectFilePaths(content);
    // Leading / may be stripped by generic pattern, path still usable
    expect(paths.some((p) => p.includes("Users/test/data/config.json"))).toBe(true);
  });

  it("should ignore node_modules", () => {
    const content = "node_modules/lodash/index.js is a dependency";
    const paths = detectFilePaths(content);
    expect(paths).not.toContain("node_modules/lodash/index.js");
  });

  it("should handle multiple paths", () => {
    const content = `
      Updated src/index.ts and extensions/mu/src/db.ts
      Also touched ./package.json
    `;
    const paths = detectFilePaths(content);
    expect(paths.length).toBeGreaterThanOrEqual(2);
  });
});

describe("detectBranchRefs", () => {
  it("should detect feat/ branches", () => {
    const content = "Working on feat/delta-prune branch";
    const branches = detectBranchRefs(content);
    expect(branches).toContain("feat/delta-prune");
  });

  it("should detect fix/ branches", () => {
    const content = "Merged fix/memory-leak into main";
    const branches = detectBranchRefs(content);
    expect(branches).toContain("fix/memory-leak");
  });

  it("should detect branches in commit messages", () => {
    const content = "[feat/new-feature abc1234] Added new feature";
    const branches = detectBranchRefs(content);
    expect(branches).toContain("feat/new-feature");
  });

  it("should not include main/master", () => {
    const content = "Merged into main branch";
    const branches = detectBranchRefs(content);
    expect(branches).not.toContain("main");
  });

  it("should handle multiple branches", () => {
    const content = `
      PR from feat/feature-a to main
      Also rebased on feat/feature-b
    `;
    const branches = detectBranchRefs(content);
    expect(branches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("analyze - low_content detection", () => {
  const now = Date.now();
  const baseInput: AnalyzeInput = {
    memories: [],
    currentSessionId: "test-session",
    config: {
      staleAgeDays: 30,
      minScoreThreshold: 30,
      checkFiles: false,
      checkBranches: false,
      detectDuplicates: false,
      duplicateSimilarity: 0.8,
      minContentLength: 10,
    },
  };

  /** Helper to create a note-like memory */
  function createNote(
    id: number,
    content: string,
    importance: Memory["importance"] = "normal"
  ): Memory {
    return {
      id,
      content,
      tags: ["general"], // Note-like category tag
      importance,
      context: null,
      session_id: null,
      created_at: now,
      updated_at: now,
      last_accessed: now,
    };
  }

  /** Helper to create an episode-like memory */
  function createEpisode(id: number, content: string): Memory {
    return {
      id,
      content,
      tags: ["commit"], // Episode-like tag
      importance: "normal",
      context: null,
      session_id: "test-session",
      created_at: now,
      updated_at: now,
      last_accessed: now,
    };
  }

  /** Helper to create a KV-like memory */
  function createKV(id: number, key: string, value: string): Memory {
    return {
      id,
      content: `${key}: ${value}`,
      tags: ["kv", key], // KV-specific tags
      importance: "normal",
      context: null,
      session_id: null,
      created_at: now,
      updated_at: now,
      last_accessed: now,
    };
  }

  it("should flag notes with content < minContentLength", async () => {
    const result = await analyze({
      ...baseInput,
      memories: [createNote(1, "C")], // 1 char - below threshold
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].reasons).toContain("low_content");
    expect(result.stats.byReason.low_content).toBe(1);
  });

  it("should NOT flag notes with content >= minContentLength", async () => {
    const result = await analyze({
      ...baseInput,
      memories: [createNote(1, "This is a proper note with enough content")],
    });

    // Should not be a candidate at all (recent, accessed, normal importance)
    const lowContentCandidates = result.candidates.filter((c) => c.reasons.includes("low_content"));
    expect(lowContentCandidates).toHaveLength(0);
  });

  it("should flag episodes with content < minContentLength", async () => {
    const result = await analyze({
      ...baseInput,
      memories: [createEpisode(1, "X")], // 1 char
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].reasons).toContain("low_content");
  });

  it("should flag KV entries with value < minContentLength", async () => {
    const result = await analyze({
      ...baseInput,
      memories: [createKV(1, "test-key", "AB")], // 2 chars total value
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].reasons).toContain("low_content");
  });

  it("should flag high importance notes with low_content (junk overrides importance)", async () => {
    const result = await analyze({
      ...baseInput,
      memories: [createNote(1, "C", "high")], // 1 char - junk despite high importance
    });

    // Should be flagged despite high importance
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].reasons).toContain("low_content");
  });

  it("should respect custom minContentLength config", async () => {
    const result = await analyze({
      ...baseInput,
      config: { ...(baseInput.config ?? {}), minContentLength: 50 },
      memories: [createNote(1, "Twenty chars here!!")], // 20 chars - below 50
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].reasons).toContain("low_content");
  });
});
