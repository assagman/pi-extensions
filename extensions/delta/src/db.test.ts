/**
 * Delta v3 database tests — no tasks.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DB_VERSION,
  type MemoryIndexEntry,
  closeDb,
  createNote,
  deleteEpisode,
  deleteNote,
  getDatabaseSchema,
  getDb,
  getDbLocation,
  getMemoryContext,
  getMemoryIndex,
  getNote,
  getVersionInfo,
  kvDelete,
  kvGet,
  kvSet,
  listNotes,
  logEpisode,
  rebuildIndex,
  recallEpisodes,
  searchIndex,
  updateNote,
} from "./db.js";

// ============ Helpers ============

function getIndexEntry(
  sourceType: string,
  sourceId: string | number
): MemoryIndexEntry | undefined {
  return getMemoryIndex(500).find(
    (e) => e.source_type === sourceType && e.source_id === String(sourceId)
  );
}

function countIndex(sourceType?: string): number {
  if (!sourceType) return getMemoryIndex(500).length;
  return getMemoryIndex(500).filter((e) => e.source_type === sourceType).length;
}

function assertIndexConsistency(): void {
  const db = getDb();
  const notes = (db.prepare("SELECT COUNT(*) as c FROM project_notes").get() as { c: number }).c;
  const episodes = (db.prepare("SELECT COUNT(*) as c FROM episodes").get() as { c: number }).c;
  const kv = (db.prepare("SELECT COUNT(*) as c FROM kv").get() as { c: number }).c;
  const index = (db.prepare("SELECT COUNT(*) as c FROM memory_index").get() as { c: number }).c;

  expect(index).toBe(notes + episodes + kv);
}

function clearAll(): void {
  const db = getDb();
  db.exec("DELETE FROM memory_index");
  db.exec("DELETE FROM project_notes");
  db.exec("DELETE FROM episodes");
  db.exec("DELETE FROM kv");
}

// ============ Setup / Teardown ============

afterAll(() => {
  closeDb();
});

// ============ Notes × Index ============

describe("Notes → Index Sync", () => {
  beforeEach(clearAll);

  it("createNote → index entry created with correct fields", () => {
    const id = createNote({
      title: "SQL injection found",
      content: "Found in login endpoint",
      category: "issue",
      importance: "high",
    });

    const entry = getIndexEntry("note", id);
    expect(entry).toBeDefined();
    expect(entry?.summary).toBe("SQL injection found");
    expect(entry?.keywords).toBe("issue");
    expect(entry?.importance).toBe("high");
    assertIndexConsistency();
  });

  it("createNote with defaults → index importance is 'normal'", () => {
    const id = createNote({ title: "General note", content: "Content" });
    const entry = getIndexEntry("note", id);
    expect(entry?.importance).toBe("normal");
    expect(entry?.keywords).toBe("general");
  });

  it("updateNote title → index summary updated", () => {
    const id = createNote({ title: "Original", content: "C" });
    updateNote(id, { title: "Renamed" });

    const entry = getIndexEntry("note", id);
    expect(entry?.summary).toBe("Renamed");
    assertIndexConsistency();
  });

  it("updateNote category → index keywords updated", () => {
    const id = createNote({ title: "Note", content: "C", category: "general" });
    updateNote(id, { category: "issue" });
    expect(getIndexEntry("note", id)?.keywords).toBe("issue");
  });

  it("updateNote importance → index importance updated", () => {
    const id = createNote({ title: "Note", content: "C", importance: "normal" });
    updateNote(id, { importance: "critical" });
    expect(getIndexEntry("note", id)?.importance).toBe("critical");
  });

  it("deleteNote → index entry removed", () => {
    const id = createNote({ title: "To delete", content: "C" });
    expect(getIndexEntry("note", id)).toBeDefined();
    deleteNote(id);
    expect(getIndexEntry("note", id)).toBeUndefined();
    assertIndexConsistency();
  });

  it("create 3 notes, delete 1 → index has exactly 2", () => {
    const id1 = createNote({ title: "Keep 1", content: "C" });
    const id2 = createNote({ title: "Remove", content: "C" });
    const id3 = createNote({ title: "Keep 2", content: "C" });
    deleteNote(id2);

    expect(countIndex("note")).toBe(2);
    expect(getIndexEntry("note", id1)).toBeDefined();
    expect(getIndexEntry("note", id2)).toBeUndefined();
    expect(getIndexEntry("note", id3)).toBeDefined();
    assertIndexConsistency();
  });

  it("multiple updates → index reflects final state only", () => {
    const id = createNote({ title: "v1", content: "C", category: "general", importance: "low" });
    updateNote(id, { title: "v2", category: "issue" });
    updateNote(id, { title: "v3", importance: "critical" });

    const entry = getIndexEntry("note", id);
    expect(entry?.summary).toBe("v3");
    expect(entry?.keywords).toBe("issue");
    expect(entry?.importance).toBe("critical");
    expect(countIndex("note")).toBe(1);
  });
});

// ============ Episodes × Index ============

describe("Episodes → Index Sync", () => {
  beforeEach(clearAll);

  it("logEpisode → index entry created", () => {
    const id = logEpisode("Discovered a race condition in worker pool");
    const entry = getIndexEntry("episode", id);
    expect(entry).toBeDefined();
    expect(entry?.summary).toBe("Discovered a race condition in worker pool");
    expect(entry?.importance).toBe("normal");
    assertIndexConsistency();
  });

  it("logEpisode with tags → index keywords populated", () => {
    const id = logEpisode("Found bug", "src/main.ts", ["bug", "critical"]);
    const entry = getIndexEntry("episode", id);
    expect(entry?.keywords).toBe('["bug","critical"]');
  });

  it("logEpisode with long content → summary truncated at 120 chars", () => {
    const longContent = "A".repeat(200);
    const id = logEpisode(longContent);
    const entry = getIndexEntry("episode", id);
    expect(entry?.summary.length).toBe(120);
  });

  it("deleteEpisode → index entry removed", () => {
    const id = logEpisode("Temporary event");
    expect(getIndexEntry("episode", id)).toBeDefined();
    deleteEpisode(id);
    expect(getIndexEntry("episode", id)).toBeUndefined();
    assertIndexConsistency();
  });

  it("log 5 episodes, delete 2 → index has exactly 3", () => {
    const ids = Array.from({ length: 5 }, (_, i) => logEpisode(`Event ${i}`));
    deleteEpisode(ids[1]);
    deleteEpisode(ids[3]);
    expect(countIndex("episode")).toBe(3);
    assertIndexConsistency();
  });
});

// ============ KV × Index ============

describe("KV → Index Sync", () => {
  beforeEach(clearAll);

  it("kvSet new key → index entry created", () => {
    kvSet("theme", "dark");
    const entry = getIndexEntry("kv", "theme");
    expect(entry).toBeDefined();
    expect(entry?.summary).toBe("theme: dark");
    expect(entry?.keywords).toBe("theme");
    assertIndexConsistency();
  });

  it("kvSet existing key (upsert) → index entry updated, no duplicate", () => {
    kvSet("theme", "dark");
    kvSet("theme", "light");
    const entry = getIndexEntry("kv", "theme");
    expect(entry?.summary).toBe("theme: light");
    expect(countIndex("kv")).toBe(1);
    assertIndexConsistency();
  });

  it("kvDelete → index entry removed", () => {
    kvSet("temp", "value");
    kvDelete("temp");
    expect(getIndexEntry("kv", "temp")).toBeUndefined();
    assertIndexConsistency();
  });

  it("multiple keys → each has own index entry", () => {
    kvSet("a", "1");
    kvSet("b", "2");
    kvSet("c", "3");
    expect(countIndex("kv")).toBe(3);
    assertIndexConsistency();
  });
});

// ============ Cross-Table Consistency ============

describe("Cross-Table Index Consistency", () => {
  beforeEach(clearAll);

  it("empty DB → empty index", () => {
    expect(countIndex()).toBe(0);
    assertIndexConsistency();
  });

  it("mixed inserts → index count = sum of all source rows", () => {
    createNote({ title: "Note 1", content: "C" });
    createNote({ title: "Note 2", content: "C" });
    logEpisode("Event 1");
    logEpisode("Event 2");
    logEpisode("Event 3");
    kvSet("k1", "v1");
    kvSet("k2", "v2");

    expect(countIndex()).toBe(7);
    expect(countIndex("note")).toBe(2);
    expect(countIndex("episode")).toBe(3);
    expect(countIndex("kv")).toBe(2);
    assertIndexConsistency();
  });

  it("mixed inserts then mixed deletes → index reflects survivors", () => {
    const n1 = createNote({ title: "Note", content: "C" });
    const e1 = logEpisode("Event");
    kvSet("key", "val");
    expect(countIndex()).toBe(3);

    deleteNote(n1);
    deleteEpisode(e1);
    expect(countIndex()).toBe(1);
    expect(getIndexEntry("kv", "key")).toBeDefined();

    kvDelete("key");
    expect(countIndex()).toBe(0);
    assertIndexConsistency();
  });

  it("no orphaned index entries after all source rows deleted", () => {
    createNote({ title: "N", content: "C" });
    logEpisode("E");
    kvSet("K", "V");
    expect(countIndex()).toBe(3);

    const db = getDb();
    db.exec("DELETE FROM project_notes");
    db.exec("DELETE FROM episodes");
    db.exec("DELETE FROM kv");
    expect(countIndex()).toBe(0);
    assertIndexConsistency();
  });

  it("no SCD2 behavior — updates replace, never accumulate", () => {
    const id = createNote({ title: "v1", content: "C", importance: "low" });
    updateNote(id, { title: "v2" });
    updateNote(id, { title: "v3" });
    updateNote(id, { title: "v4" });

    expect(countIndex("note")).toBe(1);
    expect(getIndexEntry("note", id)?.summary).toBe("v4");
    assertIndexConsistency();
  });
});

// ============ Memory Index Operations ============

describe("Memory Index Operations", () => {
  beforeEach(clearAll);

  describe("getMemoryIndex", () => {
    it("returns empty array for empty DB", () => {
      expect(getMemoryIndex()).toEqual([]);
    });

    it("returns all entries ordered by importance DESC", () => {
      createNote({ title: "Low note", content: "C", importance: "low" });
      createNote({ title: "Critical note", content: "C", importance: "critical" });
      createNote({ title: "Normal note", content: "C", importance: "normal" });

      const index = getMemoryIndex();
      expect(index[0].summary).toBe("Critical note");
      expect(index.length).toBe(3);
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) createNote({ title: `Note ${i}`, content: "C" });
      expect(getMemoryIndex(3).length).toBe(3);
    });
  });

  describe("searchIndex", () => {
    it("finds entries by summary text", () => {
      createNote({ title: "SQL injection found", content: "C" });
      createNote({ title: "XSS vulnerability", content: "C" });
      logEpisode("Fixed SQL injection in auth");

      const results = searchIndex("SQL");
      expect(results.length).toBe(2);
    });

    it("finds entries by keywords", () => {
      createNote({ title: "Bug report", content: "C", category: "issue" });
      createNote({ title: "Code standard", content: "C", category: "convention" });

      const results = searchIndex("issue");
      expect(results.length).toBe(1);
      expect(results[0].summary).toBe("Bug report");
    });

    it("filters by source_type", () => {
      createNote({ title: "SQL note", content: "C" });
      logEpisode("SQL episode");

      const noteOnly = searchIndex("SQL", "note");
      expect(noteOnly.length).toBe(1);
      expect(noteOnly[0].source_type).toBe("note");
    });

    it("returns empty for no matches", () => {
      createNote({ title: "Something", content: "C" });
      expect(searchIndex("nonexistent")).toEqual([]);
    });
  });

  describe("rebuildIndex", () => {
    it("rebuilds from empty → 0 entries", () => {
      expect(rebuildIndex()).toBe(0);
    });

    it("rebuilds from populated source tables", () => {
      createNote({ title: "Note", content: "C" });
      logEpisode("Episode");
      kvSet("key", "val");

      getDb().exec("DELETE FROM memory_index");
      expect(countIndex()).toBe(0);

      const count = rebuildIndex();
      expect(count).toBe(3);
      assertIndexConsistency();
    });

    it("rebuild is idempotent", () => {
      createNote({ title: "Note", content: "C" });
      logEpisode("Event");

      const count1 = rebuildIndex();
      const count2 = rebuildIndex();
      expect(count1).toBe(count2);
      assertIndexConsistency();
    });

    it("rebuild removes stale entries", () => {
      const id = createNote({ title: "Note", content: "C" });
      getDb()
        .prepare(
          "INSERT INTO memory_index(source_type,source_id,summary,keywords,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
        )
        .run("note", "999", "Ghost", null, "normal", Date.now(), Date.now());
      expect(countIndex()).toBe(2);

      rebuildIndex();
      expect(countIndex()).toBe(1);
      expect(getIndexEntry("note", id)).toBeDefined();
      expect(getIndexEntry("note", 999)).toBeUndefined();
      assertIndexConsistency();
    });
  });
});

// ============ getMemoryContext ============

describe("getMemoryContext", () => {
  beforeEach(clearAll);

  it("indexEntries contains all memory types", () => {
    createNote({ title: "N", content: "C" });
    logEpisode("E");
    kvSet("K", "V");

    const ctx = getMemoryContext();
    expect(ctx.indexEntries.length).toBe(3);
    const types = ctx.indexEntries.map((e) => e.source_type).sort();
    expect(types).toEqual(["episode", "kv", "note"]);
  });

  it("criticalNotes includes only HIGH and CRITICAL active notes", () => {
    createNote({ title: "Low", content: "C", importance: "low" });
    createNote({ title: "Normal", content: "C", importance: "normal" });
    createNote({ title: "High", content: "Full content high", importance: "high" });
    createNote({ title: "Critical", content: "Full content critical", importance: "critical" });

    const ctx = getMemoryContext();
    expect(ctx.criticalNotes.length).toBe(2);
    const titles = ctx.criticalNotes.map((n) => n.title).sort();
    expect(titles).toEqual(["Critical", "High"]);
  });

  it("criticalNotes excludes archived (active=false) HIGH notes", () => {
    createNote({ title: "Archived High", content: "C", importance: "high", active: false });
    const ctx = getMemoryContext();
    expect(ctx.criticalNotes.length).toBe(0);
  });

  it("empty DB → empty context", () => {
    const ctx = getMemoryContext();
    expect(ctx.indexEntries.length).toBe(0);
    expect(ctx.criticalNotes.length).toBe(0);
  });
});

// ============ CRUD Tests ============

describe("Key-Value Store", () => {
  beforeEach(clearAll);

  it("should return null for non-existent key", () => {
    expect(kvGet("nonexistent")).toBeNull();
  });

  it("should set and get a value", () => {
    kvSet("test-key", "test-value");
    expect(kvGet("test-key")).toBe("test-value");
  });

  it("should overwrite existing value", () => {
    kvSet("key", "value1");
    kvSet("key", "value2");
    expect(kvGet("key")).toBe("value2");
  });

  it("should delete a key", () => {
    kvSet("to-delete", "value");
    expect(kvDelete("to-delete")).toBe(true);
    expect(kvGet("to-delete")).toBeNull();
  });

  it("should return false when deleting non-existent key", () => {
    expect(kvDelete("nonexistent")).toBe(false);
  });
});

describe("Episodic Memory", () => {
  beforeEach(clearAll);

  it("should log an episode and return id", () => {
    const id = logEpisode("Test event occurred");
    expect(id).toBeGreaterThan(0);
  });

  it("should log episode with context and tags", () => {
    logEpisode("Bug found", "src/main.ts", ["bug", "critical"]);
    const episodes = recallEpisodes({ limit: 1 });
    expect(episodes[0].content).toBe("Bug found");
    expect(episodes[0].context).toBe("src/main.ts");
    expect(episodes[0].tags).toEqual(["bug", "critical"]);
  });

  it("should recall episodes with query filter", () => {
    logEpisode("Found a security bug");
    logEpisode("Fixed the performance issue");
    logEpisode("Security review complete");
    const results = recallEpisodes({ query: "security" });
    expect(results.length).toBe(2);
  });

  it("should recall episodes with tag filter", () => {
    logEpisode("Event 1", undefined, ["important"]);
    logEpisode("Event 2", undefined, ["minor"]);
    logEpisode("Event 3", undefined, ["important", "bug"]);
    const results = recallEpisodes({ tags: ["important"] });
    expect(results.length).toBe(2);
  });

  it("should respect limit parameter", () => {
    for (let i = 0; i < 10; i++) logEpisode(`Event ${i}`);
    const results = recallEpisodes({ limit: 5 });
    expect(results.length).toBe(5);
  });

  it("should delete episode by id", () => {
    const id = logEpisode("To be deleted");
    expect(deleteEpisode(id)).toBe(true);
    const results = recallEpisodes({ query: "deleted" });
    expect(results.length).toBe(0);
  });
});

describe("Project Notes", () => {
  beforeEach(clearAll);

  it("should create a note with defaults", () => {
    const id = createNote({ title: "Test Note", content: "Content here" });
    const note = getNote(id);
    expect(note).not.toBeNull();
    expect(note?.title).toBe("Test Note");
    expect(note?.category).toBe("general");
    expect(note?.importance).toBe("normal");
    expect(note?.active).toBe(true);
  });

  it("should update a note", () => {
    const id = createNote({ title: "Original", content: "Content" });
    updateNote(id, { title: "Updated", active: false });
    const note = getNote(id);
    expect(note?.title).toBe("Updated");
    expect(note?.active).toBe(false);
  });

  it("should delete a note", () => {
    const id = createNote({ title: "To delete", content: "Content" });
    expect(deleteNote(id)).toBe(true);
    expect(getNote(id)).toBeNull();
  });

  it("should list active notes only", () => {
    createNote({ title: "Active 1", content: "C", active: true });
    createNote({ title: "Active 2", content: "C", active: true });
    createNote({ title: "Archived", content: "C", active: false });
    const activeNotes = listNotes({ activeOnly: true });
    expect(activeNotes.length).toBe(2);
  });

  it("should filter by category", () => {
    createNote({ title: "Issue 1", content: "C", category: "issue" });
    createNote({ title: "Convention", content: "C", category: "convention" });
    createNote({ title: "Issue 2", content: "C", category: "issue" });
    const issues = listNotes({ category: "issue" });
    expect(issues.length).toBe(2);
  });
});

// ============ Version & Schema ============

describe("Database Version", () => {
  it("DB_VERSION is 3", () => {
    expect(DB_VERSION).toBe(3);
  });

  it("schema_version table exists", () => {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'"
      )
      .get() as { count: number };
    expect(row.count).toBe(1);
  });

  it("getVersionInfo returns correct structure", () => {
    const info = getVersionInfo();
    expect(info).toHaveProperty("current");
    expect(info).toHaveProperty("shipped");
    expect(info).toHaveProperty("match");
    expect(typeof info.shipped).toBe("number");
  });

  it("no tasks table exists", () => {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
      )
      .get() as { count: number };
    expect(row.count).toBe(0);
  });

  it("last_accessed column exists on all memory tables", () => {
    const db = getDb();
    for (const table of ["kv", "episodes", "project_notes"]) {
      const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{
        name: string;
      }>;
      expect(cols.some((c) => c.name === "last_accessed")).toBe(true);
    }
  });
});

describe("Database Schema Dump", () => {
  it("returns non-empty DDL string", () => {
    const schema = getDatabaseSchema();
    expect(schema.length).toBeGreaterThan(0);
  });

  it("contains expected tables but NOT tasks", () => {
    const schema = getDatabaseSchema();
    for (const table of ["schema_version", "kv", "episodes", "project_notes", "memory_index"]) {
      expect(schema).toContain(table);
    }
    // No tasks references
    expect(schema).not.toContain("mi_task_insert");
  });

  it("contains note/episode/kv triggers", () => {
    const schema = getDatabaseSchema();
    expect(schema).toContain("mi_note_insert");
    expect(schema).toContain("mi_episode_insert");
    expect(schema).toContain("mi_kv_insert");
  });
});

describe("Database Info", () => {
  it("should return database location", () => {
    const location = getDbLocation();
    expect(location).toContain("pi-ext-delta");
    expect(location).toContain("delta.db");
  });
});
