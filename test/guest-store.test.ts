import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupBeforeMigration, backupPath, MIGRATIONS, openDb } from "../src/store/db.ts";
import { GuestStore } from "../src/store/guest.ts";
import { JobStore } from "../src/store/jobs.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

/** 2026-10-23T00:<minute>:00.000Z */
function at(minute: number): Date {
  return new Date(Date.UTC(2026, 9, 23, 0, minute));
}

function tempStore(t: TestContext): { store: GuestStore; setNow: (date: Date) => void } {
  let now = at(0);
  return {
    store: new GuestStore(tempDb(t), () => now),
    setNow: (date) => {
      now = date;
    },
  };
}

test("openDb: v22 の DB を v23 に上げても既存のデータは残り、ゲストの表は空で使える。移行の前に v22 の控えを取る", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const v22 = new DatabaseSync(path);
  v22.exec("PRAGMA journal_mode=WAL");
  for (const migration of MIGRATIONS.slice(0, 22)) v22.exec(migration);
  v22.exec("PRAGMA user_version = 22");
  const created = "2026-10-01T00:00:00.000Z";
  v22.prepare("INSERT INTO tasks (title, status, created_at) VALUES ('残る', 'open', ?)").run(created);
  v22.close();

  const logs: string[] = [];
  await backupBeforeMigration(path, (message) => logs.push(message));
  assert.ok(existsSync(backupPath(path, 22)));
  assert.deepEqual(logs, ["DB を移行する前に控えを取りました（v22）"]);

  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 23);
  assert.deepEqual(new TaskStore(db).list({ status: "open", limit: 20 }).map((task) => task.title), ["残る"]);
  assert.equal(new JobStore(db).countOpen(), 0);

  const store = new GuestStore(db, () => at(0));
  assert.equal(store.countActive("g"), 0);
  assert.equal(store.get("c"), undefined);
  assert.equal(store.countTurns("g", "2026-10-23"), 0);
  assert.equal(store.enable("g", "c").result, "enabled");
});

test("GuestStore.enable: 作る・既に有効なら already_enabled・無効な行は開き直して SDK セッションの数を戻す", (t) => {
  const { store, setNow } = tempStore(t);
  const first = store.enable("g", "c1");
  assert.deepEqual(first, {
    result: "enabled",
    active: 1,
    channel: {
      guildId: "g",
      channelId: "c1",
      enabledAt: at(0).toISOString(),
      disabledAt: null,
      disabledReason: null,
      sessionStartedAt: null,
      sessionTurns: 0,
    },
  });
  assert.equal(store.enable("g", "c1").result, "already_enabled");

  setNow(at(1));
  store.bumpSession("c1");
  store.bumpSession("c1");
  assert.equal(store.get("c1")?.sessionTurns, 2);
  assert.equal(store.get("c1")?.sessionStartedAt, at(1).toISOString());

  setNow(at(2));
  assert.equal(store.disable("c1", "command"), true);
  assert.equal(store.disable("c1", "command"), false);
  assert.equal(store.disable("missing", "command"), false);
  assert.equal(store.get("c1")?.disabledAt, at(2).toISOString());
  assert.equal(store.get("c1")?.disabledReason, "command");
  assert.equal(store.countActive("g"), 0);

  setNow(at(3));
  const reopened = store.enable("g", "c1");
  assert.equal(reopened.result, "enabled");
  assert.deepEqual(store.get("c1"), {
    guildId: "g",
    channelId: "c1",
    enabledAt: at(3).toISOString(),
    disabledAt: null,
    disabledReason: null,
    sessionStartedAt: null,
    sessionTurns: 0,
  });
});

