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
}
