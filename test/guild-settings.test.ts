import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { backupBeforeMigration, backupPath, MIGRATIONS, openDb } from "../src/store/db.ts";
import { GuildSettingsStore, type SessionState } from "../src/store/guild-settings.ts";
import { InboxSummaryStore } from "../src/store/inbox-summaries.ts";
import { KnowledgeStore } from "../src/store/knowledge.ts";
import { MemoryStore } from "../src/store/memories.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";

/** 呼ぶたびに 1 分進む時計 */
function clock(): () => Date {
  let minutes = 0;
  return () => new Date(Date.UTC(2026, 9, 2, 0, minutes++));
}

function tempStore(t: TestContext): GuildSettingsStore {
  const db = tempDb(t);
  return createStores(db, clock()).guildSettings;
}

test("GuildSettingsStore: 未設定のサーバーは undefined、ID は 1 つずつ保存でき、まだ無い列は null", (t) => {
  const store = tempStore(t);
  assert.equal(store.get("guild-1"), undefined);

  store.setChannel("guild-1", "homeCategoryId", "home-1");
  assert.deepEqual(store.get("guild-1"), {
    guildId: "guild-1",
    homeCategoryId: "home-1",
    inboxChannelId: null,
    tasksChannelId: null,
    systemChannelId: null,
    homePanelMessageId: null,
    inboxRotatedDate: null,
    inboxRotatedAt: null,
    tasksRotatedAt: null,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  });

  store.setChannel("guild-1", "inboxChannelId", "inbox-1");
  store.setChannel("guild-1", "tasksChannelId", "tasks-1");
  store.setChannel("guild-1", "systemChannelId", "system-1");
  // 作り直したものは上書きする
  store.setChannel("guild-1", "inboxChannelId", "inbox-2");
  assert.deepEqual(store.get("guild-1"), {
    guildId: "guild-1",
    homeCategoryId: "home-1",
    inboxChannelId: "inbox-2",
    tasksChannelId: "tasks-1",
    systemChannelId: "system-1",
    homePanelMessageId: null,
    inboxRotatedDate: null,
    inboxRotatedAt: null,
    tasksRotatedAt: null,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:04:00.000Z",
  });
  assert.equal(store.get("guild-2"), undefined);
});

test("GuildSettingsStore: 状態カテゴリは (サーバー, 状態, ordinal) ごとに保存し、作り直したら置き換える。listStateCategories はそのサーバー・状態のものを ordinal の昇順で返す", (t) => {
  const store = tempStore(t);
  assert.equal(store.getStateCategory("guild-1", "active", 1), undefined);
  assert.deepEqual(store.listStateCategories("guild-1", "active"), []);

  store.setStateCategory("guild-1", "active", 3, "active-3");
  store.setStateCategory("guild-1", "active", 1, "active-1");
  store.setStateCategory("guild-1", "waiting", 1, "waiting-1");
  store.setStateCategory("guild-1", "active", 2, "active-2");
  store.setStateCategory("guild-2", "active", 1, "other-active-1");
  store.setStateCategory("guild-1", "active", 1, "active-1b");

  assert.equal(store.getStateCategory("guild-1", "active", 1), "active-1b");
  assert.equal(store.getStateCategory("guild-1", "active", 2), "active-2");
  assert.equal(store.getStateCategory("guild-1", "waiting", 1), "waiting-1");
  assert.equal(store.getStateCategory("guild-1", "done", 1), undefined);
  assert.equal(store.getStateCategory("guild-2", "active", 1), "other-active-1");
  assert.deepEqual(store.listStateCategories("guild-1", "active"), [
    { ordinal: 1, categoryId: "active-1b" },
    { ordinal: 2, categoryId: "active-2" },
    { ordinal: 3, categoryId: "active-3" },
  ]);
  assert.deepEqual(store.listStateCategories("guild-1", "waiting"), [{ ordinal: 1, categoryId: "waiting-1" }]);
  assert.deepEqual(store.listStateCategories("guild-1", "done"), []);
});

test("state_categories: 決めた状態以外・同じカテゴリの二重登録は DB が拒む", (t) => {
  const store = tempStore(t);
  store.setStateCategory("guild-1", "active", 1, "active-1");

  assert.throws(() => store.setStateCategory("guild-1", "deleted" as SessionState, 1, "x-1"), /CHECK/);
  assert.throws(() => store.setStateCategory("guild-1", "active", 0, "x-2"), /CHECK/);
  assert.throws(() => store.setStateCategory("guild-1", "waiting", 1, "active-1"), /UNIQUE/);
});

