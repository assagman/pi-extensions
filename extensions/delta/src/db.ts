import { exec, execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";

const execAsync = promisify(exec);

const BASE_DIR = join(homedir(), ".local", "share", "pi-ext-delta");

let db: Database.Database | null = null;
let currentSessionId: string | null = null;
let currentDbPath: string | null = null;
const cachedBranch: Map<string, string> = new Map();

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getSessionId(): string {
  if (!currentSessionId) {
    currentSessionId = generateSessionId();
  }
  return currentSessionId;
}

function sanitizePath(path: string): string {
  return path
    .replace(/^\//, "") // remove leading slash
    .replace(/\//g, "_") // replace slashes with underscores
    .replace(/[^a-zA-Z0-9_.-]/g, "_") // replace special chars
    .substring(0, 200); // limit length
}

/**
 * Pre-warm the git branch cache asynchronously.
 * Call this from session_start to avoid blocking execSync on first DB access.
 */
export async function initBranchCacheAsync(cwd: string): Promise<void> {
  if (cachedBranch.has(cwd)) return;

  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd });
    const sanitized = sanitizePath(stdout.trim());
    cachedBranch.set(cwd, sanitized);
  } catch {
    cachedBranch.set(cwd, "no-git");
  }
}

function getGitBranch(cwd: string): string {
  // Check cache first (should be pre-warmed by initBranchCacheAsync)
  const cached = cachedBranch.get(cwd);
  if (cached) return cached;

  // Fallback to sync if cache miss (e.g., cwd changed unexpectedly)
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000, // 5s timeout to prevent indefinite blocking
    }).trim();
    const sanitized = sanitizePath(branch);
    cachedBranch.set(cwd, sanitized);
    return sanitized;
  } catch {
    cachedBranch.set(cwd, "no-git");
    return "no-git";
  }
}

function getDbPath(cwd: string): string {
  const sanitizedCwd = sanitizePath(cwd);
  const branch = getGitBranch(cwd);
  const dirName = `${sanitizedCwd}-${branch}`;
  const dirPath = join(BASE_DIR, dirName);

  // Security: Ensure path stays within BASE_DIR (CWE-22 mitigation)
  const resolvedPath = resolve(dirPath);
  const resolvedBase = resolve(BASE_DIR);
  if (!resolvedPath.startsWith(`${resolvedBase}/`) && resolvedPath !== resolvedBase) {
    throw new Error("Invalid database path: path traversal detected");
  }

  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }

  return join(dirPath, "delta.db");
}

export function getDb(): Database.Database {
  const cwd = process.cwd();
  const dbPath = getDbPath(cwd);

  // Reopen if cwd changed
  if (db && currentDbPath !== dbPath) {
    db.close();
    db = null;
  }

  if (!db) {
    currentDbPath = dbPath;
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    initSchema();
  }
  return db;
}

function initSchema(): void {
  if (!db) throw new Error("Database not initialized");
  const database = db;

  database.exec(`
    -- Key-Value Store
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Episodic Memory
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      context TEXT,
      tags TEXT,
      timestamp INTEGER NOT NULL,
      session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON episodes(timestamp);
    CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);

    -- Tasks
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT DEFAULT 'medium',
      scope TEXT NOT NULL DEFAULT 'project',
      tags TEXT,
      parent_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      session_id TEXT,
      FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks(scope);
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

    -- Project Notes (persistent context for agent)
    CREATE TABLE IF NOT EXISTS project_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      importance TEXT NOT NULL DEFAULT 'normal',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notes_category ON project_notes(category);
    CREATE INDEX IF NOT EXISTS idx_notes_active ON project_notes(active);
    CREATE INDEX IF NOT EXISTS idx_notes_importance ON project_notes(importance);
  `);
}

// ============ Key-Value Operations ============

