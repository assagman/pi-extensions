/**
 * Mu persistence layer — SQLite storage for tool results across restarts.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { ensureSchemaVersion, getExtensionDbPath, openDatabase } from "pi-ext-shared";

// =============================================================================
// TYPES
// =============================================================================
export interface ToolResultOption {
  key: string;
  toolName: string;
  sig: string;
  label: string;
  args: Record<string, unknown>;
  result: unknown;
  startTime: number;
  duration?: number;
  isError: boolean;
}

// =============================================================================
// DEBUG LOGGING
// =============================================================================
const MU_DEBUG = process.env.MU_DEBUG === "1";
let debugLogPath: string | null = null;

function debugLog(msg: string): void {
  if (!MU_DEBUG) return;
  try {
    if (!debugLogPath) {
      const baseDir = join(process.env.HOME ?? "/tmp", ".local", "share", "pi-ext-mu");
      debugLogPath = join(baseDir, "debug.log");
    }
    const ts = new Date().toISOString();
    appendFileSync(debugLogPath, `[${ts}] ${msg}\n`);
  } catch {
    // Debug logging must never break anything
  }
}

// =============================================================================
// DATABASE
// =============================================================================
const MU_DB_VERSION = 1;
const MU_SESSION_TTL_DAYS = 30;
const MAX_TOOL_RESULTS = 200;

let muDb: Database.Database | null = null;

/** Lazy-open the mu database. Reuses connection if already open. */
function getMuDb(): Database.Database {
  if (muDb) return muDb;

  const dbPath = getExtensionDbPath("pi-ext-mu", "mu");
  debugLog(`getMuDb: opening ${dbPath}`);
  muDb = openDatabase(dbPath);

  const { isFresh } = ensureSchemaVersion(muDb, MU_DB_VERSION);
  debugLog(`getMuDb: isFresh=${isFresh}`);

  if (isFresh) {
    muDb.exec(`
      CREATE TABLE tool_results (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        tool_call_id TEXT    NOT NULL,
        tool_name    TEXT    NOT NULL,
        sig          TEXT    NOT NULL,
        label        TEXT    NOT NULL,
        args         TEXT    NOT NULL,
        result       TEXT    NOT NULL,
        start_time   INTEGER NOT NULL,
        duration     INTEGER,
        is_error     INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX idx_tool_results_session ON tool_results(session_id);
      CREATE INDEX idx_tool_results_created ON tool_results(created_at);
    `);
  }

  return muDb;
}

/** Persist a single tool result row. */
export function persistToolResult(sessionId: string, opt: ToolResultOption): void {
  try {
    const db = getMuDb();
    db.prepare(`
      INSERT INTO tool_results (session_id, tool_call_id, tool_name, sig, label, args, result, start_time, duration, is_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      opt.key,
      opt.toolName,
      opt.sig,
      opt.label,
      JSON.stringify(opt.args),
      JSON.stringify(opt.result),
      opt.startTime,
      opt.duration ?? null,
      opt.isError ? 1 : 0
    );
    debugLog(`persistToolResult: OK session=${sessionId} tool=${opt.toolName} key=${opt.key}`);

    // Cap per-session results in DB
    const count = (
      db.prepare("SELECT COUNT(*) as c FROM tool_results WHERE session_id = ?").get(sessionId) as {
        c: number;
      }
    ).c;
    if (count > MAX_TOOL_RESULTS) {
      db.prepare(`
        DELETE FROM tool_results WHERE id IN (
          SELECT id FROM tool_results WHERE session_id = ? ORDER BY id ASC LIMIT ?
        )
      `).run(sessionId, count - MAX_TOOL_RESULTS);
      debugLog(`persistToolResult: capped to ${MAX_TOOL_RESULTS} (was ${count})`);
    }
  } catch (e: unknown) {
    debugLog(`persistToolResult: ERROR ${e instanceof Error ? e.message : String(e)}`);
    // Non-fatal — persistence failure should never break tool rendering
  }
}

/** Load persisted tool results for a session, returning them in insertion order. */
export function loadToolResults(sessionId: string): ToolResultOption[] {
  try {
    const db = getMuDb();
    const rows = db
      .prepare(
        `
      SELECT tool_call_id, tool_name, sig, label, args, result, start_time, duration, is_error
      FROM tool_results
      WHERE session_id = ?
      ORDER BY id ASC
    `
      )
      .all(sessionId) as Array<{
      tool_call_id: string;
      tool_name: string;
      sig: string;
      label: string;
      args: string;
      result: string;
      start_time: number;
      duration: number | null;
      is_error: number;
    }>;

    debugLog(`loadToolResults: session=${sessionId} rows=${rows.length}`);

    // Parse rows individually — skip corrupt rows instead of failing entire load
    const results: ToolResultOption[] = [];
    for (const r of rows) {
      try {
        results.push({
          key: r.tool_call_id,
          toolName: r.tool_name,
          sig: r.sig,
          label: r.label,
          args: JSON.parse(r.args) as Record<string, unknown>,
          result: JSON.parse(r.result) as unknown,
          startTime: r.start_time,
          duration: r.duration ?? undefined,
          isError: r.is_error === 1,
        });
      } catch (e: unknown) {
        debugLog(
          `loadToolResults: skipped corrupt row key=${r.tool_call_id} err=${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    return results;
  } catch (e: unknown) {
    debugLog(`loadToolResults: ERROR ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Delete tool results for sessions older than TTL. */
export function cleanupOldSessions(): void {
  try {
    const db = getMuDb();
    const cutoff = Math.floor(Date.now() / 1000) - MU_SESSION_TTL_DAYS * 86400;
    const result = db.prepare("DELETE FROM tool_results WHERE created_at < ?").run(cutoff);
    if (result.changes > 0) {
      debugLog(`cleanupOldSessions: deleted ${result.changes} rows`);
    }
  } catch (e: unknown) {
    debugLog(`cleanupOldSessions: ERROR ${e instanceof Error ? e.message : String(e)}`);
    // Non-fatal
  }
}

/** Close the database (called on session shutdown). */
export function closeMuDb(): void {
  if (muDb) {
    debugLog("closeMuDb: closing");
    try {
      muDb.close();
    } catch {
      /* ignore */
    }
    muDb = null;
  }
}