test("openDb: v1 の DB を v2 に上げても既存のデータは残る", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // P1 時点（v1）の DB を作る
  const v1 = new DatabaseSync(path);
  v1.exec(MIGRATIONS[0]!);
  v1.exec("PRAGMA user_version = 1");
  v1.prepare("INSERT INTO tasks (title, status, created_at) VALUES ('残る', 'open', '2026-10-01T00:00:00.000Z')").run();
  v1.prepare("INSERT INTO channel_sessions (key, session_id, updated_at) VALUES ('inbox-1', 'session-1', '2026-10-01T00:00:00.000Z')").run();
  v1.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.deepEqual(
    new TaskStore(db).list({ status: "open", limit: 20 }).map((task) => task.title),
    ["残る"],
  );
  assert.equal(new SdkSessionStore(db).get("inbox-1"), "session-1");

  const store = new GuildSettingsStore(db);
  assert.equal(store.get("guild-1"), undefined);
  store.setChannel("guild-1", "inboxChannelId", "inbox-2");
  store.setStateCategory("guild-1", "done", 1, "done-1");
  assert.equal(store.get("guild-1")?.inboxChannelId, "inbox-2");
  assert.equal(store.getStateCategory("guild-1", "done", 1), "done-1");
});

test("GuildSettingsStore.setInboxRotated・setTasksRotated: 他の列（もう一方のチャンネルの記録を含む）は変えずに、切り替えた日・時刻（渡した時刻。ISO）を上書きする", (t) => {
  const first = new Date("2026-10-01T19:00:00.000Z");
  const second = new Date("2026-10-02T19:00:01.234Z");
  // other はもう一方のチャンネルの記録
  const cases = [
    {
      label: "#inbox",
      other: (store: GuildSettingsStore) => store.setTasksRotated("guild-1", first),
      rotate: (store: GuildSettingsStore, date: string, at: Date) => store.setInboxRotated("guild-1", date, at),
      changes: { inboxRotatedDate: "2026-10-03", inboxRotatedAt: second.toISOString() },
    },
    {
      label: "#tasks",
      other: (store: GuildSettingsStore) => store.setInboxRotated("guild-1", "2026-10-02", first),
      rotate: (store: GuildSettingsStore, _date: string, at: Date) => store.setTasksRotated("guild-1", at),
      changes: { tasksRotatedAt: second.toISOString() },
    },
  ];

  for (const { label, other, rotate, changes } of cases) {
    const store = tempStore(t);
    store.setChannel("guild-1", "inboxChannelId", "inbox-1");
    store.setChannel("guild-1", "tasksChannelId", "tasks-1");
    other(store);
    const prior = store.get("guild-1")!;

    rotate(store, "2026-10-02", first);
    rotate(store, "2026-10-03", second);

    assert.deepEqual(store.get("guild-1"), { ...prior, ...changes, updatedAt: "2026-10-02T00:04:00.000Z" }, label);
  }
});

test("openDb: v9 の DB を v10 に上げても既存のサーバー設定は残り、切り替えた日は null。以後は切り替えた日と #inbox の要約を記録できる", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // #inbox の切り替えより前（v9）の DB を作る
  const v9 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 9)) v9.exec(migration);
  v9.exec("PRAGMA user_version = 9");
  v9.prepare(
    "INSERT INTO guild_settings (guild_id, inbox_channel_id, system_channel_id, created_at, updated_at) " +
      "VALUES ('guild-1', 'inbox-1', 'system-1', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
  ).run();
  v9.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 10);
  const store = new GuildSettingsStore(db, clock());
  assert.equal(store.get("guild-1")?.inboxChannelId, "inbox-1");
  assert.equal(store.get("guild-1")?.systemChannelId, "system-1");
  assert.equal(store.get("guild-1")?.inboxRotatedDate, null);
  store.setInboxRotated("guild-1", "2026-10-02", new Date("2026-10-01T19:00:00.000Z"));
  assert.equal(store.get("guild-1")?.inboxRotatedDate, "2026-10-02");

  const summaries = new InboxSummaryStore(db, clock());
  assert.equal(summaries.latest("guild-1"), undefined);
  summaries.add("guild-1", "2026-10-02", "- 金曜までに見積もりを送る");
  assert.deepEqual(summaries.latest("guild-1"), {
    id: 1,
    guildId: "guild-1",
    date: "2026-10-02",
    summary: "- 金曜までに見積もりを送る",
    createdAt: "2026-10-02T00:00:00.000Z",
  });
});

