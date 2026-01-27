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
  let firstTurnInjected = false;

  // Register task tools
  registerTools(pi);

  pi.on("session_start", async () => {
    firstTurnInjected = false;
  });

  // Inject task context before each agent turn
  pi.on("before_agent_start", async (event) => {
    const summary = getTaskSummary();
    const activeCount = summary.todo + summary.in_progress + summary.blocked;
    const hasContent = activeCount > 0 || summary.done > 0;

    // First turn: instructions + data + hidden summary message
    if (!firstTurnInjected) {
      firstTurnInjected = true;

      const systemPromptAddition = hasContent
        ? buildTasksPrompt({ instructions: true, summary })
        : buildMinimalPrompt();

      const messageContent = hasContent ? buildFirstTurnMessage(summary) : buildEmptyStateMessage();

      return {
        systemPrompt: `${event.systemPrompt}\n\n${systemPromptAddition}`,
        message: {
          customType: "epsilon-tasks",
          content: messageContent,
          display: false,
        },
      };
    }

    // Subsequent turns: data only, no instructions
    if (hasContent) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${buildTasksPrompt({ instructions: false, summary })}`,
      };
    }

    return { systemPrompt: event.systemPrompt };
  });

  pi.on("session_shutdown", () => {
    closeDb();
  });
};

function buildMinimalPrompt(): string {
  return `<epsilon_tasks>
## Task Workflow
1. **ALWAYS create tasks BEFORE acting** — Every work item gets a task via epsilon_task_create before execution begins
2. **ALWAYS update tasks AFTER acting** — Update status (in_progress/done/blocked), progress, and completion via epsilon_task_update
3. Mark tasks done when complete — no task left behind
4. Check **epsilon_task_list** before creating to avoid duplicates

Tools: epsilon_task_create/list/update/delete/get, epsilon_info, epsilon_version
</epsilon_tasks>`;
}

function buildFirstTurnMessage(summary: ReturnType<typeof getTaskSummary>): string {
  const active = summary.todo + summary.in_progress + summary.blocked;
  const lines: string[] = [];

  lines.push("📋 Epsilon tasks loaded.");
  lines.push(
    `⏳ ${active} active tasks (${summary.todo} todo, ${summary.in_progress} in progress, ${summary.blocked} blocked)`
  );
  lines.push("");
  lines.push("Create tasks with epsilon_task_create, update with epsilon_task_update.");

  return lines.join("\n");
}

function buildEmptyStateMessage(): string {
  return `📋 Epsilon tasks — empty (no tasks yet).
Create tasks with epsilon_task_create.`;
}

export default epsilonExtension;
