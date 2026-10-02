import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { SessionStore } from "../src/store/sessions.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";

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

function tempDb(t: TestContext): DatabaseSync {
  const db = openDb(join(tempDir(t), "self-agent.db"));
  t.after(() => db.close());
  return db;
}

const NEW_SESSION = { channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" };

test("TopicSessionStore: 進行中として保存し、最終発言の時刻は作成時刻。無いチャンネルは undefined", (t) => {
  const store = new TopicSessionStore(tempDb(t), clock());
  assert.equal(store.get("topic-1"), undefined);

  const created = store.create(NEW_SESSION);

  const expected = {
    channelId: "topic-1",
    guildId: "guild-1",
    title: "旅行の計画",
    state: "active",
    categoryId: "active-1",
    createdAt: "2026-10-02T00:00:00.000Z",
    lastActivityAt: "2026-10-02T00:00:00.000Z",
    waitingSince: null,
    closedAt: null,
  };
  assert.deepEqual(created, expected);
  assert.deepEqual(store.get("topic-1"), expected);
  assert.equal(store.get("topic-2"), undefined);
});

test("TopicSessionStore: touch は last_activity_at だけを今にし、行が無ければ undefined", (t) => {
  const store = new TopicSessionStore(tempDb(t), clock());
  store.create(NEW_SESSION);
  store.create({ ...NEW_SESSION, channelId: "topic-2" });

  const touched = store.touch("topic-1");

  assert.equal(touched?.lastActivityAt, "2026-10-02T00:02:00.000Z");
  assert.equal(touched?.createdAt, "2026-10-02T00:00:00.000Z");
  assert.deepEqual(store.get("topic-1"), touched);
  assert.equal(store.get("topic-2")?.lastActivityAt, "2026-10-02T00:01:00.000Z");
  assert.equal(store.touch("topic-9"), undefined);
});

test("sessions: 決めた状態以外・同じチャンネルの二重登録は DB が拒む", (t) => {
  const db = tempDb(t);
  const store = new TopicSessionStore(db, clock());
  store.create(NEW_SESSION);

  for (const state of ["waiting", "done", "deleted", "active"]) {
    db.prepare("UPDATE sessions SET state = ? WHERE channel_id = 'topic-1'").run(state);
    assert.equal(store.get("topic-1")?.state, state);
  }
  assert.throws(() => db.prepare("UPDATE sessions SET state = 'archived' WHERE channel_id = 'topic-1'").run(), /CHECK/);
  assert.throws(() => store.create(NEW_SESSION), /UNIQUE|PRIMARY KEY/);
});

test("openDb: v2 の DB を v3 に上げても既存のデータは残り、sessions が使える", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // P2-2 時点（v2）の DB を作る
  const v2 = new DatabaseSync(path);
  v2.exec(MIGRATIONS[0]!);
  v2.exec(MIGRATIONS[1]!);
  v2.exec("PRAGMA user_version = 2");
  v2.prepare("INSERT INTO tasks (title, status, created_at) VALUES ('残る', 'open', '2026-10-01T00:00:00.000Z')").run();
  v2.prepare("INSERT INTO channel_sessions (key, session_id, updated_at) VALUES ('inbox-1', 'session-1', '2026-10-01T00:00:00.000Z')").run();
  v2.prepare(
    "INSERT INTO guild_settings (guild_id, inbox_channel_id, created_at, updated_at) VALUES ('guild-1', 'inbox-1', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
  ).run();
  v2.prepare(
    "INSERT INTO state_categories (guild_id, state, ordinal, category_id, created_at) VALUES ('guild-1', 'active', 1, 'active-1', '2026-10-01T00:00:00.000Z')",
  ).run();
  v2.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 3);
  assert.deepEqual(
    new TaskStore(db).list({ status: "open", limit: 20 }).map((task) => task.title),
    ["残る"],
  );
  assert.equal(new SessionStore(db).get("inbox-1"), "session-1");
  const guildSettings = new GuildSettingsStore(db);
  assert.equal(guildSettings.get("guild-1")?.inboxChannelId, "inbox-1");
  assert.equal(guildSettings.getStateCategory("guild-1", "active", 1), "active-1");

  const store = new TopicSessionStore(db, clock());
  store.create(NEW_SESSION);
  assert.equal(store.get("topic-1")?.title, "旅行の計画");
});
