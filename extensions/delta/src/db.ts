import { exec, execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";

const execAsync = promisify(exec);

/**
 * Shipped schema version. Increment when the schema changes.
 * - v1: original schema (kv, episodes, tasks, project_notes)
 * - v2: added memory_index table + 12 auto-sync triggers
 */
export const DB_VERSION = 2;

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
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    initSchema();
  }
  return db;
}

function initSchema(): void {
  if (!db) throw new Error("Database not initialized");

  // Detect fresh DB BEFORE creating tables (for version stamping)
  const tableCount = (
    db
      .prepare(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .get() as { count: number }
  ).count;
  const isFreshDb = tableCount === 0;

  db.exec(`
    -- Schema Version (single-row enforced by CHECK constraint)
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      version INTEGER NOT NULL
    );

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

    -- Tasks (branch-scoped: all tasks visible to any session on same git branch)
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

    -- Memory Index (lightweight catalog for session-start loading)
    CREATE TABLE IF NOT EXISTS memory_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      keywords TEXT,
      importance TEXT NOT NULL DEFAULT 'normal',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source_type, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mi_type ON memory_index(source_type);
    CREATE INDEX IF NOT EXISTS idx_mi_importance ON memory_index(importance);
  `);

  if (isFreshDb) {
    // Fresh DB — stamp current version
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(DB_VERSION);
  } else {
    // Existing DB — run migrations (before triggers, since migrations may alter columns)
    migrateSchema();
  }

  initMemoryIndexTriggers();
  backfillMemoryIndex();
}

/**
 * Migrate existing databases to the current schema version.
 * Each migration is idempotent (safe to re-run).
 */
function migrateSchema(): void {
  if (!db) throw new Error("Database not initialized");
  const database = db;

  const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  const currentVersion = row?.version ?? 0;

  if (currentVersion >= DB_VERSION) return;

  // Atomic migration — all-or-nothing to prevent partial schema on crash
  const txn = database.transaction(() => {
    // v1→v2: Remove deprecated scope/session_id columns from tasks
    if (currentVersion < 2) {
      // Drop indexes FIRST — SQLite can't drop columns that have indexes
      database.exec("DROP INDEX IF EXISTS idx_tasks_scope");
      database.exec("DROP INDEX IF EXISTS idx_tasks_session");

      const columns = database
        .prepare("SELECT name FROM pragma_table_info('tasks')")
        .all() as Array<{ name: string }>;
      const colNames = columns.map((c) => c.name);

      if (colNames.includes("scope")) {
        database.exec("ALTER TABLE tasks DROP COLUMN scope");
      }
      if (colNames.includes("session_id")) {
        database.exec("ALTER TABLE tasks DROP COLUMN session_id");
      }
    }

    // Stamp the new version
    database.exec("DELETE FROM schema_version");
    database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(DB_VERSION);
  });
  txn();
}

function initMemoryIndexTriggers(): void {
  if (!db) throw new Error("Database not initialized");

  // Use ON CONFLICT ... DO UPDATE (UPSERT) instead of INSERT OR REPLACE
  // to avoid issues with conflict resolution inheritance in nested trigger contexts.

  // --- Notes triggers ---
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mi_note_insert AFTER INSERT ON project_notes
    BEGIN
      INSERT INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
      VALUES('note', CAST(NEW.id AS TEXT), NEW.title, NEW.category, NEW.importance, NEW.created_at, NEW.updated_at)
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        summary = excluded.summary, keywords = excluded.keywords,
        importance = excluded.importance, updated_at = excluded.updated_at;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mi_note_update AFTER UPDATE ON project_notes
    BEGIN
      INSERT INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
      VALUES('note', CAST(NEW.id AS TEXT), NEW.title, NEW.category, NEW.importance, NEW.updated_at, NEW.updated_at)
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        summary = excluded.summary, keywords = excluded.keywords,
        importance = excluded.importance, updated_at = excluded.updated_at;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mi_note_delete AFTER DELETE ON project_notes
    BEGIN
      DELETE FROM memory_index WHERE source_type = 'note' AND source_id = CAST(OLD.id AS TEXT);
    END
  `);

  // --- Episodes triggers ---
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mi_episode_insert AFTER INSERT ON episodes
    BEGIN
      INSERT INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
      VALUES('episode', CAST(NEW.id AS TEXT), substr(NEW.content, 1, 120), NEW.tags, 'normal', NEW.timestamp, NEW.timestamp)
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        summary = excluded.summary, keywords = excluded.keywords, updated_at = excluded.updated_at;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mi_episode_update AFTER UPDATE ON episodes
    BEGIN
      INSERT INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
      VALUES('episode', CAST(NEW.id AS TEXT), substr(NEW.content, 1, 120), NEW.tags, 'normal', NEW.timestamp, NEW.timestamp)
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        summary = excluded.summary, keywords = excluded.keywords, updated_at = excluded.updated_at;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mi_episode_delete AFTER DELETE ON episodes
    BEGIN
      DELETE FROM memory_index WHERE source_type = 'episode' AND source_id = CAST(OLD.id AS TEXT);
    END
  `);

  // --- Tasks triggers ---
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mi_task_insert AFTER INSERT ON tasks
    BEGIN
      INSERT INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
      VALUES('task', CAST(NEW.id AS TEXT), NEW.title, NEW.status || ',' || NEW.priority,
        CASE WHEN NEW.priority IN ('high', 'critical') THEN NEW.priority ELSE 'normal' END,
        NEW.created_at, NEW.updated_at)
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        summary = excluded.summary, keywords = excluded.keywords,
        importance = excluded.importance, updated_at = excluded.updated_at;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mi_task_update AFTER UPDATE ON tasks
    BEGIN
      INSERT INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
      VALUES('task', CAST(NEW.id AS TEXT), NEW.title, NEW.status || ',' || NEW.priority,
        CASE WHEN NEW.priority IN ('high', 'critical') THEN NEW.priority ELSE 'normal' END,
        NEW.created_at, NEW.updated_at)
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        summary = excluded.summary, keywords = excluded.keywords,
        importance = excluded.importance, updated_at = excluded.updated_at;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mi_task_delete AFTER DELETE ON tasks
    BEGIN
      DELETE FROM memory_index WHERE source_type = 'task' AND source_id = CAST(OLD.id AS TEXT);
    END
  `);

  // --- KV triggers ---
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mi_kv_insert AFTER INSERT ON kv
    BEGIN
      INSERT INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
      VALUES('kv', NEW.key, NEW.key || ': ' || substr(NEW.value, 1, 80), NEW.key, 'normal', NEW.created_at, NEW.updated_at)
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        summary = excluded.summary, keywords = excluded.keywords, updated_at = excluded.updated_at;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mi_kv_update AFTER UPDATE ON kv
    BEGIN
      INSERT INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
      VALUES('kv', NEW.key, NEW.key || ': ' || substr(NEW.value, 1, 80), NEW.key, 'normal', NEW.updated_at, NEW.updated_at)
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        summary = excluded.summary, keywords = excluded.keywords, updated_at = excluded.updated_at;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mi_kv_delete AFTER DELETE ON kv
    BEGIN
      DELETE FROM memory_index WHERE source_type = 'kv' AND source_id = OLD.key;
    END
  `);
}

