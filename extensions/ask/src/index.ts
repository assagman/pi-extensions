/**
 * Ask — Better questionnaire tool for Pi
 *
 * Improvements over the built-in questionnaire:
 *   1. Number keys (1–9) for direct option selection
 *   2. Ctrl-N / Ctrl-P for down/up navigation (emacs-style)
 *   3. Long question text properly word-wrapped via wrapTextWithAnsi
 *   4. "Type something" option is ALWAYS present — not agent-controlled
 *
 * Single question  → simple options list, auto-submits on selection
 * Multiple questions → tab bar navigation between questions + Submit tab
 */

import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Types ──────────────────────────────────────────────────────────────────

interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

/** Render-time option (may include the auto-injected "Type something" entry) */
type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
}

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

interface AskResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

// ─── Schema ─────────────────────────────────────────────────────────────────

const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below label" })
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({
      description:
        "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
    })
  ),
  prompt: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
  // NOTE: allowOther is intentionally omitted from schema.
  // "Type something" is ALWAYS shown — agents must not control this.
});

const AskParams = Type.Object({
  questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function errorResult(
  message: string,
  questions: Question[] = []
): { content: { type: "text"; text: string }[]; details: AskResult } {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

// ─── Extension ──────────────────────────────────────────────────────────────

const ASK_SYSTEM_PROMPT = `
## Ask Tool — Mandatory Usage Rules

You have access to the \`ask\` tool for interactive user questions.

**MANDATORY — follow these rules without exception:**

1. **ALWAYS use the \`ask\` tool** for every decision point, ambiguity, unclear requirement, or confirmation. Never assume — ask.
2. **ONE question at a time.** Always send exactly 1 question per \`ask\` call. The user's answer to question N informs what question N+1 should be. This prevents stale or conflicting questions.
3. **Provide concrete options.** Every question must have relevant, actionable options. Don't give vague choices.
4. **"Type something" is always available.** The user can always type a custom answer — you don't need to add it as an option.
`.trim();

const askExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  // Inject system prompt instructions on every agent turn
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${ASK_SYSTEM_PROMPT}`,
    };
  });

  pi.registerTool({
    name: "ask",
    label: "Ask",
    description:
      "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
    parameters: AskParams,

    async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
      if (!ctx.hasUI) {
        return errorResult("Error: UI not available (running in non-interactive mode)");
      }
      if (params.questions.length === 0) {
        return errorResult("Error: No questions provided");
      }

      // Normalise questions — always enable "Type something"
      const questions: Question[] = params.questions.map((q, i) => ({
        ...q,
        label: q.label || `Q${i + 1}`,
      }));

      const isMulti = questions.length > 1;
      const totalTabs = questions.length + 1; // questions + Submit

      const result = await ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
        // ── State ────────────────────────────────────────────────
        let currentTab = 0;
        let optionIndex = 0;
        let inputMode = false;
        let inputQuestionId: string | null = null;
        let cachedLines: string[] | undefined;
        const answers = new Map<string, Answer>();

        // ── Editor for custom input ──────────────────────────────
        const editorTheme: EditorTheme = {
          borderColor: (s) => theme.fg("accent", s),
          selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          },
        };
        const editor = new Editor(tui, editorTheme);

        // ── Helpers ──────────────────────────────────────────────

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
          const opts: RenderOption[] = [...q.options];
          // ALWAYS add "Type something" — never agent-controlled
          opts.push({ value: "__other__", label: "Type something.", isOther: true });
          return opts;
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

        // ── Editor submit callback ───────────────────────────────
        editor.onSubmit = (value) => {
          if (!inputQuestionId) return;
          const trimmed = value.trim() || "(no response)";
          saveAnswer(inputQuestionId, trimmed, trimmed, true);
          inputMode = false;
          inputQuestionId = null;
          editor.setText("");
          advanceAfterAnswer();
        };

        // ── Input handling ───────────────────────────────────────

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

        function handleInput(data: string) {
          // ── Input mode: route to editor ──────────────────────
          if (inputMode) {
            if (matchesKey(data, Key.escape)) {
              inputMode = false;
              inputQuestionId = null;
              editor.setText("");
              refresh();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          const q = currentQuestion();
          const opts = currentOptions();

          // ── Tab navigation (multi-question) ──────────────────
          if (isMulti) {
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
              currentTab = (currentTab + 1) % totalTabs;
              optionIndex = 0;
              refresh();
              return;
            }
            if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
              currentTab = (currentTab - 1 + totalTabs) % totalTabs;
              optionIndex = 0;
              refresh();
              return;
            }
          }

          // ── Submit tab ───────────────────────────────────────
          if (currentTab === questions.length) {
            if (matchesKey(data, Key.enter) && allAnswered()) {
              submit(false);
            } else if (matchesKey(data, Key.escape)) {
              submit(true);
            }
            return;
          }

          // ── Option navigation: ↑/↓ and C-p/C-n ─────────────
          if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
            optionIndex = Math.max(0, optionIndex - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
            optionIndex = Math.min(opts.length - 1, optionIndex + 1);
            refresh();
            return;
          }

          // ── Number key shortcuts (1–9) ───────────────────────
          if (data.length === 1 && data >= "1" && data <= "9") {
            const idx = Number.parseInt(data, 10) - 1;
            if (idx < opts.length) {
              selectOptionAtIndex(idx);
              return;
            }
          }

          // ── Enter to select highlighted ──────────────────────
          if (matchesKey(data, Key.enter) && q) {
            selectOptionAtIndex(optionIndex);
            return;
          }

          // ── Cancel ───────────────────────────────────────────
          if (matchesKey(data, Key.escape)) {
            submit(true);
          }
        }

        // ── Rendering ────────────────────────────────────────────

        function render(width: number): string[] {
          if (cachedLines) return cachedLines;

          const lines: string[] = [];
          const q = currentQuestion();
          const opts = currentOptions();

          const add = (s: string) => lines.push(truncateToWidth(s, width));
          const addWrapped = (text: string, indent: number) => {
            const usable = width - indent;
            if (usable <= 10) {
              // Degenerate width – just truncate
              add(" ".repeat(indent) + text);
              return;
            }
            const wrapped = wrapTextWithAnsi(text, usable);
            const prefix = " ".repeat(indent);
            for (const wl of wrapped) {
              lines.push(truncateToWidth(prefix + wl, width));
            }
          };

          add(theme.fg("accent", "─".repeat(width)));

          // ── Tab bar (multi-question) ─────────────────────────
          if (isMulti) {
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
            add(` ${tabs.join("")}`);
            lines.push("");
          }

          // ── Render options list ──────────────────────────────
          function renderOptions() {
            for (let i = 0; i < opts.length; i++) {
              const opt = opts[i];
              const selected = i === optionIndex;
              const isOther = opt.isOther === true;
              const prefix = selected ? theme.fg("accent", "> ") : "  ";
              const color = selected ? "accent" : "text";
              const num = `${i + 1}`;

              if (isOther && inputMode) {
                add(prefix + theme.fg("accent", `${num}. ${opt.label} ✎`));
              } else {
                add(prefix + theme.fg(color as "accent" | "text", `${num}. ${opt.label}`));
              }
              if (opt.description) {
                addWrapped(theme.fg("muted", opt.description), 5);
              }
            }
          }

          // ── Content area ─────────────────────────────────────
          if (inputMode && q) {
            addWrapped(theme.fg("text", q.prompt), 1);
            lines.push("");
            renderOptions();
            lines.push("");
            add(theme.fg("muted", " Your answer:"));
            for (const line of editor.render(width - 2)) {
              add(` ${line}`);
            }
            lines.push("");
            add(theme.fg("dim", " Enter to submit • Esc to cancel"));
          } else if (currentTab === questions.length) {
            add(theme.fg("accent", theme.bold(" Ready to submit")));
            lines.push("");
            for (const question of questions) {
              const answer = answers.get(question.id);
              if (answer) {
                const prefix = answer.wasCustom ? "(wrote) " : "";
                add(
                  `${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`
                );
              }
            }
            lines.push("");
            if (allAnswered()) {
              add(theme.fg("success", " Press Enter to submit"));
            } else {
              const missing = questions
                .filter((question) => !answers.has(question.id))
                .map((question) => question.label)
                .join(", ");
              add(theme.fg("warning", ` Unanswered: ${missing}`));
            }
          } else if (q) {
            addWrapped(theme.fg("text", q.prompt), 1);
            lines.push("");
            renderOptions();
          }

          lines.push("");
          if (!inputMode) {
            const help = isMulti
              ? " Tab/←→ navigate • ↑↓/C-p/C-n select • 1-9 quick pick • Enter confirm • Esc cancel"
              : " ↑↓/C-p/C-n navigate • 1-9 quick pick • Enter select • Esc cancel";
            add(theme.fg("dim", help));
          }
          add(theme.fg("accent", "─".repeat(width)));

          cachedLines = lines;
          return lines;
        }

        return {
          render,
          invalidate: () => {
            cachedLines = undefined;
          },
          handleInput,
        };
      });

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire" }],
          details: result,
        };
      }

      const answerLines = result.answers.map((a) => {
        const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
        if (a.wasCustom) {
          return `${qLabel}: user wrote: ${a.label}`;
        }
        return `${qLabel}: user selected: ${a.index}. ${a.label}`;
      });

      return {
        content: [{ type: "text", text: answerLines.join("\n") }],
        details: result,
      };
    },

    renderCall(args, theme) {
      const qs = (args.questions as Question[]) || [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme.fg("toolTitle", theme.bold("ask "));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (labels) {
        text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as AskResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      const resultLines = details.answers.map((a) => {
        if (a.wasCustom) {
          return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
        }
        const display = a.index != null ? `${a.index}. ${a.label}` : a.label;
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
      });
      return new Text(resultLines.join("\n"), 0, 0);
    },
  });
};

export default askExtension;
