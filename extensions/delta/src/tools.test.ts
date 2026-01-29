/**
 * Delta v4 tools tests — verify all 6 tools work correctly.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _testReset,
  closeDb,
  forget,
  getDatabaseSchema,
  getDb,
  getDbLocation,
  getVersionInfo,
  remember,
  search,
} from "./db.js";

// ============ Helpers ============

function clearAll(): void {
  const db = getDb();
  db.exec("DELETE FROM memories");
}

// ============ Setup / Teardown ============

beforeEach(() => {
  _testReset();
  clearAll();
});

afterAll(() => {
  closeDb();
});

// ============ Tool Handler Tests ============
// These tests verify the tool logic works correctly by calling the actual DB functions.

describe("delta_remember tool logic", () => {
  it("should store a memory and return formatted output", () => {
    const id = remember("Test decision", { tags: ["decision"], importance: "high" });
    expect(id).toBeGreaterThan(0);

    const memory = search({ query: "Test decision" })[0];
    expect(memory).toBeDefined();
    expect(memory.id).toBe(id);
    expect(memory.content).toBe("Test decision");
    expect(memory.tags).toEqual(["decision"]);
    expect(memory.importance).toBe("high");
  });

  it("should handle minimal input", () => {
    const id = remember("Simple note");
    expect(id).toBeGreaterThan(0);

    const memory = search({ query: "Simple note" })[0];
    expect(memory).toBeDefined();
    expect(memory.id).toBe(id);
    expect(memory.importance).toBe("normal");
    expect(memory.tags).toEqual([]);
  });
});

describe("delta_search tool logic", () => {
  beforeEach(() => {
    clearAll(); // Ensure clean state before adding test data
    remember("Critical bug found", { tags: ["bug"], importance: "critical" });
    remember("Preference for tabs", { tags: ["preference"], importance: "normal" });
    remember("Architecture decision", { tags: ["architecture", "decision"], importance: "high" });
  });

  afterEach(() => {
    clearAll(); // Clean up after each test
  });

  it("should find memories by query", () => {
    const results = search({ query: "bug" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("bug");
  });

  it("should find memories by tag", () => {
    const results = search({ tags: ["decision"] });
    expect(results).toHaveLength(1);
    expect(results[0].tags).toContain("decision");
  });

  it("should filter by importance", () => {
    const results = search({ importance: "high" });
    expect(results).toHaveLength(1);
    expect(results[0].importance).toBe("high");
  });

  it("should handle no results", () => {
    clearAll();
    const results = search({ query: "nonexistent" });
    expect(results).toHaveLength(0);
  });
});

describe("delta_forget tool logic", () => {
  it("should delete existing memory", () => {
    const id = remember("To be deleted");
    const deleted = forget(id);
    expect(deleted).toBe(true);

    const results = search({});
    expect(results).toHaveLength(0);
  });

  it("should return false for non-existent memory", () => {
    const deleted = forget(999);
    expect(deleted).toBe(false);
  });
});

describe("delta_info tool logic", () => {
  it("should return database location and stats", () => {
    remember("Test 1", { importance: "critical" });
    remember("Test 2", { importance: "high" });
    remember("Test 3", { importance: "normal" });

    const location = getDbLocation();
    expect(location).toContain("delta.db");

    const all = search({ limit: 1000 });
    expect(all).toHaveLength(3);

    const critical = all.filter((m) => m.importance === "critical");
    expect(critical).toHaveLength(1);
  });
});

describe("delta_version tool logic", () => {
  it("should return version info", () => {
    const info = getVersionInfo();
    expect(info.current).toBe(4);
    expect(info.shipped).toBe(4);
    expect(info.match).toBe(true);
  });
});

describe("delta_schema tool logic", () => {
  it("should return database schema", () => {
    const schema = getDatabaseSchema();
    expect(schema).toContain("CREATE TABLE");
    expect(schema).toContain("memories");
  });
});
