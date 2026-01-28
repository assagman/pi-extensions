/**
 * Mu bash syntax highlighting — custom tokenizer for bash commands.
 * Colors commands, keywords, builtins, strings, variables, flags, pipes,
 * redirections, and arguments.
 */
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import { getTheme } from "../theme.js";

const BASH_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "in",
  "function",
  "select",
  "time",
  "coproc",
]);

const BASH_FLOW_RESUME = new Set(["do", "then", "else", "elif"]);

const BASH_BUILTINS = new Set([
  "cd",
  "echo",
  "printf",
  "read",
  "export",
  "source",
  "alias",
  "unalias",
  "set",
  "unset",
  "shift",
  "return",
  "exit",
  "exec",
  "eval",
  "trap",
  "wait",
  "kill",
  "jobs",
  "fg",
  "bg",
  "declare",
  "local",
  "readonly",
  "typeset",
  "let",
  "test",
  "true",
  "false",
  "pwd",
  "pushd",
  "popd",
  "dirs",
  "getopts",
  "hash",
  "type",
  "command",
  "builtin",
  "enable",
  "help",
  "logout",
  "mapfile",
  "readarray",
  "shopt",
  "bind",
  "ulimit",
  "umask",
]);

/** Apply a pi syntax theme color directly. */
const syn = (c: ThemeColor, text: string): string => getTheme().fg(c, text);

/** Check if a bash line ends with a chain operator (&&, ||, |, \) */
export function bashLineIsChained(line: string): boolean {
  const trimmed = line.trimEnd();
  return (
    trimmed.endsWith("&&") ||
    trimmed.endsWith("||") ||
    trimmed.endsWith("|") ||
    trimmed.endsWith("\\")
  );
}

/**
 * Track quote state across a bash line.
 * Returns updated [inSingle, inDouble] state after processing the line.
 */
export function bashUpdateQuoteState(
  line: string,
  inSingle: boolean,
  inDouble: boolean
): [boolean, boolean] {
  let sq = inSingle;
  let dq = inDouble;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    // Backslash escapes next char inside double quotes (not single quotes)
    if (ch === "\\" && dq && !sq) {
      i++;
      continue;
    }
    if (ch === "'" && !dq) sq = !sq;
    if (ch === '"' && !sq) dq = !dq;
  }
  return [sq, dq];
}

/**
 * Highlight a single bash line with syntax coloring.
 * Handles multi-line string continuation via startInSQ/startInDQ.
 */