test("openDb: v10 の DB を v11 に上げても切り替えた日は残り、切り替えた時刻は null。以後は時刻も記録できる", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // 切り替えた時刻より前（v10）の DB を作る
  const v10 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 10)) v10.exec(migration);
  v10.exec("PRAGMA user_version = 10");
  v10.prepare(
    "INSERT INTO guild_settings (guild_id, inbox_channel_id, inbox_rotated_date, created_at, updated_at) " +
      "VALUES ('guild-1', 'inbox-1', '2026-10-01', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
  ).run();
  v10.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 11);
  const store = new GuildSettingsStore(db, clock());
  assert.equal(store.get("guild-1")?.inboxRotatedDate, "2026-10-01");
  assert.equal(store.get("guild-1")?.inboxRotatedAt, null);
  store.setInboxRotated("guild-1", "2026-10-02", new Date("2026-10-01T19:00:00.000Z"));
  assert.equal(store.get("guild-1")?.inboxRotatedAt, "2026-10-01T19:00:00.000Z");
});

test("openDb: v13 の DB を v14 に上げても既存の要約は #inbox のものとして残り、#tasks の要約と切り替えた時刻は無い。以後はチャンネルごとに記録できる", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // #tasks の切り替えより前（v13）の DB を作る
  const v13 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 13)) v13.exec(migration);
  v13.exec("PRAGMA user_version = 13");
  v13.prepare(
    "INSERT INTO guild_settings (guild_id, inbox_channel_id, tasks_channel_id, inbox_rotated_date, inbox_rotated_at, created_at, updated_at) " +
      "VALUES ('guild-1', 'inbox-1', 'tasks-1', '2026-10-01', '2026-09-30T19:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
  ).run();
  v13.prepare(
    "INSERT INTO inbox_summaries (guild_id, date, summary, created_at) VALUES ('guild-1', '2026-10-01', '- 前の要約', '2026-09-30T19:00:00.000Z')",
  ).run();
  v13.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 14);
  const store = new GuildSettingsStore(db, clock());
  assert.equal(store.get("guild-1")?.tasksChannelId, "tasks-1");
  assert.equal(store.get("guild-1")?.inboxRotatedAt, "2026-09-30T19:00:00.000Z");
  assert.equal(store.get("guild-1")?.tasksRotatedAt, null);

  const summaries = new InboxSummaryStore(db, clock());
  assert.equal(summaries.latest("guild-1")?.summary, "- 前の要約");
  assert.equal(summaries.latest("guild-1", "inbox")?.summary, "- 前の要約");
  assert.equal(summaries.latest("guild-1", "tasks"), undefined);

  // #tasks の要約は #inbox の要約に混ざらない（逆も）
  summaries.add("guild-1", "2026-10-02", "- #tasks の要約", "tasks");
  assert.equal(summaries.latest("guild-1")?.summary, "- 前の要約");
  assert.deepEqual(summaries.latest("guild-1", "tasks"), {
    id: 2,
    guildId: "guild-1",
    date: "2026-10-02",
    summary: "- #tasks の要約",
    createdAt: "2026-10-02T00:00:00.000Z",
  });
  summaries.add("guild-1", "2026-10-03", "- #inbox の要約");
  assert.equal(summaries.latest("guild-1", "tasks")?.summary, "- #tasks の要約");
  assert.equal(summaries.latest("guild-1", "inbox")?.summary, "- #inbox の要約");
  assert.equal(
    db.prepare("SELECT channel_kind FROM inbox_summaries WHERE id = 1").get()?.channel_kind,
    "inbox",
  );
});

/** 表の列名 */
function columnsOf(db: DatabaseSync, table: string): string[] {
  return db
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((row) => String(row.name));
}

