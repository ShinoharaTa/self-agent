import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";

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
    summary: null,
    origin: "command",
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
  assert.equal(new SdkSessionStore(db).get("inbox-1"), "session-1");
  const guildSettings = new GuildSettingsStore(db);
  assert.equal(guildSettings.get("guild-1")?.inboxChannelId, "inbox-1");
  assert.equal(guildSettings.getStateCategory("guild-1", "active", 1), "active-1");

  const store = new TopicSessionStore(db, clock());
  store.create(NEW_SESSION);
  assert.equal(store.get("topic-1")?.title, "旅行の計画");
});

test("TopicSessionStore: 下書きの保存・取得・削除。行が無いチャンネルには保存しない", (t) => {
  const store = new TopicSessionStore(tempDb(t), clock());
  store.create(NEW_SESSION);
  const draft = { summary: "要約", tasks: [{ title: "宿を予約する", due: "2026-10-05" }, { title: "休みの申請" }] };

  assert.equal(store.getCloseDraft("topic-1"), undefined);
  assert.equal(store.saveCloseDraft("topic-1", draft), true);
  assert.deepEqual(store.getCloseDraft("topic-1"), draft);
  assert.equal(store.saveCloseDraft("topic-9", draft), false);
  assert.equal(store.getCloseDraft("topic-9"), undefined);

  store.clearCloseDraft("topic-1");
  assert.equal(store.getCloseDraft("topic-1"), undefined);
});

test("TopicSessionStore: close は完了にして閉じた時刻と要約を残し、下書きを消す。行が無ければ undefined", (t) => {
  const store = new TopicSessionStore(tempDb(t), clock());
  store.create(NEW_SESSION);
  store.saveCloseDraft("topic-1", { summary: "下書き", tasks: [] });

  const closed = store.close("topic-1", "要約");

  assert.equal(closed?.state, "done");
  assert.equal(closed?.closedAt, "2026-10-02T00:01:00.000Z");
  assert.equal(closed?.summary, "要約");
  assert.deepEqual(store.get("topic-1"), closed);
  assert.equal(store.getCloseDraft("topic-1"), undefined);
  assert.equal(store.close("topic-9", "要約"), undefined);
});

test("TopicSessionStore: setCategory は今置いているカテゴリを更新し、行が無ければ何もしない", (t) => {
  const store = new TopicSessionStore(tempDb(t), clock());
  store.create(NEW_SESSION);

  store.setCategory("topic-1", "done-1");
  store.setCategory("inbox-1", "home-1");

  assert.equal(store.get("topic-1")?.categoryId, "done-1");
  assert.equal(store.get("inbox-1"), undefined);
});

test("TopicSessionStore: setWaiting は待ちにして waiting_since を今にし、setActive は進行中に戻して waiting_since と closed_at を消す（要約は残す）", (t) => {
  const store = new TopicSessionStore(tempDb(t), clock());
  store.create(NEW_SESSION);

  const waiting = store.setWaiting("topic-1");

  assert.equal(waiting?.state, "waiting");
  assert.equal(waiting?.waitingSince, "2026-10-02T00:01:00.000Z");
  assert.equal(waiting?.lastActivityAt, "2026-10-02T00:00:00.000Z");
  assert.deepEqual(store.get("topic-1"), waiting);

  const active = store.setActive("topic-1");

  assert.equal(active?.state, "active");
  assert.equal(active?.waitingSince, null);
  assert.deepEqual(store.get("topic-1"), active);

  // 完了から戻す
  store.close("topic-1", "要約");
  const reopened = store.setActive("topic-1");
  assert.equal(reopened?.state, "active");
  assert.equal(reopened?.closedAt, null);
  assert.equal(reopened?.summary, "要約");

  assert.equal(store.setWaiting("topic-9"), undefined);
  assert.equal(store.setActive("topic-9"), undefined);
});