/** SQL to populate memory_index from all source tables (shared by backfill and rebuild) */
const POPULATE_INDEX_SQL = `
  INSERT OR IGNORE INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
  SELECT 'note', CAST(id AS TEXT), title, category, importance, created_at, updated_at
  FROM project_notes;

  INSERT OR IGNORE INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
  SELECT 'episode', CAST(id AS TEXT), substr(content, 1, 120), tags, 'normal', timestamp, timestamp
  FROM episodes;

  INSERT OR IGNORE INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
  SELECT 'task', CAST(id AS TEXT), title, status || ',' || priority,
    CASE WHEN priority IN ('high', 'critical') THEN priority ELSE 'normal' END,
    created_at, updated_at
  FROM tasks;

  INSERT OR IGNORE INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
  SELECT 'kv', key, key || ': ' || substr(value, 1, 80), key, 'normal', created_at, updated_at
  FROM kv;
`;

function backfillMemoryIndex(): void {
  if (!db) throw new Error("Database not initialized");

  // Only backfill if memory_index is empty but source tables have data
  const indexCount = db.prepare("SELECT COUNT(*) as count FROM memory_index").get() as {
    count: number;
  };
  if (indexCount.count > 0) return;

  const sourceCount = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM project_notes) +
        (SELECT COUNT(*) FROM episodes) +
        (SELECT COUNT(*) FROM tasks) +
        (SELECT COUNT(*) FROM kv) as total`
    )
    .get() as { total: number };
  if (sourceCount.total === 0) return;

  // Backfill atomically — prevents partial index on crash
  // Use db.transaction() (SAVEPOINT-based) to be safely nestable
  const database = db;
  const txn = database.transaction(() => {
    database.exec(POPULATE_INDEX_SQL);
  });
  txn();
}

// ============ Memory Index Operations ============

/** SQL expression for ordering by importance (critical > high > normal > low).
 *  Compile-time constant — safe for SQL interpolation (never derived from user input). */
const IMPORTANCE_ORDER_SQL =
  "CASE importance WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC";

export interface MemoryIndexEntry {
  id: number;
  source_type: "note" | "episode" | "task" | "kv";
  source_id: string;
  summary: string;
  keywords: string | null;
  importance: string;
  created_at: number;
  updated_at: number;
}

export function getMemoryIndex(limit = 100): MemoryIndexEntry[] {
  return getDb()
    .prepare(
      `SELECT * FROM memory_index
       ORDER BY ${IMPORTANCE_ORDER_SQL}, updated_at DESC
       LIMIT ?`
    )
    .all(limit) as MemoryIndexEntry[];
}

/** Escape SQL LIKE wildcards so %, _, and \ are treated as literals */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

export function searchIndex(query: string, sourceType?: string): MemoryIndexEntry[] {
  let sql =
    "SELECT * FROM memory_index WHERE (summary LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')";
  const escaped = escapeLike(query);
  const params: string[] = [`%${escaped}%`, `%${escaped}%`];

  if (sourceType) {
    sql += " AND source_type = ?";
    params.push(sourceType);
  }

  sql += ` ORDER BY ${IMPORTANCE_ORDER_SQL}, updated_at DESC LIMIT 50`;

  return getDb()
    .prepare(sql)
    .all(...params) as MemoryIndexEntry[];
}

export function rebuildIndex(): number {
  const database = getDb();

  // Atomic rebuild — DELETE + repopulate in one transaction
  // Use db.transaction() (SAVEPOINT-based) to be safely nestable
  const txn = database.transaction(() => {
    database.exec("DELETE FROM memory_index");
    database.exec(POPULATE_INDEX_SQL);
  });
  txn();

  const count = database.prepare("SELECT COUNT(*) as count FROM memory_index").get() as {
    count: number;
  };
  return count.count;
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
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, now, now);
}

export function kvDelete(key: string): boolean {
  const row = getDb().prepare("DELETE FROM kv WHERE key = ? RETURNING key").get(key) as
    | { key: string }
    | undefined;
  return row !== undefined;
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
  const row = getDb()
    .prepare(
      `INSERT INTO episodes (content, context, tags, timestamp, session_id)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    )
    .get(
      content,
      context ?? null,
      tags ? JSON.stringify(tags) : null,
      Date.now(),
      getSessionId()
    ) as { id: number };
  return row.id;
}

