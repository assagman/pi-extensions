import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import type { TUI } from "@mariozechner/pi-tui";
import { buildOptions } from "./helpers.js";
import type { Answer, AskResult, Question, RenderOption } from "./types.js";

/**
 * Create the Ask TUI component.
 *
 * This is the factory passed to `ctx.ui.custom<AskResult>(...)`.
 * It encapsulates all mutable state, rendering, and input handling.
 */
export function createAskUI<
  T extends {
    // biome-ignore lint/suspicious/noExplicitAny: Theme methods accept varying argument types
    fg: (...a: any[]) => string;
    // biome-ignore lint/suspicious/noExplicitAny: Theme methods accept varying argument types
    bg: (...a: any[]) => string;
    bold: (s: string) => string;
  },
>(tui: TUI, theme: T, done: (result: AskResult) => void, questions: Question[]) {
  const isMulti = questions.length > 1;
  const totalTabs = questions.length + 1; // questions + Submit

  // ── State ────────────────────────────────────────────────────────────
  let currentTab = 0;
  let optionIndex = 0;
  let inputMode = false;
  let inputQuestionId: string | null = null;
  let cachedLines: string[] | undefined;
  const answers = new Map<string, Answer>();

  // Memoised options per question (PERF-001)
  const optionsCache = new Map<string, RenderOption[]>();

  // ── Editor for custom input ──────────────────────────────────────────
  const editorTheme: EditorTheme = {
    borderColor: (s: string) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    },
  };
  const editor = new Editor(tui, editorTheme);

  // ── Helpers ──────────────────────────────────────────────────────────

  function refresh() {
    cachedLines = undefined;
    tui.requestRender();
  }

  function submit(cancelled: boolean) {
    done({ questions, answers: Array.from(answers.values()), cancelled });
  }

  function currentQuestion(): Question | undefined {
    return questions[currentTab];
  }

  function currentOptions(): RenderOption[] {
    const q = currentQuestion();
    if (!q) return [];
    let cached = optionsCache.get(q.id);
    if (!cached) {
      cached = buildOptions(q);
      optionsCache.set(q.id, cached);
    }
    return cached;
  }

  function allAnswered(): boolean {
    return questions.every((q) => answers.has(q.id));
  }

  function advanceAfterAnswer() {
    if (!isMulti) {
      submit(false);
      return;
    }
    if (currentTab < questions.length - 1) {
      currentTab++;
    } else {
      currentTab = questions.length; // Submit tab
    }
    optionIndex = 0;
    refresh();
  }

  function saveAnswer(
    questionId: string,
    value: string,
    label: string,
    wasCustom: boolean,
    index?: number
  ) {
    answers.set(questionId, { id: questionId, value, label, wasCustom, index });
  }

  function selectOptionAtIndex(idx: number) {
    const q = currentQuestion();
    const opts = currentOptions();
    if (!q || idx < 0 || idx >= opts.length) return;

    const opt = opts[idx];
    if (opt.isOther) {
      inputMode = true;
      inputQuestionId = q.id;
      editor.setText("");
      refresh();
      return;
    }
    saveAnswer(q.id, opt.value, opt.label, false, idx + 1);
    advanceAfterAnswer();
  }

  // ── Editor submit callback ───────────────────────────────────────────
  editor.onSubmit = (value: string) => {
    if (!inputQuestionId) return;
    const trimmed = value.trim() || "(no response)";
    saveAnswer(inputQuestionId, trimmed, trimmed, true);
    inputMode = false;
    inputQuestionId = null;
    editor.setText("");
    advanceAfterAnswer();
  };

  // ── Input handling (STR-003: split into focused handlers) ────────────

  function handleEditorInput(data: string): boolean {
    if (!inputMode) return false;
    if (matchesKey(data, Key.escape)) {
      inputMode = false;
      inputQuestionId = null;
      editor.setText("");
      refresh();
      return true;
    }
    editor.handleInput(data);
    refresh();
    return true;
  }

  function handleTabNavigation(data: string): boolean {
    if (!isMulti) return false;
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      currentTab = (currentTab + 1) % totalTabs;
      optionIndex = 0;
      refresh();
      return true;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      currentTab = (currentTab - 1 + totalTabs) % totalTabs;
      optionIndex = 0;
      refresh();
      return true;
    }
    return false;
  }

  function handleSubmitTab(data: string): boolean {
    if (currentTab !== questions.length) return false;
    if (matchesKey(data, Key.enter) && allAnswered()) {
      submit(false);
      return true;
    }
    if (matchesKey(data, Key.escape)) {
      submit(true);
      return true;
    }
    return true; // consume all input on submit tab
  }

  function handleOptionNavigation(data: string): boolean {
    const opts = currentOptions();
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
      optionIndex = Math.max(0, optionIndex - 1);
      refresh();
      return true;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
      optionIndex = Math.min(opts.length - 1, optionIndex + 1);
      refresh();
      return true;
    }
    return false;
  }

  function handleNumberKeys(data: string): boolean {
    if (data.length !== 1 || data < "1" || data > "9") return false;
    const opts = currentOptions();
    const idx = Number.parseInt(data, 10) - 1;
    if (idx < opts.length) {
      selectOptionAtIndex(idx);
      return true;
    }
    return false;
  }

  function handleEnterKey(data: string): boolean {
    if (!matchesKey(data, Key.enter)) return false;
    if (currentQuestion()) {
      selectOptionAtIndex(optionIndex);
      return true;
    }
    return false;
  }

  function handleEscapeKey(data: string): boolean {
    if (!matchesKey(data, Key.escape)) return false;
    submit(true);
    return true;
  }

  function handleInput(data: string) {
    if (handleEditorInput(data)) return;
    if (handleTabNavigation(data)) return;
    if (handleSubmitTab(data)) return;
    if (handleOptionNavigation(data)) return;
    if (handleNumberKeys(data)) return;
    if (handleEnterKey(data)) return;
    handleEscapeKey(data);
  }

  // ── Rendering (STR-002: split into focused renderers) ────────────────

  function addLine(lines: string[], s: string, width: number) {
    lines.push(truncateToWidth(s, width));
  }

  function addWrapped(lines: string[], text: string, indent: number, width: number) {
    const usable = width - indent;
    if (usable <= 10) {
      addLine(lines, " ".repeat(indent) + text, width);
      return;
    }
    const wrapped = wrapTextWithAnsi(text, usable);
    const prefix = " ".repeat(indent);
    for (const wl of wrapped) {
      lines.push(truncateToWidth(prefix + wl, width));
    }
  }

  function renderTabBar(lines: string[], width: number) {
    if (!isMulti) return;
    const tabs: string[] = ["← "];
    for (let i = 0; i < questions.length; i++) {
      const isActive = i === currentTab;
      const isAnswered = answers.has(questions[i].id);
      const lbl = questions[i].label;
      const box = isAnswered ? "■" : "□";
      const color = isAnswered ? "success" : "muted";
      const text = ` ${box} ${lbl} `;
      const styled = isActive
        ? theme.bg("selectedBg", theme.fg("text", text))
        : theme.fg(color as "success" | "muted", text);
      tabs.push(`${styled} `);
    }
    const canSubmit = allAnswered();
    const isSubmitTab = currentTab === questions.length;
    const submitText = " ✓ Submit ";
    const submitStyled = isSubmitTab
      ? theme.bg("selectedBg", theme.fg("text", submitText))
      : theme.fg(canSubmit ? "success" : "dim", submitText);
    tabs.push(`${submitStyled} →`);
    addLine(lines, ` ${tabs.join("")}`, width);
    lines.push("");
  }

  function renderOptionsList(lines: string[], opts: RenderOption[], width: number) {
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i];
      const selected = i === optionIndex;
      const isOther = opt.isOther === true;
      const prefix = selected ? theme.fg("accent", "> ") : "  ";
      const color = selected ? "accent" : "text";
      const num = `${i + 1}`;

      if (isOther && inputMode) {
        addLine(lines, prefix + theme.fg("accent", `${num}. ${opt.label} ✎`), width);
      } else {
        addLine(
          lines,
          prefix + theme.fg(color as "accent" | "text", `${num}. ${opt.label}`),
          width
        );
      }
      if (opt.description) {
        addWrapped(lines, theme.fg("muted", opt.description), 5, width);
      }
    }
  }

  function renderInputMode(lines: string[], q: Question, opts: RenderOption[], width: number) {
    addWrapped(lines, theme.fg("text", q.prompt), 1, width);
    lines.push("");
    renderOptionsList(lines, opts, width);
    lines.push("");
    addLine(lines, theme.fg("muted", " Your answer:"), width);
    for (const line of editor.render(width - 2)) {
      addLine(lines, ` ${line}`, width);
    }
    lines.push("");
    addLine(lines, theme.fg("dim", " Enter to submit • Esc to cancel"), width);
  }

  function renderSubmitTab(lines: string[], width: number) {
    addLine(lines, theme.fg("accent", theme.bold(" Ready to submit")), width);
    lines.push("");
    for (const question of questions) {
      const answer = answers.get(question.id);
      if (answer) {
        const prefix = answer.wasCustom ? "(wrote) " : "";
        addLine(
          lines,
          `${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`,
          width
        );
      }
    }
    lines.push("");
    if (allAnswered()) {
      addLine(lines, theme.fg("success", " Press Enter to submit"), width);
    } else {
      const missing = questions
        .filter((question) => !answers.has(question.id))
        .map((question) => question.label)
        .join(", ");
      addLine(lines, theme.fg("warning", ` Unanswered: ${missing}`), width);
    }
  }

  function renderQuestionView(lines: string[], q: Question, opts: RenderOption[], width: number) {
    addWrapped(lines, theme.fg("text", q.prompt), 1, width);
    lines.push("");
    renderOptionsList(lines, opts, width);
  }

  function render(width: number): string[] {
    if (cachedLines) return cachedLines;

    const lines: string[] = [];
    const q = currentQuestion();
    const opts = currentOptions();

    addLine(lines, theme.fg("accent", "─".repeat(width)), width);
    renderTabBar(lines, width);

    if (inputMode && q) {
      renderInputMode(lines, q, opts, width);
    } else if (currentTab === questions.length) {
      renderSubmitTab(lines, width);
    } else if (q) {
      renderQuestionView(lines, q, opts, width);
    }

    lines.push("");
    if (!inputMode) {
      const help = isMulti
        ? " Tab/←→ navigate • ↑↓/C-p/C-n select • 1-9 quick pick • Enter confirm • Esc cancel"
        : " ↑↓/C-p/C-n navigate • 1-9 quick pick • Enter select • Esc cancel";
      addLine(lines, theme.fg("dim", help), width);
    }
    addLine(lines, theme.fg("accent", "─".repeat(width)), width);

    cachedLines = lines;
    return lines;
  }

  // ── Public interface ─────────────────────────────────────────────────
  return {
    render,
    invalidate: () => {
      cachedLines = undefined;
    },
    handleInput,
  };
}
