/**
 * Delta v3 — Pure persistent memory extension for Pi coding agent.
 *
 * Provides: notes (semantic), episodes (episodic), KV (scratchpad), memory index (navigator).
 * Storage:  repo-scoped SQLite at ~/.local/share/pi-ext-delta/<repo-id>/delta.db
 *
 * No tasks (use epsilon extension), no branch scoping.
 */
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { buildMemoryPrompt, closeDb, getMemoryContext, resetSession } from "./db.js";
import { registerTools } from "./tools.js";

const deltaExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  let firstTurnInjected = false;

  // Register memory tools
  registerTools(pi);

  // Reset session state
  pi.on("session_start", async () => {
    firstTurnInjected = false;
    resetSession();
  });

  // Inject memory context before each agent turn
  pi.on("before_agent_start", async (event) => {
    const memoryCtx = getMemoryContext();

    const hasContent = memoryCtx.indexEntries.length > 0;

    const systemPromptAddition = hasContent ? buildMemoryPrompt() : buildMinimalPrompt();

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
          display: false,
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
## MANDATORY — Memory workflow:

1. **delta_log** — Log every discovery: bugs, decisions, patterns, gotchas
2. **delta_note_create** — Save reusable knowledge (issues, conventions, workflows)
3. Check **delta_recall** and **delta_note_list** before creating to avoid duplicates

Tools: delta_note_create/list/update/delete/get, delta_log/recall/episode_delete, delta_get/set/delete, delta_index_search/rebuild
</delta_memory>`;
}

function buildFirstTurnMessage(ctx: ReturnType<typeof getMemoryContext>): string {
  const lines: string[] = [];

  lines.push(
    "🧠 Delta memory loaded. Log discoveries with delta_log, save knowledge with delta_note_create."
  );
  lines.push("");

  if (ctx.indexEntries.length > 0) {
    const noteCount = ctx.indexEntries.filter((e) => e.source_type === "note").length;
    const episodeCount = ctx.indexEntries.filter((e) => e.source_type === "episode").length;
    const kvCount = ctx.indexEntries.filter((e) => e.source_type === "kv").length;

    const parts: string[] = [];
    if (noteCount > 0) parts.push(`${noteCount} notes`);
    if (episodeCount > 0) parts.push(`${episodeCount} episodes`);
    if (kvCount > 0) parts.push(`${kvCount} kv`);
    if (parts.length > 0) lines.push(`Memory: ${parts.join(", ")}`);
  }

  if (ctx.indexEntries.length > 0) {
    lines.push("Use delta_index_search(query) to find relevant memories.");
  }

  return lines.join("\n");
}

function buildEmptyStateMessage(): string {
  return `🧠 Delta memory — empty (first session for this project).
Log discoveries with delta_log, save knowledge with delta_note_create.`;
}

export default deltaExtension;
