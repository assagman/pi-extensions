import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Dashboard } from "./ui/dashboard.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("theta", {
    description: "Open Theta Code Review Dashboard",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("UI not available", "error");
        return;
      }

      await ctx.ui.custom((tui, theme, keybindings, done) => {
        return new Dashboard(tui, theme, keybindings, done);
      });
    },
  });
}
