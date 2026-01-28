/**
 * Mu utilities — common helper functions.
 */
import { createHash } from "node:crypto";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { MU_CONFIG } from "./config.js";

/** Type guard for plain objects */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Detect language from file extension for syntax highlighting. */
export const detectLanguageFromPath = (filePath: string): string | null => {
  if (!filePath) return null;
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return null;

  const extToLang: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    scala: "scala",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    fs: "fsharp",
    swift: "swift",
    m: "objectivec",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    md: "markdown",
    sql: "sql",
    graphql: "graphql",
    dockerfile: "dockerfile",
    makefile: "makefile",
  };

  return extToLang[ext] ?? null;
};

/** Safety clamp: ensure every line in array fits within maxWidth. */
export const clampLines = (lines: string[], maxWidth: number): string[] =>
  lines.map((l) => (visibleWidth(l) > maxWidth ? truncateToWidth(l, maxWidth) : l));

/** Extract text content from a tool result object. */
export const extractResultText = (result: unknown): string => {
  if (!isRecord(result)) return "";
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((c: unknown) => isRecord(c) && c.type === "text")
    .map((c: unknown) => (isRecord(c) && typeof c.text === "string" ? c.text : ""))
    .join("\n");
};

/** Generate a short preview of text, truncated with ellipsis. */
export const preview = (text: string, max: number = MU_CONFIG.PREVIEW_LENGTH): string => {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
};

/** Format read tool location range (e.g., @100-150 or "full"). */
export const formatReadLoc = (offset?: number, limit?: number): string => {
  if (offset === undefined && limit === undefined) return "full";
  const start = offset ?? 1;
  const end = limit === undefined ? "end" : start + Math.max(0, Number(limit) - 1);
  return `@${start}-${end}`;
};

/** Compute edit diff stats from oldText/newText. */
export const computeEditStats = (
  oldText: string,
  newText: string
): { added: number; modified: number; deleted: number } => {
  const oldLines = oldText ? oldText.split("\n").length : 0;
  const newLines = newText ? newText.split("\n").length : 0;
  const modified = Math.min(oldLines, newLines);
  const added = Math.max(0, newLines - oldLines);
  const deleted = Math.max(0, oldLines - newLines);
  return { added, modified, deleted };
};

/** Compute a signature hash for tool name + args (for deduplication). */
export const computeSignature = (name: string, args: Record<string, unknown>): string => {
  const hash = createHash("sha256");
  hash.update(name);
  hash.update(JSON.stringify(args));
  return hash.digest("hex").slice(0, MU_CONFIG.SIGNATURE_HASH_LENGTH);
};

/** Format elapsed time in human-readable form. */
export const formatWorkingElapsed = (ms: number): string => {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
};

// =============================================================================
// PATH UTILITIES — CWD-relative paths and bash cd-stripping
// =============================================================================
// Thread-safety note: Module-level state is safe because Node.js is single-threaded.
// The cache is explicitly refreshed on session_start to ensure consistency.
// =============================================================================

/**
 * Cached CWD for consistent path resolution.
 * Refresh via refreshCwdCache() on session start.
 * @internal Module-global — safe in single-threaded Node.js runtime.
 */
let cachedCwd: string | null = null;
let cachedHome: string | null = null;

/** Refresh CWD cache. Call on session start. */
export const refreshCwdCache = (): void => {
  cachedCwd = process.cwd();
  cachedHome = process.env.HOME ?? process.env.USERPROFILE ?? null;
};

/** Get cached CWD (auto-initializes if needed). */
const getCwd = (): string => {
  if (!cachedCwd) refreshCwdCache();
  return cachedCwd as string;
};

/** Get cached HOME directory. */
const getHome = (): string | null => {
  if (!cachedHome) refreshCwdCache();
  return cachedHome;
};

/**
 * Convert absolute path to CWD-relative path.
 * - If path starts with CWD, strip CWD prefix.
 * - Otherwise return as-is.
 */
export const toRelativePath = (path: string): string => {
  if (!path) return path;

  const cwd = getCwd();
  const cwdSlash = cwd.endsWith("/") ? cwd : `${cwd}/`;
  const cwdNoSlash = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;

  // Exact match (path is CWD itself, with or without trailing slash)
  if (path === cwdNoSlash || path === cwdSlash) {
    return ".";
  }

  // Path starts with CWD prefix
  if (path.startsWith(cwdSlash)) {
    return path.slice(cwdSlash.length);
  }

  // Handle ~ prefix: expand and check
  const home = getHome();
  if (home && path.startsWith("~/")) {
    const expanded = home + path.slice(1);
    const expandedNoSlash = expanded.endsWith("/") ? expanded.slice(0, -1) : expanded;
    if (expandedNoSlash === cwdNoSlash || expanded === cwdSlash) {
      return ".";
    }
    if (expanded.startsWith(cwdSlash)) {
      return expanded.slice(cwdSlash.length);
    }
  }

  return path;
};

/**
 * Strip redundant `cd <cwd> && ` prefix from bash commands.
 * Only strips when cd target matches the current working directory.
 * Handles variations: with/without trailing slash, ~ prefix.
 */
export const stripCdPrefix = (cmd: string): string => {
  if (!cmd) return cmd;

  const cwd = getCwd();
  const home = getHome();

  // Build regex-safe CWD variants
  const cwdVariants: string[] = [escapeRegex(cwd), escapeRegex(`${cwd}/`)];

  // Add ~ variant if CWD is under HOME
  if (home && cwd.startsWith(home)) {
    const tildeRelative = `~${cwd.slice(home.length)}`;
    cwdVariants.push(escapeRegex(tildeRelative));
    cwdVariants.push(escapeRegex(`${tildeRelative}/`));
  }

  // Build pattern: cd <any CWD variant> && (with optional spaces and quotes)
  // Handles: cd /path && cmd, cd '/path' && cmd, cd "/path" && cmd
  const cdPattern = new RegExp(`^cd\\s+['"]?(${cwdVariants.join("|")})['"]?\\s*&&\\s*`, "i");

  return cmd.replace(cdPattern, "");
};

/** Escape string for use in RegExp */
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// =============================================================================
// SKILL FILE DETECTION
// =============================================================================

/**
 * Check if a path points to a SKILL.md file (skill loading).
 */
export const isSkillRead = (path: string): boolean => {
  if (!path) return false;
  return path.endsWith("/SKILL.md") || path === "SKILL.md";
};

/**
 * Extract skill name from a SKILL.md path.
 * Returns the directory name containing SKILL.md.
 * Example: "/Users/.../skills/ascii-diagram/SKILL.md" → "ascii-diagram"
 */
export const extractSkillName = (path: string): string => {
  if (!path) return "unknown";

  // Handle paths ending with /SKILL.md
  const cleanPath = path.endsWith("/SKILL.md") ? path.slice(0, -"/SKILL.md".length) : path;

  // Extract last directory component
  const lastSlash = cleanPath.lastIndexOf("/");
  if (lastSlash === -1) return "unknown";

  return cleanPath.slice(lastSlash + 1) || "unknown";
};
