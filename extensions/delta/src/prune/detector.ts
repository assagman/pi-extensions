/**
 * Prune detector — extracts and validates file paths and branch references.
 */

import { exec } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ============ Path Detection ============

/**
 * Regex patterns for file path detection.
 * Ordered by specificity (more specific first).
 */
const PATH_PATTERNS = [
  // Explicit file references: "file: /path/to/file"
  /(?:file|path|in|at|from|to):\s*([^\s,)]+\.[a-z0-9]+)/gi,

  // Extension paths: extensions/delta/src/index.ts
  /\b(extensions\/[a-z0-9_-]+\/[^\s,)]+\.[a-z0-9]+)/gi,

  // Source paths: src/something.ts
  /\b(src\/[^\s,)]+\.[a-z0-9]+)/gi,

  // Relative paths: ./foo/bar.ts, ../baz/qux.js
  /\b(\.\.?\/[^\s,)]+\.[a-z0-9]+)/gi,

  // Absolute paths: /Users/... or /home/...
  /\b(\/(?:Users|home|var|tmp|opt)[^\s,)]+\.[a-z0-9]+)/gi,

  // Generic file paths with extensions (must have /)
  /\b([a-zA-Z0-9_-]+\/[^\s,)]*\.[a-z0-9]{1,5})\b/gi,
];

/** Common file extensions to look for */
const FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "md",
  "txt",
  "yaml",
  "yml",
  "toml",
  "sh",
  "bash",
  "css",
  "scss",
  "html",
  "sql",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
]);

/** Paths to exclude (common false positives) */
const EXCLUDE_PATHS = new Set(["node_modules", ".git", "dist/", "build/", ".cache", "__pycache__"]);

/**
 * Extract file paths from content.
 * Returns unique, cleaned paths.
 */
export function detectFilePaths(content: string): string[] {
  const paths = new Set<string>();

  for (const pattern of PATH_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
      let path = match[1];
      if (!path) continue;

      // Clean up path
      path = path.replace(/['"`,;:()[\]{}]+$/, ""); // Remove trailing punctuation
      path = path.replace(/^['"`,;:()[\]{}]+/, ""); // Remove leading punctuation

      // Skip if too short or no extension
      if (path.length < 3) continue;
      const ext = path.split(".").pop()?.toLowerCase();
      if (!ext || !FILE_EXTENSIONS.has(ext)) continue;

      // Skip excluded paths
      if ([...EXCLUDE_PATHS].some((ex) => path.includes(ex))) continue;

      paths.add(path);
    }
  }

  return [...paths];
}

// ============ Branch Detection ============

/**
 * Regex patterns for git branch detection.
 */
const BRANCH_PATTERNS = [
  // Explicit branch references: "branch: feat/something"
  /(?:branch|on|from|to|merge|into):\s*([a-zA-Z0-9/_-]+)/gi,

  // Git commit messages: [feat/branch-name abc123]
  /\[([a-zA-Z0-9/_-]+)\s+[a-f0-9]+\]/gi,

  // Common branch patterns: feat/xxx, fix/xxx, release/xxx
  /\b((?:feat|fix|feature|bugfix|hotfix|release|chore|refactor|docs)\/[a-zA-Z0-9_-]+)/gi,

  // PR/branch mentions: "PR #123 on branch-name"
  /\bPR\s*#?\d+\s+(?:on|from|to)\s+([a-zA-Z0-9/_-]+)/gi,
];

/** Branch names to exclude (always exist or false positives) */
const EXCLUDE_BRANCHES = new Set([
  "main",
  "master",
  "develop",
  "dev",
  "HEAD",
  "origin/main",
  "origin/master",
]);

/**
 * Extract branch references from content.
 * Returns unique, cleaned branch names.
 */
export function detectBranchRefs(content: string): string[] {
  const branches = new Set<string>();

  for (const pattern of BRANCH_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
      let branch = match[1];
      if (!branch) continue;

      // Clean up
      branch = branch.replace(/['"`,;:()[\]{}]+$/, "");
      branch = branch.replace(/^['"`,;:()[\]{}]+/, "");

      // Skip if too short or excluded
      if (branch.length < 3) continue;
      if (EXCLUDE_BRANCHES.has(branch)) continue;
      if (EXCLUDE_BRANCHES.has(branch.replace(/^origin\//, ""))) continue;

      branches.add(branch);
    }
  }

  return [...branches];
}

// ============ Existence Checks ============

/**
 * Check which paths exist in the filesystem.
 * Returns set of existing paths.
 */
export async function checkPathsExist(paths: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  const cwd = process.cwd();

  for (const path of paths) {
    try {
      const resolved = isAbsolute(path) ? path : resolve(cwd, path);
      if (existsSync(resolved)) {
        // Verify it's a file or directory
        const stat = statSync(resolved);
        if (stat.isFile() || stat.isDirectory()) {
          existing.add(path);
        }
      }
    } catch {
      // Path doesn't exist or inaccessible
    }
  }

  return existing;
}

/**
 * Check which branches exist in the git repository.
 * Returns set of existing branch names.
 */
export async function checkBranchesExist(branches: string[]): Promise<Set<string>> {
  const existing = new Set<string>();

  try {
    // Get all local and remote branches
    const { stdout } = await execAsync("git branch -a --format='%(refname:short)'", {
      timeout: 5000,
    });

    const allBranches = new Set(
      stdout
        .split("\n")
        .map((b) => b.trim().replace(/^origin\//, ""))
        .filter(Boolean)
    );

    for (const branch of branches) {
      const clean = branch.replace(/^origin\//, "");
      if (allBranches.has(clean) || allBranches.has(branch)) {
        existing.add(branch);
      }
    }
  } catch {
    // Git not available or not a git repo — assume all exist (conservative)
    return new Set(branches);
  }

  return existing;
}

// ============ Completed Context Detection ============

/**
 * Patterns that indicate completed/merged/closed context.
 */
const COMPLETED_PATTERNS = [
  /\bPR\s*#?\d+\s+merged\b/gi,
  /\bclosed\s+(?:issue|PR|ticket)\s*#?\d+/gi,
  /\bmerged\s+(?:into|to)\s+main\b/gi,
  /\btask\s+(?:completed|done|closed)\b/gi,
  /\b(?:completed|done|finished|shipped)\s+(?:task|feature|work)\b/gi,
];

/**
 * Detect if content refers to completed/closed context.
 */
export function hasCompletedContext(content: string): boolean {
  for (const pattern of COMPLETED_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      return true;
    }
  }
  return false;
}