test("TopicSessionStore: listIdle は進行中で最終発言が指定時刻以前（ちょうどを含む）のものを古い順に limit 件まで返す", (t) => {
  const db = tempDb(t);
  const at = { now: new Date("2026-10-02T00:00:00.000Z") };
  const store = new TopicSessionStore(db, () => at.now);
  const create = (channelId: string, iso: string): void => {
    at.now = new Date(iso);
    store.create({ ...NEW_SESSION, channelId });
  };
  create("topic-c", "2026-10-02T00:03:00.000Z");
  create("topic-a", "2026-10-02T00:01:00.000Z");
  create("topic-b", "2026-10-02T00:02:00.000Z");
  create("topic-d", "2026-10-02T00:04:00.000Z");
  create("topic-w", "2026-10-02T00:00:00.000Z");
  create("topic-x", "2026-10-02T00:00:00.000Z");
  store.setWaiting("topic-w");
  store.close("topic-x", "要約");

  const ids = (before: string, limit: number): string[] =>
    store.listIdle(new Date(before), limit).map((session) => session.channelId);

  assert.deepEqual(ids("2026-10-02T00:03:00.000Z", 10), ["topic-a", "topic-b", "topic-c"]);
  assert.deepEqual(ids("2026-10-02T00:02:59.999Z", 10), ["topic-a", "topic-b"]);
  assert.deepEqual(ids("2026-10-02T00:10:00.000Z", 2), ["topic-a", "topic-b"]);
  assert.deepEqual(ids("2026-10-02T00:00:59.999Z", 10), []);
});

test("ChannelSeedStore: 保存（置き換え）・取得・削除。SdkSessionStore.delete で SDK セッションを捨てる", (t) => {
  const db = tempDb(t);
  const seeds = new ChannelSeedStore(db, clock());
  assert.equal(seeds.get("topic-1"), undefined);
  seeds.set("topic-1", "古い");
  seeds.set("topic-1", "新しい");
  assert.equal(seeds.get("topic-1"), "新しい");
  assert.equal(db.prepare("SELECT created_at FROM channel_seeds").get()?.created_at, "2026-10-02T00:01:00.000Z");
  seeds.delete("topic-1");
  assert.equal(seeds.get("topic-1"), undefined);

  const sessions = new SdkSessionStore(db, clock());
  sessions.set("topic-1", "session-1");
  sessions.set("topic-2", "session-2");
  sessions.delete("topic-1");
  assert.equal(sessions.get("topic-1"), undefined);
  assert.equal(sessions.get("topic-2"), "session-2");
});

test("openDb: v3 の DB を v4 に上げても既存のセッションは残り、要約は null。下書きと seed が使える", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // P2-3 時点（v3）の DB を作る
  const v3 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 3)) v3.exec(migration);
  v3.exec("PRAGMA user_version = 3");
  v3.prepare("INSERT INTO channel_sessions (key, session_id, updated_at) VALUES ('topic-1', 'session-1', '2026-10-01T00:00:00.000Z')").run();
  v3.prepare(
    "INSERT INTO sessions (channel_id, guild_id, title, state, category_id, created_at, last_activity_at) " +
      "VALUES ('topic-1', 'guild-1', '旅行の計画', 'active', 'active-1', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
  ).run();
  v3.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 4);
  const store = new TopicSessionStore(db, clock());
  assert.deepEqual(store.get("topic-1"), {
    channelId: "topic-1",
    guildId: "guild-1",
    title: "旅行の計画",
    state: "active",
    categoryId: "active-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    lastActivityAt: "2026-10-01T00:00:00.000Z",
    waitingSince: null,
    closedAt: null,
    summary: null,
    origin: "command",
  });
  assert.equal(store.getCloseDraft("topic-1"), undefined);
  assert.equal(new SdkSessionStore(db).get("topic-1"), "session-1");

  store.saveCloseDraft("topic-1", { summary: "要約", tasks: [] });
  assert.equal(store.close("topic-1", "要約")?.summary, "要約");
  const seeds = new ChannelSeedStore(db, clock());
  seeds.set("topic-1", "seed");
  assert.equal(seeds.get("topic-1"), "seed");
});

