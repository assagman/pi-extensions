/**
 * Theta — Code review extension for Pi.
 *
 * Commands:
 *   - /theta [base..head]: Full code review dashboard
 *
 * Architecture (Reimagined):
 *   - No DimmedOverlay — renders directly as a pi-tui Component
 *   - Alt-screen for clean screen ownership
 *   - Pre-computed styled lines for instant scroll
 */

import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { App } from "./ui/app.js";

// ─── Extension ──────────────────────────────────────────────────────────────

const thetaExtension: ExtensionFactory = (pi: ExtensionAPI) => {
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

      // Use ctx.ui.custom() directly — no DimmedOverlay overhead.
      // Alt-screen is managed here (enter on mount, exit on done).
      await ctx.ui.custom(
        (tui, theme, _kb, done) => {
          // Enter alternate screen buffer for clean rendering
          tui.terminal.write("\x1b[?1049h"); // Enter alt-screen
          tui.terminal.write("\x1b[?25l"); // Hide cursor
          tui.terminal.write("\x1b[2J\x1b[H"); // Clear + home
          tui.requestRender(true); // Force TUI to re-render in new buffer

          // Wrap done to exit alt-screen before completing
          const wrappedDone = (result: unknown) => {
            tui.terminal.write("\x1b[?1049l"); // Exit alt-screen
            tui.terminal.write("\x1b[?25h"); // Show cursor
            tui.requestRender(true); // Force refresh for main buffer
            done(result);
          };

          return new App(tui, theme, wrappedDone, base, head);
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-left",
            width: "100%",
          },
        }
      );
    },
  });
};

export default thetaExtension;