export interface RecallOptions {
  query?: string;
  tags?: string[];
  limit?: number;
  sessionOnly?: boolean;
  since?: number;
}

export function deleteEpisode(id: number): boolean {
  const row = getDb().prepare("DELETE FROM episodes WHERE id = ? RETURNING id").get(id) as
    | { id: number }
    | undefined;
  return row !== undefined;
}

export function recallEpisodes(options: RecallOptions = {}): Episode[] {
  const { query, tags, limit = 20, sessionOnly = false, since } = options;

  let sql = "SELECT id, content, context, tags, timestamp, session_id FROM episodes WHERE 1=1";
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
    sql += " AND content LIKE ? ESCAPE '\\'";
    params.push(`%${escapeLike(query)}%`);
  }

  if (tags && tags.length > 0) {
    const tagConditions = tags.map(() => "tags LIKE ? ESCAPE '\\'").join(" OR ");
    sql += ` AND (${tagConditions})`;
    for (const tag of tags) params.push(`%"${escapeLike(tag)}"%`);
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

/** Status → icon mapping shared across db.ts and tools.ts */
export const TASK_STATUS_ICONS: Record<TaskStatus, string> = {
  todo: "○",
  in_progress: "◐",
  blocked: "⊘",
  done: "●",
  cancelled: "✕",
};
export type TaskPriority = "low" | "medium" | "high" | "critical";
// Tasks are now branch-scoped (DB is per-branch, all tasks visible to any session on same branch)

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

export interface ListTasksOptions {
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority;
  tags?: string[];
  parent_id?: number | null;
  limit?: number;
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
  const row = getDb()
    .prepare(
      `INSERT INTO project_notes (title, content, category, importance, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .get(
      input.title,
      input.content,
      input.category ?? "general",
      input.importance ?? "normal",
      input.active !== false ? 1 : 0,
      now,
      now
    ) as { id: number };
  return row.id;
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

  const sql = `UPDATE project_notes SET ${updates.join(", ")} WHERE id = ? RETURNING id`;
  const row = getDb()
    .prepare(sql)
    .get(...params) as { id: number } | undefined;
  return row !== undefined;
}

export function deleteNote(id: number): boolean {
  const row = getDb().prepare("DELETE FROM project_notes WHERE id = ? RETURNING id").get(id) as
    | { id: number }
    | undefined;
  return row !== undefined;
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
  const database = getDb();

  // Get counts by status for all tasks (branch-scoped)
  const counts = database
    .prepare(
      `
    SELECT status, COUNT(*) as count 
    FROM tasks 
    GROUP BY status
  `
    )
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

  // Get active (non-done, non-cancelled) tasks
  summary.activeTasks = listTasks({
    status: ["todo", "in_progress", "blocked"],
    limit: 20,
  });

  return summary;
}

export interface MemoryContext {
  indexEntries: MemoryIndexEntry[];
  criticalNotes: ProjectNote[];
  taskSummary: TaskSummary;
}

export function getMemoryContext(): MemoryContext {
  // Lightweight memory index (all entries as one-liners)
  const indexEntries = getMemoryIndex(100);

  // HIGH/CRITICAL active notes: full content for hybrid loading (SQL-filtered)
  const criticalNotes = getDb()
    .prepare(
      `SELECT * FROM project_notes
       WHERE active = 1 AND importance IN ('high', 'critical')
       ORDER BY importance DESC, updated_at DESC
       LIMIT 50`
    )
    .all() as ProjectNote[];

  // Task summary for active task display
  const taskSummary = getTaskSummary();

  return {
    indexEntries,
    criticalNotes,
    taskSummary,
  };
}

export function buildMemoryPrompt(): string {
  const ctx = getMemoryContext();
  const lines: string[] = [];

  lines.push("<delta_memory>");
  lines.push("");

  // MANDATORY workflow FIRST — most important, must not be buried
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

  // Active Tasks detail — second priority (actionable context)
  const ts = ctx.taskSummary;
  const activeCount = ts.todo + ts.in_progress + ts.blocked;
  if (activeCount > 0) {
    lines.push("## Active Tasks");
    for (const task of ts.activeTasks) {
      const statusIcon = TASK_STATUS_ICONS[task.status];
      const priority = task.priority !== "medium" ? ` [${task.priority}]` : "";
      lines.push(`  ${statusIcon} #${task.id}${priority} ${task.title}`);
      if (task.description) {
        lines.push(`    ${task.description.substring(0, 100)}`);
      }
    }
    lines.push("");
  }

  // Tasks summary stats
  lines.push("## Tasks Overview");
  lines.push(
    `Status: ${ts.todo} todo, ${ts.in_progress} in progress, ${ts.blocked} blocked, ${ts.done} done`
  );
  lines.push("");

  // Critical Knowledge: HIGH/CRITICAL notes loaded in full
  if (ctx.criticalNotes.length > 0) {
    lines.push("## Critical Knowledge (auto-loaded)");
    lines.push("");
    for (const note of ctx.criticalNotes) {
      const imp = ` [${note.importance.toUpperCase()}]`;
      lines.push(`### ${note.title}${imp} (${note.category})`);
      lines.push(note.content);
      lines.push("");
    }
  }

  // Compact Memory Index — reference material at the end
  if (ctx.indexEntries.length > 0) {
    const noteEntries = ctx.indexEntries.filter((e) => e.source_type === "note");
    const episodeEntries = ctx.indexEntries.filter((e) => e.source_type === "episode");
    const taskEntries = ctx.indexEntries.filter((e) => e.source_type === "task");
    const kvEntries = ctx.indexEntries.filter((e) => e.source_type === "kv");

    lines.push(`## Memory Index (${ctx.indexEntries.length} entries)`);
    lines.push("");

    if (noteEntries.length > 0) {
      lines.push("Notes:");
      for (const e of noteEntries) {
        const imp = e.importance !== "normal" ? " ⚠" : "  ";
        lines.push(`  [N${e.source_id}]${imp} ${e.summary} (${e.keywords || "general"})`);
      }
      lines.push("");
    }

    if (episodeEntries.length > 0) {
      lines.push("Episodes:");
      for (const e of episodeEntries) {
        const tags = e.keywords ? ` (${e.keywords.replace(/[[\]"]/g, "")})` : "";
        lines.push(`  [E${e.source_id}]   ${e.summary}${tags}`);
      }
      lines.push("");
    }

    if (taskEntries.length > 0) {
      lines.push("Tasks:");
      for (const e of taskEntries) {
        const parts = (e.keywords || "todo,medium").split(",");
        const status = parts[0] || "todo";
        const priority = parts[1] || "medium";
        const icon = TASK_STATUS_ICONS[status as TaskStatus] ?? "?";
        lines.push(`  [T${e.source_id}] ${icon} ${e.summary} (${priority})`);
      }
      lines.push("");
    }

    if (kvEntries.length > 0) {
      lines.push("Key-Value:");
      for (const e of kvEntries) {
        lines.push(`  [K:${e.source_id}] ${e.summary}`);
      }
      lines.push("");
    }

    lines.push(
      "Fetch full content: delta_note_get(id), delta_recall(query), delta_task_get(id), delta_get(key)"
    );
    lines.push("Search index: delta_index_search(query)");
    lines.push("");
  }

  lines.push("</delta_memory>");

  return lines.join("\n");
}

// ============ Version & Schema Info ============

export interface VersionInfo {
  /** Version stored in the database (null if pre-versioning DB) */
  current: number | null;
  /** Version shipped with this extension code */
  shipped: number;
  /** Whether current matches shipped */
  match: boolean;
}

export function getVersionInfo(): VersionInfo {
  const database = getDb();
  const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? null;
  return {
    current,
    shipped: DB_VERSION,
    match: current === DB_VERSION,
  };
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
  return getDbPath(process.cwd());
}