test("SdkSessionStore: 連続失敗を数え、set（成功・別のセッションへの置き換え）で 0 に戻す。行が無ければ 0", (t) => {
  const sessions = new SdkSessionStore(tempDb(t), clock());
  assert.equal(sessions.recordFailure("inbox-1"), 0);
  assert.equal(sessions.failureCount("inbox-1"), 0);

  sessions.set("inbox-1", "session-1");
  assert.equal(sessions.recordFailure("inbox-1"), 1);
  assert.equal(sessions.recordFailure("inbox-1"), 2);
  assert.equal(sessions.failureCount("inbox-1"), 2);
  assert.equal(sessions.get("inbox-1"), "session-1");

  sessions.set("inbox-1", "session-1");
  assert.equal(sessions.failureCount("inbox-1"), 0);
  sessions.recordFailure("inbox-1");
  sessions.set("inbox-1", "session-2");
  assert.equal(sessions.failureCount("inbox-1"), 0);

  sessions.delete("inbox-1");
  assert.equal(sessions.failureCount("inbox-1"), 0);
});

test("openDb: v4 の DB を v5 に上げても SDK セッションは残り、連続失敗の回数は 0 から数える", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // P2-4 時点（v4）の DB を作る
  const v4 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 4)) v4.exec(migration);
  v4.exec("PRAGMA user_version = 4");
  v4.prepare("INSERT INTO channel_sessions (key, session_id, updated_at) VALUES ('topic-1', 'session-1', '2026-10-01T00:00:00.000Z')").run();
  v4.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 5);
  const sessions = new SdkSessionStore(db, clock());
  assert.equal(sessions.get("topic-1"), "session-1");
  assert.equal(sessions.failureCount("topic-1"), 0);
  assert.equal(sessions.recordFailure("topic-1"), 1);
});

test("openDb: v5 の DB を v6 に上げても usage_log の行は残り、compacted は 0（false）。以後は compacted を記録できる", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // compaction の記録より前（v5）の DB を作る
  const v5 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 5)) v5.exec(migration);
  v5.exec("PRAGMA user_version = 5");
  v5.prepare("INSERT INTO usage_log (at, key, session_id, ok) VALUES ('2026-10-01T00:00:00.000Z', 'inbox-1', 'session-1', 1)").run();
  v5.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 6);
  const usage = new UsageStore(db, clock());
  usage.record({ key: "topic-1", sessionId: "session-2", ok: true, compacted: true });
  usage.record({ key: "topic-1", sessionId: "session-2", ok: false });
  assert.deepEqual(
    usage.recent(10).map((entry) => [entry.key, entry.ok, entry.compacted]),
    [
      ["topic-1", false, false],
      ["topic-1", true, true],
      ["inbox-1", true, false],
    ],
  );
});

test("TopicSessionStore: origin を省略すれば command、inbox を渡せば inbox で保存する。決めた値以外は DB が拒む", (t) => {
  const db = tempDb(t);
  const store = new TopicSessionStore(db, clock());

  assert.equal(store.create(NEW_SESSION).origin, "command");
  assert.equal(store.create({ ...NEW_SESSION, channelId: "topic-2", origin: "inbox" }).origin, "inbox");
  assert.equal(store.get("topic-2")?.origin, "inbox");
  assert.throws(() => db.prepare("UPDATE sessions SET origin = 'auto' WHERE channel_id = 'topic-1'").run(), /CHECK/);
});

