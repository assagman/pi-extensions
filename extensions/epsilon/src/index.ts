/**
 * Epsilon — Task management extension for Pi coding agent.
 *
 * Provides: task CRUD with subtasks, priorities, statuses, tags.
 * Storage:  repo-scoped SQLite at ~/.local/share/pi-ext-epsilon/<repo-id>/epsilon.db
 */
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { buildTasksPrompt, closeDb, getTaskSummary } from "./db.js";
import { registerTools } from "./tools.js";

const epsilonExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  // Register task tools
  registerTools(pi);

  // Single system-prompt injection every turn — no hidden messages
  pi.on("before_agent_start", async (event) => {
    const summary = getTaskSummary();
    const addition = buildTasksPrompt({ summary });
    return {
      systemPrompt: `${event.systemPrompt}\n\n${addition}`,
    };
  });

  pi.on("session_shutdown", () => {
    closeDb();
  });
};

export default epsilonExtension;
