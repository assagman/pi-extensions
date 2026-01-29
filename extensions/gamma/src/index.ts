/**
 * Gamma Extension — Context Window Token Analyzer
 *
 * Visualizes token usage across all sources in the context window.
 * Triggered via `/gamma` command.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Import sub-modules
import { createAnalyzer } from "./analyzer.js";
import { getCapturedSchemas, installSchemaCapture } from "./schema-capture.js";
import { Dashboard } from "./ui/dashboard.js";

// =============================================================================
// EXTENSION STATE
// =============================================================================

/** Captured system prompt from last before_agent_start */
let lastSystemPrompt: string | null = null;

// =============================================================================
// EXTENSION ENTRY POINT
// =============================================================================

export default function (pi: ExtensionAPI) {
  const analyzer = createAnalyzer();

  // Install fetch hook to capture tool schemas from API requests
  installSchemaCapture();

  // Capture system prompt on each agent start
  pi.on("before_agent_start", async (event, _ctx) => {
    lastSystemPrompt = event.systemPrompt;
    return {};
  });

  // Reset on session start
  pi.on("session_start", async () => {
    lastSystemPrompt = null;
  });

  // Register /gamma command
  pi.registerCommand("gamma", {
    description: "Analyze context window token usage",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("UI not available", "error");
        return;
      }

      // Get tool schemas captured from API request
      const capturedSchemas = getCapturedSchemas();

      await ctx.ui.custom((tui, theme, keybindings, done) => {
        return new Dashboard(
          tui,
          theme,
          keybindings,
          done,
          ctx,
          analyzer,
          lastSystemPrompt,
          capturedSchemas
        );
      });
    },
  });
}

// Re-export schema capture utilities for testing
export {
  installSchemaCapture,
  uninstallSchemaCapture,
  resetCapturedSchemas,
  getCapturedSchemas,
  hasCapturedSchemas,
  getTotalSchemaTokens,
  getCapturedToolCount,
} from "./schema-capture.js";