test("TopicSessionStore.listOpen: そのサーバーの進行中・待ちだけを最終発言の新しい順に返す", (t) => {
  const db = tempDb(t);
  const store = new TopicSessionStore(db, clock());
  for (const channelId of ["topic-1", "topic-2", "topic-3", "topic-4"]) store.create({ ...NEW_SESSION, channelId });
  store.create({ ...NEW_SESSION, channelId: "topic-5", guildId: "guild-2" });
  store.setWaiting("topic-2");
  db.prepare("UPDATE sessions SET state = 'done' WHERE channel_id = 'topic-3'").run();
  db.prepare("UPDATE sessions SET state = 'deleted' WHERE channel_id = 'topic-4'").run();
  // topic-1 を最後に発言したことにする
  store.touch("topic-1");

  assert.deepEqual(
    store.listOpen("guild-1").map((session) => [session.channelId, session.state]),
    [
      ["topic-1", "active"],
      ["topic-2", "waiting"],
    ],
  );
  assert.deepEqual(
    store.listOpen("guild-2").map((session) => session.channelId),
    ["topic-5"],
  );
  assert.deepEqual(store.listOpen("guild-9"), []);
});

test("TopicSessionStore: countCreatedSince と lastCreatedAt はその origin だけを、全サーバー・全状態で数える", (t) => {
  const db = tempDb(t);
  // 00:00, 00:01, ... に作る
  const store = new TopicSessionStore(db, clock());
  assert.equal(store.countCreatedSince("inbox", new Date(0)), 0);
  assert.equal(store.lastCreatedAt("inbox"), undefined);

  store.create({ ...NEW_SESSION, channelId: "topic-1", origin: "inbox" });
  store.create({ ...NEW_SESSION, channelId: "topic-2", origin: "inbox", guildId: "guild-2" });
  store.create({ ...NEW_SESSION, channelId: "topic-3" });
  store.create({ ...NEW_SESSION, channelId: "topic-4", origin: "inbox" });
  db.prepare("UPDATE sessions SET state = 'deleted' WHERE channel_id = 'topic-4'").run();

  // since ちょうどを含む
  assert.equal(store.countCreatedSince("inbox", new Date("2026-10-02T00:01:00.000Z")), 2);
  assert.equal(store.countCreatedSince("inbox", new Date("2026-10-02T00:01:00.001Z")), 1);
  assert.equal(store.countCreatedSince("inbox", new Date("2026-10-02T00:00:00.000Z")), 3);
  assert.equal(store.countCreatedSince("command", new Date("2026-10-02T00:00:00.000Z")), 1);
  assert.deepEqual(store.lastCreatedAt("inbox"), new Date("2026-10-02T00:03:00.000Z"));
  assert.deepEqual(store.lastCreatedAt("command"), new Date("2026-10-02T00:02:00.000Z"));
});

test("openDb: v7 の DB を v8 に上げても既存のセッションは残り、origin は command。以後は inbox で作ったものを数えられる", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // セッションの作られ方の記録より前（v7）の DB を作る
  const v7 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 7)) v7.exec(migration);
  v7.exec("PRAGMA user_version = 7");
  v7.prepare(
    "INSERT INTO sessions (channel_id, guild_id, title, state, category_id, created_at, last_activity_at) " +
      "VALUES ('topic-1', 'guild-1', '旅行の計画', 'waiting', 'waiting-1', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
  ).run();
  v7.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 8);
  const store = new TopicSessionStore(db, clock());
  assert.equal(store.get("topic-1")?.origin, "command");
  assert.equal(store.get("topic-1")?.state, "waiting");
  assert.equal(store.countCreatedSince("inbox", new Date(0)), 0);
  assert.equal(store.countCreatedSince("command", new Date(0)), 1);

  store.create({ ...NEW_SESSION, channelId: "topic-2", origin: "inbox" });
  assert.equal(store.countCreatedSince("inbox", new Date(0)), 1);
  assert.deepEqual(store.lastCreatedAt("inbox"), new Date("2026-10-02T00:00:00.000Z"));
});
