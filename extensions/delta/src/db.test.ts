import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DB_VERSION,
  type MemoryIndexEntry,
  closeDb,
  createNote,
  createTask,
  deleteEpisode,
  deleteNote,
  deleteTask,
  getDatabaseSchema,
  getDb,
  getDbLocation,
  getMemoryContext,
  getMemoryIndex,
  getNote,
  getTask,
  getVersionInfo,
  kvDelete,
  kvGet,
  kvSet,
  listNotes,
  listTasks,
  logEpisode,
  rebuildIndex,
  recallEpisodes,
  searchIndex,
  updateNote,
  updateTask,
} from "./db.js";

// ============ Helpers ============

/** Get a specific index entry by source type and ID */
function getIndexEntry(
  sourceType: string,
  sourceId: string | number
): MemoryIndexEntry | undefined {
  return getMemoryIndex(500).find(
    (e) => e.source_type === sourceType && e.source_id === String(sourceId)
  );
}

/** Count index entries by source type */
function countIndex(sourceType?: string): number {
  if (!sourceType) return getMemoryIndex(500).length;
  return getMemoryIndex(500).filter((e) => e.source_type === sourceType).length;
}

/** Assert memory_index row count matches sum of all source tables */
function assertIndexConsistency(): void {
  const db = getDb();
  const notes = (
    db.prepare("SELECT COUNT(*) as c FROM project_notes").get() as {
      c: number;
    }
  ).c;
  const episodes = (
    db.prepare("SELECT COUNT(*) as c FROM episodes").get() as {
      c: number;
    }
  ).c;
  const tasks = (db.prepare("SELECT COUNT(*) as c FROM tasks").get() as { c: number }).c;
  const kv = (db.prepare("SELECT COUNT(*) as c FROM kv").get() as { c: number }).c;
  const index = (db.prepare("SELECT COUNT(*) as c FROM memory_index").get() as { c: number }).c;

  expect(index).toBe(notes + episodes + tasks + kv);
}

/** Clear all tables for a clean slate */
function clearAll(): void {
  const db = getDb();
  // Disable FK temporarily so we can delete tasks without cascade issues
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DELETE FROM memory_index");
  db.exec("DELETE FROM project_notes");
  db.exec("DELETE FROM episodes");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM kv");
  db.exec("PRAGMA foreign_keys = ON");
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
    const id = createNote({
      title: "Note",
      content: "C",
      category: "general",
    });
    updateNote(id, { category: "issue" });

    const entry = getIndexEntry("note", id);
    expect(entry?.keywords).toBe("issue");
  });

  it("updateNote importance → index importance updated", () => {
    const id = createNote({
      title: "Note",
      content: "C",
      importance: "normal",
    });
    updateNote(id, { importance: "critical" });

    const entry = getIndexEntry("note", id);
    expect(entry?.importance).toBe("critical");
  });

  it("updateNote active=false (archive) → index entry still exists", () => {
    const id = createNote({
      title: "Archived",
      content: "C",
      active: true,
    });
    updateNote(id, { active: false });

    const entry = getIndexEntry("note", id);
    expect(entry).toBeDefined();
    assertIndexConsistency();
  });

  it("deleteNote → index entry removed", () => {
    const id = createNote({ title: "To delete", content: "C" });
    expect(getIndexEntry("note", id)).toBeDefined();

    deleteNote(id);
    expect(getIndexEntry("note", id)).toBeUndefined();
    assertIndexConsistency();
  });

  it("create 3 notes, delete 1 → index has exactly 2 note entries", () => {
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
    const id = createNote({
      title: "v1",
      content: "C",
      category: "general",
      importance: "low",
    });
    updateNote(id, { title: "v2", category: "issue" });
    updateNote(id, { title: "v3", importance: "critical" });

    const entry = getIndexEntry("note", id);
    expect(entry?.summary).toBe("v3");
    expect(entry?.keywords).toBe("issue");
    expect(entry?.importance).toBe("critical");
    expect(countIndex("note")).toBe(1); // no history rows
  });
});

// ============ Tasks × Index ============

