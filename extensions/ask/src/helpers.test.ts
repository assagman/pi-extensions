import { describe, expect, it } from "vitest";
import { buildOptions, errorResult, formatAnswerLines, normalizeQuestions } from "./helpers.js";
import type { Answer, Question } from "./types.js";

// ─── errorResult ────────────────────────────────────────────────────────────

describe("errorResult", () => {
  it("returns cancelled result with message", () => {
    const r = errorResult("something went wrong");
    expect(r.content).toEqual([{ type: "text", text: "something went wrong" }]);
    expect(r.details.cancelled).toBe(true);
    expect(r.details.answers).toEqual([]);
    expect(r.details.questions).toEqual([]);
  });

  it("includes provided questions in details", () => {
    const qs: Question[] = [
      { id: "q1", label: "Q1", prompt: "Pick one", options: [{ value: "a", label: "A" }] },
    ];
    const r = errorResult("err", qs);
    expect(r.details.questions).toHaveLength(1);
    expect(r.details.questions[0].id).toBe("q1");
  });
});

// ─── normalizeQuestions ─────────────────────────────────────────────────────

describe("normalizeQuestions", () => {
  it("assigns default labels Q1, Q2, … when label is missing", () => {
    const raw = [
      { id: "a", prompt: "First?", options: [] },
      { id: "b", prompt: "Second?", options: [] },
    ];
    const result = normalizeQuestions(raw);
    expect(result[0].label).toBe("Q1");
    expect(result[1].label).toBe("Q2");
  });

  it("preserves explicit labels", () => {
    const raw = [{ id: "x", label: "Scope", prompt: "What scope?", options: [] }];
    const result = normalizeQuestions(raw);
    expect(result[0].label).toBe("Scope");
  });

  it("preserves options unchanged", () => {
    const opts = [{ value: "v1", label: "L1", description: "D1" }];
    const raw = [{ id: "q", prompt: "Pick", options: opts }];
    const result = normalizeQuestions(raw);
    expect(result[0].options).toEqual(opts);
  });

  it("returns empty array for empty input", () => {
    expect(normalizeQuestions([])).toEqual([]);
  });
});

// ─── buildOptions ───────────────────────────────────────────────────────────

describe("buildOptions", () => {
  it("appends 'Type something.' with isOther flag", () => {
    const q: Question = {
      id: "q1",
      label: "Q1",
      prompt: "Pick one",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
    };
    const opts = buildOptions(q);
    expect(opts).toHaveLength(3);
    expect(opts[2]).toEqual({ value: "__other__", label: "Type something.", isOther: true });
  });

  it("works with zero original options", () => {
    const q: Question = { id: "q2", label: "Q2", prompt: "Anything?", options: [] };
    const opts = buildOptions(q);
    expect(opts).toHaveLength(1);
    expect(opts[0].isOther).toBe(true);
  });

  it("does not mutate the original question options", () => {
    const original = [{ value: "x", label: "X" }];
    const q: Question = { id: "q3", label: "Q3", prompt: "?", options: original };
    buildOptions(q);
    expect(original).toHaveLength(1); // unchanged
  });
});

// ─── formatAnswerLines ──────────────────────────────────────────────────────

describe("formatAnswerLines", () => {
  const questions: Question[] = [
    { id: "q1", label: "Scope", prompt: "", options: [] },
    { id: "q2", label: "Priority", prompt: "", options: [] },
  ];

  it("formats selected answers with index", () => {
    const answers: Answer[] = [
      { id: "q1", value: "feat", label: "Feature", wasCustom: false, index: 2 },
    ];
    const lines = formatAnswerLines(answers, questions);
    expect(lines).toEqual(["Scope: user selected: 2. Feature"]);
  });

  it("formats custom answers with 'user wrote'", () => {
    const answers: Answer[] = [
      { id: "q2", value: "urgent fix", label: "urgent fix", wasCustom: true },
    ];
    const lines = formatAnswerLines(answers, questions);
    expect(lines).toEqual(["Priority: user wrote: urgent fix"]);
  });

  it("falls back to answer id when question not found", () => {
    const answers: Answer[] = [
      { id: "unknown", value: "x", label: "X", wasCustom: false, index: 1 },
    ];
    const lines = formatAnswerLines(answers, []);
    expect(lines).toEqual(["unknown: user selected: 1. X"]);
  });

  it("handles multiple answers", () => {
    const answers: Answer[] = [
      { id: "q1", value: "a", label: "A", wasCustom: false, index: 1 },
      { id: "q2", value: "b", label: "B", wasCustom: true },
    ];
    const lines = formatAnswerLines(answers, questions);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Scope");
    expect(lines[1]).toContain("Priority");
  });

  it("returns empty array for no answers", () => {
    expect(formatAnswerLines([], questions)).toEqual([]);
  });
});
