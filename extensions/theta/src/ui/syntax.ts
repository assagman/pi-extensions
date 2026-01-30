/**
 * Syntax highlighting for diff content.
 *
 * Provides a simple regex-based tokenizer that handles common programming
 * language constructs: keywords, strings, comments, numbers, types, and
 * function calls. Combined with ANSI 24-bit color output for terminal
 * rendering.
 *
 * Design:
 *   - Language auto-detected from file extension
 *   - Line-based tokenization (no cross-line state)
 *   - Block comment lines detected by leading * heuristic
 *   - Palette inspired by One Dark Pro theme
 */

// ── ANSI helpers ──────────────────────────────────────────────────────────

const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const bg = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;

export const RESET = "\x1b[0m";

// ── Token types ───────────────────────────────────────────────────────────

export type TokenType =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "type"
  | "function"
  | "operator"
  | "punctuation"
  | "text";

export interface Token {
  text: string;
  type: TokenType;
}

// ── Syntax foreground colors (One Dark Pro inspired) ──────────────────────

export const SYNTAX_FG: Record<TokenType, string> = {
  keyword: fg(198, 120, 221), // purple
  string: fg(152, 195, 121), // green
  comment: fg(106, 112, 124), // gray
  number: fg(209, 154, 102), // orange
  type: fg(97, 175, 239), // blue
  function: fg(229, 192, 123), // yellow
  operator: fg(86, 182, 194), // cyan
  punctuation: fg(140, 147, 160), // light gray
  text: fg(190, 195, 204), // white-gray
};

// ── Diff background colors ────────────────────────────────────────────────

export const DIFF_BG = {
  /** Subtle red tint for deletion lines. */
  deletion: bg(50, 15, 18),
  /** Subtle green tint for addition lines. */
  addition: bg(18, 42, 20),
  /** Brighter red for word-diff changed words (deletion side). */
  wordDeletion: bg(106, 28, 33),
  /** Brighter green for word-diff changed words (addition side). */
  wordAddition: bg(28, 86, 32),
};

/** Gray foreground for line numbers (matches dim). */
export const DIM_FG = fg(106, 112, 124);

// ── Language detection ────────────────────────────────────────────────────

const EXT_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  lua: "lua",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  css: "css",
  scss: "css",
  html: "html",
  xml: "html",
  sql: "sql",
  md: "markdown",
  r: "r",
  R: "r",
  zig: "zig",
  dart: "dart",
  scala: "scala",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  vue: "typescript",
  svelte: "typescript",
};

/**
 * Detect programming language from a file path.
 * Returns language identifier or "text" for unknown files.
 */
export function detectLanguage(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "text";
  const ext = filePath.substring(dot + 1).toLowerCase();
  return EXT_MAP[ext] || "text";
}

// ── Keyword sets ──────────────────────────────────────────────────────────

const JS_KW = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "keyof",
  "let",
  "namespace",
  "new",
  "null",
  "of",
  "override",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const PY_KW = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "self",
  "try",
  "while",
  "with",
  "yield",
]);

const GO_KW = new Set([
  "break",
  "case",
  "chan",
  "const",
  "continue",
  "default",
  "defer",
  "else",
  "fallthrough",
  "false",
  "for",
  "func",
  "go",
  "goto",
  "if",
  "import",
  "interface",
  "map",
  "nil",
  "package",
  "range",
  "return",
  "select",
  "struct",
  "switch",
  "true",
  "type",
  "var",
]);

const RUST_KW = new Set([
  "as",
  "async",
  "await",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
]);

const GENERIC_KW = new Set([
  "abstract",
  "assert",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "for",
  "foreach",
  "goto",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "int",
  "interface",
  "long",
  "namespace",
  "new",
  "nil",
  "null",
  "override",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "string",
  "struct",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "true",
  "try",
  "typedef",
  "typeof",
  "unsigned",
  "using",
  "var",
  "virtual",
  "void",
  "volatile",
  "while",
  "yield",
]);

function getKeywords(lang: string): Set<string> {
  switch (lang) {
    case "typescript":
    case "javascript":
      return JS_KW;
    case "python":
      return PY_KW;
    case "go":
      return GO_KW;
    case "rust":
      return RUST_KW;
    default:
      return GENERIC_KW;
  }
}

/** Languages that use # for line comments. */
const HASH_COMMENT_LANGS = new Set([
  "python",
  "ruby",
  "shell",
  "yaml",
  "toml",
  "r",
  "elixir",
  "perl",
]);

// ── Tokenizer ─────────────────────────────────────────────────────────────

/**
 * Tokenize a single line of source code.
 *
 * Simple regex-based scanner — handles the most common constructs for
 * syntax highlighting. Not a full parser, but good enough for diff display.
 */
