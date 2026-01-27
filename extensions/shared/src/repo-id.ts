/**
 * Repo identification utilities for Pi extensions.
 *
 * Determines a stable, unique identifier for the current repository
 * that is consistent across git worktrees and branches.
 *
 * Strategy:
 *   1. Normal git repo  → `git rev-parse --show-toplevel`
 *   2. Bare repo / worktree → `git rev-parse --git-common-dir` (shared root)
 *   3. Non-git project  → sanitized CWD
 */
import { execSync } from "node:child_process";

/**
 * Replace path separators and special characters with underscores.
 * Safe for use as a directory or file name.
 */
export function sanitizePath(path: string): string {
  return path
    .replace(/^\//, "") // remove leading slash
    .replace(/\//g, "_") // replace slashes with underscores
    .replace(/[^a-zA-Z0-9_.-]/g, "_") // replace special chars
    .substring(0, 200); // limit length
}

/** Options passed to every git command */
function gitOpts(cwd: string) {
  return {
    cwd,
    encoding: "utf-8" as const,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    timeout: 5000,
  };
}

/**
 * Check if the repo is a bare repo or a linked worktree.
 * Returns true when `git rev-parse --is-bare-repository` is "true"
 * or the working tree is separate from the git dir (worktree).
 */
function isBareOrWorktree(cwd: string): boolean {
  try {
    const isBare = execSync("git rev-parse --is-bare-repository", gitOpts(cwd)).trim();
    if (isBare === "true") return true;

    // Check if this is a linked worktree (git dir != common dir)
    const gitDir = execSync("git rev-parse --git-dir", gitOpts(cwd)).trim();
    const commonDir = execSync("git rev-parse --git-common-dir", gitOpts(cwd)).trim();

    // Linked worktrees have gitDir ending in .git/worktrees/<name>
    // while commonDir points to the main .git directory
    return gitDir !== commonDir;
  } catch {
    return false;
  }
}

/**
 * Get a stable, sanitized identifier for the current repository.
 *
 * - Normal repos:     sanitized result of `git rev-parse --show-toplevel`
 * - Bare/worktrees:   sanitized result of `git rev-parse --git-common-dir`
 * - Non-git projects: sanitized CWD
 */
export function getRepoIdentifier(cwd: string): string {
  try {
    if (isBareOrWorktree(cwd)) {
      const commonDir = execSync("git rev-parse --git-common-dir", gitOpts(cwd)).trim();
      return sanitizePath(commonDir);
    }

    const toplevel = execSync("git rev-parse --show-toplevel", gitOpts(cwd)).trim();
    return sanitizePath(toplevel);
  } catch {
    // Not a git repo — fall back to sanitized CWD
    return sanitizePath(cwd);
  }
}