test("openDb: v17 の DB を v18 に上げても既存のデータは残り、#inbox・#tasks の ID と切り替えの日・時刻は既定の人格の persona_channels に移り、人格・エンジンの列は既定値になる", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // 人格より前（v17）の DB を作る
  const v17 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 17)) v17.exec(migration);
  v17.exec("PRAGMA user_version = 17");
  const created = "2026-10-01T00:00:00.000Z";
  const updated = "2026-10-01T01:00:00.000Z";
  const insertSettings = v17.prepare(
    "INSERT INTO guild_settings (guild_id, home_category_id, inbox_channel_id, tasks_channel_id, system_channel_id, home_panel_message_id, " +
      "inbox_rotated_date, inbox_rotated_at, tasks_rotated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // guild-1: すべてある / guild-2: カテゴリだけ（/setup の途中） / guild-3: #inbox と切り替えの日だけ（v10 の頃に切り替えた）
  insertSettings.run("guild-1", "home-1", "inbox-1", "tasks-1", "system-1", "panel-1", "2026-10-01", "2026-09-30T19:00:00.000Z", "2026-09-30T19:00:01.000Z", created, updated);
  insertSettings.run("guild-2", "home-2", null, null, null, null, null, null, null, created, updated);
  insertSettings.run("guild-3", null, "inbox-3", null, null, null, "2026-09-29", null, null, created, updated);
  v17.prepare("INSERT INTO tasks (title, status, created_at) VALUES ('残る', 'open', ?)").run(created);
  v17.prepare("INSERT INTO channel_sessions (key, session_id, updated_at) VALUES ('inbox-1', 'session-1', ?)").run(created);
  v17.prepare(
    "INSERT INTO sessions (channel_id, guild_id, title, state, category_id, created_at, last_activity_at) VALUES ('topic-1', 'guild-1', '題名', 'active', 'active-1', ?, ?)",
  ).run(created, created);
  v17.prepare("INSERT INTO usage_log (at, key, ok) VALUES (?, 'inbox-1', 1)").run(created);
  v17.prepare("INSERT INTO inbox_summaries (guild_id, date, summary, created_at) VALUES ('guild-1', '2026-10-01', '- 要約', ?)").run(created);
  v17.prepare("INSERT INTO memories (text, created_at) VALUES ('朝型', ?)").run(created);
  v17.prepare("INSERT INTO kb_entries (title, summary, created_at, updated_at) VALUES ('資料の題名', '要点', ?, ?)").run(created, created);
  v17.close();

  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 18);

  // 読み出しは移す前と同じ
  const store = new GuildSettingsStore(db, clock());
  assert.deepEqual(store.get("guild-1"), {
    guildId: "guild-1",
    homeCategoryId: "home-1",
    inboxChannelId: "inbox-1",
    tasksChannelId: "tasks-1",
    systemChannelId: "system-1",
    homePanelMessageId: "panel-1",
    inboxRotatedDate: "2026-10-01",
    inboxRotatedAt: "2026-09-30T19:00:00.000Z",
    tasksRotatedAt: "2026-09-30T19:00:01.000Z",
    createdAt: created,
    updatedAt: updated,
  });
  assert.deepEqual(store.get("guild-2"), {
    guildId: "guild-2",
    homeCategoryId: "home-2",
    inboxChannelId: null,
    tasksChannelId: null,
    systemChannelId: null,
    homePanelMessageId: null,
    inboxRotatedDate: null,
    inboxRotatedAt: null,
    tasksRotatedAt: null,
    createdAt: created,
    updatedAt: updated,
  });
  assert.equal(store.get("guild-3")?.inboxChannelId, "inbox-3");
  assert.equal(store.get("guild-3")?.inboxRotatedDate, "2026-09-29");
  assert.equal(store.get("guild-3")?.tasksChannelId, null);

  // 値のある分だけ既定の人格の行にし、guild_settings の列は消す
  assert.deepEqual(
    db
      .prepare("SELECT guild_id, persona, kind, channel_id, rotated_date, rotated_at FROM persona_channels ORDER BY guild_id, kind")
      .all()
      .map((row) => ({ ...row })),
    [
      { guild_id: "guild-1", persona: "default", kind: "inbox", channel_id: "inbox-1", rotated_date: "2026-10-01", rotated_at: "2026-09-30T19:00:00.000Z" },
      { guild_id: "guild-1", persona: "default", kind: "tasks", channel_id: "tasks-1", rotated_date: null, rotated_at: "2026-09-30T19:00:01.000Z" },
      { guild_id: "guild-3", persona: "default", kind: "inbox", channel_id: "inbox-3", rotated_date: "2026-09-29", rotated_at: null },
    ],
  );
  assert.deepEqual(columnsOf(db, "guild_settings"), [
    "guild_id",
    "home_category_id",
    "system_channel_id",
    "home_panel_message_id",
    "created_at",
    "updated_at",
  ]);

  // ほかのデータは残り、人格・エンジンの列は既存の行も新しい行も既定値
  assert.deepEqual(
    new TaskStore(db).list({ status: "open", limit: 20 }).map((task) => task.title),
    ["残る"],
  );
  assert.equal(new SdkSessionStore(db).get("inbox-1"), "session-1");
  assert.equal(new TopicSessionStore(db).get("topic-1")?.title, "題名");
  assert.equal(new InboxSummaryStore(db).latest("guild-1")?.summary, "- 要約");
  assert.deepEqual(new MemoryStore(db).list().map((memory) => memory.text), ["朝型"]);
  const knowledge = new KnowledgeStore(db);
  assert.deepEqual(knowledge.search("資料の").entries.map((entry) => entry.title), ["資料の題名"]);

  new SdkSessionStore(db).set("inbox-2", "session-2");
  new TopicSessionStore(db).create({ channelId: "topic-2", guildId: "guild-1", title: "次", categoryId: "active-1" });
  new UsageStore(db).record({ key: "inbox-2", ok: true });
  new InboxSummaryStore(db).add("guild-1", "2026-10-02", "- 次の要約");
  new MemoryStore(db).add("夜は返事が遅い");
  knowledge.add({ title: "次の資料", summary: "要点" });
  for (const [table, column, value] of [
    ["sessions", "persona", "default"],
    ["channel_sessions", "engine", "claude"],
    ["usage_log", "persona", "default"],
    ["usage_log", "engine", "claude"],
    ["inbox_summaries", "persona", "default"],
    ["memories", "created_by", "default"],
    ["kb_entries", "created_by", "default"],
  ] as const) {
    const values = db.prepare(`SELECT ${column} AS value FROM ${table}`).all().map((row) => row.value);
    assert.deepEqual(values, [value, value], `${table}.${column}`);
  }
});

