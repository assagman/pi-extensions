/**
 * Types Unit Tests
 */

import { describe, expect, it } from "vitest";
import { CATEGORY_META, type TokenCategory } from "./types.js";

describe("CATEGORY_META", () => {
  const expectedCategories: TokenCategory[] = [
    "system",
    "memory",
    "skills",
    "user",
    "assistant",
    "tool_io",
  ];

  it("has all expected categories", () => {
    for (const cat of expectedCategories) {
      expect(CATEGORY_META[cat]).toBeDefined();
    }
  });

  it("each category has required fields", () => {
    for (const cat of expectedCategories) {
      const meta = CATEGORY_META[cat];
      expect(meta.label).toBeDefined();
      expect(typeof meta.label).toBe("string");
      expect(meta.icon).toBeDefined();
      expect(typeof meta.icon).toBe("string");
      expect(meta.color).toBeDefined();
      expect(typeof meta.color.r).toBe("number");
      expect(typeof meta.color.g).toBe("number");
      expect(typeof meta.color.b).toBe("number");
    }
  });

  it("colors are valid RGB values", () => {
    for (const cat of expectedCategories) {
      const { r, g, b } = CATEGORY_META[cat].color;
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(255);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    }
  });

  it("icons are non-empty strings", () => {
    for (const cat of expectedCategories) {
      expect(CATEGORY_META[cat].icon.length).toBeGreaterThan(0);
    }
  });

  it("labels are human-readable", () => {
    for (const cat of expectedCategories) {
      const label = CATEGORY_META[cat].label;
      expect(label.length).toBeGreaterThan(2);
      // First letter should be uppercase
      expect(label[0]).toBe(label[0].toUpperCase());
    }
  });
});
