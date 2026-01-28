/**
 * Ask UI — Premium floating card component for the Ask extension.
 *
 * Renders inside DimmedOverlay as a visually rich card with:
 *   - Rounded box border with top→bottom gradient (muted→dim)
 *   - Card background (distinct dark surface)
 *   - Accent-tinted banner header with ？ icon
 *   - Boxed number badges [1]…[9] for options, [0] for "Type something"
 *   - Bold accent selection indicator (focused option)
 *   - │-prefixed description blocks
 *   - Pill-shaped tab bar (multi-question) with inverted active tab
 *   - Clean summary table on Submit tab
 *   - [keycap] help badges in footer
 *   - Dotted (┄) separators between sections
 *   - Scrollable body viewport with ▲/▼ indicators
 */

import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import type { TUI } from "@mariozechner/pi-tui";
import { buildOptions } from "./helpers.js";
import type { Answer, AskResult, Question, RenderOption } from "./types.js";

// ── Visual constants ────────────────────────────────────────────────────────

/** Card body background: distinct dark surface, lifted from scrim. */
const CARD_BG = "\x1b[48;2;22;22;32m";
/** Banner header background: accent-tinted dark. */
const BANNER_BG = "\x1b[48;2;28;24;45m";
/** ANSI full reset. */
const RESET = "\x1b[0m";
/** ANSI reverse video (swap fg/bg). */
const REVERSE = "\x1b[7m";
/** ANSI reverse video off. */
const REVERSE_OFF = "\x1b[27m";
/** Horizontal content padding (columns) inside card borders. */
const PAD = 2;

// ── ANSI helpers ────────────────────────────────────────────────────────────

/**
 * Apply a background ANSI code to text, persisting through any \x1b[0m resets
 * contained in the text. Ensures the bg is re-applied after each full reset.
 */
function applyBg(text: string, bgCode: string): string {
  return bgCode + text.replaceAll("\x1b[0m", `\x1b[0m${bgCode}`) + RESET;
}

/**
 * Pad text with trailing spaces to reach exact visible width.
 * Truncates (with ellipsis) if text exceeds targetWidth.
 */