test("GuildSettingsStore: #inbox・#tasks の ID と切り替えの日・時刻は既定の人格の persona_channels に書き、ほかの人格の行は get に出ない", (t) => {
  const db = tempDb(t);
  const store = new GuildSettingsStore(db, clock());

  // persona_channels だけに書いても、guild_settings の行を作る（/setup 済みの印）
  store.setInboxRotated("guild-1", "2026-10-02", new Date("2026-10-01T19:00:00.000Z"));
  assert.equal(store.get("guild-1")?.inboxRotatedDate, "2026-10-02");
  assert.equal(store.get("guild-1")?.createdAt, "2026-10-02T00:00:00.000Z");
  store.setChannel("guild-1", "inboxChannelId", "inbox-1");
  store.setChannel("guild-1", "tasksChannelId", "tasks-1");
  store.setTasksRotated("guild-1", new Date("2026-10-01T19:00:01.000Z"));
  assert.equal(store.get("guild-1")?.updatedAt, "2026-10-02T00:03:00.000Z");

  // 足した人格の入口（kind は inbox）は既定の人格の #inbox に混ざらない
  db.prepare(
    "INSERT INTO persona_channels (guild_id, persona, kind, channel_id, rotated_date, rotated_at, created_at, updated_at) " +
      "VALUES ('guild-1', 'aoi', 'inbox', 'aoi-1', '2026-10-05', '2026-10-04T19:00:00.000Z', 'x', 'x')",
  ).run();
  assert.deepEqual(
    db
      .prepare("SELECT persona, kind, channel_id, rotated_date, rotated_at FROM persona_channels ORDER BY persona, kind")
      .all()
      .map((row) => ({ ...row })),
    [
      { persona: "aoi", kind: "inbox", channel_id: "aoi-1", rotated_date: "2026-10-05", rotated_at: "2026-10-04T19:00:00.000Z" },
      { persona: "default", kind: "inbox", channel_id: "inbox-1", rotated_date: "2026-10-02", rotated_at: "2026-10-01T19:00:00.000Z" },
      { persona: "default", kind: "tasks", channel_id: "tasks-1", rotated_date: null, rotated_at: "2026-10-01T19:00:01.000Z" },
    ],
  );
  const settings = store.get("guild-1");
  assert.equal(settings?.inboxChannelId, "inbox-1");
  assert.equal(settings?.inboxRotatedDate, "2026-10-02");
  assert.equal(settings?.inboxRotatedAt, "2026-10-01T19:00:00.000Z");
  assert.equal(settings?.tasksChannelId, "tasks-1");
  assert.equal(settings?.tasksRotatedAt, "2026-10-01T19:00:01.000Z");

  // チャンネルの持ち主は 1 つ: 同じチャンネルを別の人格（同じ人格の別の種類も）の行にはできない
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO persona_channels (guild_id, persona, kind, channel_id, created_at, updated_at) VALUES ('guild-1', 'kai', 'inbox', 'inbox-1', 'x', 'x')",
        )
        .run(),
    /UNIQUE/,
  );
  // setChannel で重なれば、guild_settings の updated_at も変えない（2 つの書き込みは 1 つのトランザクション）
  const before = store.get("guild-1");
  assert.throws(() => store.setChannel("guild-1", "tasksChannelId", "aoi-1"), /UNIQUE/);
  assert.deepEqual(store.get("guild-1"), before);
  // 別のサーバーで重なれば、guild_settings の行も作らない（/setup 前のまま）
  assert.throws(() => store.setChannel("guild-2", "inboxChannelId", "inbox-1"), /UNIQUE/);
  assert.equal(store.get("guild-2"), undefined);
  // channel_id が NULL の行（切り替えの時刻だけ）はいくつあってもよい
  store.setTasksRotated("guild-3", new Date("2026-10-01T19:00:00.000Z"));
  store.setTasksRotated("guild-4", new Date("2026-10-01T19:00:00.000Z"));

  // 決めた種類以外は DB が拒む
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO persona_channels (guild_id, persona, kind, created_at, updated_at) VALUES ('guild-1', 'aoi', 'system', 'x', 'x')",
        )
        .run(),
    /CHECK/,
  );
});

