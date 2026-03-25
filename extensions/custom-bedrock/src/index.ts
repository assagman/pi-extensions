import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { initialRuntimeState, reloadProviders, renderStatus } from "./registration.js";

export default function (pi: ExtensionAPI) {
  const state = initialRuntimeState();

  pi.on("session_start", async (_event, ctx) => {
    const result = await reloadProviders(pi, state, { cwd: ctx.cwd });
    if (!ctx.hasUI) return;

    if (result.profiles.length === 0) {
      ctx.ui.notify("custom-bedrock: no valid profiles loaded", "warning");
      return;
    }

    ctx.ui.notify(
      `custom-bedrock: loaded ${result.profiles.length} profile${result.profiles.length === 1 ? "" : "s"}`,
      "info"
    );
  });

  pi.registerCommand("custom-bedrock-status", {
    description: "Show custom-bedrock config and provider status",
    handler: async (_args, ctx) => {
      const lines = renderStatus(state, ctx.cwd);
      if (ctx.hasUI) {
        ctx.ui.setWidget("custom-bedrock", lines);
        ctx.ui.notify(lines[0], state.errors.length > 0 ? "warning" : "info");
      }
    },
  });
}
