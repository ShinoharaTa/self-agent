import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupBeforeMigration, backupPath, MIGRATIONS, openDb } from "../src/store/db.ts";
import { HistoryStore } from "../src/store/history.ts";
import { NOTICE_LIST_MAX, NoticeStore } from "../src/store/notices.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const BASE = Date.parse("2026-10-01T00:00:00.000Z");

/** BASE から minutes 分後 */
function at(minutes: number): Date {
  return new Date(BASE + minutes * 60_000);
}

function setup(t: Parameters<typeof tempDb>[0]) {
  const db = tempDb(t);
  const clock = { now: at(0) };
  const store = new NoticeStore(db, () => clock.now);
  return { db, clock, store };
}

test("openDb: v25 の DB を v26 に上げても既存のデータは残り、notices は空で使える。移行の前に v25 の控えを取る", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const v25 = new DatabaseSync(path);
  v25.exec("PRAGMA journal_mode=WAL");
  for (const migration of MIGRATIONS.slice(0, 25)) v25.exec(migration);
  v25.exec("PRAGMA user_version = 25");
  new HistoryStore(v25, () => at(0)).add({ guildId: "g", channelId: "c", kind: "owner", source: "discord", text: "残る" });
  v25.close();

  const logs: string[] = [];
  await backupBeforeMigration(path, (message) => logs.push(message));
  assert.ok(existsSync(backupPath(path, 25)));
  assert.deepEqual(logs, ["DB を移行する前に控えを取りました（v25）"]);

  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 26);
  assert.deepEqual(new HistoryStore(db).list("c", { limit: 10 }).map((row) => row.text), ["残る"]);
  const store = new NoticeStore(db, () => at(0));
  assert.deepEqual(store.listRecent(10), []);
  const id = store.add({ guildId: "g", level: "info", text: "知らせ" });
  assert.equal(store.listRecent(10)[0]?.id, id);
});

test("NoticeStore.add: 未投稿の行を書いて id を返す。書いた時刻は now。level は 4 種類だけ", (t) => {
  const { db, store } = setup(t);
  const id = store.add({ guildId: "g-1", level: "warning", text: "シェル（Bash）を使えない状態です: bwrap" });
  assert.deepEqual(store.listRecent(10), [
    {
      id,
      at: at(0).toISOString(),
      guildId: "g-1",
      level: "warning",
      text: "シェル（Bash）を使えない状態です: bwrap",
      messageId: null,
      postedAt: null,
    },
  ]);
  for (const level of ["info", "success", "danger"] as const) store.add({ guildId: "g-1", level, text: level });
  assert.deepEqual(
    store.listRecent(10).map((row) => row.level),
    ["danger", "success", "info", "warning"],
  );
  assert.throws(() =>
    db.prepare("INSERT INTO notices (at, guild_id, level, text) VALUES (?, 'g-1', 'error', 'x')").run(at(0).toISOString()),
  );
});

test("NoticeStore.findUnposted: 同じサーバー・同じ本文で未投稿の最新の行。投稿済み・別のサーバー・別の本文は返さない", (t) => {
  const { clock, store } = setup(t);
  assert.equal(store.findUnposted("g-1", "A"), undefined);
  const first = store.add({ guildId: "g-1", level: "info", text: "A" });
  clock.now = at(1);
  const second = store.add({ guildId: "g-1", level: "info", text: "A" });
  store.add({ guildId: "g-2", level: "info", text: "A" });
  store.add({ guildId: "g-1", level: "info", text: "B" });
  assert.equal(store.findUnposted("g-1", "A")?.id, second);
  assert.equal(store.markPosted(second, "m-2"), true);
  assert.equal(store.findUnposted("g-1", "A")?.id, first);
  assert.equal(store.markPosted(first, "m-1"), true);
  assert.equal(store.findUnposted("g-1", "A"), undefined);
  assert.equal(store.findUnposted("g-3", "A"), undefined);
});

test("NoticeStore.markPosted: message_id と posted_at（now）を入れる。無い id は false", (t) => {
  const { clock, store } = setup(t);
  const id = store.add({ guildId: "g-1", level: "success", text: "戻りました" });
  clock.now = at(5);
  assert.equal(store.markPosted(id, "m-1"), true);
  const row = store.listRecent(1)[0];
  assert.equal(row?.messageId, "m-1");
  assert.equal(row?.postedAt, at(5).toISOString());
  assert.equal(row?.at, at(0).toISOString());
  assert.equal(store.markPosted(id + 100, "m-2"), false);
});

test("NoticeStore.listRecent: 新しい順に limit 件。limit が 1〜200 の整数でなければ RangeError", (t) => {
  const { store } = setup(t);
  const ids = [1, 2, 3].map((n) => store.add({ guildId: "g-1", level: "info", text: `知らせ ${n}` }));
  assert.deepEqual(
    store.listRecent(2).map((row) => row.id),
    [ids[2], ids[1]],
  );
  assert.equal(store.listRecent(NOTICE_LIST_MAX).length, 3);
  for (const limit of [0, -1, 1.5, NOTICE_LIST_MAX + 1, Number.NaN]) {
    assert.throws(() => store.listRecent(limit), RangeError, String(limit));
  }
});

test("NoticeStore.countSince・prune: since 以後の数（未投稿を含む）と、cutoff より前の行（未投稿も）の削除", (t) => {
  const { clock, store } = setup(t);
  const old = store.add({ guildId: "g-1", level: "info", text: "古い" });
  store.markPosted(old, "m-1");
  store.add({ guildId: "g-1", level: "warning", text: "古い未投稿" });
  clock.now = at(10);
  store.add({ guildId: "g-1", level: "info", text: "ちょうど" });
  clock.now = at(20);
  const fresh = store.add({ guildId: "g-1", level: "danger", text: "新しい" });
  assert.equal(store.countSince(at(0)), 4);
  assert.equal(store.countSince(at(10)), 2);
  assert.equal(store.countSince(at(21)), 0);
  assert.equal(store.prune(at(10)), 2);
  assert.deepEqual(
    store.listRecent(10).map((row) => row.text),
    ["新しい", "ちょうど"],
  );
  assert.equal(store.prune(at(10)), 0);
  assert.equal(store.listRecent(1)[0]?.id, fresh);
});
