import { exec } from "node:child_process";
import { promisify } from "node:util";
import { parsePatchFiles, type FileDiffMetadata, type Hunk } from "@pierre/diffs";

const execAsync = promisify(exec);

export interface DiffFile {
  path: string;
  prevPath?: string;
  additions: number;
  deletions: number;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
}

export interface DiffResult {
  raw: string;
  files: DiffFile[];
  metadata: FileDiffMetadata[];
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  isUncommitted?: boolean;
}

function countHunkStats(hunks: Hunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

export class DiffService {
  async getFiles(base?: string, head?: string): Promise<string[]> {
    const args: string[] = [];
    if (base) args.push(base);
    if (head) args.push(head);

    // If no refs provided, default to HEAD to show all changes (staged + unstaged)
    if (args.length === 0) {
      args.push("HEAD");
    }

    // Restrict to CWD and use relative paths
    args.push("--relative", ".");

    const cmd = `git diff --name-only ${args.join(" ")}`;
    try {
      const { stdout } = await execAsync(cmd, { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 10 });
      return stdout.trim().split("\n").filter(Boolean);
    } catch (e) {
      console.error("Failed to get files", e);
      return [];
    }
  }

  async getDiff(base?: string, head?: string, file?: string): Promise<DiffResult> {
    const args: string[] = [];
    if (base) args.push(base);
    if (head) args.push(head);

    // Default to HEAD if no refs provided
    if (args.length === 0) {
      args.push("HEAD");
    }

    // Use relative paths to match getFiles behavior
    args.push("--relative");

    if (file) args.push("--", file);
    else args.push("."); // If no file specified, diff current dir

    // Get raw diff
    const cmd = `git diff ${args.join(" ")}`;
    let raw = "";
    try {
      const { stdout } = await execAsync(cmd, { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 10 });
      raw = stdout;
    } catch (e) {
      console.error("Failed to get diff", e);
      throw e;
    }

    // Parse with @pierre/diffs
    const patches = parsePatchFiles(raw);
    const metadata: FileDiffMetadata[] = [];
    const files: DiffFile[] = [];

    for (const patch of patches) {
      for (const fileDiff of patch.files) {
        metadata.push(fileDiff);
        const stats = countHunkStats(fileDiff.hunks);
        files.push({
          path: fileDiff.name,
          prevPath: fileDiff.prevName,
          additions: stats.additions,
          deletions: stats.deletions,
          type: fileDiff.type,
        });
      }
    }

    return { raw, files, metadata };
  }

  /**
   * Check if there are uncommitted changes (staged or unstaged)
   */
  async hasUncommittedChanges(): Promise<boolean> {
    try {
      const { stdout } = await execAsync("git status --porcelain", {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get list of commits with pagination
   * @param skip Number of commits to skip
   * @param limit Number of commits to fetch
   */
  async getCommits(skip = 0, limit = 50): Promise<CommitInfo[]> {
    const format = "%H%x00%h%x00%s"; // full sha, short sha, subject (NUL-separated)
    const cmd = `git log --format="${format}" --skip=${skip} -n ${limit}`;

    try {
      const { stdout } = await execAsync(cmd, {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024 * 10,
      });

      const lines = stdout.trim().split("\n").filter(Boolean);
      return lines.map((line) => {
        const [sha, shortSha, subject] = line.split("\x00");
        return { sha, shortSha, subject };
      });
    } catch {
      return [];
    }
  }

  /**
   * Get diff for a single commit (commit vs its parent)
   * @param sha Commit SHA
   * @param file Optional file path to filter
   */
  async getCommitDiff(sha: string, file?: string): Promise<DiffResult> {
    const args = [`${sha}^..${sha}`, "--relative"];
    if (file) args.push("--", file);
    else args.push(".");

    const cmd = `git diff ${args.join(" ")}`;
    let raw = "";

    try {
      const { stdout } = await execAsync(cmd, {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024 * 10,
      });
      raw = stdout;
    } catch (e) {
      // Handle first commit (no parent)
      if (String(e).includes("unknown revision")) {
        const showCmd = file
          ? `git show ${sha} --format="" --relative -- ${file}`
          : `git show ${sha} --format="" --relative`;
        try {
          const { stdout } = await execAsync(showCmd, {
            cwd: process.cwd(),
            maxBuffer: 1024 * 1024 * 10,
          });
          raw = stdout;
        } catch {
          throw e;
        }
      } else {
        throw e;
      }
    }

    const patches = parsePatchFiles(raw);
    const metadata: FileDiffMetadata[] = [];
    const files: DiffFile[] = [];

    for (const patch of patches) {
      for (const fileDiff of patch.files) {
        metadata.push(fileDiff);
        const stats = countHunkStats(fileDiff.hunks);
        files.push({
          path: fileDiff.name,
          prevPath: fileDiff.prevName,
          additions: stats.additions,
          deletions: stats.deletions,
          type: fileDiff.type,
        });
      }
    }

    return { raw, files, metadata };
  }

  /**
   * Get files changed in a specific commit
   */
  async getCommitFiles(sha: string): Promise<string[]> {
    const cmd = `git diff-tree --no-commit-id --name-only -r ${sha} --relative`;
    try {
      const { stdout } = await execAsync(cmd, {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024 * 10,
      });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}
