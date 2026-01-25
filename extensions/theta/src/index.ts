import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTools } from "./tools/index.js";
import { Dashboard } from "./ui/dashboard.js";

export default function(pi: ExtensionAPI) {
    registerTools(pi);

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
        }
    });

    pi.on("session_start", async (_event, ctx) => {
        // notification suppressed to avoid noise during dev, can be enabled for debugging
        // ctx.ui.notify("Theta extension loaded", "info"); 
        console.log("Theta extension loaded");
    });
}
