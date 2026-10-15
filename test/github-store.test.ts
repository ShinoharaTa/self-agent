import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupBeforeMigration, backupPath, MIGRATIONS, openDb } from "../src/store/db.ts";
import { GithubStore, type NewGithubNotification } from "../src/store/github.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { RoutineStore } from "../src/store/routines.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

/** 2026-10-15T00:<minute>:00.000Z */
function at(minute: number): Date {
  return new Date(Date.UTC(2026, 9, 15, 0, minute));
}

function tempStore(t: TestContext): { store: GithubStore; db: DatabaseSync; setNow: (date: Date) => void } {
  let now = at(0);
  const db = tempDb(t);
  return {
    store: new GithubStore(db, () => now),
    db,
    setNow: (date) => {
      now = date;
    },
  };
}

function event(overrides: Partial<NewGithubNotification> = {}): NewGithubNotification {
  return {
    threadId: "t-1",
    updatedAt: "2026-10-15T00:00:00Z",
    reason: "author",
    level: "red",
    label: "コメント",
    actorLogin: "example-other",
    actorKnown: true,
    title: "題名",
    url: "https://github.com/example-org/example-repo/pull/12",
    repoPrivate: true,
    handoffOk: false,
    ...overrides,
  };
}

test("openDb: v20 の DB を v21 に上げても既存のデータは残り、GitHub の表は空で使え、guild_settings の #github は null。移行の前に v20 の控えを取る", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const v20 = new DatabaseSync(path);
  v20.exec("PRAGMA journal_mode=WAL");
  for (const migration of MIGRATIONS.slice(0, 20)) v20.exec(migration);
  v20.exec("PRAGMA user_version = 20");
  const created = "2026-10-01T00:00:00.000Z";
  v20
    .prepare(
      "INSERT INTO guild_settings (guild_id, home_category_id, system_channel_id, routine_category_id, created_at, updated_at) VALUES ('g', 'home-1', 'system-1', 'routine-1', ?, ?)",
    )
    .run(created, created);
  v20.prepare("INSERT INTO tasks (title, status, created_at) VALUES ('残る', 'open', ?)").run(created);
  v20
    .prepare("INSERT INTO routines (channel_id, guild_id, name, created_at, updated_at) VALUES ('rt-1', 'g', '領収書', ?, ?)")
    .run(created, created);
  v20.close();

  const logs: string[] = [];
  await backupBeforeMigration(path, (message) => logs.push(message));
  assert.ok(existsSync(backupPath(path, 20)));
  assert.deepEqual(logs, ["DB を移行する前に控えを取りました（v20）"]);

  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 21);

  const guildSettings = new GuildSettingsStore(db);
  assert.equal(guildSettings.get("g")?.systemChannelId, "system-1");
  assert.equal(guildSettings.routineCategoryId("g"), "routine-1");
  assert.equal(db.prepare("SELECT github_channel_id FROM guild_settings WHERE guild_id = 'g'").get()?.github_channel_id, null);
  assert.deepEqual(new TaskStore(db).list({ status: "open", limit: 20 }).map((task) => task.title), ["残る"]);
  assert.equal(new RoutineStore(db).get("rt-1")?.name, "領収書");

  const store = new GithubStore(db, () => at(0));
  assert.equal(store.getThread("t-1"), undefined);
  assert.deepEqual(store.listUnposted(10), []);
  assert.equal(store.getPollState().baselineDone, false);
  assert.equal(store.addNotification(event()).result, "added");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM github_handoffs").get()?.count), 0);
});

test("GithubStore: スレッドは初めて見た時刻を残して updated_at を書き換える", (t) => {
  const { store, setNow } = tempStore(t);
  const first = store.recordThread({ threadId: "t-1", repo: "example-org/example-repo", subjectType: "PullRequest", number: 12, updatedAt: "2026-10-15T00:00:00Z" });
  assert.deepEqual(first, {
    threadId: "t-1",
    repo: "example-org/example-repo",
    subjectType: "PullRequest",
    number: 12,
    lastUpdatedAt: "2026-10-15T00:00:00Z",
    firstSeenAt: at(0).toISOString(),
  });
  setNow(at(5));
  const second = store.recordThread({ threadId: "t-1", repo: "example-org/example-repo", subjectType: "PullRequest", number: 12, updatedAt: "2026-10-15T00:04:00Z" });
  assert.equal(second.lastUpdatedAt, "2026-10-15T00:04:00Z");
  assert.equal(second.firstSeenAt, at(0).toISOString());
  assert.deepEqual(store.getThread("t-1"), second);
  // 古い updated_at では戻さない（形の違う同じ時刻も）
  assert.equal(store.recordThread({ threadId: "t-1", repo: "example-org/example-repo", subjectType: "PullRequest", number: 12, updatedAt: "2026-10-15T00:01:00Z" }).lastUpdatedAt, "2026-10-15T00:04:00Z");
  assert.equal(store.recordThread({ threadId: "t-1", repo: "example-org/example-repo", subjectType: "PullRequest", number: 12, updatedAt: "2026-10-15T00:04:00.000Z" }).lastUpdatedAt, "2026-10-15T00:04:00Z");
  assert.equal(store.recordThread({ threadId: "t-2", repo: "example-org/example-repo", subjectType: "Release", number: null, updatedAt: "2026-10-15T00:00:00Z" }).number, null);
});

