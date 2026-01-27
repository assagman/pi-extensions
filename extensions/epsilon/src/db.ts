/**
 * Epsilon — Task management database layer.
 *
 * Storage: ~/.local/share/pi-ext-epsilon/<repo-id>/epsilon.db
 * Tables:  tasks, schema_version
 */
import type Database from "better-sqlite3";
import {
  ensureSchemaVersion,
  getExtensionDbPath,
  openDatabase,
  escapeLike as sharedEscapeLike,
} from "pi-ext-shared";

// ============ Constants ============

export const DB_VERSION = 1;

// ============ State ============

let db: Database.Database | null = null;
let currentDbPath: string | null = null;

function escapeLike(s: string): string {
  return sharedEscapeLike(s);
}

// ============ Database Lifecycle ============

function getDbPath(): string {
  return getExtensionDbPath("pi-ext-epsilon", "epsilon");
}

export function getDb(): Database.Database {
  const dbPath = getDbPath();

  if (db && currentDbPath !== dbPath) {
    db.close();
    db = null;
  }

  if (!db) {
    currentDbPath = dbPath;
    db = openDatabase(dbPath);
    initSchema();
  }
  return db;
}

// ============ Schema ============

function initSchema(): void {
  if (!db) throw new Error("Database not initialized");

  ensureSchemaVersion(db, DB_VERSION);

  db.exec(`
    -- Tasks with subtask support
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT DEFAULT 'medium',
      tags TEXT,
      parent_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
  `);
}

// ============ Types ============

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";

export const TASK_STATUS_ICONS: Record<TaskStatus, string> = {
  todo: "○",
  in_progress: "◐",
  blocked: "⊘",
  done: "●",
  cancelled: "✕",
};

export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  parent_id: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  parent_id?: number;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  parent_id?: number | null;
}

export interface ListTasksOptions {
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority;
  tags?: string[];
  parent_id?: number | null;
  limit?: number;
}

// ============ Parent Validation ============

const MAX_PARENT_DEPTH = 100;

function validateParentId(parentId: number | null | undefined, taskId?: number): void {
  if (parentId === undefined || parentId === null) return;

  const parent = getDb().prepare("SELECT id FROM tasks WHERE id = ?").get(parentId) as
    | { id: number }
    | undefined;
  if (!parent) throw new Error(`Parent task #${parentId} not found`);

  if (taskId !== undefined && parentId === taskId) {
    throw new Error("Task cannot be its own parent");
  }

  if (taskId !== undefined) {
    let currentParentId: number | null = parentId;
    const visited = new Set<number>();
    let depth = 0;
    while (currentParentId !== null) {
      if (++depth > MAX_PARENT_DEPTH) throw new Error("Task hierarchy too deep or cycle detected");
      if (visited.has(currentParentId)) break;
      visited.add(currentParentId);
      const ancestor = getDb()
        .prepare("SELECT parent_id FROM tasks WHERE id = ?")
        .get(currentParentId) as { parent_id: number | null } | undefined;
      if (!ancestor) break;
      if (ancestor.parent_id === taskId) throw new Error("Circular parent reference detected");
      currentParentId = ancestor.parent_id;
    }
  }
}

// ============ CRUD Operations ============

