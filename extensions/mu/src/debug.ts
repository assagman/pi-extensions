/**
 * Mu debug logging — centralized logging for the mu extension.
 * Enable with MU_DEBUG=1 environment variable.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const MU_DEBUG = process.env.MU_DEBUG === "1";
let debugLogPath: string | null = null;

/**
 * Log debug message to ~/.local/share/pi-ext-mu/debug.log
 * Only active when MU_DEBUG=1 environment variable is set.
 */
export function debugLog(msg: string): void {
  if (!MU_DEBUG) return;
  try {
    if (!debugLogPath) {
      const baseDir = join(process.env.HOME ?? "/tmp", ".local", "share", "pi-ext-mu");
      debugLogPath = join(baseDir, "debug.log");
    }
    const ts = new Date().toISOString();
    appendFileSync(debugLogPath, `[${ts}] ${msg}\n`);
  } catch {
    // Debug logging must never break anything
  }
}