export function kvGet(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM kv WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO kv (key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`
    )
    .run(key, value, now, now, value, now);
}

export function kvDelete(key: string): boolean {
  const result = getDb().prepare("DELETE FROM kv WHERE key = ?").run(key);
  return result.changes > 0;
}

// ============ Episodic Operations ============

export interface Episode {
  id: number;
  content: string;
  context: string | null;
  tags: string[];
  timestamp: number;
  session_id: string | null;
}

export function logEpisode(content: string, context?: string, tags?: string[]): number {
  const result = getDb()
    .prepare(
      `INSERT INTO episodes (content, context, tags, timestamp, session_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(content, context ?? null, tags ? JSON.stringify(tags) : null, Date.now(), getSessionId());
  return result.lastInsertRowid as number;
}

export interface RecallOptions {
  query?: string;
  tags?: string[];
  limit?: number;
  sessionOnly?: boolean;
  since?: number;
}

export function recallEpisodes(options: RecallOptions = {}): Episode[] {
  const { query, tags, limit = 20, sessionOnly = false, since } = options;

  let sql = "SELECT * FROM episodes WHERE 1=1";
  const params: (string | number)[] = [];

  if (sessionOnly) {
    sql += " AND session_id = ?";
    params.push(getSessionId());
  }

  if (since) {
    sql += " AND timestamp >= ?";
    params.push(since);
  }

  if (query) {
    sql += " AND content LIKE ?";
    params.push(`%${query}%`);
  }

  if (tags && tags.length > 0) {
    const tagConditions = tags.map(() => "tags LIKE ?").join(" OR ");
    sql += ` AND (${tagConditions})`;
    for (const tag of tags) params.push(`%"${tag}"%`);
  }

  sql += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);

  const rows = getDb()
    .prepare(sql)
    .all(...params) as Array<{
    id: number;
    content: string;
    context: string | null;
    tags: string | null;
    timestamp: number;
    session_id: string | null;
  }>;

  return rows.map((row) => ({
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  }));
}

// ============ Task Operations ============

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";
export type TaskScope = "session" | "project";

export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  scope: TaskScope;
  tags: string[];
  parent_id: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  session_id: string | null;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  scope?: TaskScope;
  tags?: string[];
  parent_id?: number;
}

const MAX_PARENT_DEPTH = 100;

function validateParentId(parentId: number | null | undefined, taskId?: number): void {
  if (parentId === undefined || parentId === null) return;

  // Check parent exists
  const parent = getDb().prepare("SELECT id FROM tasks WHERE id = ?").get(parentId) as
    | { id: number }
    | undefined;
  if (!parent) {
    throw new Error(`Parent task #${parentId} not found`);
  }

  // Prevent self-reference
  if (taskId !== undefined && parentId === taskId) {
    throw new Error("Task cannot be its own parent");
  }

  // Prevent circular reference (check ancestors with depth limit)
  if (taskId !== undefined) {
    let currentParentId: number | null = parentId;
    const visited = new Set<number>();
    let depth = 0;
    while (currentParentId !== null) {
      if (++depth > MAX_PARENT_DEPTH) {
        throw new Error("Task hierarchy too deep or cycle detected");
      }
      if (visited.has(currentParentId)) break;
      visited.add(currentParentId);
      const ancestor = getDb()
        .prepare("SELECT parent_id FROM tasks WHERE id = ?")
        .get(currentParentId) as { parent_id: number | null } | undefined;
      if (!ancestor) break;
      if (ancestor.parent_id === taskId) {
        throw new Error("Circular parent reference detected");
      }
      currentParentId = ancestor.parent_id;
    }
  }
}

