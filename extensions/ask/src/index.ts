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
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { createAskUI } from "./ask-ui.js";
import { errorResult, formatAnswerLines, normalizeQuestions } from "./helpers.js";
import type { AskResult, Question } from "./types.js";

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

// ─── System Prompt ──────────────────────────────────────────────────────────

const ASK_SYSTEM_PROMPT = `
## Ask Tool — Mandatory Usage Rules

You have access to the \`ask\` tool for interactive user questions.

**MANDATORY — follow these rules without exception:**

1. **ALWAYS use the \`ask\` tool** for every decision point, ambiguity, unclear requirement, or confirmation. Never assume — ask.
2. **ONE question at a time.** Always send exactly 1 question per \`ask\` call. The user's answer to question N informs what question N+1 should be. This prevents stale or conflicting questions.
3. **Provide concrete options.** Every question must have relevant, actionable options. Don't give vague choices.
4. **"Type something" is always available.** The user can always type a custom answer — you don't need to add it as an option.
5. **ALWAYS ask next actions on completion.** When all tasks, findings, or items in a request are completed, ALWAYS use \`ask\` to ask the user what to do next. Never assume the next step.
`.trim();

// ─── Extension ──────────────────────────────────────────────────────────────

const askExtension: ExtensionFactory = (pi: ExtensionAPI) => {
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

      const questions = normalizeQuestions(params.questions);

      const result = await ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
        return createAskUI(tui, theme, done, questions);
      });

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire" }],
          details: result,
        };
      }

      return {
        content: [{ type: "text", text: formatAnswerLines(result.answers, questions).join("\n") }],
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