export function tokenizeLine(line: string, language: string): Token[] {
  if (!line || language === "text" || language === "markdown") {
    return [{ text: line || "", type: "text" }];
  }

  const tokens: Token[] = [];
  const keywords = getKeywords(language);
  const useHash = HASH_COMMENT_LANGS.has(language);
  const len = line.length;
  let i = 0;

  while (i < len) {
    const ch = line[i];

    // ── Whitespace ──────────────────────────────────────────────
    if (ch === " " || ch === "\t") {
      const start = i;
      while (i < len && (line[i] === " " || line[i] === "\t")) i++;
      tokens.push({ text: line.slice(start, i), type: "text" });
      continue;
    }

    // ── Line comment ────────────────────────────────────────────
    if (line[i] === "/" && line[i + 1] === "/") {
      tokens.push({ text: line.slice(i), type: "comment" });
      break;
    }
    if (useHash && ch === "#") {
      tokens.push({ text: line.slice(i), type: "comment" });
      break;
    }

    // ── Block comment (heuristic: line starts with * or /*) ─────
    if (i === 0 || (i <= 4 && tokens.every((t) => t.type === "text"))) {
      const trimmed = line.trimStart();
      if (
        trimmed.startsWith("/*") ||
        trimmed.startsWith("* ") ||
        trimmed.startsWith("*/") ||
        trimmed === "*"
      ) {
        if (i === 0) {
          tokens.push({ text: line, type: "comment" });
          return tokens;
        }
      }
    }

    // ── Block comment inline ────────────────────────────────────
    if (line[i] === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      const closeIdx = end >= 0 ? end + 2 : len;
      tokens.push({ text: line.slice(i, closeIdx), type: "comment" });
      i = closeIdx;
      continue;
    }

    // ── String ──────────────────────────────────────────────────
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      tokens.push({ text: line.slice(i, j), type: "string" });
      i = j;
      continue;
    }

    // ── Number ──────────────────────────────────────────────────
    if (
      (ch >= "0" && ch <= "9") ||
      (ch === "." && i + 1 < len && line[i + 1] >= "0" && line[i + 1] <= "9")
    ) {
      const start = i;
      if (line[i] === "0" && (line[i + 1] === "x" || line[i + 1] === "X")) {
        i += 2;
        while (i < len && /[0-9a-fA-F_]/.test(line[i])) i++;
      } else if (line[i] === "0" && (line[i + 1] === "b" || line[i + 1] === "B")) {
        i += 2;
        while (i < len && /[01_]/.test(line[i])) i++;
      } else if (line[i] === "0" && (line[i + 1] === "o" || line[i + 1] === "O")) {
        i += 2;
        while (i < len && /[0-7_]/.test(line[i])) i++;
      } else {
        while (i < len && /[0-9._eE]/.test(line[i])) i++;
        if (i < len && (line[i] === "+" || line[i] === "-") && /[eE]/.test(line[i - 1])) i++;
        while (i < len && /[0-9_]/.test(line[i])) i++;
      }
      // Numeric suffix (like 'n' for BigInt, 'f' for float)
      if (i < len && /[nNfFlLuU]/.test(line[i])) i++;
      tokens.push({ text: line.slice(start, i), type: "number" });
      continue;
    }

    // ── Identifier / keyword / type / function ──────────────────
    if (/[a-zA-Z_$]/.test(ch)) {
      const start = i;
      while (i < len && /[a-zA-Z0-9_$]/.test(line[i])) i++;
      const word = line.slice(start, i);

      if (keywords.has(word)) {
        tokens.push({ text: word, type: "keyword" });
      } else if (/^[A-Z][a-zA-Z0-9]*$/.test(word) && word.length > 1) {
        // PascalCase → type (but not single uppercase letter)
        tokens.push({ text: word, type: "type" });
      } else if (i < len && line[i] === "(") {
        tokens.push({ text: word, type: "function" });
      } else {
        tokens.push({ text: word, type: "text" });
      }
      continue;
    }

    // ── Operator ────────────────────────────────────────────────
    if (/[=+\-*/<>!&|^~?:%]/.test(ch)) {
      const start = i;
      // Consume multi-character operators
      i++;
      while (i < len && /[=+\-*/<>!&|^~?:]/.test(line[i])) i++;
      tokens.push({ text: line.slice(start, i), type: "operator" });
      continue;
    }

    // ── Punctuation ─────────────────────────────────────────────
    if (/[(){}[\];,.]/.test(ch)) {
      tokens.push({ text: ch, type: "punctuation" });
      i++;
      continue;
    }

    // ── Decorator (@) ───────────────────────────────────────────
    if (ch === "@") {
      const start = i;
      i++;
      while (i < len && /[a-zA-Z0-9_$.]/.test(line[i])) i++;
      tokens.push({ text: line.slice(start, i), type: "keyword" });
      continue;
    }

    // ── Other ───────────────────────────────────────────────────
    tokens.push({ text: ch, type: "text" });
    i++;
  }

  return tokens;
}
