import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { GithubTopicStore } from "../src/store/github-topics.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const AT = new Date("2026-11-20T00:00:00.000Z");

test("github_topics: 新しい DB は最新の版で、表と索引がある", (t) => {
  const db = tempDb(t);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 46);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'github_topics' AND sql IS NOT NULL ORDER BY name")
    .all();
  assert.deepEqual(indexes.map((index) => index.name), ["github_topics_thread"]);
  const columns = db.prepare("PRAGMA table_info(github_topics)").all().map((column) => String(column.name));
  assert.deepEqual(columns, ["id", "notification_id", "thread_id", "channel_id", "created_at"]);
});

test("openDb: v45 までの DB を上げると最新の版になり、github_topics ができる。今ある表・索引の定義と cc_takeovers の行はそのまま", (t) => {
  assert.ok(MIGRATIONS.length >= 46);
  const path = join(tempDir(t), "self-agent.db");
  // v46（github_topics）の 1 つ前の版。後の移行を足しても変えない
  const before = 45;
  const old = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
  old.exec(`PRAGMA user_version = ${before}`);
  assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE name = 'github_topics'").get(), undefined);
  old
    .prepare(
      "INSERT INTO cc_takeovers (session_id, source, project, guild_id, entry, state, permission_mode, created_at, updated_at) VALUES ('s', 'alive', 'p', 'g', 'web', 'awaiting_confirm', 'default', 'a', 'a')",
    )
    .run();
  // github_topics の他の表・索引の定義（名前の近い github_handoffs・github_notifications も入る）。
  // 後の移行が変える表（v47 の sessions・usage_log・place_settings、v48 の topic_pins、v49 の persona_channels・local_ids）は除く（その移行のテストで見る）
  const others =
    "SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'github_topics%' AND tbl_name NOT IN ('sessions', 'usage_log', 'place_settings', 'topic_pins', 'persona_channels', 'local_ids') ORDER BY name";
  const defsBefore = old.prepare(others).all().map((row) => ({ ...row }));
  assert.ok(defsBefore.some((row) => row.name === "github_handoffs"));
  old.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'github_topics'").get()?.name, "github_topics");
  assert.deepEqual(db.prepare(others).all().map((row) => ({ ...row })), defsBefore);
  const rows = db.prepare("SELECT session_id, project, state FROM cc_takeovers").all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ session_id: "s", project: "p", state: "awaiting_confirm" }]);
});

test("add・latestForThread: add した行を返す", (t) => {
  const store = new GithubTopicStore(tempDb(t));
  const id = store.add({ notificationId: 7, threadId: "thread-1", channelId: "channel-1", at: AT });
  assert.deepEqual(store.latestForThread("thread-1"), {
    id,
    notificationId: 7,
    threadId: "thread-1",
    channelId: "channel-1",
    createdAt: AT.toISOString(),
  });
});

test("latestForThread: 同じスレッドは新しい行が勝つ", (t) => {
  const store = new GithubTopicStore(tempDb(t));
  store.add({ notificationId: 1, threadId: "thread-1", channelId: "channel-old", at: AT });
  const id = store.add({ notificationId: 2, threadId: "thread-1", channelId: "channel-new", at: AT });
  const row = store.latestForThread("thread-1");
  assert.equal(row?.id, id);
  assert.equal(row?.channelId, "channel-new");
  assert.equal(row?.notificationId, 2);
});

test("latestForThread: 別のスレッドは混ざらない", (t) => {
  const store = new GithubTopicStore(tempDb(t));
  store.add({ notificationId: 1, threadId: "thread-1", channelId: "channel-1", at: AT });
  store.add({ notificationId: 2, threadId: "thread-2", channelId: "channel-2", at: AT });
  assert.equal(store.latestForThread("thread-1")?.channelId, "channel-1");
  assert.equal(store.latestForThread("thread-2")?.channelId, "channel-2");
});

test("latestForThread: 無ければ undefined", (t) => {
  const store = new GithubTopicStore(tempDb(t));
  assert.equal(store.latestForThread("thread-1"), undefined);
  store.add({ notificationId: 1, threadId: "thread-2", channelId: "channel-2", at: AT });
  assert.equal(store.latestForThread("thread-1"), undefined);
});
