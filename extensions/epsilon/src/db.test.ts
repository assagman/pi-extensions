/**
 * Epsilon database tests.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DB_VERSION,
  closeDb,
  createTask,
  deleteTask,
  getDb,
  getDbLocation,
  getTask,
  getTaskSummary,
  getVersionInfo,
  listTasks,
  updateTask,
} from "./db.js";

function clearAll(): void {
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DELETE FROM tasks");
  db.exec("PRAGMA foreign_keys = ON");
}

afterAll(() => {
  closeDb();
});

// ============ Task CRUD ============

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

    expect(listTasks({ status: "todo" }).length).toBe(2);
    expect(listTasks({ status: "done" }).length).toBe(1);
  });

  it("should list tasks with multiple status filter", () => {
    createTask({ title: "Todo", status: "todo" });
    createTask({ title: "In Progress", status: "in_progress" });
    createTask({ title: "Done", status: "done" });

    expect(listTasks({ status: ["todo", "in_progress"] }).length).toBe(2);
  });
});

// ============ Parent Validation ============

describe("Parent Validation", () => {
  beforeEach(clearAll);

  it("should create subtask with valid parent", () => {
    const parentId = createTask({ title: "Parent" });
    const childId = createTask({ title: "Child", parent_id: parentId });
    expect(getTask(childId)?.parent_id).toBe(parentId);
  });

  it("should reject non-existent parent", () => {
    expect(() => createTask({ title: "Orphan", parent_id: 9999 })).toThrow(
      "Parent task #9999 not found"
    );
  });

  it("should reject self-reference on update", () => {
    const id = createTask({ title: "Task" });
    expect(() => updateTask(id, { parent_id: id })).toThrow("Task cannot be its own parent");
  });

  it("should reject circular reference", () => {
    const parentId = createTask({ title: "Parent" });
    const childId = createTask({ title: "Child", parent_id: parentId });
    expect(() => updateTask(parentId, { parent_id: childId })).toThrow(
      "Circular parent reference detected"
    );
  });

  it("should allow moving task to different parent", () => {
    const p1 = createTask({ title: "P1" });
    const p2 = createTask({ title: "P2" });
    const child = createTask({ title: "Child", parent_id: p1 });
    updateTask(child, { parent_id: p2 });
    expect(getTask(child)?.parent_id).toBe(p2);
  });

  it("should allow removing parent (making root task)", () => {
    const parent = createTask({ title: "Parent" });
    const child = createTask({ title: "Child", parent_id: parent });
    updateTask(child, { parent_id: null });
    expect(getTask(child)?.parent_id).toBeNull();
  });
});

// ============ Task Summary ============

describe("Task Summary", () => {
  beforeEach(clearAll);

  it("returns zeroes for empty DB", () => {
    const s = getTaskSummary();
    expect(s.todo).toBe(0);
    expect(s.in_progress).toBe(0);
    expect(s.blocked).toBe(0);
    expect(s.done).toBe(0);
    expect(s.activeTasks.length).toBe(0);
  });

  it("counts statuses correctly", () => {
    createTask({ title: "T1", status: "todo" });
    createTask({ title: "T2", status: "in_progress" });
    createTask({ title: "T3", status: "done" });
    const s = getTaskSummary();
    expect(s.todo).toBe(1);
    expect(s.in_progress).toBe(1);
    expect(s.done).toBe(1);
    expect(s.activeTasks.length).toBe(2);
  });
});

// ============ Version & Info ============

describe("Database", () => {
  it("DB_VERSION is 1", () => {
    expect(DB_VERSION).toBe(1);
  });

  it("version info matches", () => {
    const info = getVersionInfo();
    expect(info.shipped).toBe(1);
    expect(info.match).toBe(true);
  });

  it("db location contains epsilon", () => {
    expect(getDbLocation()).toContain("pi-ext-epsilon");
    expect(getDbLocation()).toContain("epsilon.db");
  });
});