export function highlightBashLine(line: string, startInSQ = false, startInDQ = false): string {
  let result = "";
  let i = 0;
  let cmdPos = !startInSQ && !startInDQ; // inside a quote = not command position

  // If continuing inside a single-quoted string from a previous line
  if (startInSQ) {
    const end = line.indexOf("'", i);
    if (end === -1) {
      return syn("syntaxString", line);
    }
    result += syn("syntaxString", line.slice(0, end + 1));
    i = end + 1;
    cmdPos = false;
  } else if (startInDQ) {
    // Continuing inside a double-quoted string from a previous line
    let closed = false;
    let j = 0;
    while (j < line.length) {
      if (line[j] === "\\" && j + 1 < line.length) {
        j += 2;
        continue;
      }
      if (line[j] === '"') {
        result += syn("syntaxString", line.slice(0, j + 1));
        i = j + 1;
        cmdPos = false;
        closed = true;
        break;
      }
      j++;
    }
    if (!closed) {
      return syn("syntaxString", line);
    }
  }

  while (i < line.length) {
    // Whitespace
    if (line[i] === " " || line[i] === "\t") {
      result += line[i];
      i++;
      continue;
    }

    // Comment
    if (line[i] === "#" && (i === 0 || line[i - 1] === " ")) {
      result += syn("syntaxComment", line.slice(i));
      break;
    }

    // Single-quoted string
    if (line[i] === "'") {
      const end = line.indexOf("'", i + 1);
      const s = end === -1 ? line.slice(i) : line.slice(i, end + 1);
      result += syn("syntaxString", s);
      i += s.length;
      cmdPos = false;
      continue;
    }

    // Double-quoted string
    if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if (line[j] === "\\") j++;
        j++;
      }
      const s = line.slice(i, j + 1);
      result += syn("syntaxString", s);
      i = j + 1;
      cmdPos = false;
      continue;
    }

    // Variable
    if (line[i] === "$") {
      const m = line.slice(i).match(/^\$(\{[^}]*\}|[A-Za-z_]\w*|\(.*?\)|\d|[?!#$@*-])/);
      if (m) {
        result += syn("syntaxVariable", m[0]);
        i += m[0].length;
      } else {
        result += line[i];
        i++;
      }
      cmdPos = false;
      continue;
    }

    // Backtick command substitution
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      const s = end === -1 ? line.slice(i) : line.slice(i, end + 1);
      result += syn("syntaxVariable", s);
      i += s.length;
      cmdPos = false;
      continue;
    }

    // Operators: &&, ||
    if (line[i] === "&" && line[i + 1] === "&") {
      result += syn("syntaxOperator", "&&");
      i += 2;
      cmdPos = true;
      continue;
    }
    if (line[i] === "|" && line[i + 1] === "|") {
      result += syn("syntaxOperator", "||");
      i += 2;
      cmdPos = true;
      continue;
    }

    // Pipe
    if (line[i] === "|") {
      result += syn("syntaxOperator", "|");
      i++;
      cmdPos = true;
      continue;
    }

    // Semicolon
    if (line[i] === ";") {
      result += syn("syntaxPunctuation", ";");
      i++;
      cmdPos = true;
      continue;
    }

    // Heredoc <<
    if (line[i] === "<" && line[i + 1] === "<") {
      result += syn("syntaxOperator", "<<");
      i += 2;
      if (i < line.length && line[i] === "-") {
        result += syn("syntaxOperator", "-");
        i++;
      }
      cmdPos = false;
      continue;
    }

    // Redirections: 2>&1, &>>, &>, >>, 2>, <, >
    const redir = line.slice(i).match(/^(2>&1|&>>|&>|>>|2>|[<>])/);
    if (redir) {
      result += syn("syntaxOperator", redir[0]);
      i += redir[0].length;
      cmdPos = false;
      continue;
    }

    // Background &
    if (line[i] === "&") {
      result += syn("syntaxOperator", "&");
      i++;
      cmdPos = true;
      continue;
    }

    // Parentheses / braces
    if (line[i] === "(" || line[i] === ")" || line[i] === "{" || line[i] === "}") {
      result += syn("syntaxPunctuation", line[i]);
      i++;
      if (line[i - 1] === "(" || line[i - 1] === "{") cmdPos = true;
      continue;
    }

    // Word token
    let word = "";
    while (i < line.length && " \t|&;<>\"'`$#(){}".indexOf(line[i]) === -1) {
      // Break before redirection: digit followed by > or <
      if ((line[i] === ">" || line[i] === "<") && word.length > 0 && /^\d+$/.test(word)) {
        break;
      }
      word += line[i];
      i++;
    }

    if (!word) {
      // Safety: consume one char to avoid infinite loop
      result += line[i] ?? "";
      i++;
      continue;
    }

    // Classify word
    if (cmdPos) {
      if (BASH_KEYWORDS.has(word)) {
        result += syn("syntaxKeyword", word);
      } else if (BASH_BUILTINS.has(word)) {
        result += syn("syntaxFunction", word);
      } else {
        result += syn("syntaxType", word);
      }
      cmdPos = BASH_FLOW_RESUME.has(word);
    } else if (word.startsWith("--") || (word.startsWith("-") && word.length > 1)) {
      result += syn("syntaxVariable", word);
    } else if (/^\d+(\.\d+)?$/.test(word)) {
      result += syn("syntaxNumber", word);
    } else {
      result += syn("syntaxOperator", word);
    }
  }

  return result;
}