test("backupBeforeMigration: v17 から移行する前に v17 の控え（権限 600。古い列のまま読める）を取り、パスは log に出さない。同じ版の控えがあれば上書きしない", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const makeV17 = (inbox: string): void => {
    const v17 = new DatabaseSync(path);
    v17.exec("PRAGMA journal_mode=WAL");
    for (const migration of MIGRATIONS.slice(0, 17)) v17.exec(migration);
    v17.exec("PRAGMA user_version = 17");
    v17.prepare(
      "INSERT INTO guild_settings (guild_id, inbox_channel_id, created_at, updated_at) VALUES ('guild-1', ?, 'x', 'x')",
    ).run(inbox);
    v17.close();
  };
  makeV17("inbox-1");

  const logs: string[] = [];
  await backupBeforeMigration(path, (message) => logs.push(message));
  const db = openDb(path);
  assert.equal(new GuildSettingsStore(db).get("guild-1")?.inboxChannelId, "inbox-1");

  const target = backupPath(path, 17);
  assert.equal(target, join(dir, "self-agent.db.v17.bak"));
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.ok(!readdirSync(dir).some((name) => name.endsWith(".tmp")));
  assert.deepEqual(logs, ["DB を移行する前に控えを取りました（v17）"]);
  const bak = new DatabaseSync(target, { readOnly: true });
  assert.equal(bak.prepare("PRAGMA user_version").get()?.user_version, 17);
  assert.equal(bak.prepare("SELECT inbox_channel_id FROM guild_settings").get()?.inbox_channel_id, "inbox-1");
  assert.equal(bak.prepare("SELECT name FROM sqlite_master WHERE name = 'persona_channels'").get(), undefined);
  bak.close();

  // 移行済み（最新）なら何もしない
  await backupBeforeMigration(path, (message) => logs.push(message));
  assert.equal(logs.length, 1);
  db.close();

  // 同じ版の控えがあれば、上書きせずにそのまま使う
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) writeFileSync(path + suffix, "");
  }
  makeV17("inbox-2");
  const before = readFileSync(target);
  await backupBeforeMigration(path, (message) => logs.push(message));
  assert.deepEqual(readFileSync(target), before);
  assert.equal(logs[1], "DB を移行する前の控え（v17）は既にあるので、取り直しません");
  assert.ok(logs.every((message) => !message.includes(dir)));
});

test("backupBeforeMigration: DB が無い・新しい（v0）なら控えを取らない", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const logs: string[] = [];
  await backupBeforeMigration(path, (message) => logs.push(message));
  new DatabaseSync(path).close();
  await backupBeforeMigration(path, (message) => logs.push(message));
  assert.deepEqual(logs, []);
  assert.deepEqual(readdirSync(dir), ["self-agent.db"]);
});