test("GithubStore: 出来事は thread_id + updated_at で 1 回だけ。白は投稿の対象に出ず、投稿・投稿しないで済ませたものは二度と出ない", (t) => {
  const { store, setNow } = tempStore(t);
  const added = store.addNotification(event());
  assert.equal(added.result, "added");
  assert.ok(added.result === "added");
  assert.deepEqual(added.notification, {
    id: added.notification.id,
    ...event(),
    postedAt: null,
    messageId: null,
    channelId: null,
    createdAt: at(0).toISOString(),
  });
  assert.deepEqual(store.addNotification(event({ title: "別の題名" })), { result: "exists" });
  const later = store.addNotification(event({ updatedAt: "2026-10-15T00:05:00Z", level: "yellow", label: "新しい PR", actorKnown: false, actorLogin: null }));
  const drop = store.addNotification(event({ threadId: "t-2", level: "drop", label: "対象外", title: null, url: null }));
  assert.ok(later.result === "added" && drop.result === "added");
  assert.deepEqual(store.getNotification(drop.notification.id)?.level, "drop");

  assert.deepEqual(store.listUnposted(10).map((row) => row.id), [added.notification.id, later.notification.id]);
  assert.deepEqual(store.listUnposted(1).map((row) => row.id), [added.notification.id]);

  setNow(at(1));
  assert.equal(store.markPosted(added.notification.id, "github-1", "message-1"), true);
  assert.equal(store.markPosted(added.notification.id, "github-1", "message-2"), false);
  const posted = store.getNotification(added.notification.id);
  assert.deepEqual([posted?.postedAt, posted?.channelId, posted?.messageId], [at(1).toISOString(), "github-1", "message-1"]);
  assert.equal(store.markSkipped(later.notification.id), true);
  assert.equal(store.markSkipped(later.notification.id), false);
  assert.equal(store.getNotification(later.notification.id)?.messageId, null);
  assert.deepEqual(store.listUnposted(10), []);
  assert.equal(store.markPosted(999, "github-1", "message-3"), false);
});

test("GithubStore.prune: 古い出来事と更新の無いスレッドを消す。積んでいる送り込みの通知は残す", (t) => {
  const { store, db, setNow } = tempStore(t);
  const old = store.addNotification(event({ threadId: "t-old" }));
  const queued = store.addNotification(event({ threadId: "t-queued" }));
  store.recordThread({ threadId: "t-old", repo: "example-org/example-repo", subjectType: "Issue", number: 1, updatedAt: "2026-09-01T00:00:00Z" });
  store.recordThread({ threadId: "t-new", repo: "example-org/example-repo", subjectType: "Issue", number: 2, updatedAt: "2026-10-15T00:20:00Z" });
  assert.ok(old.result === "added" && queued.result === "added");
  db.prepare(
    "INSERT INTO github_handoffs (notification_id, target, state, created_at, updated_at) VALUES (?, 'session', 'queued', ?, ?)",
  ).run(queued.notification.id, at(0).toISOString(), at(0).toISOString());
  setNow(at(30));
  const fresh = store.addNotification(event({ threadId: "t-fresh" }));
  assert.ok(fresh.result === "added");

  assert.equal(store.prune(at(10)), 1);
  assert.equal(store.getNotification(old.notification.id), undefined);
  assert.ok(store.getNotification(queued.notification.id));
  assert.ok(store.getNotification(fresh.notification.id));
  assert.equal(store.getThread("t-old"), undefined);
  assert.ok(store.getThread("t-new"));
});

test("GithubStore: ポーリングの状態は行が無ければ空、渡した項目だけを書き換える", (t) => {
  const { store } = tempStore(t);
  assert.deepEqual(store.getPollState(), {
    lastModified: null,
    pollIntervalSec: null,
    lastSuccessAt: null,
    errorKind: null,
    errorSince: null,
    rateRemaining: null,
    rateResetAt: null,
    baselineDone: false,
  });
  store.savePollState({});
  // 列に無い名前（prototype の名前を含む）は無視する
  store.savePollState({ constructor: 1, toString: "x" } as never);
  assert.equal(store.getPollState().baselineDone, false);
  const saved = store.savePollState({ lastModified: "Wed, 14 Oct 2026 01:02:03 GMT", pollIntervalSec: 60, baselineDone: true, rateRemaining: 4900 });
  assert.deepEqual(
    [saved.lastModified, saved.pollIntervalSec, saved.baselineDone, saved.rateRemaining, saved.errorKind],
    ["Wed, 14 Oct 2026 01:02:03 GMT", 60, true, 4900, null],
  );
  const failed = store.savePollState({ errorKind: "auth", errorSince: at(3).toISOString() });
  assert.deepEqual([failed.errorKind, failed.errorSince, failed.lastModified, failed.baselineDone], ["auth", at(3).toISOString(), "Wed, 14 Oct 2026 01:02:03 GMT", true]);
  const cleared = store.savePollState({ errorKind: null, errorSince: null, lastSuccessAt: at(4).toISOString() });
  assert.deepEqual([cleared.errorKind, cleared.errorSince, cleared.lastSuccessAt], [null, null, at(4).toISOString()]);
});
