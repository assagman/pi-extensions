import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDb,
  createNote,
  createTask,
  deleteNote,
  deleteTask,
  getDb,
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

// Clean up test database after tests
const _TEST_DB_DIR = join(homedir(), ".local", "share", "pi-ext-delta");

afterAll(() => {
  closeDb();
});

describe("Key-Value Store", () => {
  beforeEach(() => {
    // Clear KV table before each test
    getDb().exec("DELETE FROM kv");
  });

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
  beforeEach(() => {
    getDb().exec("DELETE FROM episodes");
  });

  it("should log an episode and return id", () => {
    const id = logEpisode("Test event occurred");
    expect(id).toBeGreaterThan(0);
  });

  it("should log episode with context and tags", () => {
    const _id = logEpisode("Bug found", "src/main.ts", ["bug", "critical"]);
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
});

describe("Task Management", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM tasks");
  });

  it("should create a task with defaults", () => {
    const id = createTask({ title: "Test task" });
    const task = getTask(id);

    expect(task).not.toBeNull();
    expect(task?.title).toBe("Test task");
    expect(task?.status).toBe("todo");
    expect(task?.priority).toBe("medium");
    expect(task?.scope).toBe("project");
  });

  it("should create a task with all fields", () => {
    const id = createTask({
      title: "Full task",
      description: "A detailed description",
      status: "in_progress",
      priority: "high",
      scope: "session",
      tags: ["urgent", "review"],
    });

    const task = getTask(id);
    expect(task?.description).toBe("A detailed description");
    expect(task?.status).toBe("in_progress");
    expect(task?.priority).toBe("high");
    expect(task?.scope).toBe("session");
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

describe("Task Parent Validation", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM tasks");
  });

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

    // Try to make parent a child of its own child
    expect(() => {
      updateTask(parentId, { parent_id: childId });
    }).toThrow("Circular parent reference detected");
  });

  it("should reject deep circular reference", () => {
    const id1 = createTask({ title: "Task 1" });
    const id2 = createTask({ title: "Task 2", parent_id: id1 });
    const id3 = createTask({ title: "Task 3", parent_id: id2 });

    // Try to make Task 1 a child of Task 3 (creates cycle)
    expect(() => {
      updateTask(id1, { parent_id: id3 });
    }).toThrow("Circular parent reference detected");
  });

  it("should allow moving task to different parent", () => {
    const parent1 = createTask({ title: "Parent 1" });
    const parent2 = createTask({ title: "Parent 2" });
    const child = createTask({ title: "Child", parent_id: parent1 });

    updateTask(child, { parent_id: parent2 });

    const updated = getTask(child);
    expect(updated?.parent_id).toBe(parent2);
  });

  it("should allow removing parent (making root task)", () => {
    const parent = createTask({ title: "Parent" });
    const child = createTask({ title: "Child", parent_id: parent });

    updateTask(child, { parent_id: null });

    const updated = getTask(child);
    expect(updated?.parent_id).toBeNull();
  });
});

describe("Project Notes", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM project_notes");
  });

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
    createNote({ title: "Convention", content: "C", category: "convention" });
    createNote({ title: "Issue 2", content: "C", category: "issue" });

    const issues = listNotes({ category: "issue" });
    expect(issues.length).toBe(2);
  });
});

describe("Database Info", () => {
  it("should return database location", () => {
    const location = getDbLocation();
    expect(location).toContain("pi-ext-delta");
    expect(location).toContain("delta.db");
  });
});
