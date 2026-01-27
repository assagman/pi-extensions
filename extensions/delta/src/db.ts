/**
 * Delta v3 — Pure memory extension database layer.
 *
 * Storage: ~/.local/share/pi-ext-delta/<repo-id>/delta.db
 * Tables:  kv, episodes, project_notes, memory_index, schema_version
 *
 * Removed in v3: tasks table, branch-scoped storage.
 * Added in v3:   last_accessed columns, importance decay.
 */
import type Database from "better-sqlite3";
import {
  ensureSchemaVersion,
  generateSessionId,
  getExtensionDbPath,
  openDatabase,
  escapeLike as sharedEscapeLike,
  stampSchemaVersion,
} from "pi-ext-shared";

// ============ Constants ============

/**
 * Shipped schema version. Increment when the schema changes.
 * - v1: original schema (kv, episodes, tasks, project_notes)
 * - v2: added memory_index + triggers, dropped task scope/session_id columns
 * - v3: removed tasks, added last_accessed, repo-scoped storage
 */
export const DB_VERSION = 3;

// ============ State ============

let db: Database.Database | null = null;
let currentSessionId: string | null = null;
let currentDbPath: string | null = null;

export function getSessionId(): string {
  if (!currentSessionId) {
    currentSessionId = generateSessionId();
  }
  return currentSessionId;
}

export function resetSession(): void {
  currentSessionId = null;
}

function escapeLike(s: string): string {
  return sharedEscapeLike(s);
}

// ============ Database Lifecycle ============

function getDbPath(): string {
  return getExtensionDbPath("pi-ext-delta", "delta");
}

export function getDb(): Database.Database {
  const dbPath = getDbPath();

  // Reopen if path changed (e.g., cwd changed)
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

  const { current, isFresh } = ensureSchemaVersion(db, DB_VERSION);

  db.exec(`
    -- Key-Value Store
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL DEFAULT 0
    );

    -- Episodic Memory
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      context TEXT,
      tags TEXT,
      timestamp INTEGER NOT NULL,
      session_id TEXT,
      last_accessed INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON episodes(timestamp);
    CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);

    -- Project Notes
    CREATE TABLE IF NOT EXISTS project_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      importance TEXT NOT NULL DEFAULT 'normal',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_notes_category ON project_notes(category);
    CREATE INDEX IF NOT EXISTS idx_notes_active ON project_notes(active);
    CREATE INDEX IF NOT EXISTS idx_notes_importance ON project_notes(importance);

    -- Memory Index (lightweight catalog for session-start injection)
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

  if (!isFresh) {
    migrateSchema(current);
  }

  initMemoryIndexTriggers();
  backfillMemoryIndex();
}

// ============ Migrations ============

function migrateSchema(currentVersion: number): void {
  if (!db) throw new Error("Database not initialized");
  if (currentVersion >= DB_VERSION) return;

  const database = db;
  const txn = database.transaction(() => {
    // v1→v2: Drop deprecated scope/session_id from tasks
    if (currentVersion < 2) {
      database.exec("DROP INDEX IF EXISTS idx_tasks_scope");
      database.exec("DROP INDEX IF EXISTS idx_tasks_session");
      const columns = database
        .prepare("SELECT name FROM pragma_table_info('tasks')")
        .all() as Array<{ name: string }>;
      const colNames = columns.map((c) => c.name);
      if (colNames.includes("scope")) database.exec("ALTER TABLE tasks DROP COLUMN scope");
      if (colNames.includes("session_id"))
        database.exec("ALTER TABLE tasks DROP COLUMN session_id");
    }

    // v2→v3: Remove tasks, add last_accessed, clean index
    if (currentVersion < 3) {
      // Remove task data from index
      database.exec("DELETE FROM memory_index WHERE source_type = 'task'");

      // Drop task triggers (they reference the tasks table)
      database.exec("DROP TRIGGER IF EXISTS mi_task_insert");
      database.exec("DROP TRIGGER IF EXISTS mi_task_update");
      database.exec("DROP TRIGGER IF EXISTS mi_task_delete");

      // Drop tasks table
      database.exec("DROP INDEX IF EXISTS idx_tasks_status");
      database.exec("DROP INDEX IF EXISTS idx_tasks_parent");
      database.exec("DROP TABLE IF EXISTS tasks");

      // Add last_accessed columns (idempotent check)
      const addColIfMissing = (table: string) => {
        const cols = database
          .prepare(`SELECT name FROM pragma_table_info('${table}')`)
          .all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === "last_accessed")) {
          database.exec(`ALTER TABLE ${table} ADD COLUMN last_accessed INTEGER NOT NULL DEFAULT 0`);
        }
      };
      addColIfMissing("kv");
      addColIfMissing("episodes");
      addColIfMissing("project_notes");
    }

    stampSchemaVersion(database, DB_VERSION);
  });
  txn();
}

// ============ Memory Index Triggers ============

function initMemoryIndexTriggers(): void {
  if (!db) throw new Error("Database not initialized");

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

// ============ Index Operations ============

/** SQL to populate memory_index from all source tables */
const POPULATE_INDEX_SQL = `
  INSERT OR IGNORE INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
  SELECT 'note', CAST(id AS TEXT), title, category, importance, created_at, updated_at
  FROM project_notes;

  INSERT OR IGNORE INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
  SELECT 'episode', CAST(id AS TEXT), substr(content, 1, 120), tags, 'normal', timestamp, timestamp
  FROM episodes;

  INSERT OR IGNORE INTO memory_index(source_type, source_id, summary, keywords, importance, created_at, updated_at)
  SELECT 'kv', key, key || ': ' || substr(value, 1, 80), key, 'normal', created_at, updated_at
  FROM kv;
`;

function backfillMemoryIndex(): void {
  if (!db) throw new Error("Database not initialized");

  const indexCount = db.prepare("SELECT COUNT(*) as count FROM memory_index").get() as {
    count: number;
  };
  if (indexCount.count > 0) return;

  const sourceCount = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM project_notes) +
        (SELECT COUNT(*) FROM episodes) +
        (SELECT COUNT(*) FROM kv) as total`
    )
    .get() as { total: number };
  if (sourceCount.total === 0) return;

  const database = db;
  const txn = database.transaction(() => {
    database.exec(POPULATE_INDEX_SQL);
  });
  txn();
}

