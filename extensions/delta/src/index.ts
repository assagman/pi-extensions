/**
 * Delta v3 — Pure persistent memory extension for Pi coding agent.
 *
 * Provides: notes (semantic), episodes (episodic), KV (scratchpad), memory index (navigator).
 * Storage:  repo-scoped SQLite at ~/.local/share/pi-ext-delta/<repo-id>/delta.db
 *
 * Enforcement features:
 * - Always-on compact instructions injected every turn (never dropped)
 * - Idle nudge after N turns without memory writes
 * - Auto-capture git commits as episodes
 * - Session write stats in system prompt
 */
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { buildMemoryPrompt, closeDb, getMemoryContext, logEpisode, resetSession } from "./db.js";
import { registerTools } from "./tools.js";

// ============ Constants ============

/** Delta write tools that count toward session activity */
const DELTA_WRITE_TOOLS = new Set([
  "delta_set",
  "delta_log",
  "delta_note_create",
  "delta_note_update",
]);

/** Turns of inactivity before injecting a nudge message */
const IDLE_THRESHOLD = 4;

/** Minimum turns between consecutive nudge messages */
const NUDGE_COOLDOWN = 4;

// ============ Session State ============

let turnCount = 0;
let lastWriteTurn = 0;
let sessionWriteCount = 0;
let firstTurnDone = false;
let lastNudgeTurn = 0;

function resetState(): void {
  turnCount = 0;
  lastWriteTurn = 0;
  sessionWriteCount = 0;
  firstTurnDone = false;
  lastNudgeTurn = 0;
}

function trackWrite(): void {
  lastWriteTurn = turnCount;
  sessionWriteCount++;
}

function turnsIdle(): number {
  return turnCount - lastWriteTurn;
}

function shouldNudge(): boolean {
  return (
    turnCount > 3 && turnsIdle() >= IDLE_THRESHOLD && turnCount - lastNudgeTurn >= NUDGE_COOLDOWN
  );
}

// ============ Git Commit Detection ============

const GIT_COMMIT_RE = /\bgit\s+commit\b/;
const COMMIT_HEADER_RE = /\[(\S+)\s+([a-f0-9]+)\]\s*(.*)/;
const COMMIT_STATS_RE = /(\d+)\s+files?\s+changed[^\n]*/;

function extractCommitInfo(output: string): string | null {
  const header = output.match(COMMIT_HEADER_RE);
  if (!header) return null;

  const [, branch, hash, message] = header;
  const stats = output.match(COMMIT_STATS_RE);
  const statsStr = stats ? ` (${stats[0]})` : "";
  return `Commit ${hash} on ${branch}: ${message}${statsStr}`;
}

// ============ Extension ============

const deltaExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  registerTools(pi);

  // --- Session lifecycle ---
  pi.on("session_start", async () => {
    resetState();
    resetSession();
  });

  pi.on("session_shutdown", () => {
    closeDb();
  });

  // --- Track delta tool usage ---
  pi.on("tool_call", async (event) => {
    if (DELTA_WRITE_TOOLS.has(event.toolName)) {
      trackWrite();
    }
  });

  // --- Auto-capture git commits ---
  pi.on("tool_result", async (event) => {
    // All ToolResultEvent variants have toolName
    if ((event as { toolName: string }).toolName !== "Bash") return;

    const command = String((event.input as Record<string, unknown>).command ?? "");
    if (!GIT_COMMIT_RE.test(command)) return;

    const output = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");

    const info = extractCommitInfo(output);
    if (info) {
      logEpisode(info, "git", ["commit", "auto-captured"]);
      trackWrite();
    }
  });

  // --- Inject memory context before each agent turn ---
  pi.on("before_agent_start", async (event) => {
    turnCount++;

    const ctx = getMemoryContext();

    // Always inject compact instructions + memory index + stats
    const prompt = buildMemoryPrompt({
      ctx,
      sessionWrites: sessionWriteCount,
      turnsIdle: turnsIdle(),
    });

    const result: {
      systemPrompt: string;
      message?: { customType: string; content: string; display: boolean };
    } = {
      systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
    };

    // First turn: hidden welcome message
    if (!firstTurnDone) {
      firstTurnDone = true;
      result.message = {
        customType: "delta-memory",
        content: buildWelcomeMessage(ctx),
        display: false,
      };
    }
    // Idle nudge: hidden reminder after sustained inactivity
    else if (shouldNudge()) {
      lastNudgeTurn = turnCount;
      result.message = {
        customType: "delta-nudge",
        content: `⚠ No memory writes in ${turnsIdle()} turns. If you've made decisions, found bugs, or learned patterns — log them with delta_log or delta_note_create.`,
        display: false,
      };
    }

    return result;
  });
};

// ============ Helpers ============

function buildWelcomeMessage(ctx: ReturnType<typeof getMemoryContext>): string {
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

    lines.push("Use delta_index_search(query) to find relevant memories.");
  } else {
    lines.push("Memory is empty — start logging discoveries and decisions.");
  }

  return lines.join("\n");
}

export default deltaExtension;
