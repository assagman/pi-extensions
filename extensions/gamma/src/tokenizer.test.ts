/**
 * Tokenizer Unit Tests
 */

import { describe, expect, it } from "vitest";
import { countTokens, estimateImageTokens, freeTokenizer } from "./tokenizer.js";

describe("countTokens", () => {
  it("returns 0 for empty string", () => {
    expect(countTokens("")).toBe(0);
  });

  it("returns 0 for null/undefined", () => {
    expect(countTokens(null as unknown as string)).toBe(0);
    expect(countTokens(undefined as unknown as string)).toBe(0);
  });

  it("counts tokens for simple text", () => {
    const tokens = countTokens("Hello, world!");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10); // Should be ~4 tokens
  });

  it("counts tokens for longer text", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    const tokens = countTokens(text);
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(20);
  });

  it("handles code snippets", () => {
    const code = `function hello() {
  console.log("Hello, world!");
}`;
    const tokens = countTokens(code);
    expect(tokens).toBeGreaterThan(10);
  });

  it("handles unicode text", () => {
    const text = "こんにちは世界";
    const tokens = countTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("estimateImageTokens", () => {
  it("returns flat estimate for images", () => {
    const tokens = estimateImageTokens();
    expect(tokens).toBe(850);
  });

  it("ignores width/height parameters (simple estimate)", () => {
    const tokens = estimateImageTokens(1024, 768);
    expect(tokens).toBe(850);
  });
});

describe("freeTokenizer", () => {
  it("can be called without error", () => {
    expect(() => freeTokenizer()).not.toThrow();
  });

  it("tokenizer still works after free (lazy re-init)", () => {
    freeTokenizer();
    const tokens = countTokens("test");
    expect(tokens).toBeGreaterThan(0);
  });
});