export function createTask(input: CreateTaskInput): number {
  validateParentId(input.parent_id);
  const now = Date.now();

  const row = getDb()
    .prepare(
      `INSERT INTO tasks (title, description, status, priority, tags, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .get(
      input.title,
      input.description ?? null,
      input.status ?? "todo",
      input.priority ?? "medium",
      input.tags ? JSON.stringify(input.tags) : null,
      input.parent_id ?? null,
      now,
      now
    ) as { id: number };
  return row.id;
}

export function getTask(id: number): Task | null {
  const row = getDb()
    .prepare(
      "SELECT id, title, description, status, priority, tags, parent_id, created_at, updated_at, completed_at FROM tasks WHERE id = ?"
    )
    .get(id) as
    | {
        id: number;
        title: string;
        description: string | null;
        status: TaskStatus;
        priority: TaskPriority;
        tags: string | null;
        parent_id: number | null;
        created_at: number;
        updated_at: number;
        completed_at: number | null;
      }
    | undefined;

  if (!row) return null;
  return { ...row, tags: row.tags ? JSON.parse(row.tags) : [] };
}

export function listTasks(options: ListTasksOptions = {}): Task[] {
  const { status, priority, tags, parent_id, limit = 50 } = options;

  let sql =
    "SELECT id, title, description, status, priority, tags, parent_id, created_at, updated_at, completed_at FROM tasks WHERE 1=1";
  const params: (string | number)[] = [];

  if (status) {
    if (Array.isArray(status)) {
      sql += ` AND status IN (${status.map(() => "?").join(", ")})`;
      params.push(...status);
    } else {
      sql += " AND status = ?";
      params.push(status);
    }
  }

  if (priority) {
    sql += " AND priority = ?";
    params.push(priority);
  }

  if (parent_id !== undefined) {
    if (parent_id === null) {
      sql += " AND parent_id IS NULL";
    } else {
      sql += " AND parent_id = ?";
      params.push(parent_id);
    }
  }

  if (tags && tags.length > 0) {
    const tagConditions = tags.map(() => "tags LIKE ? ESCAPE '\\'").join(" OR ");
    sql += ` AND (${tagConditions})`;
    for (const tag of tags) params.push(`%"${escapeLike(tag)}"%`);
  }

  sql += " ORDER BY priority DESC, created_at DESC LIMIT ?";
  params.push(limit);

  const rows = getDb()
    .prepare(sql)
    .all(...params) as Array<{
    id: number;
    title: string;
    description: string | null;
    status: TaskStatus;
    priority: TaskPriority;
    tags: string | null;
    parent_id: number | null;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
  }>;

  return rows.map((row) => ({ ...row, tags: row.tags ? JSON.parse(row.tags) : [] }));
}

export function updateTask(id: number, input: UpdateTaskInput): boolean {
  if (input.parent_id !== undefined) validateParentId(input.parent_id, id);

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.title !== undefined) {
    updates.push("title = ?");
    params.push(input.title);
  }
  if (input.description !== undefined) {
    updates.push("description = ?");
    params.push(input.description);
  }
  if (input.status !== undefined) {
    updates.push("status = ?");
    params.push(input.status);
    if (input.status === "done" || input.status === "cancelled") {
      updates.push("completed_at = ?");
      params.push(Date.now());
    }
  }
  if (input.priority !== undefined) {
    updates.push("priority = ?");
    params.push(input.priority);
  }
  if (input.tags !== undefined) {
    updates.push("tags = ?");
    params.push(JSON.stringify(input.tags));
  }
  if (input.parent_id !== undefined) {
    updates.push("parent_id = ?");
    params.push(input.parent_id);
  }

  if (updates.length === 0) return false;

  updates.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);

  const sql = `UPDATE tasks SET ${updates.join(", ")} WHERE id = ? RETURNING id`;
  const row = getDb()
    .prepare(sql)
    .get(...params) as { id: number } | undefined;
  return row !== undefined;
}

export function deleteTask(id: number): boolean {
  const row = getDb().prepare("DELETE FROM tasks WHERE id = ? RETURNING id").get(id) as
    | { id: number }
    | undefined;
  return row !== undefined;
}

// ============ Task Summary ============

export interface TaskSummary {
  todo: number;
  in_progress: number;
  blocked: number;
  done: number;
  cancelled: number;
  activeTasks: Task[];
}

export function getTaskSummary(): TaskSummary {
  const database = getDb();

  const counts = database
    .prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
    .all() as Array<{ status: TaskStatus; count: number }>;

  const summary: TaskSummary = {
    todo: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
    activeTasks: [],
  };

  for (const row of counts) {
    summary[row.status] = row.count;
  }

  summary.activeTasks = listTasks({
    status: ["todo", "in_progress", "blocked"],
    limit: 20,
  });

  return summary;
}

// ============ Prompt Builder ============

export function buildTasksPrompt(): string {
  const summary = getTaskSummary();
  const lines: string[] = [];

  lines.push("<epsilon_tasks>");
  lines.push("");

  lines.push("## Task Workflow");
  lines.push("1. Create tasks for ALL work items using epsilon_task_create");
  lines.push("2. Update task status as you progress (in_progress, done, blocked)");
  lines.push("3. Mark tasks done when complete using epsilon_task_update");
  lines.push("");

  const activeCount = summary.todo + summary.in_progress + summary.blocked;
  if (activeCount > 0) {
    lines.push("## Active Tasks");
    for (const task of summary.activeTasks) {
      const icon = TASK_STATUS_ICONS[task.status];
      const priority = task.priority !== "medium" ? ` [${task.priority}]` : "";
      const tags = task.tags.length > 0 ? ` [${task.tags.join(", ")}]` : "";
      lines.push(`  ${icon} #${task.id}${priority} ${task.title}${tags}`);
      if (task.description) {
        lines.push(`    ${task.description.substring(0, 100)}`);
      }
    }
    lines.push("");
  }

  lines.push("## Overview");
  lines.push(
    `Status: ${summary.todo} todo, ${summary.in_progress} in progress, ${summary.blocked} blocked, ${summary.done} done`
  );
  lines.push("");

  lines.push("</epsilon_tasks>");

  return lines.join("\n");
}

// ============ Version & Info ============

export interface VersionInfo {
  current: number | null;
  shipped: number;
  match: boolean;
}

export function getVersionInfo(): VersionInfo {
  const database = getDb();
  const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? null;
  return { current, shipped: DB_VERSION, match: current === DB_VERSION };
}

export function getDatabaseSchema(): string {
  const database = getDb();
  const rows = database
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
    .all() as Array<{ type: string; name: string; sql: string }>;
  if (rows.length === 0) return "No schema objects found.";
  return rows.map((r) => `-- ${r.type}: ${r.name}\n${r.sql};`).join("\n\n");
}

// ============ Utility ============

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    currentDbPath = null;
  }
}

export function getDbLocation(): string {
  return getDbPath();
}
