import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// MIGRATIONS[i] で user_version を i から i + 1 に上げる。既存の要素は書き換えず、末尾に追加する
export const MIGRATIONS: readonly string[] = [
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
  // v2: /setup で作ったカテゴリ・チャンネルの ID。1 つ作るごとに保存するので、途中で失敗すると NULL の列が残る
  `
  CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY,
    home_category_id TEXT,
    inbox_channel_id TEXT,
    tasks_channel_id TEXT,
    system_channel_id TEXT,
    home_panel_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE state_categories (
    guild_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'waiting', 'done')),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    category_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, state, ordinal)
  );
  `,
  // v3: /new で作ったセッション（1 テキストチャンネル = 1 セッション）。SDK の session_id は channel_sessions のまま
  `
  CREATE TABLE sessions (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'waiting', 'done', 'deleted')),
    category_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    waiting_since TEXT,
    closed_at TEXT
  );
  `,
  // v4: /close の要約と確認待ちの下書き（session_report の JSON）。resume できなくなった会話などを次のターンで再開するための種（seed）
  `
  ALTER TABLE sessions ADD COLUMN summary TEXT;
  ALTER TABLE sessions ADD COLUMN close_draft TEXT;
  CREATE TABLE channel_seeds (
    channel_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // v5: 同じ SDK セッションでの resume の連続失敗回数（成功・別のセッションに替えたら 0）
  `
  ALTER TABLE channel_sessions ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
  `,
  // v6: そのターンで SDK が会話を要約したか（compaction。compact_boundary を受け取ったら 1）
  `
  ALTER TABLE usage_log ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0;
  `,
  // v7: そのターンのツール呼び出しの回数（失敗した呼び出しを含む。SDK の PostToolUse / PostToolUseFailure で数える）
  `
  ALTER TABLE usage_log ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0;
  `,
  // v8: セッションの作られ方（command: /new・ホームパネル、inbox: #inbox の session_open）。session_open の 1 日の上限と間隔を数える
  `
  ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'command' CHECK (origin IN ('command', 'inbox'));
  `,
  // v9: 完了から SELF_AGENT_DELETE_AFTER_DAYS 日経ったときに #system に投稿した削除の確認（投稿済みなら投稿し直さない）と、チャンネルを削除した時刻
  `
  ALTER TABLE sessions ADD COLUMN delete_prompt_message_id TEXT;
  ALTER TABLE sessions ADD COLUMN deleted_at TEXT;
  `,
  // v10: #inbox の会話を切り替えたときに残した要約（date は切り替えた日）と、サーバーごとの最後に切り替えた日（いずれも SELF_AGENT_TZ の日付、YYYY-MM-DD）。
  // usage_log にはターンの最後のステップの入力（input + cache read + cache creation。会話の大きさの目安、失敗したターンは 0）
  `
  CREATE TABLE inbox_summaries (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    date TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  ALTER TABLE guild_settings ADD COLUMN inbox_rotated_date TEXT;
  ALTER TABLE usage_log ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0;
  `,
  // v11: #inbox の会話を最後に切り替えた時刻（ISO）。切り替えの後のターンだけを見るときの基準（要約のターン自身の記録より後の時刻）
  `
  ALTER TABLE guild_settings ADD COLUMN inbox_rotated_at TEXT;
  `,
  // v12: ナレッジベース（url_key は呼び出し側が正規化した URL。URL 無しのメモは NULL で、UNIQUE は NULL を重複扱いしない）と、
  // その全文検索（FTS5 trigram の外部コンテンツ。kb_entries の変更はトリガーで反映する）。オーナーについての記憶（deleted_at で論理削除）
  `
  CREATE TABLE kb_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT,
    url_key TEXT UNIQUE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    channel_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE kb_fts USING fts5(
    title, summary, body, tags, url,
    content='kb_entries', content_rowid='id', tokenize='trigram'
  );
  CREATE TRIGGER kb_entries_ai AFTER INSERT ON kb_entries BEGIN
    INSERT INTO kb_fts (rowid, title, summary, body, tags, url)
      VALUES (new.id, new.title, new.summary, new.body, new.tags, new.url);
  END;
  CREATE TRIGGER kb_entries_ad AFTER DELETE ON kb_entries BEGIN
    INSERT INTO kb_fts (kb_fts, rowid, title, summary, body, tags, url)
      VALUES ('delete', old.id, old.title, old.summary, old.body, old.tags, old.url);
  END;
  CREATE TRIGGER kb_entries_au AFTER UPDATE ON kb_entries BEGIN
    INSERT INTO kb_fts (kb_fts, rowid, title, summary, body, tags, url)
      VALUES ('delete', old.id, old.title, old.summary, old.body, old.tags, old.url);
    INSERT INTO kb_fts (rowid, title, summary, body, tags, url)
      VALUES (new.id, new.title, new.summary, new.body, new.tags, new.url);
  END;
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    channel_id TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  `,
  // v13: 作って URL で渡すプロジェクト。deleted_at で論理削除し、削除済みの slug も UNIQUE のまま残す（同じ URL が別のものを指さないように）。
  // channel_id は削除されていないものの中で一意（削除した後は同じチャンネルで新しく作れる）
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE UNIQUE INDEX projects_channel_id_active ON projects (channel_id) WHERE deleted_at IS NULL;
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
