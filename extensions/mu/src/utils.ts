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

/** Format read tool location range (e.g., @L1-50). */
export const formatReadLoc = (offset?: number, limit?: number): string => {
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  const end = limit === undefined ? "end" : start + Math.max(0, Number(limit) - 1);
  return `@L${start}-${end}`;
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
