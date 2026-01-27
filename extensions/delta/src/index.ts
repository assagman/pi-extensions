import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { buildMemoryPrompt, closeDb, getMemoryContext, initBranchCacheAsync } from "./db.js";
import { registerTools } from "./tools.js";

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
      memoryCtx.indexEntries.length > 0 || memoryCtx.taskSummary.activeTasks.length > 0;

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
## MANDATORY — You MUST do ALL of these BEFORE any work:

1. **delta_task_create** — Create a task for the user's request RIGHT NOW
2. **delta_task_update** — Update status as you work (in_progress → done)
3. **delta_log** — Log every discovery: bugs, decisions, patterns, gotchas
4. **delta_note_create** — Save reusable knowledge (issues, conventions, workflows)

Tools: delta_task_create/list/update/delete/get, delta_note_create/list/update/delete/get, delta_log/recall, delta_get/set/delete, delta_index_search/rebuild
</delta_memory>`;
}

function buildFirstTurnMessage(ctx: ReturnType<typeof getMemoryContext>): string {
  const lines: string[] = [];

  // Lead with the ACTION REQUIRED — not the stats
  lines.push("⚠️ MANDATORY — Do these NOW before any other work:");
  lines.push("1. delta_task_create → Create a task for this request");
  lines.push("2. delta_log → Log any discoveries as you work");
  lines.push("3. delta_note_create → Save reusable knowledge when found");
  lines.push("4. delta_task_update → Mark task done when complete");
  lines.push("");

  // Then show context summary
  if (ctx.indexEntries.length > 0) {
    const noteCount = ctx.indexEntries.filter((e) => e.source_type === "note").length;
    const episodeCount = ctx.indexEntries.filter((e) => e.source_type === "episode").length;
    const taskCount = ctx.indexEntries.filter((e) => e.source_type === "task").length;
    const kvCount = ctx.indexEntries.filter((e) => e.source_type === "kv").length;

    lines.push(`🧠 Memory: ${ctx.indexEntries.length} entries`);
    const parts: string[] = [];
    if (noteCount > 0) parts.push(`${noteCount} notes`);
    if (episodeCount > 0) parts.push(`${episodeCount} episodes`);
    if (taskCount > 0) parts.push(`${taskCount} tasks`);
    if (kvCount > 0) parts.push(`${kvCount} kv`);
    if (parts.length > 0) lines.push(`  ${parts.join(", ")}`);
  }

  const active = ctx.taskSummary.todo + ctx.taskSummary.in_progress + ctx.taskSummary.blocked;
  if (active > 0) {
    lines.push(
      `⏳ ${active} active tasks (${ctx.taskSummary.todo} todo, ${ctx.taskSummary.in_progress} in progress, ${ctx.taskSummary.blocked} blocked)`
    );
  }

  if (ctx.indexEntries.length > 0) {
    lines.push("");
    lines.push("Use delta_index_search(query) to find relevant memories");
  }

  return lines.join("\n");
}

function buildEmptyStateMessage(): string {
  return `⚠️ MANDATORY — Do these NOW before any other work:
1. delta_task_create → Create a task for this request
2. delta_log → Log any discoveries as you work
3. delta_note_create → Save reusable knowledge when found
4. delta_task_update → Mark task done when complete

Empty memory — first session for this project/branch.`;
}

export default deltaExtension;
