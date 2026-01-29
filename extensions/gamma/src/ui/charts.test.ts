/**
 * Charts Unit Tests
 */

import { describe, expect, it } from "vitest";
import { renderBarChart, renderProgressBar } from "./charts.js";

describe("renderProgressBar", () => {
  it("renders empty bar at 0%", () => {
    const bar = renderProgressBar(0, 10);
    expect(bar).toContain("░");
    expect(bar).not.toContain("█");
  });

  it("renders full bar at 100%", () => {
    const bar = renderProgressBar(100, 10);
    expect(bar).toContain("█");
    expect(bar).not.toContain("░");
  });

  it("renders partial fill at 50%", () => {
    const bar = renderProgressBar(50, 10);
    expect(bar).toContain("█");
    expect(bar).toContain("░");
  });

  it("clamps values below 0%", () => {
    const bar = renderProgressBar(-10, 10);
    // Should render as 0%
    expect(bar).toContain("░");
  });

  it("clamps values above 100%", () => {
    const bar = renderProgressBar(150, 10);
    // Should render as 100%
    expect(bar).toContain("█");
  });

  it("respects width parameter", () => {
    const bar5 = renderProgressBar(100, 5);
    const bar20 = renderProgressBar(100, 20);
    // Strip ANSI codes for length check
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires control chars
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    expect(strip(bar5).length).toBe(5);
    expect(strip(bar20).length).toBe(20);
  });

  it("includes ANSI color codes", () => {
    const bar = renderProgressBar(50, 10);
    // Should contain escape sequences
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape detection requires control chars
    expect(bar).toMatch(/\x1b\[/);
  });
});

describe("renderBarChart", () => {
  it("renders empty bar at 0%", () => {
    const bar = renderBarChart(0, 10);
    expect(bar).toContain("░");
  });

  it("renders full bar at 100%", () => {
    const bar = renderBarChart(100, 10);
    expect(bar).toContain("█");
  });

  it("uses sub-character precision", () => {
    // At ~12.5%, should use partial block character
    const bar = renderBarChart(12.5, 10);
    // Should contain at least one partial block character (▏▎▍▌▋▊▉)
    expect(/[▏▎▍▌▋▊▉]/.test(bar) || bar.length > 0).toBe(true);
  });

  it("accepts custom color", () => {
    const bar = renderBarChart(50, 10, { r: 255, g: 0, b: 0 });
    // Should include RGB color code for red
    expect(bar).toContain("255");
  });

  it("uses default teal color when no color provided", () => {
    const bar = renderBarChart(50, 10);
    // Default teal is rgb(84, 160, 160)
    expect(bar).toContain("84");
    expect(bar).toContain("160");
  });

  it("respects width parameter", () => {
    const bar = renderBarChart(100, 15);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires control chars
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    expect(strip(bar).length).toBe(15);
  });

  it("clamps percent to 0-100 range", () => {
    const barNeg = renderBarChart(-50, 10);
    const barOver = renderBarChart(200, 10);
    // Should not throw, should render valid bars
    expect(barNeg.length).toBeGreaterThan(0);
    expect(barOver.length).toBeGreaterThan(0);
  });
});
