import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import {
  type ListNotesOptions,
  type ListTasksOptions,
  type ProjectNote,
  type RecallOptions,
  type Task,
  createNote,
  createTask,
  deleteNote,
  deleteTask,
  getDbLocation,
  getNote,
  getTask,
  kvDelete,
  kvGet,
  kvSet,
  listNotes,
  listTasks,
  logEpisode,
  recallEpisodes,
  updateNote,
  updateTask,
} from "./db.js";

// ============ Schemas ============

const GetSchema = Type.Object({
  key: Type.String({ description: "Key to retrieve" }),
});

const SetSchema = Type.Object({
  key: Type.String({ description: "Key to store" }),
  value: Type.String({ description: "Value to store" }),
});

const DeleteSchema = Type.Object({
  key: Type.String({ description: "Key to delete" }),
});

const LogSchema = Type.Object({
  content: Type.String({ description: "Event/fact to remember" }),
  context: Type.Optional(Type.String({ description: "Additional context (e.g., file, task)" })),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tags for categorization (e.g., ['decision', 'bug'])",
    })
  ),
});

const RecallSchema = Type.Object({
  query: Type.Optional(Type.String({ description: "Search term to filter content" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags" })),
  limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
  sessionOnly: Type.Optional(
    Type.Boolean({ description: "Only current session (default: false)" })
  ),
  since: Type.Optional(Type.Number({ description: "Unix timestamp to filter from" })),
});

const TaskStatusEnum = Type.Union([
  Type.Literal("todo"),
  Type.Literal("in_progress"),
  Type.Literal("blocked"),
  Type.Literal("done"),
  Type.Literal("cancelled"),
]);

const TaskPriorityEnum = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

const TaskScopeEnum = Type.Union([Type.Literal("session"), Type.Literal("project")]);

const TaskCreateSchema = Type.Object({
  title: Type.String({ description: "Task title" }),
  description: Type.Optional(Type.String({ description: "Task description" })),
  status: Type.Optional(TaskStatusEnum),
  priority: Type.Optional(TaskPriorityEnum),
  scope: Type.Optional(TaskScopeEnum),
  tags: Type.Optional(Type.Array(Type.String())),
  parent_id: Type.Optional(Type.Number({ description: "Parent task ID for subtasks" })),
});

const TaskListSchema = Type.Object({
  status: Type.Optional(
    Type.Union([TaskStatusEnum, Type.Array(TaskStatusEnum)], {
      description: "Filter by status (single or array)",
    })
  ),
  scope: Type.Optional(TaskScopeEnum),
  priority: Type.Optional(TaskPriorityEnum),
  tags: Type.Optional(Type.Array(Type.String())),
  parent_id: Type.Optional(
    Type.Union([Type.Number(), Type.Null()], {
      description: "Filter by parent (null = root tasks only)",
    })
  ),
  sessionOnly: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Number()),
});

const TaskUpdateSchema = Type.Object({
  id: Type.Number({ description: "Task ID to update" }),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  status: Type.Optional(TaskStatusEnum),
  priority: Type.Optional(TaskPriorityEnum),
  tags: Type.Optional(Type.Array(Type.String())),
  parent_id: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

const TaskDeleteSchema = Type.Object({
  id: Type.Number({ description: "Task ID to delete" }),
});

const TaskGetSchema = Type.Object({
  id: Type.Number({ description: "Task ID to retrieve" }),
});

// ============ Helper ============

function createTool<T extends TSchema>(
  name: string,
  label: string,
  description: string,
  parameters: T,
  handler: (params: Static<T>) => string
): ToolDefinition<T, undefined> {
  return {
    name,
    label,
    description,
    parameters,
    execute: async (
      _toolCallId: string,
      params: Static<T>,
      _onUpdate: AgentToolUpdateCallback<undefined> | undefined,
      _ctx: ExtensionContext,
      _signal?: AbortSignal
    ): Promise<AgentToolResult<undefined>> => {
      try {
        const output = handler(params);
        return { content: [{ type: "text", text: output }], details: undefined };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${msg}` }], details: undefined };
      }
    },
  };
}

// ============ KV Tools ============

const deltaGet = createTool(
  "delta_get",
  "Memory Get",
  "Get a value from persistent key-value memory. Returns null if key doesn't exist.",
  GetSchema,
  ({ key }) => {
    const value = kvGet(key);
    return value === null ? `Key "${key}" not found` : value;
  }
);

const deltaSet = createTool(
  "delta_set",
  "Memory Set",
  "Store a key-value pair in persistent memory. Overwrites if key exists.",
  SetSchema,
  ({ key, value }) => {
    kvSet(key, value);
    return `Stored "${key}"`;
  }
);

const deltaDelete = createTool(
  "delta_delete",
  "Memory Delete",
  "Delete a key from persistent memory.",
  DeleteSchema,
  ({ key }) => {
    const deleted = kvDelete(key);
    return deleted ? `Deleted "${key}"` : `Key "${key}" not found`;
  }
);

// ============ Episodic Tools ============

const deltaLog = createTool(
  "delta_log",
  "Memory Log",
  "Log an event, decision, or fact to episodic memory with timestamp. Use to remember important events, decisions made, bugs found, user preferences, etc.",
  LogSchema,
  ({ content, context, tags }) => {
    const id = logEpisode(content, context, tags);
    return `Logged episode #${id}`;
  }
);

const deltaRecall = createTool(
  "delta_recall",
  "Memory Recall",
  "Search and recall past events/facts from episodic memory. Filter by text query, tags, time range, or session.",
  RecallSchema,
  (options) => {
    const episodes = recallEpisodes(options as RecallOptions);

    if (episodes.length === 0) {
      return "No episodes found matching criteria";
    }

    const formatted = episodes
      .map((ep) => {
        const date = new Date(ep.timestamp).toISOString();
        const tagsStr = ep.tags.length > 0 ? ` [${ep.tags.join(", ")}]` : "";
        const ctxStr = ep.context ? ` (${ep.context})` : "";
        return `#${ep.id} ${date}${tagsStr}${ctxStr}\n  ${ep.content}`;
      })
      .join("\n\n");

    return `Found ${episodes.length} episodes:\n\n${formatted}`;
  }
);

// ============ Task Tools ============

function formatTask(task: Task): string {
  const date = new Date(task.created_at).toISOString().split("T")[0];
  const tagsStr = task.tags.length > 0 ? ` [${task.tags.join(", ")}]` : "";
  const parentStr = task.parent_id ? ` (subtask of #${task.parent_id})` : "";
  const statusIcon = {
    todo: "○",
    in_progress: "◐",
    blocked: "⊘",
    done: "●",
    cancelled: "✕",
  }[task.status];

  return `${statusIcon} #${task.id} [${task.priority}] ${task.title}${tagsStr}${parentStr}\n  ${task.scope} | ${task.status} | ${date}${task.description ? `\n  ${task.description}` : ""}`;
}

const deltaTaskCreate = createTool(
  "delta_task_create",
  "Create Task",
  "Create a new task. Scope: 'session' (current session only) or 'project' (persists across sessions). Priority: low/medium/high/critical. Status: todo/in_progress/blocked/done/cancelled.",
  TaskCreateSchema,
  (input) => {
    const id = createTask(input);
    const task = getTask(id);
    return `Created task #${id}:\n${task ? formatTask(task) : ""}`;
  }
);

const deltaTaskList = createTool(
  "delta_task_list",
  "List Tasks",
  "List tasks with optional filters. Filter by status, scope, priority, tags, or parent_id (null = root tasks only).",
  TaskListSchema,
  (options) => {
    const tasks = listTasks(options as ListTasksOptions);

    if (tasks.length === 0) {
      return "No tasks found matching criteria";
    }

    const formatted = tasks.map(formatTask).join("\n\n");
    return `Found ${tasks.length} tasks:\n\n${formatted}`;
  }
);

const deltaTaskUpdate = createTool(
  "delta_task_update",
  "Update Task",
  "Update an existing task. Only provided fields will be updated.",
  TaskUpdateSchema,
  ({ id, ...updates }) => {
    const updated = updateTask(id, updates);
    if (!updated) {
      return `Task #${id} not found`;
    }
    const task = getTask(id);
    return `Updated task #${id}:\n${task ? formatTask(task) : ""}`;
  }
);

const deltaTaskDelete = createTool(
  "delta_task_delete",
  "Delete Task",
  "Delete a task by ID. Also deletes subtasks.",
  TaskDeleteSchema,
  ({ id }) => {
    const deleted = deleteTask(id);
    return deleted ? `Deleted task #${id}` : `Task #${id} not found`;
  }
);

const deltaTaskGet = createTool(
  "delta_task_get",
  "Get Task",
  "Get a single task by ID with full details.",
  TaskGetSchema,
  ({ id }) => {
    const task = getTask(id);
    if (!task) {
      return `Task #${id} not found`;
    }
    return formatTask(task);
  }
);

// ============ Note Schemas ============

const NoteCategoryEnum = Type.Union([
  Type.Literal("issue"),
  Type.Literal("convention"),
  Type.Literal("workflow"),
  Type.Literal("reminder"),
  Type.Literal("general"),
]);

const NoteImportanceEnum = Type.Union([
  Type.Literal("low"),
  Type.Literal("normal"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

const NoteCreateSchema = Type.Object({
  title: Type.String({ description: "Note title" }),
  content: Type.String({ description: "Note content (markdown supported)" }),
  category: Type.Optional(NoteCategoryEnum),
  importance: Type.Optional(NoteImportanceEnum),
  active: Type.Optional(
    Type.Boolean({ description: "Whether note is active (loaded at session start)" })
  ),
});

const NoteListSchema = Type.Object({
  category: Type.Optional(NoteCategoryEnum),
  importance: Type.Optional(NoteImportanceEnum),
  activeOnly: Type.Optional(Type.Boolean({ description: "Only active notes (default: false)" })),
  limit: Type.Optional(Type.Number()),
});

const NoteUpdateSchema = Type.Object({
  id: Type.Number({ description: "Note ID to update" }),
  title: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  category: Type.Optional(NoteCategoryEnum),
  importance: Type.Optional(NoteImportanceEnum),
  active: Type.Optional(Type.Boolean()),
});

const NoteDeleteSchema = Type.Object({
  id: Type.Number({ description: "Note ID to delete" }),
});

const NoteGetSchema = Type.Object({
  id: Type.Number({ description: "Note ID to retrieve" }),
});

// ============ Note Tools ============

function formatNote(note: ProjectNote): string {
  const date = new Date(note.created_at).toISOString().split("T")[0];
  const activeStr = note.active ? "active" : "archived";
  const impStr = note.importance !== "normal" ? ` [${note.importance.toUpperCase()}]` : "";

  return `#${note.id}${impStr} ${note.title}\n  ${note.category} | ${activeStr} | ${date}\n  ${note.content.substring(0, 100)}${note.content.length > 100 ? "..." : ""}`;
}

const deltaNoteCreate = createTool(
  "delta_note_create",
  "Create Note",
  "Create a project note for persistent context. Notes marked 'active' are automatically loaded at session start. Categories: issue, convention, workflow, reminder, general. Use for project-specific issues, coding conventions, workflow notes, or reminders.",
  NoteCreateSchema,
  (input) => {
    const id = createNote(input);
    const note = getNote(id);
    return `Created note #${id}:\n${note ? formatNote(note) : ""}`;
  }
);

const deltaNoteList = createTool(
  "delta_note_list",
  "List Notes",
  "List project notes with optional filters.",
  NoteListSchema,
  (options) => {
    const notes = listNotes(options as ListNotesOptions);

    if (notes.length === 0) {
      return "No notes found matching criteria";
    }

    const formatted = notes.map(formatNote).join("\n\n");
    return `Found ${notes.length} notes:\n\n${formatted}`;
  }
);

const deltaNoteUpdate = createTool(
  "delta_note_update",
  "Update Note",
  "Update an existing project note. Set active=false to archive.",
  NoteUpdateSchema,
  ({ id, ...updates }) => {
    const updated = updateNote(id, updates);
    if (!updated) {
      return `Note #${id} not found`;
    }
    const note = getNote(id);
    return `Updated note #${id}:\n${note ? formatNote(note) : ""}`;
  }
);

const deltaNoteDelete = createTool(
  "delta_note_delete",
  "Delete Note",
  "Permanently delete a project note.",
  NoteDeleteSchema,
  ({ id }) => {
    const deleted = deleteNote(id);
    return deleted ? `Deleted note #${id}` : `Note #${id} not found`;
  }
);

const deltaNoteGet = createTool(
  "delta_note_get",
  "Get Note",
  "Get a single project note by ID with full content.",
  NoteGetSchema,
  ({ id }) => {
    const note = getNote(id);
    if (!note) {
      return `Note #${id} not found`;
    }
    const date = new Date(note.created_at).toISOString().split("T")[0];
    const activeStr = note.active ? "active" : "archived";
    const impStr = note.importance !== "normal" ? ` [${note.importance.toUpperCase()}]` : "";
    return `#${note.id}${impStr} ${note.title}\n${note.category} | ${activeStr} | ${date}\n\n${note.content}`;
  }
);

// ============ Info Tool ============

const InfoSchema = Type.Object({});

const deltaInfo = createTool(
  "delta_info",
  "Memory Info",
  "Get information about the delta memory database location and stats.",
  InfoSchema,
  () => {
    const location = getDbLocation();
    return `Database location: ${location}`;
  }
);

// ============ Export ============

export function registerTools(pi: ExtensionAPI): void {
  // KV
  pi.registerTool(deltaGet);
  pi.registerTool(deltaSet);
  pi.registerTool(deltaDelete);
  // Episodic
  pi.registerTool(deltaLog);
  pi.registerTool(deltaRecall);
  // Tasks
  pi.registerTool(deltaTaskCreate);
  pi.registerTool(deltaTaskList);
  pi.registerTool(deltaTaskUpdate);
  pi.registerTool(deltaTaskDelete);
  pi.registerTool(deltaTaskGet);
  // Notes
  pi.registerTool(deltaNoteCreate);
  pi.registerTool(deltaNoteList);
  pi.registerTool(deltaNoteUpdate);
  pi.registerTool(deltaNoteDelete);
  pi.registerTool(deltaNoteGet);
  // Info
  pi.registerTool(deltaInfo);
}
