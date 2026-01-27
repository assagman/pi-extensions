// ─── Types ──────────────────────────────────────────────────────────────────

export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

/** Render-time option (may include the auto-injected "Type something" entry) */
export type RenderOption = QuestionOption & { isOther?: boolean };

export interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
}

export interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

export interface AskResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}
