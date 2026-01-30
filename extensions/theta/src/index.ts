/**
 * Theta — Code review extension for Pi.
 *
 * Commands:
 *   - /theta [base..head]: Full code review dashboard
 */

import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Dashboard } from "./ui/dashboard.js";
import { DimmedOverlay } from "./ui/dimmed-overlay.js";

// ─── Extension ──────────────────────────────────────────────────────────────

const thetaExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  // Register /theta command
  pi.registerCommand("theta", {
    description: "Open Theta Code Review Dashboard — Usage: /theta [base..head]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("UI not available", "error");
        return;
      }

      let base: string | undefined;
      let head: string | undefined;

      if (args.length > 0) {
        const refArg = args[0];
        if (refArg.includes("...")) {
          [base, head] = refArg.split("...");
        } else if (refArg.includes("..")) {
          [base, head] = refArg.split("..");
        } else {
          ctx.ui.notify("Invalid format. Use: /theta base..head", "error");
          return;
        }
      }

      await DimmedOverlay.show(
        ctx.ui,
        (tui, theme, done) => new Dashboard(tui, theme, done, base, head),
        {
          altScreen: true,
          scrim: { stars: true },
          dialog: {
            width: "96%",
            maxHeight: "94%",
            glow: { enabled: true },
          },
        }
      );
    },
  });
};

export default thetaExtension;