export function createTask(input: CreateTaskInput): number {
  validateParentId(input.parent_id);
  const now = Date.now();
  const scope = input.scope ?? "project";
  const sessionId = scope === "session" ? getSessionId() : null;

  const result = getDb()
    .prepare(
      `INSERT INTO tasks (title, description, status, priority, scope, tags, parent_id, created_at, updated_at, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.title,
      input.description ?? null,
      input.status ?? "todo",
      input.priority ?? "medium",
      scope,
      input.tags ? JSON.stringify(input.tags) : null,
      input.parent_id ?? null,
      now,
      now,
      sessionId
    );
  return result.lastInsertRowid as number;
}

export interface ListTasksOptions {
  status?: TaskStatus | TaskStatus[];
  scope?: TaskScope;
  priority?: TaskPriority;
  tags?: string[];
  parent_id?: number | null;
  sessionOnly?: boolean;
  limit?: number;
}

export function listTasks(options: ListTasksOptions = {}): Task[] {
  const { status, scope, priority, tags, parent_id, sessionOnly = false, limit = 50 } = options;

  let sql = "SELECT * FROM tasks WHERE 1=1";
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

  if (scope) {
    sql += " AND scope = ?";
    params.push(scope);
  }

  if (priority) {
    sql += " AND priority = ?";
    params.push(priority);
  }

  if (sessionOnly) {
    sql += " AND session_id = ?";
    params.push(getSessionId());
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
    const tagConditions = tags.map(() => "tags LIKE ?").join(" OR ");
    sql += ` AND (${tagConditions})`;
    for (const tag of tags) params.push(`%"${tag}"%`);
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
    scope: TaskScope;
    tags: string | null;
    parent_id: number | null;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
    session_id: string | null;
  }>;

  return rows.map((row) => ({
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  }));
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  parent_id?: number | null;
}

export function updateTask(id: number, input: UpdateTaskInput): boolean {
  // Validate parent_id if being updated
  if (input.parent_id !== undefined) {
    validateParentId(input.parent_id, id);
  }

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

  const sql = `UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`;
  const result = getDb()
    .prepare(sql)
    .run(...params);
  return result.changes > 0;
}

export function deleteTask(id: number): boolean {
  const result = getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getTask(id: number): Task | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | {
        id: number;
        title: string;
        description: string | null;
        status: TaskStatus;
        priority: TaskPriority;
        scope: TaskScope;
        tags: string | null;
        parent_id: number | null;
        created_at: number;
        updated_at: number;
        completed_at: number | null;
        session_id: string | null;
      }
    | undefined;

  if (!row) return null;

  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

// ============ Project Notes Operations ============

export type NoteCategory = "issue" | "convention" | "workflow" | "reminder" | "general";
export type NoteImportance = "low" | "normal" | "high" | "critical";

export interface ProjectNote {
  id: number;
  title: string;
  content: string;
  category: NoteCategory;
  importance: NoteImportance;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export interface CreateNoteInput {
  title: string;
  content: string;
  category?: NoteCategory;
  importance?: NoteImportance;
  active?: boolean;
}

export function createNote(input: CreateNoteInput): number {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO project_notes (title, content, category, importance, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.title,
      input.content,
      input.category ?? "general",
      input.importance ?? "normal",
      input.active !== false ? 1 : 0,
      now,
      now
    );
  return result.lastInsertRowid as number;
}

export interface ListNotesOptions {
  category?: NoteCategory;
  importance?: NoteImportance;
  activeOnly?: boolean;
  limit?: number;
}

export function listNotes(options: ListNotesOptions = {}): ProjectNote[] {
  const { category, importance, activeOnly = false, limit = 50 } = options;

  let sql = "SELECT * FROM project_notes WHERE 1=1";
  const params: (string | number)[] = [];

  if (activeOnly) {
    sql += " AND active = 1";
  }

  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }

  if (importance) {
    sql += " AND importance = ?";
    params.push(importance);
  }

  sql += " ORDER BY importance DESC, created_at DESC LIMIT ?";
  params.push(limit);

  const rows = getDb()
    .prepare(sql)
    .all(...params) as Array<{
    id: number;
    title: string;
    content: string;
    category: NoteCategory;
    importance: NoteImportance;
    active: number;
    created_at: number;
    updated_at: number;
  }>;

  return rows.map((row) => ({
    ...row,
    active: row.active === 1,
  }));
}

export interface UpdateNoteInput {
  title?: string;
  content?: string;
  category?: NoteCategory;
  importance?: NoteImportance;
  active?: boolean;
}

export function updateNote(id: number, input: UpdateNoteInput): boolean {
  const updates: string[] = [];
  const params: (string | number)[] = [];

  if (input.title !== undefined) {
    updates.push("title = ?");
    params.push(input.title);
  }
  if (input.content !== undefined) {
    updates.push("content = ?");
    params.push(input.content);
  }
  if (input.category !== undefined) {
    updates.push("category = ?");
    params.push(input.category);
  }
  if (input.importance !== undefined) {
    updates.push("importance = ?");
    params.push(input.importance);
  }
  if (input.active !== undefined) {
    updates.push("active = ?");
    params.push(input.active ? 1 : 0);
  }

  if (updates.length === 0) return false;

  updates.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);

  const sql = `UPDATE project_notes SET ${updates.join(", ")} WHERE id = ?`;
  const result = getDb()
    .prepare(sql)
    .run(...params);
  return result.changes > 0;
}

export function deleteNote(id: number): boolean {
  const result = getDb().prepare("DELETE FROM project_notes WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getNote(id: number): ProjectNote | null {
  const row = getDb().prepare("SELECT * FROM project_notes WHERE id = ?").get(id) as
    | {
        id: number;
        title: string;
        content: string;
        category: NoteCategory;
        importance: NoteImportance;
        active: number;
        created_at: number;
        updated_at: number;
      }
    | undefined;

  if (!row) return null;

  return {
    ...row,
    active: row.active === 1,
  };
}

// ============ Memory Context ============

export interface TaskSummary {
  todo: number;
  in_progress: number;
  blocked: number;
  done: number;
  cancelled: number;
  activeTasks: Task[];
}

export function getTaskSummary(): TaskSummary {
  const db = getDb();

  // Get counts by status for project-scope tasks
  const counts = db
    .prepare(`
    SELECT status, COUNT(*) as count 
    FROM tasks 
    WHERE scope = 'project'
    GROUP BY status
  `)
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

  // Get active (non-done, non-cancelled) project tasks
  summary.activeTasks = listTasks({
    status: ["todo", "in_progress", "blocked"],
    scope: "project",
    limit: 20,
  });

  return summary;
}

export interface MemoryContext {
  notes: ProjectNote[];
  taskSummary: TaskSummary;
  kvKeys: string[];
  recentEpisodes: number;
}

export function getMemoryContext(): MemoryContext {
  const db = getDb();

  // Active project notes
  const notes = listNotes({ activeOnly: true, limit: 50 });

  // Task summary
  const taskSummary = getTaskSummary();

  // KV store keys (just the keys, not values)
  const kvRows = db.prepare("SELECT key FROM kv ORDER BY updated_at DESC LIMIT 50").all() as Array<{
    key: string;
  }>;
  const kvKeys = kvRows.map((r) => r.key);

  // Recent episode count
  const episodeCount = db.prepare("SELECT COUNT(*) as count FROM episodes").get() as {
    count: number;
  };

  return {
    notes,
    taskSummary,
    kvKeys,
    recentEpisodes: episodeCount.count,
  };
}

export function buildMemoryPrompt(): string {
  const ctx = getMemoryContext();
  const lines: string[] = [];

  lines.push("<delta_memory>");
  lines.push("");

  // Project Notes
  if (ctx.notes.length > 0) {
    lines.push("## Project Notes");
    for (const note of ctx.notes) {
      const imp = note.importance !== "normal" ? ` [${note.importance.toUpperCase()}]` : "";
      lines.push(`### ${note.title}${imp} (${note.category})`);
      lines.push(note.content);
      lines.push("");
    }
  }

  // Tasks Overview
  const ts = ctx.taskSummary;
  const _totalActive = ts.todo + ts.in_progress + ts.blocked;
  lines.push("## Tasks Overview");
  lines.push(
    `Status: ${ts.todo} todo, ${ts.in_progress} in progress, ${ts.blocked} blocked, ${ts.done} done`
  );

  if (ts.activeTasks.length > 0) {
    lines.push("");
    lines.push("Active tasks:");
    for (const task of ts.activeTasks) {
      const statusIconMap: Record<TaskStatus, string> = {
        todo: "○",
        in_progress: "◐",
        blocked: "⊘",
        done: "●",
        cancelled: "✕",
      };
      const statusIcon = statusIconMap[task.status];
      const priority = task.priority !== "medium" ? ` [${task.priority}]` : "";
      lines.push(`  ${statusIcon} #${task.id}${priority} ${task.title}`);
    }
  }
  lines.push("");

  // Memory Stats
  if (ctx.kvKeys.length > 0 || ctx.recentEpisodes > 0) {
    lines.push("## Memory Stats");
    if (ctx.kvKeys.length > 0) {
      lines.push(
        `Key-value entries: ${ctx.kvKeys.length} (${ctx.kvKeys.slice(0, 5).join(", ")}${ctx.kvKeys.length > 5 ? "..." : ""})`
      );
    }
    if (ctx.recentEpisodes > 0) {
      lines.push(`Episodic memory entries: ${ctx.recentEpisodes}`);
    }
    lines.push("");
  }

  // Workflow Guidelines
  lines.push("## MANDATORY Workflow");
  lines.push("1. Create tasks for ALL work items using delta_task_create");
  lines.push("2. Update task status as you progress (in_progress, done, blocked)");
  lines.push("3. Log ALL discoveries with delta_log:");
  lines.push('   - Bugs → tags=["bug", "discovery"]');
  lines.push('   - Patterns → tags=["pattern", "discovery"]');
  lines.push('   - Decisions → tags=["decision"]');
  lines.push('   - Gotchas → tags=["gotcha", "discovery"]');
  lines.push("4. Create delta_note for REUSABLE project knowledge:");
  lines.push("   - issue: bugs, limitations, workarounds, tech debt");
  lines.push("   - convention: code patterns, naming, architecture decisions");
  lines.push("   - workflow: build/deploy/test commands and procedures");
  lines.push("   - reminder: common mistakes, review checklist items");
  lines.push("5. Check delta_note_list and delta_recall before creating to avoid duplicates");
  lines.push("");
  lines.push("</delta_memory>");

  return lines.join("\n");
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
  return getDbPath(process.cwd());
}
