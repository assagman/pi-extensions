/**
 * Epsilon tools — task management operations.
 *
 * Tools: 7 total
 *   Tasks:   epsilon_task_create/list/update/delete/get (5)
 *   Info:    epsilon_info (1)
 *   Version: epsilon_version (1)
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createTool } from "pi-ext-shared";
import {
  type ListTasksOptions,
  TASK_STATUS_ICONS,
  type Task,
  createTask,
  deleteTask,
  getDbLocation,
  getTask,
  getVersionInfo,
  listTasks,
  updateTask,
} from "./db.js";

// ============ Schemas ============

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

const TaskCreateSchema = Type.Object({
  title: Type.String({ description: "Task title" }),
  description: Type.Optional(Type.String({ description: "Task description" })),
  status: Type.Optional(TaskStatusEnum),
  priority: Type.Optional(TaskPriorityEnum),
  tags: Type.Optional(Type.Array(Type.String())),
  parent_id: Type.Optional(Type.Number({ description: "Parent task ID for subtasks" })),
});

const TaskListSchema = Type.Object({
  status: Type.Optional(
    Type.Union([TaskStatusEnum, Type.Array(TaskStatusEnum)], {
      description: "Filter by status (single or array)",
    })
  ),
  priority: Type.Optional(TaskPriorityEnum),
  tags: Type.Optional(Type.Array(Type.String())),
  parent_id: Type.Optional(
    Type.Union([Type.Number(), Type.Null()], {
      description: "Filter by parent (null = root tasks only)",
    })
  ),
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

const InfoSchema = Type.Object({});
const VersionSchema = Type.Object({});

// ============ Helpers ============

function formatTask(task: Task): string {
  const date = new Date(task.created_at).toISOString().split("T")[0];
  const tagsStr = task.tags.length > 0 ? ` [${task.tags.join(", ")}]` : "";
  const parentStr = task.parent_id ? ` (subtask of #${task.parent_id})` : "";
  const statusIcon = TASK_STATUS_ICONS[task.status];
  return `${statusIcon} #${task.id} [${task.priority}] ${task.title}${tagsStr}${parentStr}\n  ${task.status} | ${date}${task.description ? `\n  ${task.description}` : ""}`;
}

// ============ Task Tools ============

const epsilonTaskCreate = createTool(
  "epsilon_task_create",
  "Create Task",
  "Create a new task. Priority: low/medium/high/critical. Status: todo/in_progress/blocked/done/cancelled.",
  TaskCreateSchema,
  (input) => {
    const id = createTask(input);
    const task = getTask(id);
    return `Created task #${id}:\n${task ? formatTask(task) : ""}`;
  }
);

const epsilonTaskList = createTool(
  "epsilon_task_list",
  "List Tasks",
  "List tasks with optional filters. Filter by status, priority, tags, or parent_id (null = root tasks only).",
  TaskListSchema,
  (options) => {
    const tasks = listTasks(options as ListTasksOptions);
    if (tasks.length === 0) return "No tasks found matching criteria";
    return `Found ${tasks.length} tasks:\n\n${tasks.map(formatTask).join("\n\n")}`;
  }
);

const epsilonTaskUpdate = createTool(
  "epsilon_task_update",
  "Update Task",
  "Update an existing task. Only provided fields will be updated.",
  TaskUpdateSchema,
  ({ id, ...updates }) => {
    const updated = updateTask(id, updates);
    if (!updated) return `Task #${id} not found`;
    const task = getTask(id);
    return `Updated task #${id}:\n${task ? formatTask(task) : ""}`;
  }
);

const epsilonTaskDelete = createTool(
  "epsilon_task_delete",
  "Delete Task",
  "Delete a task by ID. Also deletes subtasks.",
  TaskDeleteSchema,
  ({ id }) => {
    const deleted = deleteTask(id);
    return deleted ? `Deleted task #${id}` : `Task #${id} not found`;
  }
);

const epsilonTaskGet = createTool(
  "epsilon_task_get",
  "Get Task",
  "Get a single task by ID with full details.",
  TaskGetSchema,
  ({ id }) => {
    const task = getTask(id);
    if (!task) return `Task #${id} not found`;
    return formatTask(task);
  }
);

// ============ Info & Version ============

const epsilonInfo = createTool(
  "epsilon_info",
  "Task DB Info",
  "Get information about the epsilon task database location.",
  InfoSchema,
  () => `Database location: ${getDbLocation()}`
);

const epsilonVersion = createTool(
  "epsilon_version",
  "Task DB Version",
  "Reports the epsilon DB version info.",
  VersionSchema,
  () => {
    const info = getVersionInfo();
    const currentStr = info.current === null ? "unversioned" : String(info.current);
    const status = info.match ? "✓ Up to date" : `⚠ MISMATCH (${info.current} → ${info.shipped})`;
    return `Task DB Version: shipped=${info.shipped}, current=${currentStr}, ${status}`;
  }
);

// ============ Export ============

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool(epsilonTaskCreate);
  pi.registerTool(epsilonTaskList);
  pi.registerTool(epsilonTaskUpdate);
  pi.registerTool(epsilonTaskDelete);
  pi.registerTool(epsilonTaskGet);
  pi.registerTool(epsilonInfo);
  pi.registerTool(epsilonVersion);
}
