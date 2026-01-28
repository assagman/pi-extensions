/**
 * Database persistence tests
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ToolResultOption,
  cleanupOldSessions,
  closeMuDb,
  loadToolResults,
  persistToolResult,
} from "./db.js";

// Use a unique test session ID for isolation
const TEST_SESSION_ID = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe("db persistence", () => {
  beforeEach(() => {
    // Each test uses a unique session ID, no cleanup needed
  });

  afterEach(() => {
    // Close DB after each test to ensure clean state
    closeMuDb();
  });

  it("persists and loads a single tool result", () => {
    const opt: ToolResultOption = {
      key: "test-key-1",
      toolName: "bash",
      sig: "abc123",
      label: "bash echo hello",
      args: { command: "echo hello" },
      result: { content: [{ type: "text", text: "hello" }] },
      startTime: Date.now(),
      duration: 100,
      isError: false,
    };

    persistToolResult(TEST_SESSION_ID, opt);

    const loaded = loadToolResults(TEST_SESSION_ID);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].key).toBe("test-key-1");
    expect(loaded[0].toolName).toBe("bash");
    expect(loaded[0].args).toEqual({ command: "echo hello" });
    expect(loaded[0].duration).toBe(100);
    expect(loaded[0].isError).toBe(false);
  });

  it("persists multiple tool results in order", () => {
    const session = `${TEST_SESSION_ID}-multi`;

    for (let i = 1; i <= 3; i++) {
      const opt: ToolResultOption = {
        key: `key-${i}`,
        toolName: "read",
        sig: `sig-${i}`,
        label: `read file${i}.txt`,
        args: { path: `file${i}.txt` },
        result: { content: [{ type: "text", text: `content ${i}` }] },
        startTime: Date.now() + i,
        duration: i * 10,
        isError: false,
      };
      persistToolResult(session, opt);
    }

    const loaded = loadToolResults(session);
    expect(loaded).toHaveLength(3);
    expect(loaded[0].key).toBe("key-1");
    expect(loaded[1].key).toBe("key-2");
    expect(loaded[2].key).toBe("key-3");
  });

  it("handles error results", () => {
    const session = `${TEST_SESSION_ID}-error`;

    const opt: ToolResultOption = {
      key: "error-key",
      toolName: "bash",
      sig: "error-sig",
      label: "bash failing-command",
      args: { command: "failing-command" },
      result: { content: [{ type: "text", text: "command not found" }], isError: true },
      startTime: Date.now(),
      duration: 50,
      isError: true,
    };

    persistToolResult(session, opt);

    const loaded = loadToolResults(session);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].isError).toBe(true);
  });

  it("returns empty array for unknown session", () => {
    const loaded = loadToolResults("unknown-session-xyz");
    expect(loaded).toEqual([]);
  });

  it("handles results without duration", () => {
    const session = `${TEST_SESSION_ID}-no-duration`;

    const opt: ToolResultOption = {
      key: "no-duration-key",
      toolName: "ls",
      sig: "ls-sig",
      label: "ls /tmp",
      args: { path: "/tmp" },
      result: { content: [{ type: "text", text: "file1\nfile2" }] },
      startTime: Date.now(),
      isError: false,
    };

    persistToolResult(session, opt);

    const loaded = loadToolResults(session);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].duration).toBeUndefined();
  });

  it("cleanupOldSessions runs without error", () => {
    // Just verify it doesn't throw
    expect(() => cleanupOldSessions()).not.toThrow();
  });
});
