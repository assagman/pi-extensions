/**
 * Common SQLite database helpers for Pi extensions.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { getRepoIdentifier } from "./repo-id.js";

const LOCAL_SHARE = join(homedir(), ".local", "share");

/**
 * Compute the database file path for a given extension.
 *
 * Layout: `~/.local/share/<extensionDir>/<repoId>/<dbName>.db`
 *
 * @param extensionDir  e.g. "pi-ext-delta"
 * @param dbName        e.g. "delta" → delta.db
 * @param cwd           working directory (defaults to process.cwd())
 */
export function getExtensionDbPath(extensionDir: string, dbName: string, cwd?: string): string {
  const resolvedCwd = cwd ?? process.cwd();
  const repoId = getRepoIdentifier(resolvedCwd);

  const baseDir = join(LOCAL_SHARE, extensionDir);
  const dirPath = join(baseDir, repoId);

  // Security: ensure path stays within base dir (CWE-22 mitigation)
  const resolvedPath = resolve(dirPath);
  const resolvedBase = resolve(baseDir);
  if (!resolvedPath.startsWith(`${resolvedBase}/`) && resolvedPath !== resolvedBase) {
    throw new Error("Invalid database path: path traversal detected");
  }

  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }

  return join(dirPath, `${dbName}.db`);
}

/**
 * Open (or reuse) a SQLite database with standard pragmas.
 * Returns the database handle.
 */
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/**
 * Read or stamp the schema version in a `schema_version` table.
 *
 * If the DB is fresh (no tables), stamps `targetVersion`.
 * If already versioned, returns the current version for the caller to run migrations.
 */
export function ensureSchemaVersion(
  db: Database.Database,
  targetVersion: number
): { current: number; isFresh: boolean } {
  // Detect fresh DB before creating anything
  const tableCount = (
    db
      .prepare(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .get() as { count: number }
  ).count;
  const isFresh = tableCount === 0;

  // Ensure version table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      version INTEGER NOT NULL
    );
  `);

  if (isFresh) {
    db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)").run(
      targetVersion
    );
    return { current: targetVersion, isFresh: true };
  }

  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  return { current: row?.version ?? 0, isFresh: false };
}

/**
 * Update the stored schema version after successful migration.
 */
export function stampSchemaVersion(db: Database.Database, version: number): void {
  db.exec("DELETE FROM schema_version");
  db.prepare("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(version);
}

/**
 * Escape SQL LIKE wildcards so %, _, and \ are treated as literals.
 */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/**
 * Generate a unique session identifier.
 */
export function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
