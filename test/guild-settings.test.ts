import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { GuildSettingsStore, type SessionState } from "../src/store/guild-settings.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TaskStore } from "../src/store/tasks.ts";

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 呼ぶたびに 1 分進む時計 */
function clock(): () => Date {
  let minutes = 0;
  return () => new Date(Date.UTC(2026, 9, 2, 0, minutes++));
}

function tempStore(t: TestContext): GuildSettingsStore {
  const db = openDb(join(tempDir(t), "self-agent.db"));
  t.after(() => db.close());
  return new GuildSettingsStore(db, clock());
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
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:04:00.000Z",
  });
  assert.equal(store.get("guild-2"), undefined);
});

test("GuildSettingsStore: 状態カテゴリは (サーバー, 状態, ordinal) ごとに保存し、作り直したら置き換える", (t) => {
  const store = tempStore(t);
  assert.equal(store.getStateCategory("guild-1", "active", 1), undefined);

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
});

test("GuildSettingsStore: listStateCategories はそのサーバー・状態のカテゴリを ordinal の昇順で返す", (t) => {
  const store = tempStore(t);
  assert.deepEqual(store.listStateCategories("guild-1", "active"), []);

  store.setStateCategory("guild-1", "active", 3, "active-3");
  store.setStateCategory("guild-1", "active", 1, "active-1");
  store.setStateCategory("guild-1", "waiting", 1, "waiting-1");
  store.setStateCategory("guild-1", "active", 2, "active-2");
  store.setStateCategory("guild-2", "active", 4, "other-active-4");

  assert.deepEqual(store.listStateCategories("guild-1", "active"), [
    { ordinal: 1, categoryId: "active-1" },
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
