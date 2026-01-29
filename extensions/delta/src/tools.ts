/**
 * Delta v4 tools — Unified memory API.
 *
 * Tools:
 * - delta_remember(content, tags, importance, context)
 * - delta_search(query, tags, importance, limit, since, sessionOnly)
 * - delta_forget(id)
 * - delta_info()
 * - delta_version()
 * - delta_schema()
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createTool } from "pi-ext-shared";
import {
  type Importance,
  type SearchOptions,
  forget,
  getDatabaseSchema,
  getDbLocation,
  getVersionInfo,
  remember,
  search,
} from "./db.js";

// ============ Tool Schemas ============

const ImportanceEnum = Type.Union([
  Type.Literal("low"),
  Type.Literal("normal"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

const RememberSchema = Type.Object({
  content: Type.String({ description: "Memory content to store" }),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Classification tags (e.g., decision, preference, bug, workflow)",
    })
  ),
  importance: Type.Optional(ImportanceEnum),
  context: Type.Optional(Type.String({ description: "Additional context or metadata" })),
});

const SearchSchema = Type.Object({
  query: Type.Optional(
    Type.String({ description: "FTS5 full-text search query (searches content/tags/context)" })
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), { description: "Filter by tags (OR semantics — any match)" })
  ),
  importance: Type.Optional(ImportanceEnum),
  limit: Type.Optional(Type.Number({ description: "Max results (default: 50)" })),
  since: Type.Optional(
    Type.Number({ description: "Only memories created after this timestamp (ms)" })
  ),
  sessionOnly: Type.Optional(
    Type.Boolean({ description: "Only memories from current session (default: false)" })
  ),
});

const ForgetSchema = Type.Object({
  id: Type.Number({ description: "Memory ID to delete" }),
});

// ============ Tool Definitions ============

const deltaRemember = createTool(
  "delta_remember",
  "Remember",
  "Store a new memory. Use after making decisions, discovering bugs, learning patterns, or finding important information. Supports tags for classification and importance levels (low/normal/high/critical).",
  RememberSchema,
  (input) => {
    const id = remember(input.content, {
      tags: input.tags,
      importance: input.importance as Importance | undefined,
      context: input.context,
    });

    const tagsStr = input.tags && input.tags.length > 0 ? ` {${input.tags.join(", ")}}` : "";
    const impStr = input.importance ? ` [${input.importance}]` : "";
    return `✓ Stored memory #${id}${impStr}${tagsStr}`;
  }
);

const deltaSearch = createTool(
  "delta_search",
  "Search",
  "Search memories using full-text search and/or structured filters. Returns matching memories with ID, content, tags, importance, and timestamps. Use to recall past decisions, find patterns, or check previous context.",
  SearchSchema,
  (input) => {
    const opts: SearchOptions = {
      query: input.query,
      tags: input.tags,
      importance: input.importance as Importance | undefined,
      limit: input.limit,
      since: input.since,
      sessionOnly: input.sessionOnly,
    };

    const results = search(opts);

    if (results.length === 0) {
      return "No memories found matching your query.";
    }

    const lines: string[] = [];
    lines.push(`Found ${results.length} ${results.length === 1 ? "memory" : "memories"}:\n`);

    for (const mem of results) {
      const impBadge = mem.importance !== "normal" ? ` [${mem.importance.toUpperCase()}]` : "";
      const tagStr = mem.tags.length > 0 ? ` {${mem.tags.join(", ")}}` : "";
      const sessionStr = mem.session_id ? "" : " (archived)";
      const date = new Date(mem.created_at).toISOString().split("T")[0];

      lines.push(`## Memory #${mem.id}${impBadge}${tagStr}${sessionStr}`);
      lines.push(`Created: ${date}`);
      if (mem.context) {
        lines.push(`Context: ${mem.context}`);
      }
      lines.push("");
      lines.push(mem.content);
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    return lines.join("\n");
  }
);

const deltaForget = createTool(
  "delta_forget",
  "Forget",
  "Delete a memory by ID. Use to remove outdated, incorrect, or no-longer-relevant memories. Returns success status.",
  ForgetSchema,
  (input) => {
    const deleted = forget(input.id);
    if (deleted) {
      return `✓ Deleted memory #${input.id}`;
    }
    return `✗ Memory #${input.id} not found`;
  }
);

const deltaInfo = createTool(
  "delta_info",
  "Memory Info",
  "Show Delta database location and basic statistics. Use to check where memories are stored or verify database status.",
  Type.Object({}),
  () => {
    const dbPath = getDbLocation();
    const versionInfo = getVersionInfo();
    const memories = search({ limit: 1000 }); // Get all for stats
    const total = memories.length;

    const byCriticality = {
      critical: memories.filter((m) => m.importance === "critical").length,
      high: memories.filter((m) => m.importance === "high").length,
      normal: memories.filter((m) => m.importance === "normal").length,
      low: memories.filter((m) => m.importance === "low").length,
    };

    const lines: string[] = [];
    lines.push("# Delta Memory Database");
    lines.push("");
    lines.push(`**Location**: \`${dbPath}\``);
    lines.push(
      `**Schema Version**: ${versionInfo.current} ${versionInfo.match ? "✓" : `(shipped: ${versionInfo.shipped})`}`
    );
    lines.push("");
    lines.push(`**Total Memories**: ${total}`);
    if (total > 0) {
      lines.push(`- Critical: ${byCriticality.critical}`);
      lines.push(`- High: ${byCriticality.high}`);
      lines.push(`- Normal: ${byCriticality.normal}`);
      lines.push(`- Low: ${byCriticality.low}`);
    }

    return lines.join("\n");
  }
);

const deltaVersion = createTool(
  "delta_version",
  "Schema Version",
  "Show Delta schema version information. Use to check for schema mismatches or verify migrations.",
  Type.Object({}),
  () => {
    const info = getVersionInfo();
    const lines: string[] = [];
    lines.push("# Delta Schema Version");
    lines.push("");
    lines.push(`**Current**: ${info.current ?? "unknown"}`);
    lines.push(`**Shipped**: ${info.shipped}`);
    lines.push(`**Status**: ${info.match ? "✓ Up to date" : "⚠ Version mismatch"}`);

    if (!info.match) {
      lines.push("");
      lines.push(
        "_Note: Schema version mismatch may indicate incomplete migration or outdated extension._"
      );
    }

    return lines.join("\n");
  }
);

const deltaSchema = createTool(
  "delta_schema",
  "DB Schema",
  "Dump the full database schema (tables, indexes, triggers). Use for debugging or understanding the storage structure.",
  Type.Object({}),
  () => {
    const schema = getDatabaseSchema();
    return `# Delta Database Schema\n\n\`\`\`sql\n${schema}\n\`\`\``;
  }
);

// ============ Tool Registration ============

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool(deltaRemember);
  pi.registerTool(deltaSearch);
  pi.registerTool(deltaForget);
  pi.registerTool(deltaInfo);
  pi.registerTool(deltaVersion);
  pi.registerTool(deltaSchema);
}