/** SQL expression for ordering by importance */
const IMPORTANCE_ORDER_SQL =
  "CASE importance WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC";

export interface MemoryIndexEntry {
  id: number;
  source_type: "note" | "episode" | "kv";
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
      `INSERT INTO kv (key, value, created_at, updated_at, last_accessed)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, last_accessed = excluded.last_accessed`
    )
    .run(key, value, now, now, now);
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
  const now = Date.now();
  const row = getDb()
    .prepare(
      `INSERT INTO episodes (content, context, tags, timestamp, session_id, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .get(
      content,
      context ?? null,
      tags ? JSON.stringify(tags) : null,
      now,
      getSessionId(),
      now
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
  const database = getDb();

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

  const rows = database.prepare(sql).all(...params) as Array<{
    id: number;
    content: string;
    context: string | null;
    tags: string | null;
    timestamp: number;
    session_id: string | null;
  }>;

  // Guard: skip UPDATE when no rows matched to avoid empty IN() syntax error.
  // last_accessed is intentionally updated on explicit recall (not on passive reads).
  if (rows.length > 0) {
    const now = Date.now();
    const ids = rows.map((r) => r.id);
    database
      .prepare(
        `UPDATE episodes SET last_accessed = ? WHERE id IN (${ids.map(() => "?").join(",")})`
      )
      .run(now, ...ids);
  }

  return rows.map((row) => ({
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  }));
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
      `INSERT INTO project_notes (title, content, category, importance, active, created_at, updated_at, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .get(
      input.title,
      input.content,
      input.category ?? "general",
      input.importance ?? "normal",
      input.active !== false ? 1 : 0,
      now,
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

// ============ Memory Context & Prompt ============

export interface MemoryContext {
  indexEntries: MemoryIndexEntry[];
  criticalNotes: ProjectNote[];
}

export function getMemoryContext(): MemoryContext {
  const indexEntries = getMemoryIndex(100);

  const criticalNotes = getDb()
    .prepare(
      `SELECT * FROM project_notes
       WHERE active = 1 AND importance IN ('high', 'critical')
       ORDER BY importance DESC, updated_at DESC
       LIMIT 50`
    )
    .all() as Array<{
    id: number;
    title: string;
    content: string;
    category: NoteCategory;
    importance: NoteImportance;
    active: number;
    created_at: number;
    updated_at: number;
  }>;

  return {
    indexEntries,
    criticalNotes: criticalNotes.map((n) => ({ ...n, active: n.active === 1 })),
  };
}

export function buildMemoryPrompt(): string {
  const ctx = getMemoryContext();
  const lines: string[] = [];

  lines.push("<delta_memory>");
  lines.push("");

  // MANDATORY workflow
  lines.push("## MANDATORY Workflow");
  lines.push("1. Log ALL discoveries with delta_log:");
  lines.push('   - Bugs → tags=["bug", "discovery"]');
  lines.push('   - Patterns → tags=["pattern", "discovery"]');
  lines.push('   - Decisions → tags=["decision"]');
  lines.push('   - Gotchas → tags=["gotcha", "discovery"]');
  lines.push("2. Create delta_note for REUSABLE project knowledge:");
  lines.push("   - issue: bugs, limitations, workarounds, tech debt");
  lines.push("   - convention: code patterns, naming, architecture decisions");
  lines.push("   - workflow: build/deploy/test commands and procedures");
  lines.push("   - reminder: common mistakes, review checklist items");
  lines.push("3. Check delta_note_list and delta_recall before creating to avoid duplicates");
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

  // Hierarchical Memory Index
  if (ctx.indexEntries.length > 0) {
    const noteEntries = ctx.indexEntries.filter((e) => e.source_type === "note");
    const episodeEntries = ctx.indexEntries.filter((e) => e.source_type === "episode");
    const kvEntries = ctx.indexEntries.filter((e) => e.source_type === "kv");

    lines.push(`## Memory Index (${ctx.indexEntries.length} entries)`);
    lines.push("");

    // Notes: grouped by category → titles
    if (noteEntries.length > 0) {
      lines.push("Notes:");
      const byCategory = new Map<string, typeof noteEntries>();
      for (const e of noteEntries) {
        const cat = e.keywords || "general";
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)?.push(e);
      }
      for (const [cat, entries] of byCategory) {
        const titles = entries
          .map((e) => {
            const imp = e.importance !== "normal" ? " ⚠" : "";
            return `[N${e.source_id}]${imp} ${e.summary}`;
          })
          .join(", ");
        lines.push(`  ${cat}: ${titles}`);
      }
      lines.push("");
    }

    // Episodes: recent + tag summary
    if (episodeEntries.length > 0) {
      lines.push(`Episodes (${episodeEntries.length} total):`);

      // Show 5 most recent
      const recent = episodeEntries.slice(0, 5);
      for (const e of recent) {
        const tags = e.keywords ? ` (${e.keywords.replace(/[[\]"]/g, "")})` : "";
        lines.push(`  [E${e.source_id}] ${e.summary}${tags}`);
      }

      // Tag frequency summary
      const tagCounts = new Map<string, number>();
      for (const e of episodeEntries) {
        if (e.keywords) {
          try {
            const tags = JSON.parse(e.keywords) as string[];
            for (const t of tags) {
              tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
            }
          } catch {
            /* non-JSON keywords */
          }
        }
      }
      if (tagCounts.size > 0) {
        const tagSummary = [...tagCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([tag, count]) => `${tag}(${count})`)
          .join(", ");
        lines.push(`  Tags: ${tagSummary}`);
      }
      lines.push("");
    }

    // KV: compact list
    if (kvEntries.length > 0) {
      const keys = kvEntries.map((e) => e.source_id).join(", ");
      lines.push(`KV: ${keys}`);
      lines.push("");
    }

    lines.push("Fetch full content: delta_note_get(id), delta_recall(query), delta_get(key)");
    lines.push("Search index: delta_index_search(query)");
    lines.push("");
  }

  lines.push("</delta_memory>");

  return lines.join("\n");
}

// ============ Version & Schema Info ============

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