function padRight(text: string, targetWidth: number): string {
  const vis = visibleWidth(text);
  if (vis > targetWidth) return truncateToWidth(text, targetWidth);
  if (vis === targetWidth) return text;
  return text + " ".repeat(targetWidth - vis);
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the Ask TUI component with premium card design.
 *
 * This is the factory passed through DimmedOverlay.show() to ctx.ui.custom().
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
>(
  tui: TUI,
  theme: T,
  done: (result: AskResult) => void,
  questions: Question[],
  contextText?: string
) {
  const isMulti = questions.length > 1;
  const totalTabs = questions.length + 1; // questions + Submit
  const hasContext = !!contextText;

  // ── State ────────────────────────────────────────────────────────────
  let viewMode: "question" | "context" = "question";
  let currentTab = 0;
  let optionIndex = 0;
  let inputMode = false;
  let inputQuestionId: string | null = null;
  let cachedLines: string[] | undefined;
  const answers = new Map<string, Answer>();

  // Scroll state
  let scrollOffset = 0;
  let fixedBodyHeight: number | null = null;
  let manualScroll = false;

  // Memoised options per question
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

  // ── Core helpers ─────────────────────────────────────────────────────

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

  // ── Input handling ───────────────────────────────────────────────────

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

  function handleScrollKeys(data: string): boolean {
    if (data === "j") {
      scrollOffset++;
      manualScroll = true;
      refresh();
      return true;
    }
    if (data === "k") {
      scrollOffset = Math.max(0, scrollOffset - 1);
      manualScroll = true;
      refresh();
      return true;
    }
    return false;
  }

  function handleContextFlip(data: string): boolean {
    if (!hasContext) return false;
    if (matchesKey(data, Key.tab)) {
      if (viewMode === "question") {
        viewMode = "context";
      } else {
        viewMode = "question";
      }
      scrollOffset = 0;
      manualScroll = false;
      refresh();
      return true;
    }
    return false;
  }

  function handleTabNavigation(data: string): boolean {
    if (!isMulti) return false;
    // Use arrow keys only for multi-question tab navigation (Tab is for context flip)
    if (matchesKey(data, Key.right)) {
      currentTab = (currentTab + 1) % totalTabs;
      optionIndex = 0;
      scrollOffset = 0;
      manualScroll = false;
      refresh();
      return true;
    }
    if (matchesKey(data, Key.left)) {
      currentTab = (currentTab - 1 + totalTabs) % totalTabs;
      optionIndex = 0;
      scrollOffset = 0;
      manualScroll = false;
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
      manualScroll = false;
      refresh();
      return true;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
      optionIndex = Math.min(opts.length - 1, optionIndex + 1);
      manualScroll = false;
      refresh();
      return true;
    }
    return false;
  }

  function handleNumberKeys(data: string): boolean {
    const opts = currentOptions();
    // [0] → "Type something" (always the last option)
    if (data === "0") {
      const lastIdx = opts.length - 1;
      if (lastIdx >= 0 && opts[lastIdx].isOther) {
        selectOptionAtIndex(lastIdx);
        return true;
      }
      return false;
    }
    // [1-9] → regular options (excluding "Type something")
    if (data.length !== 1 || data < "1" || data > "9") return false;
    const idx = Number.parseInt(data, 10) - 1;
    if (idx < opts.length - 1) {
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
    // Context flip (Tab) has highest priority
    if (handleContextFlip(data)) return;

    // In context view, only allow scroll and escape
    if (viewMode === "context") {
      if (handleScrollKeys(data)) return;
      handleEscapeKey(data);
      return;
    }

    // Question view: normal input handling
    if (handleEditorInput(data)) return;
    if (handleScrollKeys(data)) return;
    if (handleTabNavigation(data)) return;
    if (handleSubmitTab(data)) return;
    if (handleOptionNavigation(data)) return;
    if (handleNumberKeys(data)) return;
    if (handleEnterKey(data)) return;
    handleEscapeKey(data);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ── CARD RENDERING
  // ═══════════════════════════════════════════════════════════════════════

  // ── Border gradient ──────────────────────────────────────────────────

  /**
   * 2-step border gradient: muted (top half) → dim (bottom half).
   * Returns a semantic color name for theme.fg().
   */
  function borderColorName(rowIdx: number, totalRows: number): string {
    if (totalRows <= 1) return "muted";
    const ratio = rowIdx / (totalRows - 1);
    if (ratio <= 0.5) return "muted";
    return "dim";
  }

  // ── Card structural lines ────────────────────────────────────────────

  /** Bordered content line: │ content │ with card bg. */
  function cardLine(content: string, innerW: number, bcName: string): string {
    const padded = padRight(content, innerW);
    return applyBg(`${theme.fg(bcName, "│")}${padded}${theme.fg(bcName, "│")}`, CARD_BG);
  }

  /** Top border: ╭───╮ in muted color with card bg. */
  function topBorderLine(width: number): string {
    return applyBg(theme.fg("muted", `╭${"─".repeat(width - 2)}╮`), CARD_BG);
  }

  /** Bottom border: ╰───╯ in dim color with card bg. */
  function bottomBorderLine(width: number): string {
    return applyBg(theme.fg("dim", `╰${"─".repeat(width - 2)}╯`), CARD_BG);
  }

  /** Dotted separator: ├┄┄┄┤ with optional right-aligned scroll hint. */
  function separatorLine(width: number, bcName: string, scrollHint?: string): string {
    const inner = width - 2;
    if (scrollHint) {
      const hintVis = visibleWidth(scrollHint);
      const sepChars = inner - hintVis - 1; // 1 space before hint
      if (sepChars >= 3) {
        return applyBg(
          `${theme.fg(bcName, "├")}${theme.fg("dim", "┄".repeat(sepChars))} ${theme.fg("dim", scrollHint)}${theme.fg(bcName, "┤")}`,
          CARD_BG
        );
      }
    }
    return applyBg(
      `${theme.fg(bcName, "├")}${theme.fg("dim", "┄".repeat(inner))}${theme.fg(bcName, "┤")}`,
      CARD_BG
    );
  }

  /** Banner line: │ icon Label │ with accent-tinted bg. */
  function bannerCardLine(label: string, icon: string, innerW: number, bcName: string): string {
    const text = ` ${icon} ${theme.bold(label)}`;
    const padded = padRight(text, innerW);
    const leftBorder = applyBg(theme.fg(bcName, "│"), CARD_BG);
    const rightBorder = applyBg(theme.fg(bcName, "│"), CARD_BG);
    const content = applyBg(padded, BANNER_BG);
    return `${leftBorder}${content}${rightBorder}`;
  }

  // ── Section renderers ────────────────────────────────────────────────
  // Each returns raw content strings (no borders/bg — cardLine wraps).

  /** Pill-shaped tab bar for multi-question navigation. */
  function renderTabBar(_innerW: number): string[] {
    if (!isMulti) return [];

    const pills: string[] = [];

    for (let i = 0; i < questions.length; i++) {
      const isActive = i === currentTab;
      const isAnswered = answers.has(questions[i].id);
      const lbl = questions[i].label;

      if (isActive) {
        pills.push(theme.fg("accent", `${REVERSE} ${lbl} ${REVERSE_OFF}`));
      } else if (isAnswered) {
        pills.push(theme.fg("success", `✓ ${lbl}`));
      } else {
        pills.push(theme.fg("muted", `  ${lbl}`));
      }
    }

    // Submit pill
    const isSubmitActive = currentTab === questions.length;
    const canSubmit = allAnswered();

    if (isSubmitActive) {
      pills.push(theme.fg("accent", `${REVERSE} Submit ${REVERSE_OFF}`));
    } else if (canSubmit) {
      pills.push(theme.fg("success", "✓ Submit"));
    } else {
      pills.push(theme.fg("dim", "  Submit"));
    }

    return [" ".repeat(PAD) + pills.join("  ")];
  }

  /** Word-wrapped question prompt. */
  function renderPrompt(q: Question, innerW: number): string[] {
    const usable = innerW - PAD * 2;
    if (usable <= 10) {
      return [" ".repeat(PAD) + theme.fg("text", q.prompt)];
    }
    const wrapped = wrapTextWithAnsi(q.prompt, usable);
    return wrapped.map((line) => " ".repeat(PAD) + theme.fg("text", line));
  }

  /**
   * Options list with [N] badges, descriptions, and [0] Type something.
   * Returns the lines and the index of the focused option line.
   */
  function renderOptionsList(
    opts: RenderOption[],
    innerW: number
  ): { lines: string[]; focusIdx: number } {
    const lines: string[] = [];
    let focusIdx = 0;
    const regularOpts = opts.filter((o) => !o.isOther);
    const otherOpt = opts.find((o) => o.isOther);
    const isDimmed = inputMode;

    // ── Regular options ──────────────────────────────────────────────
    for (let i = 0; i < regularOpts.length; i++) {
      const opt = regularOpts[i];
      const isSelected = i === optionIndex && !isDimmed;
      const num = `${i + 1}`;

      if (isSelected) focusIdx = lines.length;

      let badge: string;
      let label: string;

      if (isSelected) {
        badge = theme.fg("accent", theme.bold(`[${num}]`));
        label = theme.fg("accent", theme.bold(opt.label));
      } else if (isDimmed) {
        badge = theme.fg("dim", `[${num}]`);
        label = theme.fg("dim", opt.label);
      } else {
        badge = theme.fg("muted", `[${num}]`);
        label = theme.fg("text", opt.label);
      }

      lines.push(`${" ".repeat(PAD)}${badge}  ${label}`);

      // Description block: │ description text
      if (opt.description) {
        const descIndent = PAD + 6;
        const descAvail = innerW - descIndent - 1;
        if (descAvail > 10) {
          const bar = theme.fg("dim", "│");
          const wrapped = wrapTextWithAnsi(opt.description, descAvail);
          for (const wl of wrapped) {
            const descText = isDimmed ? theme.fg("dim", wl) : theme.fg("muted", wl);
            lines.push(`${" ".repeat(descIndent)}${bar} ${descText}`);
          }
        }
      }
    }

    // ── Dotted separator + "Type something" ──────────────────────────
    if (otherOpt) {
      const sepW = innerW - PAD * 2;
      lines.push(" ".repeat(PAD) + theme.fg("dim", "┄".repeat(Math.max(1, sepW))));

      const otherIdx = opts.length - 1;
      const isSelected = optionIndex === otherIdx && !isDimmed;

      if (isSelected || inputMode) focusIdx = lines.length;

      let badge: string;
      let label: string;

      if (inputMode) {
        badge = theme.fg("accent", theme.bold("[0]"));
        label = theme.fg("accent", theme.bold("✎ Type something…"));
      } else if (isSelected) {
        badge = theme.fg("accent", theme.bold("[0]"));
        label = theme.fg("accent", theme.bold("✎ Type something…"));
      } else {
        badge = theme.fg("dim", "[0]");
        label = theme.fg("dim", "✎ Type something…");
      }

      lines.push(`${" ".repeat(PAD)}${badge}  ${label}`);
    }

    return { lines, focusIdx };
  }

  /** Editor section (visible only in input mode). */
  function renderEditorSection(innerW: number): string[] {
    if (!inputMode) return [];

    const lines: string[] = [];
    lines.push("");
    lines.push(" ".repeat(PAD) + theme.fg("muted", "Your answer:"));

    const editorW = Math.max(10, innerW - PAD * 2);
    for (const line of editor.render(editorW)) {
      lines.push(" ".repeat(PAD) + line);
    }

    lines.push(" ".repeat(PAD) + theme.fg("dim", "Enter to submit · Esc to cancel"));

    return lines;
  }

  /** Submit tab: clean summary table with aligned label│value pairs. */
  function renderSubmitView(_innerW: number): string[] {
    const lines: string[] = [];

    const maxLabelW = Math.max(...questions.map((q) => visibleWidth(q.label)));

    for (const question of questions) {
      const answer = answers.get(question.id);
      const labelPadded = padRight(question.label, maxLabelW);

      if (answer) {
        const prefix = answer.wasCustom ? "(wrote) " : "";
        lines.push(
          `${" ".repeat(PAD)}${theme.fg("success", "✓ ")}` +
            `${theme.fg("muted", labelPadded)} ` +
            `${theme.fg("dim", "│")} ` +
            `${theme.fg("text", prefix + answer.label)}`
        );
      } else {
        lines.push(
          `${" ".repeat(PAD)}${theme.fg("dim", "○ ")}` +
            `${theme.fg("dim", labelPadded)} ` +
            `${theme.fg("dim", "│ —")}`
        );
      }
    }

    lines.push("");

    if (allAnswered()) {
      lines.push(" ".repeat(PAD) + theme.fg("success", theme.bold("Ready to submit")));
    } else {
      const missing = questions
        .filter((q) => !answers.has(q.id))
        .map((q) => q.label)
        .join(", ");
      lines.push(" ".repeat(PAD) + theme.fg("warning", `Unanswered: ${missing}`));
    }

    return lines;
  }

  /** Keycap-style help badges for the footer. */
  function renderHelp(_innerW: number): string[] {
    const cap = (k: string) => theme.fg("muted", `[${k}]`);
    const lbl = (t: string) => theme.fg("dim", t);

    let help: string;

    if (viewMode === "context") {
      // Context view: scroll + tab back + escape
      help = [
        `${cap("j/k")} ${lbl("scroll")}`,
        `${cap("Tab")} ${lbl("back to question")}`,
        `${cap("Esc")} ${lbl("cancel")}`,
      ].join("  ");
    } else if (inputMode) {
      help = `${cap("⏎")} ${lbl("submit")}  ${cap("Esc")} ${lbl("cancel")}`;
    } else if (currentTab === questions.length) {
      const parts = [
        `${cap("⏎")} ${lbl("submit")}`,
        `${cap("j/k")} ${lbl("scroll")}`,
        `${cap("←/→")} ${lbl("switch")}`,
        `${cap("Esc")} ${lbl("cancel")}`,
      ];
      if (hasContext) parts.splice(3, 0, `${cap("Tab")} ${lbl("context")}`);
      help = parts.join("  ");
    } else if (isMulti) {
      const parts = [
        `${cap("C-n/p")} ${lbl("navigate")}`,
        `${cap("j/k")} ${lbl("scroll")}`,
        `${cap("0-9")} ${lbl("pick")}`,
        `${cap("⏎")} ${lbl("select")}`,
        `${cap("←/→")} ${lbl("switch")}`,
      ];
      if (hasContext) parts.push(`${cap("Tab")} ${lbl("context")}`);
      help = parts.join("  ");
    } else {
      const parts = [
        `${cap("C-n/p")} ${lbl("navigate")}`,
        `${cap("j/k")} ${lbl("scroll")}`,
        `${cap("0-9")} ${lbl("pick")}`,
        `${cap("⏎")} ${lbl("select")}`,
        `${cap("Esc")} ${lbl("cancel")}`,
      ];
      if (hasContext) parts.splice(4, 0, `${cap("Tab")} ${lbl("context")}`);
      help = parts.join("  ");
    }

    return [" ".repeat(PAD) + help];
  }

  /** Render context view: full scrollable assistant message */
  function renderContextView(innerW: number): { lines: string[]; focusLine: number } {
    const lines: string[] = [];

    if (!contextText) {
      lines.push(" ".repeat(PAD) + theme.fg("dim", "(No context available)"));
      return { lines, focusLine: 0 };
    }

    // Word-wrap context text
    const usable = innerW - PAD * 2;
    if (usable <= 10) {
      lines.push(" ".repeat(PAD) + theme.fg("text", contextText));
      return { lines, focusLine: 0 };
    }

    const wrapped = wrapTextWithAnsi(contextText, usable);
    for (const line of wrapped) {
      lines.push(" ".repeat(PAD) + theme.fg("text", line));
    }

    return { lines, focusLine: 0 };
  }

  // ── Main render ──────────────────────────────────────────────────────

  function render(width: number): string[] {
    if (cachedLines) return cachedLines;

    const innerW = width - 2; // space between │ borders
    const q = currentQuestion();
    const opts = currentOptions();

    // ── Build body content + track focused line ──────────────────────
    const body: string[] = [];
    let focusLine = 0;

    // Context view: render assistant message
    if (viewMode === "context") {
      body.push(""); // spacer
      const { lines: contextLines, focusLine: ctxFocus } = renderContextView(innerW);
      body.push(...contextLines);
      focusLine = ctxFocus;
      body.push(""); // spacer before footer
    } else {
      // Question view: normal rendering
      // Tab bar (multi-question only)
      if (isMulti) {
        body.push(""); // spacer
        body.push(...renderTabBar(innerW));
      }

      body.push(""); // spacer after banner / tabs

      // Main content area
      if (inputMode && q) {
        body.push(...renderPrompt(q, innerW));
        body.push("");
        const { lines: optLines } = renderOptionsList(opts, innerW);
        body.push(...optLines);
        // Focus on editor area (bottom of content)
        body.push(...renderEditorSection(innerW));
        focusLine = body.length - 2;
      } else if (currentTab === questions.length) {
        body.push(...renderSubmitView(innerW));
        focusLine = body.length - 1;
      } else if (q) {
        body.push(...renderPrompt(q, innerW));
        body.push("");
        const optStart = body.length;
        const { lines: optLines, focusIdx } = renderOptionsList(opts, innerW);
        body.push(...optLines);
        focusLine = optStart + focusIdx;
      }

      body.push(""); // spacer before footer
    }

    // ── Compute fixed body viewport height (once) ────────────────────
    if (fixedBodyHeight === null) {
      const chromeRows = 6 + (isMulti ? 2 : 0);
      const maxBody = Math.max(10, Math.floor(tui.terminal.rows * 0.72) - chromeRows);
      // For multi-question: use full max (tabs may have different content)
      // For single: fit to content (capped)
      fixedBodyHeight = isMulti ? maxBody : Math.min(body.length, maxBody);
    }

    // ── Scroll viewport ──────────────────────────────────────────────
    const vh = fixedBodyHeight;
    let canScrollUp = false;
    let canScrollDown = false;

    if (body.length > vh) {
      if (!manualScroll) {
        // Auto-follow: keep focused line visible with 2 lines of context
        if (focusLine < scrollOffset + 2) {
          scrollOffset = Math.max(0, focusLine - 2);
        } else if (focusLine >= scrollOffset + vh - 2) {
          scrollOffset = focusLine - vh + 3;
        }
      }
      scrollOffset = Math.max(0, Math.min(scrollOffset, body.length - vh));
      canScrollUp = scrollOffset > 0;
      canScrollDown = scrollOffset + vh < body.length;
    } else {
      scrollOffset = 0;
    }

    // Slice to viewport and pad to fixed height
    const visibleBody = body.slice(scrollOffset, scrollOffset + vh);
    while (visibleBody.length < vh) {
      visibleBody.push("");
    }

    // ── Footer help ──────────────────────────────────────────────────
    const helpLines = renderHelp(innerW);

    // ── Compute total card height for border gradient ────────────────
    // top + banner + sep + viewport + sep + help + bottom
    const totalRows = 1 + 1 + 1 + vh + 1 + helpLines.length + 1;

    // ── Assemble card ────────────────────────────────────────────────
    const lines: string[] = [];
    let row = 0;

    // Top border ╭───╮
    lines.push(topBorderLine(width));
    row++;

    // Banner │ icon Label │
    let bannerLabel: string;
    let bannerIcon: string;
    if (viewMode === "context") {
      bannerLabel = "Context";
      bannerIcon = "📜";
    } else if (q != null) {
      bannerLabel = q.label;
      bannerIcon = "？";
    } else if (currentTab === questions.length) {
      bannerLabel = "Submit";
      bannerIcon = "✓";
    } else {
      bannerLabel = "Question";
      bannerIcon = "？";
    }
    lines.push(bannerCardLine(bannerLabel, bannerIcon, innerW, borderColorName(row, totalRows)));
    row++;

    // Separator ├┄┄┄┤ (with ▲ scroll hint if content above)
    const topHint = canScrollUp ? "▲ more" : undefined;
    lines.push(separatorLine(width, borderColorName(row, totalRows), topHint));
    row++;

    // Body viewport
    for (const content of visibleBody) {
      lines.push(cardLine(content, innerW, borderColorName(row, totalRows)));
      row++;
    }

    // Separator ├┄┄┄┤ (with ▼ scroll hint if content below)
    const bottomHint = canScrollDown ? "▼ more" : undefined;
    lines.push(separatorLine(width, borderColorName(row, totalRows), bottomHint));
    row++;

    // Help footer
    for (const helpStr of helpLines) {
      lines.push(cardLine(helpStr, innerW, borderColorName(row, totalRows)));
      row++;
    }

    // Bottom border ╰───╯
    lines.push(bottomBorderLine(width));

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
