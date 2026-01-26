import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { registerTools } from "./tools.js";
import { closeDb, buildMemoryPrompt, getMemoryContext, initBranchCacheAsync } from "./db.js";

const deltaExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  // Track if we've injected the first-turn message this session
  let firstTurnInjected = false;

  // Register memory tools
  registerTools(pi);

  // Reset on session start and pre-warm git branch cache
  pi.on("session_start", async (_event, ctx) => {
    firstTurnInjected = false;
    // Pre-warm branch cache asynchronously to avoid blocking on first DB access
    await initBranchCacheAsync(ctx.cwd);
  });

  // Inject memory context before each agent turn
  pi.on("before_agent_start", async (event, _ctx) => {
    const memoryCtx = getMemoryContext();

    const hasContent =
      memoryCtx.notes.length > 0 ||
      memoryCtx.taskSummary.activeTasks.length > 0 ||
      memoryCtx.kvKeys.length > 0 ||
      memoryCtx.recentEpisodes > 0;

    // Build system prompt addition
    const systemPromptAddition = hasContent ? buildMemoryPrompt() : buildMinimalPrompt();

    // On first turn, inject a visible message to ensure agent notices
    if (!firstTurnInjected) {
      firstTurnInjected = true;

      const messageContent = hasContent
        ? buildFirstTurnMessage(memoryCtx)
        : buildEmptyStateMessage();

      return {
        systemPrompt: `${event.systemPrompt}\n\n${systemPromptAddition}`,
        message: {
          customType: "delta-memory",
          content: messageContent,
          display: false, // Don't clutter UI, but agent sees it
        },
      };
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${systemPromptAddition}`,
    };
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", () => {
    closeDb();
  });
};

function buildMinimalPrompt(): string {
  return `<delta_memory>
## MANDATORY: Task-Driven Workflow

You MUST use delta_* tools for ALL work:

1. **FIRST**: Create a task for the user's request with delta_task_create
2. **DURING**: Update task status (in_progress) and log decisions with delta_log  
3. **AFTER**: Mark task done and log outcome

## MANDATORY: Log Discoveries

When you discover something new, IMMEDIATELY log it:
- Bug found → delta_log with tags=["bug", "discovery"]
- Pattern/convention discovered → delta_log with tags=["pattern", "discovery"] 
- Important decision made → delta_log with tags=["decision"]
- Gotcha/pitfall found → delta_log with tags=["gotcha", "discovery"]
- Useful insight → delta_log with tags=["insight", "discovery"]

Before logging, use delta_recall tags=["discovery"] query="<topic>" to check if already logged.

## MANDATORY: Create Project Notes

For REUSABLE project knowledge, create a delta_note (loaded every session):

| Category | When to Create Note |
|----------|---------------------|
| issue | Known bugs, limitations, tech debt, workarounds needed |
| convention | Code patterns, naming rules, architectural decisions |
| workflow | Build commands, deploy steps, test procedures |
| reminder | Things to check, common mistakes, review points |
| general | Project context future sessions need to know |

**ALWAYS create notes for:**
- Architecture/design decisions that affect future work
- Non-obvious project setup or configuration
- Recurring issues and their solutions
- Code conventions specific to this project
- Important dependencies or version constraints

Check delta_note_list before creating to avoid duplicates.

Available tools:
- delta_task_create/list/update/delete/get - Task tracking (REQUIRED)
- delta_note_create/list/update/delete/get - Project notes (REQUIRED for reusable knowledge)
- delta_log/recall - Event/decision logging (REQUIRED for discoveries)
- delta_get/set/delete - Key-value preferences

NEVER skip task creation. NEVER skip logging discoveries. NEVER skip noting reusable knowledge.
</delta_memory>`;
}

function buildFirstTurnMessage(ctx: ReturnType<typeof getMemoryContext>): string {
  const lines: string[] = [];

  lines.push("[DELTA MEMORY LOADED]");
  lines.push("");

  if (ctx.notes.length > 0) {
    lines.push(`📝 ${ctx.notes.length} active project notes`);
  } else {
    lines.push("📝 0 project notes - CREATE NOTES for reusable knowledge!");
  }

  const active = ctx.taskSummary.todo + ctx.taskSummary.in_progress + ctx.taskSummary.blocked;
  if (active > 0) {
    lines.push(
      `📋 ${active} active tasks (${ctx.taskSummary.todo} todo, ${ctx.taskSummary.in_progress} in progress, ${ctx.taskSummary.blocked} blocked)`
    );
  }

  if (ctx.kvKeys.length > 0) {
    lines.push(`🔑 ${ctx.kvKeys.length} stored values`);
  }

  if (ctx.recentEpisodes > 0) {
    lines.push(`📚 ${ctx.recentEpisodes} logged episodes`);
  }

  lines.push("");
  lines.push("⚠️ MANDATORY:");
  lines.push("- Create task for this request (or update existing)");
  lines.push("- Log discoveries with delta_log");
  lines.push("- Create delta_note for reusable project knowledge:");
  lines.push("  conventions, issues, workflows, gotchas, architecture");
  lines.push("- Update task status when done");

  return lines.join("\n");
}

function buildEmptyStateMessage(): string {
  return `[DELTA MEMORY: EMPTY STATE]

No tasks, notes, or memory entries found for this project/branch.

⚠️ MANDATORY WORKFLOW:
1. Create a task NOW with delta_task_create for the user's request
2. Update status as you work (in_progress → done)
3. Log ALL discoveries with delta_log (bugs, patterns, decisions, gotchas)
4. Create delta_note for ANY reusable project knowledge:
   - Architecture decisions → category="convention"
   - Known issues/workarounds → category="issue"  
   - Build/deploy/test steps → category="workflow"
   - Project-specific gotchas → category="reminder"

Do NOT proceed without creating a task first.
Do NOT skip logging discoveries or creating notes for reusable knowledge.`;
}

export default deltaExtension;
