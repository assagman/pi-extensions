import { exec } from "node:child_process";
import { promisify } from "node:util";
import { DiffService } from "./diff-service.js";

const execAsync = promisify(exec);

export class ReviewService {
  private diffService: DiffService;

  constructor() {
    this.diffService = new DiffService();
  }

  async runReview(base?: string, head?: string): Promise<{ url?: string; diff: string }> {
    // 1. Get the diff content for the agent to analyze
    // We limit the diff size to avoiding blowing up the context if it's huge
    // The Agent Tools truncation mechanism usually handles this, but we can be proactive.
    const { raw } = await this.diffService.getDiff(base, head);

    // 2. Try to get critique link
    let url: string | undefined;
    try {
      const args = ["review", "--json"];
      if (base) args.push(base);
      if (head) args.push(head);

      // Using 'critique' command - assumes it's in PATH
      const cmd = `critique ${args.join(" ")}`;
      // Increase maxBuffer for large outputs if critique outputs a lot of logs to stdout/stderr
      const { stdout } = await execAsync(cmd, { cwd: process.cwd(), maxBuffer: 1024 * 1024 * 5 });

      // stdout might contain logs before the JSON, or mixed content.
      // critique output shows:
      // ...
      // {"url": ...}
      // We need to find the JSON line.
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (line.trim().startsWith("{") && line.includes("url")) {
          try {
            const json = JSON.parse(line);
            if (json.url) {
              url = json.url;
              break;
            }
          } catch (_e) {
            // ignore parse errors for non-json lines
          }
        }
      }
    } catch (e) {
      console.warn("Failed to generate critique link", e);
    }

    return { url, diff: raw };
  }
}