describe("Tasks → Index Sync", () => {
  beforeEach(clearAll);

  it("createTask → index entry with correct fields", () => {
    const id = createTask({
      title: "Fix parser",
      status: "todo",
      priority: "high",
    });

    const entry = getIndexEntry("task", id);
    expect(entry).toBeDefined();
    expect(entry?.summary).toBe("Fix parser");
    expect(entry?.keywords).toBe("todo,high");
    expect(entry?.importance).toBe("high");
    assertIndexConsistency();
  });

  it("createTask medium priority → index importance is 'normal'", () => {
    const id = createTask({ title: "Low-pri task", priority: "medium" });

    const entry = getIndexEntry("task", id);
    expect(entry?.importance).toBe("normal");
  });

  it("createTask critical priority → index importance is 'critical'", () => {
    const id = createTask({ title: "Urgent", priority: "critical" });

    const entry = getIndexEntry("task", id);
    expect(entry?.importance).toBe("critical");
  });

  it("updateTask status → index keywords updated", () => {
    const id = createTask({
      title: "Task",
      status: "todo",
      priority: "high",
    });
    updateTask(id, { status: "done" });

    const entry = getIndexEntry("task", id);
    expect(entry?.keywords).toBe("done,high");
  });

  it("updateTask priority high→low → index importance updated", () => {
    const id = createTask({ title: "Task", priority: "high" });
    expect(getIndexEntry("task", id)?.importance).toBe("high");

    updateTask(id, { priority: "low" });
    expect(getIndexEntry("task", id)?.importance).toBe("normal");
  });

  it("updateTask title → index summary updated", () => {
    const id = createTask({ title: "Old title" });
    updateTask(id, { title: "New title" });

    expect(getIndexEntry("task", id)?.summary).toBe("New title");
  });

  it("deleteTask → index entry removed", () => {
    const id = createTask({ title: "Remove me" });
    deleteTask(id);

    expect(getIndexEntry("task", id)).toBeUndefined();
    assertIndexConsistency();
  });

  it("deleteTask with subtasks (CASCADE) → parent + children removed from index", () => {
    const parentId = createTask({ title: "Parent" });
    const child1Id = createTask({
      title: "Child 1",
      parent_id: parentId,
    });
    const child2Id = createTask({
      title: "Child 2",
      parent_id: parentId,
    });
    expect(countIndex("task")).toBe(3);

    deleteTask(parentId);

    expect(getIndexEntry("task", parentId)).toBeUndefined();
    expect(getIndexEntry("task", child1Id)).toBeUndefined();
    expect(getIndexEntry("task", child2Id)).toBeUndefined();
    expect(countIndex("task")).toBe(0);
    assertIndexConsistency();
  });

  it("deleteTask leaf (child only) → parent index entry remains", () => {
    const parentId = createTask({ title: "Parent" });
    const childId = createTask({
      title: "Child",
      parent_id: parentId,
    });

    deleteTask(childId);

    expect(getIndexEntry("task", parentId)).toBeDefined();
    expect(getIndexEntry("task", childId)).toBeUndefined();
    expect(countIndex("task")).toBe(1);
    assertIndexConsistency();
  });
});

// ============ Tasks — Parent Validation ============

