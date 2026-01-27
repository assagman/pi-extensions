import type { Answer, AskResult, Question, RenderOption } from "./types.js";

// ─── Pure helpers (no TUI dependency) ───────────────────────────────────────

/**
 * Build a cancelled / error result for early returns.
 */
export function errorResult(
  message: string,
  questions: Question[] = []
): { content: { type: "text"; text: string }[]; details: AskResult } {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

/**
 * Normalise raw question params into fully-populated Question objects.
 * Ensures every question has a label (defaults to Q1, Q2, …).
 */
export function normalizeQuestions(
  raw: readonly {
    id: string;
    label?: string;
    prompt: string;
    options: { value: string; label: string; description?: string }[];
  }[]
): Question[] {
  return raw.map((q, i) => ({
    ...q,
    label: q.label || `Q${i + 1}`,
  }));
}

/**
 * Build the full option list for a question (appends the always-present
 * "Type something" entry). Result is safe to cache per question since
 * question options are immutable once normalised.
 */
export function buildOptions(q: Question): RenderOption[] {
  const opts: RenderOption[] = [...q.options];
  opts.push({ value: "__other__", label: "Type something.", isOther: true });
  return opts;
}

/**
 * Format answers into text lines for the LLM response.
 */
export function formatAnswerLines(answers: Answer[], questions: Question[]): string[] {
  return answers.map((a) => {
    const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
    if (a.wasCustom) {
      return `${qLabel}: user wrote: ${a.label}`;
    }
    return `${qLabel}: user selected: ${a.index}. ${a.label}`;
  });
}
