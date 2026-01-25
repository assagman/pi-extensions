import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface DiffFile {
    path: string;
    additions: number;
    deletions: number;
}

export interface DiffResult {
    raw: string;
    files: DiffFile[];
}

export class DiffService {
    async getFiles(base?: string, head?: string): Promise<string[]> {
        const args = [];
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
        const args = [];
        if (base) args.push(base);
        if (head) args.push(head);
        
        // Default to HEAD if no refs provided
        if (args.length === 0 && !file) {
             args.push("HEAD");
        } else if (args.length === 0 && file) {
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

        // Get stats
        const statCmd = `git diff --numstat ${args.join(" ")}`;
        let files: DiffFile[] = [];
        try {
            const { stdout } = await execAsync(statCmd, { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 10 });
            files = stdout.trim().split("\n").filter(Boolean).map(line => {
                const parts = line.split(/\s+/);
                // numstat output: additions deletions path
                // path might contain spaces? git handles it, but usually separated by tab
                // let's rely on split(/\s+/) for now as simple approach
                const add = parts[0];
                const del = parts[1];
                const path = parts.slice(2).join(" ");
                return {
                    path,
                    additions: parseInt(add) || 0,
                    deletions: parseInt(del) || 0
                };
            });
        } catch (e) {
            console.warn("Failed to get stats", e);
        }

        return { raw, files };
    }
}