describe("Tasks → Parent Validation", () => {
  beforeEach(clearAll);

  it("should create subtask with valid parent", () => {
    const parentId = createTask({ title: "Parent" });
    const childId = createTask({ title: "Child", parent_id: parentId });

    const child = getTask(childId);
    expect(child?.parent_id).toBe(parentId);
  });

  it("should reject non-existent parent", () => {
    expect(() => {
      createTask({ title: "Orphan", parent_id: 9999 });
    }).toThrow("Parent task #9999 not found");
  });

  it("should reject self-reference on update", () => {
    const id = createTask({ title: "Task" });
    expect(() => {
      updateTask(id, { parent_id: id });
    }).toThrow("Task cannot be its own parent");
  });

  it("should reject circular reference", () => {
    const parentId = createTask({ title: "Parent" });
    const childId = createTask({ title: "Child", parent_id: parentId });

    expect(() => {
      updateTask(parentId, { parent_id: childId });
    }).toThrow("Circular parent reference detected");
  });

  it("should reject deep circular reference", () => {
    const id1 = createTask({ title: "Task 1" });
    const id2 = createTask({ title: "Task 2", parent_id: id1 });
    const id3 = createTask({ title: "Task 3", parent_id: id2 });

    expect(() => {
      updateTask(id1, { parent_id: id3 });
    }).toThrow("Circular parent reference detected");
  });

  it("should allow moving task to different parent", () => {
    const parent1 = createTask({ title: "Parent 1" });
    const parent2 = createTask({ title: "Parent 2" });
    const child = createTask({ title: "Child", parent_id: parent1 });

    updateTask(child, { parent_id: parent2 });
    expect(getTask(child)?.parent_id).toBe(parent2);
  });

  it("should allow removing parent (making root task)", () => {
    const parent = createTask({ title: "Parent" });
    const child = createTask({ title: "Child", parent_id: parent });

    updateTask(child, { parent_id: null });
    expect(getTask(child)?.parent_id).toBeNull();
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

  it("logEpisode without tags → index keywords null", () => {
    const id = logEpisode("Simple event");

    const entry = getIndexEntry("episode", id);
    expect(entry?.keywords).toBeNull();
  });

  it("logEpisode with long content → summary truncated at 120 chars", () => {
    const longContent = "A".repeat(200);
    const id = logEpisode(longContent);

    const entry = getIndexEntry("episode", id);
    expect(entry?.summary.length).toBe(120);
    expect(entry?.summary).toBe("A".repeat(120));
  });

  it("deleteEpisode → index entry removed", () => {
    const id = logEpisode("Temporary event");
    expect(getIndexEntry("episode", id)).toBeDefined();

    deleteEpisode(id);
    expect(getIndexEntry("episode", id)).toBeUndefined();
    assertIndexConsistency();
  });

  it("deleteEpisode non-existent → returns false, index unchanged", () => {
    logEpisode("Existing event");
    const before = countIndex("episode");

    const deleted = deleteEpisode(99999);
    expect(deleted).toBe(false);
    expect(countIndex("episode")).toBe(before);
  });

  it("log 5 episodes, delete 2 → index has exactly 3", () => {
    const ids = Array.from({ length: 5 }, (_, i) => logEpisode(`Event ${i}`));

    deleteEpisode(ids[1]);
    deleteEpisode(ids[3]);

    expect(countIndex("episode")).toBe(3);
    expect(getIndexEntry("episode", ids[0])).toBeDefined();
    expect(getIndexEntry("episode", ids[1])).toBeUndefined();
    expect(getIndexEntry("episode", ids[2])).toBeDefined();
    expect(getIndexEntry("episode", ids[3])).toBeUndefined();
    expect(getIndexEntry("episode", ids[4])).toBeDefined();
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
    expect(entry?.importance).toBe("normal");
    assertIndexConsistency();
  });

  it("kvSet existing key (upsert) → index entry updated, no duplicate", () => {
    kvSet("theme", "dark");
    kvSet("theme", "light");

    const entry = getIndexEntry("kv", "theme");
    expect(entry?.summary).toBe("theme: light");
    expect(countIndex("kv")).toBe(1); // no duplicate
    assertIndexConsistency();
  });

  it("kvSet long value → summary truncated", () => {
    kvSet("data", "X".repeat(200));

    const entry = getIndexEntry("kv", "data");
    // summary = "data: " (6 chars) + substr(value, 1, 80) = 86 chars max
    expect(entry?.summary.length).toBeLessThanOrEqual(86);
  });

  it("kvDelete → index entry removed", () => {
    kvSet("temp", "value");
    expect(getIndexEntry("kv", "temp")).toBeDefined();

    kvDelete("temp");
    expect(getIndexEntry("kv", "temp")).toBeUndefined();
    assertIndexConsistency();
  });

  it("kvDelete non-existent → returns false, index unchanged", () => {
    kvSet("keep", "value");
    const before = countIndex();

    const deleted = kvDelete("nope");
    expect(deleted).toBe(false);
    expect(countIndex()).toBe(before);
  });

  it("set-overwrite-delete cycle → clean index", () => {
    kvSet("key", "v1");
    expect(countIndex("kv")).toBe(1);

    kvSet("key", "v2");
    expect(countIndex("kv")).toBe(1);

    kvDelete("key");
    expect(countIndex("kv")).toBe(0);
    assertIndexConsistency();
  });

  it("multiple keys → each has own index entry", () => {
    kvSet("a", "1");
    kvSet("b", "2");
    kvSet("c", "3");

    expect(countIndex("kv")).toBe(3);
    expect(getIndexEntry("kv", "a")?.summary).toBe("a: 1");
    expect(getIndexEntry("kv", "b")?.summary).toBe("b: 2");
    expect(getIndexEntry("kv", "c")?.summary).toBe("c: 3");
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
    createTask({ title: "Task 1" });
    kvSet("k1", "v1");
    kvSet("k2", "v2");

    expect(countIndex()).toBe(8);
    expect(countIndex("note")).toBe(2);
    expect(countIndex("episode")).toBe(3);
    expect(countIndex("task")).toBe(1);
    expect(countIndex("kv")).toBe(2);
    assertIndexConsistency();
  });

  it("mixed inserts then mixed deletes → index reflects survivors", () => {
    const n1 = createNote({ title: "Note", content: "C" });
    const e1 = logEpisode("Event");
    const t1 = createTask({ title: "Task" });
    kvSet("key", "val");
    expect(countIndex()).toBe(4);

    deleteNote(n1);
    deleteEpisode(e1);
    expect(countIndex()).toBe(2);
    expect(getIndexEntry("note", n1)).toBeUndefined();
    expect(getIndexEntry("episode", e1)).toBeUndefined();
    expect(getIndexEntry("task", t1)).toBeDefined();
    expect(getIndexEntry("kv", "key")).toBeDefined();

    deleteTask(t1);
    kvDelete("key");
    expect(countIndex()).toBe(0);
    assertIndexConsistency();
  });

  it("no orphaned index entries after all source rows deleted", () => {
    // Seed data across all types
    createNote({ title: "N", content: "C" });
    logEpisode("E");
    createTask({ title: "T" });
    kvSet("K", "V");
    expect(countIndex()).toBe(4);

    // Delete all source data
    const db = getDb();
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DELETE FROM project_notes");
    db.exec("DELETE FROM episodes");
    db.exec("DELETE FROM tasks");
    db.exec("DELETE FROM kv");
    db.exec("PRAGMA foreign_keys = ON");

    // Index must be clean — no orphans
    expect(countIndex()).toBe(0);
    assertIndexConsistency();
  });

  it("no SCD2 behavior — updates replace, never accumulate", () => {
    const id = createNote({
      title: "v1",
      content: "C",
      importance: "low",
    });
    updateNote(id, { title: "v2" });
    updateNote(id, { title: "v3" });
    updateNote(id, { title: "v4" });

    // Must have exactly 1 index entry, not 4
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

    it("returns all entries ordered by importance DESC, updated_at DESC", () => {
      createNote({
        title: "Low note",
        content: "C",
        importance: "low",
      });
      createNote({
        title: "Critical note",
        content: "C",
        importance: "critical",
      });
      createNote({
        title: "Normal note",
        content: "C",
        importance: "normal",
      });

      const index = getMemoryIndex();
      expect(index[0].summary).toBe("Critical note");
      // low and normal — both non-critical, ordered by updated_at DESC
      expect(index.length).toBe(3);
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        createNote({ title: `Note ${i}`, content: "C" });
      }
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
      createNote({
        title: "Bug report",
        content: "C",
        category: "issue",
      });
      createNote({
        title: "Code standard",
        content: "C",
        category: "convention",
      });

      const results = searchIndex("issue");
      expect(results.length).toBe(1);
      expect(results[0].summary).toBe("Bug report");
    });

    it("filters by source_type", () => {
      createNote({ title: "SQL note", content: "C" });
      logEpisode("SQL episode");
      createTask({ title: "SQL task" });

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
      createTask({ title: "Task" });
      kvSet("key", "val");

      // Manually corrupt index by clearing it
      getDb().exec("DELETE FROM memory_index");
      expect(countIndex()).toBe(0);

      const count = rebuildIndex();
      expect(count).toBe(4);
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

      // Manually insert a stale/orphan entry
      getDb()
        .prepare(
          "INSERT INTO memory_index(source_type,source_id,summary,keywords,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
        )
        .run("note", "999", "Ghost", null, "normal", Date.now(), Date.now());
      expect(countIndex()).toBe(2); // real + ghost

      rebuildIndex();
      expect(countIndex()).toBe(1); // ghost removed
      expect(getIndexEntry("note", id)).toBeDefined();
      expect(getIndexEntry("note", 999)).toBeUndefined();
      assertIndexConsistency();
    });
  });
});

// ============ getMemoryContext (Hybrid Loading) ============

describe("getMemoryContext → Hybrid Loading", () => {
  beforeEach(clearAll);

  it("indexEntries contains all memory types", () => {
    createNote({ title: "N", content: "C" });
    logEpisode("E");
    createTask({ title: "T" });
    kvSet("K", "V");

    const ctx = getMemoryContext();
    expect(ctx.indexEntries.length).toBe(4);
    const types = ctx.indexEntries.map((e) => e.source_type).sort();
    expect(types).toEqual(["episode", "kv", "note", "task"]);
  });

  it("criticalNotes includes only HIGH and CRITICAL notes", () => {
    createNote({
      title: "Low",
      content: "C",
      importance: "low",
    });
    createNote({
      title: "Normal",
      content: "C",
      importance: "normal",
    });
    createNote({
      title: "High",
      content: "Full content high",
      importance: "high",
    });
    createNote({
      title: "Critical",
      content: "Full content critical",
      importance: "critical",
    });

    const ctx = getMemoryContext();
    expect(ctx.criticalNotes.length).toBe(2);
    const titles = ctx.criticalNotes.map((n) => n.title).sort();
    expect(titles).toEqual(["Critical", "High"]);
    // Verify full content is loaded
    expect(ctx.criticalNotes.every((n) => n.content.startsWith("Full"))).toBe(true);
  });

  it("criticalNotes excludes archived (active=false) HIGH notes", () => {
    const id = createNote({
      title: "Archived High",
      content: "C",
      importance: "high",
      active: false,
    });

    const ctx = getMemoryContext();
    expect(ctx.criticalNotes.length).toBe(0);
    // But index still has it
    expect(getIndexEntry("note", id)).toBeDefined();
  });

  it("taskSummary reflects active tasks", () => {
    createTask({ title: "Todo", status: "todo" });
    createTask({ title: "In Progress", status: "in_progress" });
    createTask({ title: "Done", status: "done" });

    const ctx = getMemoryContext();
    expect(ctx.taskSummary.todo).toBe(1);
    expect(ctx.taskSummary.in_progress).toBe(1);
    expect(ctx.taskSummary.done).toBe(1);
    expect(ctx.taskSummary.activeTasks.length).toBe(2);
  });

  it("empty DB → empty context", () => {
    const ctx = getMemoryContext();
    expect(ctx.indexEntries.length).toBe(0);
    expect(ctx.criticalNotes.length).toBe(0);
    expect(ctx.taskSummary.activeTasks.length).toBe(0);
  });
});

// ============ Original CRUD Tests (preserved) ============

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
    for (let i = 0; i < 10; i++) {
      logEpisode(`Event ${i}`);
    }
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

describe("Task Management", () => {
  beforeEach(clearAll);

  it("should create a task with defaults", () => {
    const id = createTask({ title: "Test task" });
    const task = getTask(id);

    expect(task).not.toBeNull();
    expect(task?.title).toBe("Test task");
    expect(task?.status).toBe("todo");
    expect(task?.priority).toBe("medium");
  });

  it("should create a task with all fields", () => {
    const id = createTask({
      title: "Full task",
      description: "A detailed description",
      status: "in_progress",
      priority: "high",
      tags: ["urgent", "review"],
    });

    const task = getTask(id);
    expect(task?.description).toBe("A detailed description");
    expect(task?.status).toBe("in_progress");
    expect(task?.priority).toBe("high");
    expect(task?.tags).toEqual(["urgent", "review"]);
  });

  it("should update a task", () => {
    const id = createTask({ title: "Original title" });
    updateTask(id, { title: "Updated title", status: "done" });

    const task = getTask(id);
    expect(task?.title).toBe("Updated title");
    expect(task?.status).toBe("done");
    expect(task?.completed_at).not.toBeNull();
  });

  it("should delete a task", () => {
    const id = createTask({ title: "To delete" });
    expect(deleteTask(id)).toBe(true);
    expect(getTask(id)).toBeNull();
  });

  it("should list tasks with status filter", () => {
    createTask({ title: "Todo 1", status: "todo" });
    createTask({ title: "Todo 2", status: "todo" });
    createTask({ title: "Done 1", status: "done" });

    const todoTasks = listTasks({ status: "todo" });
    expect(todoTasks.length).toBe(2);

    const doneTasks = listTasks({ status: "done" });
    expect(doneTasks.length).toBe(1);
  });

  it("should list tasks with multiple status filter", () => {
    createTask({ title: "Todo", status: "todo" });
    createTask({ title: "In Progress", status: "in_progress" });
    createTask({ title: "Done", status: "done" });

    const activeTasks = listTasks({ status: ["todo", "in_progress"] });
    expect(activeTasks.length).toBe(2);
  });
});

describe("Project Notes", () => {
  beforeEach(clearAll);

  it("should create a note with defaults", () => {
    const id = createNote({ title: "Test Note", content: "Content here" });
    const note = getNote(id);

    expect(note).not.toBeNull();
    expect(note?.title).toBe("Test Note");
    expect(note?.content).toBe("Content here");
    expect(note?.category).toBe("general");
    expect(note?.importance).toBe("normal");
    expect(note?.active).toBe(true);
  });

  it("should create note with all fields", () => {
    const id = createNote({
      title: "Security Issue",
      content: "Found SQL injection",
      category: "issue",
      importance: "critical",
      active: true,
    });

    const note = getNote(id);
    expect(note?.category).toBe("issue");
    expect(note?.importance).toBe("critical");
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
    createNote({
      title: "Convention",
      content: "C",
      category: "convention",
    });
    createNote({ title: "Issue 2", content: "C", category: "issue" });

    const issues = listNotes({ category: "issue" });
    expect(issues.length).toBe(2);
  });
});

// ============ Version & Schema ============

describe("Database Version", () => {
  /** Ensure schema_version has exactly one row with the given version */
  function stampVersion(version: number): void {
    const db = getDb();
    db.exec("DELETE FROM schema_version");
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
  }

  it("DB_VERSION is 2", () => {
    expect(DB_VERSION).toBe(2);
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
    expect(typeof info.match).toBe("boolean");
  });

  it("reads stamped version correctly → match", () => {
    stampVersion(DB_VERSION);

    const info = getVersionInfo();
    expect(info.current).toBe(DB_VERSION);
    expect(info.shipped).toBe(DB_VERSION);
    expect(info.match).toBe(true);
  });

  it("detects mismatch when schema_version row is missing (pre-versioning DB)", () => {
    const db = getDb();
    db.exec("DELETE FROM schema_version");

    const info = getVersionInfo();
    expect(info.current).toBeNull();
    expect(info.shipped).toBe(DB_VERSION);
    expect(info.match).toBe(false);

    stampVersion(DB_VERSION); // restore
  });

  it("detects mismatch when DB version is older", () => {
    stampVersion(1);

    const info = getVersionInfo();
    expect(info.current).toBe(1);
    expect(info.shipped).toBe(DB_VERSION);
    expect(info.match).toBe(false);

    stampVersion(DB_VERSION); // restore
  });

  it("detects mismatch when DB version is newer (downgrade scenario)", () => {
    stampVersion(99);

    const info = getVersionInfo();
    expect(info.current).toBe(99);
    expect(info.shipped).toBe(DB_VERSION);
    expect(info.match).toBe(false);

    stampVersion(DB_VERSION); // restore
  });
});

describe("Database Schema Dump", () => {
  it("returns non-empty DDL string", () => {
    const schema = getDatabaseSchema();
    expect(schema.length).toBeGreaterThan(0);
  });

  it("contains all expected tables", () => {
    const schema = getDatabaseSchema();
    for (const table of [
      "schema_version",
      "kv",
      "episodes",
      "tasks",
      "project_notes",
      "memory_index",
    ]) {
      expect(schema).toContain(table);
    }
  });

  it("contains indexes", () => {
    const schema = getDatabaseSchema();
    expect(schema).toContain("idx_episodes_timestamp");
    expect(schema).toContain("idx_episodes_session");
    expect(schema).toContain("idx_tasks_status");
    expect(schema).toContain("idx_tasks_parent");
    expect(schema).toContain("idx_notes_category");
    expect(schema).toContain("idx_mi_type");
  });

  it("contains triggers", () => {
    const schema = getDatabaseSchema();
    expect(schema).toContain("mi_note_insert");
    expect(schema).toContain("mi_note_update");
    expect(schema).toContain("mi_note_delete");
    expect(schema).toContain("mi_episode_insert");
    expect(schema).toContain("mi_task_insert");
    expect(schema).toContain("mi_kv_insert");
    expect(schema).toContain("mi_kv_delete");
  });

  it("each entry has type comment prefix and trailing semicolon", () => {
    const schema = getDatabaseSchema();
    const entries = schema.split("\n\n");
    for (const entry of entries) {
      expect(entry).toMatch(/^-- (table|index|trigger): /);
      expect(entry.trimEnd()).toMatch(/;$/);
    }
  });

  it("entries are ordered by type then name", () => {
    const schema = getDatabaseSchema();
    const typeOrder = [...schema.matchAll(/^-- (\w+):/gm)].map((m) => m[1]);
    // SQLite master types: index, table, trigger (alphabetical)
    const sorted = [...typeOrder].sort();
    expect(typeOrder).toEqual(sorted);
  });
});

describe("Database Info", () => {
  it("should return database location", () => {
    const location = getDbLocation();
    expect(location).toContain("pi-ext-delta");
    expect(location).toContain("delta.db");
  });
});
