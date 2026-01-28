import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Dashboard } from "./ui/dashboard.js";
import { DimmedOverlay } from "./ui/dimmed-overlay.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("theta", {
    description: "Open Theta Code Review Dashboard",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("UI not available", "error");
        return;
      }

      await DimmedOverlay.show(
        ctx.ui,
        (tui, theme, done) => {
          return new Dashboard(tui, theme, done);
        },
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
}
