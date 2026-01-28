/**
 * Delta v4 database tests — unified memories table + FTS5.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DB_VERSION,
  type Memory,
  _testReset,
  batchDeleteMemories,
  buildMemoryPrompt,
  closeDb,
  forget,
  getAllMemories,
  getById,
  getDatabaseSchema,
  getDb,
  getDbLocation,
  getMemoryContext,
  getSessionId,
  getVersionInfo,
  logEpisode,
  remember,
  search,
  update,
} from "./db.js";

// ============ Helpers ============

function clearAll(): void {
  const db = getDb();
  // Delete from memories (triggers will clean FTS5)
  db.exec("DELETE FROM memories");
}

function memoryCount(): number {
  return (getDb().prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
}

function ftsCount(): number {
  return (getDb().prepare("SELECT COUNT(*) as c FROM memories_fts").get() as { c: number }).c;
}

// ============ Setup / Teardown ============

afterAll(() => {
  closeDb();
});

// ============ Schema Tests ============

describe("Schema", () => {
  it("DB_VERSION is 4", () => {
    expect(DB_VERSION).toBe(4);
  });

  it("memories table exists", () => {
    const db = getDb();
    const row = db
      .prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='memories'")
      .get() as { c: number };
    expect(row.c).toBe(1);
  });

  it("memories_fts virtual table exists", () => {
    const db = getDb();
    const row = db
      .prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get() as { c: number };
    expect(row.c).toBe(1);
  });

  it("schema_version table reports v4", () => {
    const info = getVersionInfo();
    expect(info.current).toBe(4);
    expect(info.shipped).toBe(4);
    expect(info.match).toBe(true);
  });

  it("memories table has all expected columns", () => {
    const db = getDb();
    const cols = db.prepare("SELECT name FROM pragma_table_info('memories')").all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("content");
    expect(colNames).toContain("tags");
    expect(colNames).toContain("importance");
    expect(colNames).toContain("context");
    expect(colNames).toContain("session_id");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
    expect(colNames).toContain("last_accessed");
  });

  it("old v3 tables do NOT exist", () => {
    const db = getDb();
    for (const table of ["kv", "episodes", "project_notes", "memory_index"]) {
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='${table}'`)
        .get() as { c: number };
      expect(row.c, `table ${table} should not exist`).toBe(0);
    }
  });

  it("FTS5 sync triggers exist", () => {
    const schema = getDatabaseSchema();
    expect(schema).toContain("memories_fts_ai");
    expect(schema).toContain("memories_fts_ad");
    expect(schema).toContain("memories_fts_au");
  });

  it("indexes exist on memories table", () => {
    const schema = getDatabaseSchema();
    expect(schema).toContain("idx_memories_importance");
    expect(schema).toContain("idx_memories_session");
    expect(schema).toContain("idx_memories_created");
    expect(schema).toContain("idx_memories_updated");
  });
});

// ============ CRUD: remember() ============

describe("remember()", () => {
  beforeEach(clearAll);

  it("creates a memory and returns its ID", () => {
    const id = remember("Found a race condition in worker pool");
    expect(id).toBeGreaterThan(0);
    expect(memoryCount()).toBe(1);
  });

  it("stores content correctly", () => {
    const id = remember("SQL injection found in login endpoint");
    const mem = getById(id);
    expect(mem).not.toBeNull();
    expect(mem?.content).toBe("SQL injection found in login endpoint");
  });

  it("stores tags as JSON array", () => {
    const id = remember("Bug found", { tags: ["bug", "security"] });
    const mem = getById(id);
    expect(mem?.tags).toEqual(["bug", "security"]);
  });

  it("stores importance level", () => {
    const id = remember("Critical issue", { importance: "critical" });
    const mem = getById(id);
    expect(mem?.importance).toBe("critical");
  });

  it("defaults importance to 'normal'", () => {
    const id = remember("Regular memory");
    const mem = getById(id);
    expect(mem?.importance).toBe("normal");
  });

  it("stores context", () => {
    const id = remember("Found issue here", { context: "src/main.ts" });
    const mem = getById(id);
    expect(mem?.context).toBe("src/main.ts");
  });

  it("auto-sets session_id", () => {
    const id = remember("Session memory");
    const mem = getById(id);
    expect(mem?.session_id).toBe(getSessionId());
  });

  it("allows custom session_id", () => {
    const id = remember("Custom session", { sessionId: "custom-session-123" });
    const mem = getById(id);
    expect(mem?.session_id).toBe("custom-session-123");
  });

  it("sets timestamps on creation", () => {
    const before = Date.now();
    const id = remember("Timestamped memory");
    const after = Date.now();
    const mem = getById(id);
    expect(mem?.created_at).toBeGreaterThanOrEqual(before);
    expect(mem?.created_at).toBeLessThanOrEqual(after);
    expect(mem?.updated_at).toBe(mem?.created_at);
    expect(mem?.last_accessed).toBe(mem?.created_at);
  });

  it("handles null tags (no tags)", () => {
    const id = remember("No tags");
    const mem = getById(id);
    expect(mem?.tags).toEqual([]);
  });

  it("handles empty tags array", () => {
    const id = remember("Empty tags", { tags: [] });
    const mem = getById(id);
    expect(mem?.tags).toEqual([]);
  });
});

// ============ CRUD: getById() ============

describe("getById()", () => {
  beforeEach(clearAll);

  it("returns null for non-existent ID", () => {
    expect(getById(99999)).toBeNull();
  });

  it("returns full memory object", () => {
    const id = remember("Full memory", {
      tags: ["test", "important"],
      importance: "high",
      context: "test-file.ts",
    });
    const mem = getById(id);
    expect(mem).not.toBeNull();
    expect(mem?.id).toBe(id);
    expect(mem?.content).toBe("Full memory");
    expect(mem?.tags).toEqual(["test", "important"]);
    expect(mem?.importance).toBe("high");
    expect(mem?.context).toBe("test-file.ts");
    expect(typeof mem?.session_id).toBe("string");
    expect(typeof mem?.created_at).toBe("number");
    expect(typeof mem?.updated_at).toBe("number");
    expect(typeof mem?.last_accessed).toBe("number");
  });
});

// ============ CRUD: update() ============

describe("update()", () => {
  beforeEach(clearAll);

  it("updates content", () => {
    const id = remember("Original content");
    update(id, { content: "Updated content" });
    expect(getById(id)?.content).toBe("Updated content");
  });

  it("updates tags", () => {
    const id = remember("Memory", { tags: ["old"] });
    update(id, { tags: ["new", "replaced"] });
    expect(getById(id)?.tags).toEqual(["new", "replaced"]);
  });

  it("updates importance", () => {
    const id = remember("Memory", { importance: "low" });
    update(id, { importance: "critical" });
    expect(getById(id)?.importance).toBe("critical");
  });

  it("updates context", () => {
    const id = remember("Memory", { context: "old.ts" });
    update(id, { context: "new.ts" });
    expect(getById(id)?.context).toBe("new.ts");
  });

  it("updates updated_at timestamp", () => {
    const id = remember("Memory");
    const _original = getById(id)?.updated_at;
    // Small delay to ensure timestamp difference
    const before = Date.now();
    update(id, { content: "Changed" });
    const after = Date.now();
    const mem = getById(id) as Memory;
    expect(mem.updated_at).toBeGreaterThanOrEqual(before);
    expect(mem.updated_at).toBeLessThanOrEqual(after);
  });

  it("returns true when memory exists", () => {
    const id = remember("Memory");
    expect(update(id, { content: "Changed" })).toBe(true);
  });

  it("returns false when memory doesn't exist", () => {
    expect(update(99999, { content: "Nope" })).toBe(false);
  });

  it("returns false when no fields provided", () => {
    const id = remember("Memory");
    expect(update(id, {})).toBe(false);
  });

  it("partial update doesn't clear other fields", () => {
    const id = remember("Content", {
      tags: ["keep"],
      importance: "high",
      context: "keep.ts",
    });
    update(id, { content: "New content" });
    const mem = getById(id) as Memory;
    expect(mem.content).toBe("New content");
    expect(mem.tags).toEqual(["keep"]);
    expect(mem.importance).toBe("high");
    expect(mem.context).toBe("keep.ts");
  });
});

// ============ CRUD: forget() ============

describe("forget()", () => {
  beforeEach(clearAll);

  it("deletes a memory by ID", () => {
    const id = remember("To be forgotten");
    expect(forget(id)).toBe(true);
    expect(getById(id)).toBeNull();
    expect(memoryCount()).toBe(0);
  });

  it("returns false for non-existent ID", () => {
    expect(forget(99999)).toBe(false);
  });

  it("removes from FTS5 index on delete", () => {
    const id = remember("Searchable content to forget");
    expect(ftsCount()).toBe(1);
    forget(id);
    expect(ftsCount()).toBe(0);
  });
});

// ============ FTS5 Search ============

describe("search() — FTS5", () => {
  beforeEach(clearAll);

  it("finds memories by content keyword", () => {
    remember("Found a SQL injection vulnerability");
    remember("Fixed the performance regression");
    remember("SQL optimization applied to queries");

    const results = search({ query: "SQL" });
    expect(results.length).toBe(2);
  });

  it("finds memories by multiple keywords (AND semantics)", () => {
    remember("SQL injection in auth module");
    remember("SQL optimization in query layer");
    remember("Auth module refactored");

    const results = search({ query: "SQL auth" });
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("SQL injection in auth");
  });

  it("finds memories by tag content in FTS", () => {
    remember("Decision about API design", { tags: ["decision", "api"] });
    remember("Bug in authentication", { tags: ["bug", "auth"] });

    const results = search({ query: "decision" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    // FTS5 searches across content and tags columns
  });

  it("finds memories by context content in FTS", () => {
    remember("Found issue", { context: "src/auth/login.ts" });
    remember("Found issue", { context: "src/db/query.ts" });

    const results = search({ query: "login" });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for no matches", () => {
    remember("Some content");
    const results = search({ query: "nonexistent_term_xyz" });
    expect(results.length).toBe(0);
  });

  it("handles special characters in query gracefully", () => {
    remember("Content with special chars: <script>");
    const results = search({ query: 'script "injection" (test)' });
    // Should not throw — special chars are sanitized
    expect(results).toBeDefined();
  });

  it("handles empty query gracefully", () => {
    remember("Memory 1");
    remember("Memory 2");
    const results = search({ query: "" });
    // Empty query falls through to filtered search (returns all)
    expect(results.length).toBe(2);
  });

  it("updates last_accessed on search results", () => {
    const id = remember("Searchable memory");
    const _before = getById(id)?.last_accessed;

    // Small delay
    const searchTime = Date.now();
    search({ query: "Searchable" });

    const after = getById(id)?.last_accessed;
    expect(after).toBeGreaterThanOrEqual(searchTime);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      remember(`Memory number ${i}`);
    }
    const results = search({ query: "Memory", limit: 3 });
    expect(results.length).toBe(3);
  });

  it("FTS5 index stays in sync after insert", () => {
    expect(ftsCount()).toBe(0);
    remember("New memory");
    expect(ftsCount()).toBe(1);
  });

  it("FTS5 index stays in sync after update", () => {
    const id = remember("Original searchable content");
    expect(search({ query: "Original" }).length).toBe(1);

    update(id, { content: "Completely different text" });
    expect(search({ query: "Original" }).length).toBe(0);
    expect(search({ query: "different" }).length).toBe(1);
  });

  it("FTS5 index stays in sync after delete", () => {
    const id = remember("Content to be deleted from index");
    expect(search({ query: "deleted" }).length).toBe(1);

    forget(id);
    expect(search({ query: "deleted" }).length).toBe(0);
  });
});

// ============ Search: Tag Filtering ============

describe("search() — tag filtering", () => {
  beforeEach(clearAll);

  it("filters by single tag", () => {
    remember("Bug report", { tags: ["bug", "auth"] });
    remember("Feature request", { tags: ["feature", "ui"] });
    remember("Another bug", { tags: ["bug", "db"] });

    const results = search({ tags: ["bug"] });
    expect(results.length).toBe(2);
  });

  it("filters by multiple tags (OR semantics)", () => {
    remember("Bug", { tags: ["bug"] });
    remember("Feature", { tags: ["feature"] });
    remember("Decision", { tags: ["decision"] });

    const results = search({ tags: ["bug", "feature"] });
    expect(results.length).toBe(2);
  });

  it("combines query and tag filter", () => {
    remember("SQL bug found", { tags: ["bug"] });
    remember("SQL feature added", { tags: ["feature"] });
    remember("Auth bug found", { tags: ["bug"] });

    const results = search({ query: "SQL", tags: ["bug"] });
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("SQL bug");
  });

  it("returns empty when tag not found", () => {
    remember("Memory", { tags: ["existing"] });
    const results = search({ tags: ["nonexistent"] });
    expect(results.length).toBe(0);
  });

  it("handles memories with no tags", () => {
    remember("No tags memory");
    remember("Tagged memory", { tags: ["tagged"] });

    const results = search({ tags: ["tagged"] });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Tagged memory");
  });
});

// ============ Search: Importance Filtering ============

describe("search() — importance filtering", () => {
  beforeEach(clearAll);

  it("filters by importance level", () => {
    remember("Low", { importance: "low" });
    remember("Normal", { importance: "normal" });
    remember("High", { importance: "high" });
    remember("Critical", { importance: "critical" });

    expect(search({ importance: "critical" }).length).toBe(1);
    expect(search({ importance: "high" }).length).toBe(1);
    expect(search({ importance: "normal" }).length).toBe(1);
    expect(search({ importance: "low" }).length).toBe(1);
  });

  it("combines importance with query", () => {
    remember("SQL bug", { importance: "critical" });
    remember("SQL note", { importance: "low" });

    const results = search({ query: "SQL", importance: "critical" });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("SQL bug");
  });
});

// ============ Search: Session/Time Filtering ============

describe("search() — session and time filtering", () => {
  beforeEach(clearAll);

  it("filters by current session", () => {
    remember("Current session memory");
    // Insert a memory with a different session ID directly
    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (content, tags, importance, session_id, created_at, updated_at, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("Other session memory", null, "normal", "other-session-999", now, now, now);

    const results = search({ sessionOnly: true });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Current session memory");
  });

  it("filters by since timestamp", () => {
    const _before = Date.now();
    remember("Old memory");
    const _mid = Date.now() + 1; // ensure different timestamp
    // Insert a memory with future timestamp directly
    const db = getDb();
    const future = Date.now() + 10000;
    db.prepare(
      `INSERT INTO memories (content, tags, importance, session_id, created_at, updated_at, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("Future memory", null, "normal", getSessionId(), future, future, future);

    const results = search({ since: future });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Future memory");
  });
});

// ============ Search: No Query (filtered search) ============

describe("search() — no query", () => {
  beforeEach(clearAll);

  it("returns all memories when no filters", () => {
    remember("Memory 1");
    remember("Memory 2");
    remember("Memory 3");
    const results = search();
    expect(results.length).toBe(3);
  });

  it("orders by importance DESC then updated_at DESC", () => {
    remember("Low", { importance: "low" });
    remember("Critical", { importance: "critical" });
    remember("Normal", { importance: "normal" });

    const results = search();
    expect(results[0].importance).toBe("critical");
    expect(results[results.length - 1].importance).toBe("low");
  });

  it("respects limit", () => {
    for (let i = 0; i < 20; i++) remember(`Memory ${i}`);
    expect(search({ limit: 5 }).length).toBe(5);
  });

  it("default limit is 50", () => {
    for (let i = 0; i < 60; i++) remember(`Memory ${i}`);
    expect(search().length).toBe(50);
  });
});

// ============ Bulk Operations ============

describe("getAllMemories()", () => {
  beforeEach(clearAll);

  it("returns all memories", () => {
    remember("M1");
    remember("M2");
    remember("M3");
    expect(getAllMemories().length).toBe(3);
  });

  it("returns empty array for empty DB", () => {
    expect(getAllMemories()).toEqual([]);
  });

  it("returns properly parsed Memory objects", () => {
    remember("Content", { tags: ["a", "b"], importance: "high", context: "file.ts" });
    const memories = getAllMemories();
    expect(memories[0].tags).toEqual(["a", "b"]);
    expect(memories[0].importance).toBe("high");
    expect(memories[0].context).toBe("file.ts");
  });
});

describe("batchDeleteMemories()", () => {
  beforeEach(clearAll);

  it("deletes multiple memories", () => {
    const id1 = remember("M1");
    const id2 = remember("M2");
    const id3 = remember("M3");

    expect(batchDeleteMemories([id1, id3])).toBe(2);
    expect(memoryCount()).toBe(1);
    expect(getById(id2)).not.toBeNull();
  });

  it("returns 0 for empty array", () => {
    expect(batchDeleteMemories([])).toBe(0);
  });

  it("returns 0 for non-existent IDs", () => {
    expect(batchDeleteMemories([99999, 88888])).toBe(0);
  });

  it("cleans FTS5 index on batch delete", () => {
    const id1 = remember("Searchable one");
    const id2 = remember("Searchable two");
    expect(ftsCount()).toBe(2);

    batchDeleteMemories([id1, id2]);
    expect(ftsCount()).toBe(0);
  });
});

// ============ Memory Context ============

describe("getMemoryContext()", () => {
  beforeEach(clearAll);

  it("empty DB → empty context", () => {
    const ctx = getMemoryContext();
    expect(ctx.total).toBe(0);
    expect(ctx.memories.length).toBe(0);
    expect(ctx.important.length).toBe(0);
  });

  it("returns total count", () => {
    remember("M1");
    remember("M2");
    remember("M3");
    expect(getMemoryContext().total).toBe(3);
  });

  it("important only includes high/critical", () => {
    remember("Low", { importance: "low" });
    remember("Normal", { importance: "normal" });
    remember("High", { importance: "high" });
    remember("Critical", { importance: "critical" });

    const ctx = getMemoryContext();
    expect(ctx.important.length).toBe(2);
    const importances = ctx.important.map((m) => m.importance);
    expect(importances).toContain("high");
    expect(importances).toContain("critical");
  });

  it("memories ordered by importance then recency", () => {
    remember("Low", { importance: "low" });
    remember("Critical", { importance: "critical" });
    remember("Normal", { importance: "normal" });

    const ctx = getMemoryContext();
    expect(ctx.memories[0].importance).toBe("critical");
  });
});

// ============ Prompt Building ============

describe("buildMemoryPrompt()", () => {
  beforeEach(clearAll);

  it("includes delta_memory tags", () => {
    const prompt = buildMemoryPrompt();
    expect(prompt).toContain("<delta_memory>");
    expect(prompt).toContain("</delta_memory>");
  });

  it("includes mandatory instructions", () => {
    const prompt = buildMemoryPrompt();
    expect(prompt).toContain("## Memory (mandatory)");
    expect(prompt).toContain("delta_search");
    expect(prompt).toContain("delta_remember");
  });

  it("includes session write stats", () => {
    const prompt = buildMemoryPrompt({ sessionWrites: 5, turnsIdle: 0 });
    expect(prompt).toContain("5 writes this session");
    expect(prompt).toContain("active");
  });

  it("includes idle turn count", () => {
    const prompt = buildMemoryPrompt({ sessionWrites: 0, turnsIdle: 3 });
    expect(prompt).toContain("3 turns idle");
  });

  it("includes critical knowledge section for important memories", () => {
    remember("Critical finding about auth", {
      importance: "critical",
      tags: ["security"],
    });
    const prompt = buildMemoryPrompt();
    expect(prompt).toContain("## Critical Knowledge");
    expect(prompt).toContain("Critical finding about auth");
    expect(prompt).toContain("[CRITICAL]");
    expect(prompt).toContain("security");
  });

  it("includes memory map when memories exist", () => {
    remember("Decided to use PostgreSQL", { tags: ["decision"] });
    remember("Commit abc123: fix login", { tags: ["commit"] });
    remember("Auth module has race condition", { tags: ["bug"] });

    const prompt = buildMemoryPrompt();
    expect(prompt).toContain("## Memory Map");
    expect(prompt).toContain("Decisions:");
    expect(prompt).toContain("Commits:");
    expect(prompt).toContain("Issues:");
  });

  it("no memory map for empty DB", () => {
    const prompt = buildMemoryPrompt();
    expect(prompt).not.toContain("## Memory Map");
  });
});

// ============ Compatibility ============

describe("logEpisode() compatibility", () => {
  beforeEach(clearAll);

  it("creates a memory (backward compat with index.ts)", () => {
    const id = logEpisode("Commit abc123 on main: fix auth", "git", ["commit", "auto-captured"]);
    expect(id).toBeGreaterThan(0);

    const mem = getById(id);
    expect(mem).not.toBeNull();
    expect(mem?.content).toBe("Commit abc123 on main: fix auth");
    expect(mem?.context).toBe("git");
    expect(mem?.tags).toEqual(["commit", "auto-captured"]);
  });
});

// ============ Version & Schema ============

describe("Version & Schema Info", () => {
  it("getVersionInfo returns correct structure", () => {
    const info = getVersionInfo();
    expect(info).toHaveProperty("current");
    expect(info).toHaveProperty("shipped");
    expect(info).toHaveProperty("match");
    expect(info.shipped).toBe(4);
  });

  it("getDatabaseSchema returns non-empty DDL", () => {
    const schema = getDatabaseSchema();
    expect(schema.length).toBeGreaterThan(0);
    expect(schema).toContain("memories");
    expect(schema).toContain("memories_fts");
  });

  it("schema contains no v3 artifacts", () => {
    const schema = getDatabaseSchema();
    expect(schema).not.toContain("mi_note_insert");
    expect(schema).not.toContain("mi_episode_insert");
    expect(schema).not.toContain("mi_kv_insert");
  });
});

describe("Database Info", () => {
  it("returns database location", () => {
    const location = getDbLocation();
    expect(location).toContain("pi-ext-delta");
    expect(location).toContain("delta.db");
  });
});

// ============ Migration v3→v4 ============

describe("Migration v3→v4", () => {
  /**
   * Migration tests work by:
   * 1. Closing the current DB
   * 2. Opening a raw DB at the same path
   * 3. Creating v3 schema and populating data
   * 4. Stamping schema_version to 3
   * 5. Closing the raw DB
   * 6. Reopening via getDb() which detects v3 and auto-migrates
   */

  afterEach(() => {
    // Ensure clean state for subsequent tests
    clearAll();
  });

  function setupV3Database(): string {
    // Get the DB path, then reset module state
    const dbPath = getDbLocation();
    _testReset();

    // Import the shared helpers to work with raw DB
    // We use the getDb() path but open it directly
    const Database = require("better-sqlite3");
    const rawDb = new Database(dbPath);
    rawDb.exec("PRAGMA journal_mode = WAL");
    rawDb.exec("PRAGMA foreign_keys = ON");

    // Drop any existing v4 tables/triggers to start fresh
    rawDb.exec("DROP TRIGGER IF EXISTS memories_fts_ai");
    rawDb.exec("DROP TRIGGER IF EXISTS memories_fts_ad");
    rawDb.exec("DROP TRIGGER IF EXISTS memories_fts_au");
    rawDb.exec("DROP TABLE IF EXISTS memories_fts");
    rawDb.exec("DROP TABLE IF EXISTS memories");

    // Create v3 schema
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        version INTEGER NOT NULL
      );

      DELETE FROM schema_version;
      INSERT INTO schema_version (id, version) VALUES (1, 3);

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        context TEXT,
        tags TEXT,
        timestamp INTEGER NOT NULL,
        session_id TEXT,
        last_accessed INTEGER NOT NULL DEFAULT 0
      );

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
    `);

    return dbPath;
  }

  it("migrates episodes → memories", () => {
    const dbPath = setupV3Database();
    const Database = require("better-sqlite3");
    const rawDb = new Database(dbPath);

    const now = Date.now();
    rawDb
      .prepare(
        "INSERT INTO episodes (content, context, tags, timestamp, session_id, last_accessed) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("Found race condition", "src/worker.ts", '["bug","concurrency"]', now, "sess-1", now);
    rawDb
      .prepare(
        "INSERT INTO episodes (content, context, tags, timestamp, session_id, last_accessed) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("Decided on PostgreSQL", null, '["decision"]', now - 1000, "sess-1", 0);

    rawDb.close();

    // Reopen via getDb() — triggers migration
    const _db = getDb();

    // Verify migration
    expect(memoryCount()).toBe(2);

    const memories = getAllMemories();
    const raceMem = memories.find((m) => m.content.includes("race condition"));
    expect(raceMem).toBeDefined();
    expect(raceMem?.tags).toEqual(["bug", "concurrency"]);
    expect(raceMem?.context).toBe("src/worker.ts");
    expect(raceMem?.session_id).toBe("sess-1");
    expect(raceMem?.importance).toBe("normal");

    const decisionMem = memories.find((m) => m.content.includes("PostgreSQL"));
    expect(decisionMem).toBeDefined();
    expect(decisionMem?.tags).toEqual(["decision"]);
    expect(decisionMem?.last_accessed).toBe(0);
  });

  it("migrates project_notes → memories with title+content merged", () => {
    const dbPath = setupV3Database();
    const Database = require("better-sqlite3");
    const rawDb = new Database(dbPath);

    const now = Date.now();
    rawDb
      .prepare(
        "INSERT INTO project_notes (title, content, category, importance, active, created_at, updated_at, last_accessed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        "SQL Injection Fix",
        "Found in login endpoint, patched with parameterized queries",
        "issue",
        "critical",
        1,
        now,
        now,
        now
      );

    rawDb
      .prepare(
        "INSERT INTO project_notes (title, content, category, importance, active, created_at, updated_at, last_accessed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run("Archived Note", "Old convention", "convention", "normal", 0, now - 5000, now - 3000, 0);

    rawDb.close();

    const _db = getDb();

    expect(memoryCount()).toBe(2);

    const memories = getAllMemories();
    const issueMem = memories.find((m) => m.content.includes("SQL Injection Fix"));
    expect(issueMem).toBeDefined();
    // Title + \n\n + content merged
    expect(issueMem?.content).toContain("SQL Injection Fix");
    expect(issueMem?.content).toContain("Found in login endpoint");
    expect(issueMem?.importance).toBe("critical");
    expect(issueMem?.tags).toContain("issue");

    const archivedMem = memories.find((m) => m.content.includes("Archived Note"));
    expect(archivedMem).toBeDefined();
    expect(archivedMem?.tags).toContain("convention");
    expect(archivedMem?.tags).toContain("archived");
  });

  it("migrates kv → memories with key:value content", () => {
    const dbPath = setupV3Database();
    const Database = require("better-sqlite3");
    const rawDb = new Database(dbPath);

    const now = Date.now();
    rawDb
      .prepare(
        "INSERT INTO kv (key, value, created_at, updated_at, last_accessed) VALUES (?, ?, ?, ?, ?)"
      )
      .run("theme", "dark", now, now, now);
    rawDb
      .prepare(
        "INSERT INTO kv (key, value, created_at, updated_at, last_accessed) VALUES (?, ?, ?, ?, ?)"
      )
      .run("editor.fontSize", "14", now, now, 0);

    rawDb.close();

    const _db = getDb();

    expect(memoryCount()).toBe(2);

    const memories = getAllMemories();
    const themeMem = memories.find((m) => m.content.includes("theme: dark"));
    expect(themeMem).toBeDefined();
    expect(themeMem?.tags).toContain("kv");
    expect(themeMem?.tags).toContain("theme");
    expect(themeMem?.importance).toBe("normal");

    const fontMem = memories.find((m) => m.content.includes("editor.fontSize: 14"));
    expect(fontMem).toBeDefined();
    expect(fontMem?.tags).toContain("kv");
    expect(fontMem?.tags).toContain("editor.fontSize");
  });

  it("migrates all v3 types together", () => {
    const dbPath = setupV3Database();
    const Database = require("better-sqlite3");
    const rawDb = new Database(dbPath);

    const now = Date.now();
    // 2 episodes
    rawDb
      .prepare(
        "INSERT INTO episodes (content, context, tags, timestamp, session_id, last_accessed) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("Episode 1", null, '["tag1"]', now, "s1", 0);
    rawDb
      .prepare(
        "INSERT INTO episodes (content, context, tags, timestamp, session_id, last_accessed) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("Episode 2", null, null, now, "s1", 0);
    // 1 note
    rawDb
      .prepare(
        "INSERT INTO project_notes (title, content, category, importance, active, created_at, updated_at, last_accessed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run("Note 1", "Content", "workflow", "high", 1, now, now, 0);
    // 1 kv
    rawDb
      .prepare(
        "INSERT INTO kv (key, value, created_at, updated_at, last_accessed) VALUES (?, ?, ?, ?, ?)"
      )
      .run("k1", "v1", now, now, 0);

    rawDb.close();

    const _db = getDb();

    // Total: 2 episodes + 1 note + 1 kv = 4 memories
    expect(memoryCount()).toBe(4);
  });

  it("drops old v3 tables after migration", () => {
    const dbPath = setupV3Database();
    const Database = require("better-sqlite3");
    const rawDb = new Database(dbPath);
    rawDb.close();

    const db = getDb();

    for (const table of ["kv", "episodes", "project_notes", "memory_index"]) {
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table) as { c: number };
      expect(row.c, `table ${table} should be dropped`).toBe(0);
    }
  });

  it("bumps schema_version to 4 after migration", () => {
    const dbPath = setupV3Database();
    const Database = require("better-sqlite3");
    const rawDb = new Database(dbPath);
    rawDb.close();

    const _db = getDb();
    const info = getVersionInfo();
    expect(info.current).toBe(4);
  });

  it("FTS5 index populated after migration", () => {
    const dbPath = setupV3Database();
    const Database = require("better-sqlite3");
    const rawDb = new Database(dbPath);

    const now = Date.now();
    rawDb
      .prepare(
        "INSERT INTO episodes (content, context, tags, timestamp, session_id, last_accessed) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("Searchable episode content", null, null, now, "s1", 0);
    rawDb.close();

    const _db = getDb();

    // FTS5 should have the migrated data
    const results = search({ query: "Searchable" });
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Searchable episode content");
  });

  it("handles migration from empty v3 database", () => {
    const dbPath = setupV3Database();
    const Database = require("better-sqlite3");
    const rawDb = new Database(dbPath);
    rawDb.close();

    // No data inserted — just empty tables
    const _db = getDb();
    expect(memoryCount()).toBe(0);
    expect(getVersionInfo().current).toBe(4);
  });

  it("preserves episodes with null tags", () => {
    const dbPath = setupV3Database();
    const Database = require("better-sqlite3");
    const rawDb = new Database(dbPath);

    const now = Date.now();
    rawDb
      .prepare(
        "INSERT INTO episodes (content, context, tags, timestamp, session_id, last_accessed) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("No tags episode", null, null, now, "s1", 0);
    rawDb.close();

    const _db = getDb();
    const memories = getAllMemories();
    expect(memories[0].tags).toEqual([]);
  });
});

// ============ Edge Cases ============

describe("Edge Cases", () => {
  beforeEach(clearAll);

  it("handles very long content", () => {
    const longContent = "A".repeat(10000);
    const id = remember(longContent);
    expect(getById(id)?.content).toBe(longContent);
  });

  it("handles unicode content", () => {
    const id = remember("日本語テスト 🎉 مرحبا");
    expect(getById(id)?.content).toBe("日本語テスト 🎉 مرحبا");
  });

  it("handles tags with special characters", () => {
    const id = remember("Memory", { tags: ["c++", "node.js", "vue/nuxt"] });
    expect(getById(id)?.tags).toEqual(["c++", "node.js", "vue/nuxt"]);
  });

  it("handles rapid reads and writes", () => {
    // Create 20 memories rapidly
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(remember(`Memory ${i}`, { tags: [`tag-${i % 5}`] }));
    }
    expect(memoryCount()).toBe(20);

    // Search while data exists
    const results = search({ tags: ["tag-0"] });
    expect(results.length).toBe(4);

    // Delete half
    batchDeleteMemories(ids.filter((_, i) => i % 2 === 0));
    expect(memoryCount()).toBe(10);
  });

  it("search with LIKE-special chars doesn't break", () => {
    remember("100% complete");
    remember("under_score test");
    remember("back\\slash test");

    // These contain LIKE wildcards — should be escaped properly
    const results = search({ query: "100%" });
    expect(results).toBeDefined(); // Should not throw
  });

  it("remember with all optional fields omitted", () => {
    const id = remember("Minimal memory");
    const mem = getById(id) as Memory;
    expect(mem.content).toBe("Minimal memory");
    expect(mem.tags).toEqual([]);
    expect(mem.importance).toBe("normal");
    expect(mem.context).toBeNull();
  });
});
