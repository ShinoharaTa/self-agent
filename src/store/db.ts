import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// MIGRATIONS[i] で user_version を i から i + 1 に上げる。既存の要素は書き換えず、末尾に追加する
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    due TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    source_message_id TEXT
  );
  CREATE TABLE channel_sessions (
    key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE usage_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    key TEXT NOT NULL,
    session_id TEXT,
    ok INTEGER NOT NULL,
    duration_ms INTEGER,
    input_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER
  );
  `,
];

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
}

function migrate(db: DatabaseSync): void {
  const current = userVersion(db);
  if (current > MIGRATIONS.length) {
    throw new Error(`DB のスキーマ (v${current}) がこのバージョンより新しいため開けません`);
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  migrate(db);
  return db;
}
