/**
 * Bash highlighting tests
 */
import { beforeAll, describe, expect, it } from "vitest";
import { bashLineIsChained, bashUpdateQuoteState, highlightBashLine } from "./bash.js";

// Mock the theme for testing
const PI_THEME_KEY = Symbol.for("@mariozechner/pi-coding-agent:theme");

beforeAll(() => {
  // Mock theme that just returns text without ANSI codes for easier testing
  (globalThis as Record<symbol, unknown>)[PI_THEME_KEY] = {
    fg: (_color: string, text: string) => `[${_color}]${text}[/]`,
    getFgAnsi: () => "\x1b[38;2;200;200;200m",
  };
});

describe("bashLineIsChained", () => {
  it("detects && operator", () => {
    expect(bashLineIsChained("echo hello &&")).toBe(true);
    expect(bashLineIsChained("echo hello && ")).toBe(true);
  });

  it("detects || operator", () => {
    expect(bashLineIsChained("echo hello ||")).toBe(true);
  });

  it("detects | operator", () => {
    expect(bashLineIsChained("cat file |")).toBe(true);
  });

  it("detects backslash continuation", () => {
    expect(bashLineIsChained("echo hello \\")).toBe(true);
  });

  it("returns false for normal lines", () => {
    expect(bashLineIsChained("echo hello")).toBe(false);
    expect(bashLineIsChained("ls -la")).toBe(false);
  });
});

describe("bashUpdateQuoteState", () => {
  it("tracks single quotes", () => {
    expect(bashUpdateQuoteState("'hello", false, false)).toEqual([true, false]);
    expect(bashUpdateQuoteState("hello'", true, false)).toEqual([false, false]);
  });

  it("tracks double quotes", () => {
    expect(bashUpdateQuoteState('"hello', false, false)).toEqual([false, true]);
    expect(bashUpdateQuoteState('hello"', false, true)).toEqual([false, false]);
  });

  it("handles escaped quotes in double quotes", () => {
    expect(bashUpdateQuoteState('\\"hello', false, true)).toEqual([false, true]);
  });

  it("ignores double quotes inside single quotes", () => {
    expect(bashUpdateQuoteState('"test', true, false)).toEqual([true, false]);
  });
});

describe("highlightBashLine", () => {
  it("highlights simple commands", () => {
    const result = highlightBashLine("ls -la");
    expect(result).toContain("[syntaxType]ls[/]");
    expect(result).toContain("[syntaxVariable]-la[/]");
  });

  it("highlights keywords", () => {
    const result = highlightBashLine("if true; then");
    expect(result).toContain("[syntaxKeyword]if[/]");
    expect(result).toContain("[syntaxKeyword]then[/]");
  });

  it("highlights builtins", () => {
    const result = highlightBashLine("cd /tmp && echo hello");
    expect(result).toContain("[syntaxFunction]cd[/]");
    expect(result).toContain("[syntaxFunction]echo[/]");
  });

  it("highlights strings", () => {
    const result = highlightBashLine('echo "hello world"');
    expect(result).toContain('[syntaxString]"hello world"[/]');
  });

  it("highlights single-quoted strings", () => {
    const result = highlightBashLine("echo 'hello world'");
    expect(result).toContain("[syntaxString]'hello world'[/]");
  });

  it("highlights variables", () => {
    const result = highlightBashLine("echo $HOME");
    expect(result).toContain("[syntaxVariable]$HOME[/]");
  });

  it("highlights operators", () => {
    const result = highlightBashLine("cat file | grep pattern");
    expect(result).toContain("[syntaxOperator]|[/]");
  });

  it("highlights redirections", () => {
    const result = highlightBashLine("echo hello > file.txt");
    expect(result).toContain("[syntaxOperator]>[/]");
  });

  it("highlights comments", () => {
    const result = highlightBashLine("echo hello # comment");
    expect(result).toContain("[syntaxComment]# comment[/]");
  });

  it("handles continuation from single quote", () => {
    const result = highlightBashLine("continued string'", true, false);
    expect(result).toContain("[syntaxString]continued string'[/]");
  });

  it("handles continuation from double quote", () => {
    const result = highlightBashLine('continued string"', false, true);
    expect(result).toContain('[syntaxString]continued string"[/]');
  });
});