test("GuestStore.enable: サーバーごとの有効なチャンネルが上限なら limit で何も変えない（無効な行・ほかのサーバーは数えない）", (t) => {
  const { store } = tempStore(t);
  for (let index = 1; index <= 5; index++) assert.equal(store.enable("g", `c${index}`).result, "enabled");
  assert.deepEqual(store.enable("g", "c6"), { result: "limit" });
  assert.equal(store.get("c6"), undefined);
  // 既に有効なものは上限でも already_enabled
  assert.equal(store.enable("g", "c1").result, "already_enabled");
  // ほかのサーバーは別に数える
  assert.equal(store.enable("other", "o1").result, "enabled");
  // 1 つ無効にすれば、無効な行の開き直しも新しい行も通る
  store.disable("c5", "command");
  const sixth = store.enable("g", "c6");
  assert.equal(sixth.result, "enabled");
  assert.equal(sixth.result === "enabled" ? sixth.active : undefined, 5);
  assert.equal(store.enable("g", "c5").result, "limit");
  assert.equal(store.countActive("g"), 5);
  // limit は引数で変えられる
  assert.equal(store.enable("h", "h1", 1).result, "enabled");
  assert.equal(store.enable("h", "h2", 1).result, "limit");
});

test("GuestStore.disableGuild: そのサーバーの有効な行だけを理由付きで無効にし、数を返す", (t) => {
  const { store, setNow } = tempStore(t);
  store.enable("g", "c1");
  setNow(at(1));
  store.enable("g", "c2");
  store.enable("g", "c3");
  store.enable("other", "o1");
  store.disable("c3", "command");
  assert.deepEqual(
    store.listActive("g").map((channel) => channel.channelId),
    ["c1", "c2"],
  );
  setNow(at(5));
  assert.equal(store.disableGuild("g", "left"), 2);
  assert.equal(store.disableGuild("g", "left"), 0);
  assert.equal(store.get("c1")?.disabledReason, "left");
  assert.equal(store.get("c2")?.disabledAt, at(5).toISOString());
  // 先に無効にしたものは変えない
  assert.equal(store.get("c3")?.disabledReason, "command");
  assert.equal(store.countActive("g"), 0);
  assert.equal(store.countActive("other"), 1);
  assert.equal(store.disableGuild("other", "startup"), 1);
  assert.equal(store.get("o1")?.disabledReason, "startup");
});

test("GuestStore: bumpSession・resetSession は今の SDK セッションの始めた時刻とターン数を進める・戻す", (t) => {
  const { store, setNow } = tempStore(t);
  store.enable("g", "c1");
  setNow(at(10));
  store.bumpSession("c1");
  setNow(at(20));
  store.bumpSession("c1");
  assert.equal(store.get("c1")?.sessionStartedAt, at(10).toISOString());
  assert.equal(store.get("c1")?.sessionTurns, 2);
  store.resetSession("c1");
  assert.equal(store.get("c1")?.sessionStartedAt, null);
  assert.equal(store.get("c1")?.sessionTurns, 0);
});

test("GuestStore: 1 日のターン数をサーバー・ユーザーごとに数え、pruneTurns は指定の日より前を消す", (t) => {
  const { store } = tempStore(t);
  store.recordTurn("g", "u1", "2026-10-15");
  store.recordTurn("g", "u1", "2026-10-23");
  store.recordTurn("g", "u1", "2026-10-23");
  store.recordTurn("g", "u2", "2026-10-23");
  store.recordTurn("other", "u1", "2026-10-23");
  assert.equal(store.countTurns("g", "2026-10-23"), 3);
  assert.equal(store.countTurns("g", "2026-10-22"), 0);
  assert.equal(store.countUserTurns("g", "u1", "2026-10-23"), 2);
  assert.equal(store.countUserTurns("g", "u2", "2026-10-23"), 1);
  assert.equal(store.countUserTurns("g", "u3", "2026-10-23"), 0);
  assert.equal(store.countUserTurns("other", "u1", "2026-10-23"), 1);

  assert.equal(store.pruneTurns("2026-10-16"), 1);
  assert.equal(store.countTurns("g", "2026-10-15"), 0);
  assert.equal(store.countTurns("g", "2026-10-23"), 3);
  assert.equal(store.pruneTurns("2026-10-16"), 0);
});
