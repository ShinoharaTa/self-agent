import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

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
  // v14: #tasks の会話の切り替え。要約がどのチャンネルのものか（'inbox' | 'tasks'。既存の行は #inbox）と、
  // サーバーごとの #tasks を最後に切り替えた時刻（ISO。日付はこの時刻から SELF_AGENT_TZ で求める）
  `
  ALTER TABLE inbox_summaries ADD COLUMN channel_kind TEXT NOT NULL DEFAULT 'inbox';
  ALTER TABLE guild_settings ADD COLUMN tasks_rotated_at TEXT;
  `,
  // v15: /renew でセッションの会話を新しくしたときの要約と時刻（ISO）。resume 失敗の復旧で /close の要約が無ければ使う
  `
  ALTER TABLE sessions ADD COLUMN renewed_summary TEXT;
  ALTER TABLE sessions ADD COLUMN renewed_at TEXT;
  `,
  // v16: リマインドと予約した依頼。rule は繰り返しの形（1 回だけなら NULL）、next_at・snooze_at は UTC の ISO。
  // fire_seq は投稿のたびに 1 増やし、発火とボタンの compare-and-set に使う。物理削除はしない
  `
  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('notify', 'prompt')),
    text TEXT NOT NULL,
    task_id INTEGER,
    rule TEXT,
    next_at TEXT,
    snooze_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'fired', 'done', 'cancelled')),
    fire_seq INTEGER NOT NULL DEFAULT 0,
    last_fired_at TEXT,
    last_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX reminders_active ON reminders (status, next_at);
  `,
  // v17: ターンの種類（ログ用のラベル。ID は入れない）、出力トークン、キャッシュ作成のうち 1 時間の分、
  // メインループのステップごとのトークン（JSON の配列）。既存の行は NULL
  `
  ALTER TABLE usage_log ADD COLUMN kind TEXT;
  ALTER TABLE usage_log ADD COLUMN output_tokens INTEGER;
  ALTER TABLE usage_log ADD COLUMN cache_creation_1h_tokens INTEGER;
  ALTER TABLE usage_log ADD COLUMN steps TEXT;
  `,
  // v18: 人格（docs/plan/personas.md）。既存の行はすべて既定の人格（'default'）・Claude のもの。
  // セッションの持ち主、SDK セッションのエンジン、usage の人格とエンジン、要約の人格、記憶とナレッジを保存した人格。
  // 入口のチャンネル（#inbox・#tasks。足した人格の #<NAME> は kind 'inbox'）と切り替えの日・時刻は persona_channels に移す
  // （guild_settings の値を既定の人格の行に写し、guild_settings の列は消す。rotated_date は #inbox だけで、#tasks の日付は rotated_at から求める）。
  // チャンネルの持ち主は 1 つなので channel_id は（NULL を除いて）一意
  `
  ALTER TABLE sessions ADD COLUMN persona TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE channel_sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude';
  ALTER TABLE usage_log ADD COLUMN persona TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE usage_log ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude';
  ALTER TABLE inbox_summaries ADD COLUMN persona TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE memories ADD COLUMN created_by TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE kb_entries ADD COLUMN created_by TEXT NOT NULL DEFAULT 'default';
  CREATE TABLE persona_channels (
    guild_id TEXT NOT NULL,
    persona TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('inbox', 'tasks')),
    channel_id TEXT,
    rotated_date TEXT,
    rotated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, persona, kind)
  );
  CREATE UNIQUE INDEX persona_channels_channel_id ON persona_channels (channel_id) WHERE channel_id IS NOT NULL;
  INSERT INTO persona_channels (guild_id, persona, kind, channel_id, rotated_date, rotated_at, created_at, updated_at)
    SELECT guild_id, 'default', 'inbox', inbox_channel_id, inbox_rotated_date, inbox_rotated_at, created_at, updated_at
    FROM guild_settings
    WHERE inbox_channel_id IS NOT NULL OR inbox_rotated_date IS NOT NULL OR inbox_rotated_at IS NOT NULL;
  INSERT INTO persona_channels (guild_id, persona, kind, channel_id, rotated_date, rotated_at, created_at, updated_at)
    SELECT guild_id, 'default', 'tasks', tasks_channel_id, NULL, tasks_rotated_at, created_at, updated_at
    FROM guild_settings
    WHERE tasks_channel_id IS NOT NULL OR tasks_rotated_at IS NOT NULL;
  ALTER TABLE guild_settings DROP COLUMN inbox_channel_id;
  ALTER TABLE guild_settings DROP COLUMN tasks_channel_id;
  ALTER TABLE guild_settings DROP COLUMN inbox_rotated_date;
  ALTER TABLE guild_settings DROP COLUMN inbox_rotated_at;
  ALTER TABLE guild_settings DROP COLUMN tasks_rotated_at;
  `,
  // v19: リマインドの最後の発火のメッセージを出したチャンネル。足した人格の Bot に接続できない回は channel_id を変えずに #tasks・#inbox に出すので、
  // 前の回のボタンを外すときにここを使う。既存の行は NULL（channel_id に出した）
  `
  ALTER TABLE reminders ADD COLUMN last_message_channel_id TEXT;
  `,
  // v20: 定型チャンネル（docs/plan/routines.md）。routines はチャンネルごとの手順・要約・切り替えの日と時刻（channel_id は一意。
  // セッションのチャンネルを定型に変えたもの（origin 'converted'）も sessions とは別の表で、sessions の行は履歴として残す）。routine_records は定型チャンネルの記録（fields は JSON。物理削除せず void）。
  // attachments は受け取った添付の原本（record_id は結びつけた記録）。guild_settings にはカテゴリ「定型」の ID
  `
  CREATE TABLE routines (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    persona TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    instructions_rev INTEGER NOT NULL DEFAULT 1,
    seen_rev INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    rotated_date TEXT,
    rotated_at TEXT,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
    origin TEXT NOT NULL DEFAULT 'new' CHECK (origin IN ('new', 'converted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE INDEX routines_guild_state ON routines (guild_id, state);
  CREATE TABLE routine_records (
    id INTEGER PRIMARY KEY,
    channel_id TEXT NOT NULL,
    date TEXT,
    fields TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX routine_records_channel_date ON routine_records (channel_id, status, date);
  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    sha256 TEXT NOT NULL,
    record_id INTEGER,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX attachments_record_id ON attachments (record_id);
  CREATE INDEX attachments_unlinked ON attachments (created_at) WHERE record_id IS NULL;
  ALTER TABLE guild_settings ADD COLUMN routine_category_id TEXT;
  `,
  // v21: GitHub の通知（docs/plan/github-notifications.md §12）。github_threads はスレッドごとに最後に見た updated_at と初めて見た時刻、
  // github_notifications は 1 件の出来事（thread_id + updated_at で一意。白（drop）も残す）、github_handoffs は Claude Code への送り込みの待ち行列、
  // github_poll_state はポーリングの状態（1 行だけ）。guild_settings には #github の ID
  `
  CREATE TABLE github_threads (
    thread_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    number INTEGER,
    last_updated_at TEXT NOT NULL,
    first_seen_at TEXT NOT NULL
  );
  CREATE TABLE github_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('red', 'yellow', 'drop')),
    label TEXT NOT NULL,
    actor_login TEXT,
    actor_known INTEGER NOT NULL,
    title TEXT,
    url TEXT,
    repo_private INTEGER NOT NULL,
    handoff_ok INTEGER NOT NULL,
    posted_at TEXT,
    message_id TEXT,
    channel_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (thread_id, updated_at)
  );
  CREATE TABLE github_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL,
    target TEXT NOT NULL CHECK (target IN ('session', 'manager')),
    session_name TEXT,
    state TEXT NOT NULL CHECK (state IN ('queued', 'delivered', 'unconfirmed', 'failed', 'gave_up', 'cancelled')),
    last_pane_state TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE github_poll_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_modified TEXT,
    poll_interval_sec INTEGER,
    last_success_at TEXT,
    error_kind TEXT,
    error_since TEXT,
    rate_remaining INTEGER,
    rate_reset_at TEXT,
    baseline_done INTEGER NOT NULL DEFAULT 0
  );
  ALTER TABLE guild_settings ADD COLUMN github_channel_id TEXT;
  `,
  // v22: 作業ジョブ（docs/plan/coding-jobs.md §11）。jobs は 1 ブランチ・1 PR の作業（branch は self-agent/job-<id> をアプリが決める）、
  // job_runs はその 1 回の実行（状態・結果。続きは同じ job に run を足す）。guild_settings には #jobs の ID
  `
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    branch TEXT NOT NULL UNIQUE,
    origin TEXT NOT NULL CHECK (origin IN ('command', 'new_repo', 'github', 'inbox')),
    issue_number INTEGER,
    stacked_on_pr INTEGER,
    pr_number INTEGER,
    pr_url TEXT,
    pushed_sha TEXT,
    state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE TABLE job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    kind TEXT NOT NULL CHECK (kind IN ('initial', 'followup')),
    state TEXT NOT NULL CHECK (state IN ('awaiting_confirm', 'queued', 'running', 'held', 'pushed', 'pr_opened', 'failed', 'cancelled')),
    failure TEXT,
    instruction TEXT NOT NULL,
    source_notification_id INTEGER,
    report_channel_id TEXT,
    report_message_id TEXT,
    sdk_session_id TEXT,
    outcome TEXT CHECK (outcome IN ('done', 'cannot')),
    tests TEXT CHECK (tests IN ('passed', 'failed', 'not_run')),
    pr_title TEXT,
    summary TEXT,
    staged_sha TEXT,
    commits INTEGER,
    tool_calls INTEGER,
    kept_dir TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  ALTER TABLE guild_settings ADD COLUMN jobs_channel_id TEXT;
  `,
  // v23: ゲスト利用の簡易モード（docs/plan/guest-mode.md §4）。guest_channels はゲストのサーバーで答えるチャンネル（disabled_at が NULL なら有効。
  // 物理削除しない）、guest_turns はサーバー・ユーザーごとの 1 日（SELF_AGENT_TZ の YYYY-MM-DD）のターン数
  `
  CREATE TABLE guest_channels (
    guild_id TEXT NOT NULL,
    channel_id TEXT PRIMARY KEY,
    enabled_at TEXT NOT NULL,
    disabled_at TEXT,
    disabled_reason TEXT CHECK (disabled_reason IN ('command', 'left', 'startup')),
    session_started_at TEXT,
    session_turns INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX guest_channels_guild ON guest_channels(guild_id, disabled_at);
  CREATE TABLE guest_turns (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, day)
  );
  `,
  // v24: ゲストのサーバーの許可を env から DB へ（docs/plan/guest-mode.md §4。v3）。guest_guilds はゲスト Bot が参加した（ことのある）サーバーと
  // 許可の状態・定型文の記録、guest_invites は認証コード（sha256 のハッシュだけ）。どちらも物理削除しない。
  // v23 までに有効なチャンネルのあるサーバー（env の許可リストで許可されていたもの）は許可済みとして引き継ぐ
  `
  CREATE TABLE guest_guilds (
    guild_id TEXT PRIMARY KEY,
    joined_at TEXT NOT NULL,
    allowed_at TEXT,
    revoked_at TEXT,
    revoked_reason TEXT CHECK (revoked_reason IN ('revoke', 'left')),
    notice_channel_id TEXT,
    notice_message_id TEXT,
    notice_posted_at TEXT
  );
  CREATE TABLE guest_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    superseded_at TEXT,
    used_at TEXT,
    used_by_user_id TEXT,
    used_channel_id TEXT
  );
  CREATE INDEX guest_invites_guild ON guest_invites(guild_id, used_at, superseded_at);
  INSERT INTO guest_guilds (guild_id, joined_at, allowed_at)
    SELECT guild_id, MIN(enabled_at), MIN(enabled_at) FROM guest_channels WHERE disabled_at IS NULL GROUP BY guild_id;
  `,
  // v25: Web UI で会話を見るためのターンの記録（docs/plan/web-ui.md §4.2）。1 行はオーナーの発言・返事・知らせ・区切りのどれか。
  // steps は手順の label の JSON 配列、text は 4,000 字で切る。Web UI が有効なときだけ書き、日数で消す
  `
  CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('owner', 'agent', 'notice', 'divider')),
    source TEXT NOT NULL CHECK (source IN ('discord', 'web', 'system')),
    persona TEXT NOT NULL DEFAULT 'default',
    text TEXT NOT NULL,
    outcome TEXT CHECK (outcome IN ('done', 'max_turns', 'aborted', 'failed')),
    steps TEXT,
    tool_calls INTEGER,
    duration_ms INTEGER,
    message_id TEXT
  );
  CREATE INDEX history_channel ON history(channel_id, id);
  CREATE INDEX history_at ON history(at);
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

/** 移行する前の控えの場所（`<dataDir>/self-agent.db.v<移行前の版>.bak`） */
export function backupPath(path: string, version: number): string {
  return `${path}.v${version}.bak`;
}

/**
 * openDb で移行する（今の user_version が 1 以上で最新より古い）DB なら、先に node:sqlite の backup() で控えを取る（権限 600）。
 * 同じ版の控えが既にあれば上書きせずにそれを使う。控えを取れなければ例外（移行しない）。log にはパスを出さない。
 * backup() は非同期なので openDb（同期）の中ではなく、openDb の前に呼ぶ
 */
export async function backupBeforeMigration(path: string, log: (message: string) => void): Promise<void> {
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path);
  try {
    const version = userVersion(db);
    if (version === 0 || version >= MIGRATIONS.length) return;
    const target = backupPath(path, version);
    if (existsSync(target)) {
      log(`DB を移行する前の控え（v${version}）は既にあるので、取り直しません`);
      return;
    }
    // 書きかけの控えを target の名前で残さないよう、一時ファイル（先に 600 で作る）に取ってから名前を変える
    const temp = `${target}.tmp`;
    rmSync(temp, { force: true });
    writeFileSync(temp, "", { mode: 0o600 });
    await backup(db, temp);
    renameSync(temp, target);
    log(`DB を移行する前に控えを取りました（v${version}）`);
  } finally {
    db.close();
  }
}

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  migrate(db);
  return db;
}
