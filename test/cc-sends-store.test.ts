import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

function at(seconds: number): Date {
  return new Date(BASE + seconds * 1000);
}

function setup(t: Parameters<typeof tempDb>[0]) {
  const db = tempDb(t);
  const clock = { now: at(0) };
  const store = new CcSendStore(db, () => clock.now);
  return { db, clock, store };
}

test("openDb: v27 の DB を v28 に上げても cc_sessions・cc_state は残り、cc_sends は空。origin・state は決まった語だけ", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const v27 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 27)) v27.exec(migration);
  v27.exec("PRAGMA user_version = 27");
  new CcSessionStore(v27, () => at(0)).upsertSeen([{ sessionId: S1, cwd: "/w/a", name: "a", pid: 1 }]);
  v27.exec("UPDATE cc_state SET multiline_ok = 0");
  v27.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 28);
  const sessions = new CcSessionStore(db, () => at(0));
  assert.equal(sessions.get(S1)?.name, "a");
  assert.equal(sessions.multilineOk(), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cc_sends").get()?.n, 0);
  const insert = (origin: string, state: string) =>
    db.prepare("INSERT INTO cc_sends (text, origin, state, created_at, updated_at) VALUES ('x', ?, ?, 'a', 'a')").run(origin, state);
  assert.throws(() => insert("discord", "queued"));
  assert.throws(() => insert("web", "sent"));
  insert("start", "awaiting_confirm");
});

test("CcSendStore: add・get・同じ本文の 5 秒・まだ終わっていない行・compare-and-set", (t) => {
  const { clock, store } = setup(t);
  const first = store.add({ sessionId: S1, text: "1 行目\n2 行目", origin: "web", state: "queued" });
  assert.equal(first.state, "queued");
  assert.equal(first.attempts, 0);
  assert.equal(store.get(first.id)?.text, "1 行目\n2 行目");
  assert.equal(store.findRecentSame(S1, "1 行目\n2 行目", at(-5))?.id, first.id);
  assert.equal(store.findRecentSame(S1, "別", at(-5)), undefined);
  assert.equal(store.findRecentSame(S2, "1 行目\n2 行目", at(-5)), undefined);
  // 取り消した・送れなかった・諦めた行は返さない
  const other = store.add({ sessionId: S2, text: "x", origin: "web", state: "queued" });
  for (const state of ["cancelled", "failed", "gave_up"] as const) {
    store.transition(other.id, ["queued", "cancelled", "failed", "gave_up"], state);
    assert.equal(store.findRecentSame(S2, "x", at(-5)), undefined, state);
  }
  store.transition(other.id, ["gave_up"], "unconfirmed");
  assert.equal(store.findRecentSame(S2, "x", at(-5))?.id, other.id);
  store.transition(other.id, ["unconfirmed"], "cancelled");
  clock.now = at(6);
  assert.equal(store.findRecentSame(S1, "1 行目\n2 行目", at(1)), undefined);
  assert.equal(store.activeFor(S1)?.id, first.id);
  assert.equal(store.activeFor(S2), undefined);
  assert.equal(store.countActive(), 1);

  store.noteAttempt(first.id, "busy");
  assert.deepEqual([store.get(first.id)?.attempts, store.get(first.id)?.lastPaneState], [1, "busy"]);
  // 状態が合わなければ移さない
  assert.equal(store.transition(first.id, ["delivering"], "delivered"), false);
  assert.equal(store.transition(first.id, ["queued"], "delivering", { paneId: "%1" }), true);
  store.noteAttempt(first.id, "idle");
  assert.equal(store.get(first.id)?.attempts, 1);
  clock.now = at(10);
  assert.equal(store.transition(first.id, ["delivering"], "delivered", { lastPaneState: "busy" }), true);
  const done = store.get(first.id)!;
  assert.deepEqual([done.state, done.paneId, done.lastPaneState, done.deliveredAt], ["delivered", "%1", "busy", at(10).toISOString()]);
  assert.equal(store.activeFor(S1), undefined);
  assert.equal(store.listQueued().length, 0);
});

test("CcSendStore: 再起動で delivering → unconfirmed、古い queued → gave_up、終わった古い行だけ消す", (t) => {
  const { clock, store } = setup(t);
  const delivering = store.add({ sessionId: S1, text: "a", origin: "web", state: "queued" });
  store.transition(delivering.id, ["queued"], "delivering");
  const old = store.add({ sessionId: S2, text: "b", origin: "web", state: "queued" });
  clock.now = at(3600);
  const fresh = store.add({ sessionId: "33333333-3333-4333-8333-333333333333", text: "c", origin: "web", state: "queued" });
  assert.equal(store.recoverDelivering(), 1);
  assert.deepEqual([store.get(delivering.id)?.state, store.get(delivering.id)?.lastPaneState], ["unconfirmed", "restarted"]);
  assert.deepEqual(store.giveUpOlderThan(at(1)), [old.id]);
  assert.equal(store.get(old.id)?.state, "gave_up");
  assert.equal(store.get(fresh.id)?.state, "queued");
  assert.deepEqual(
    store.listQueued().map((row) => row.id),
    [fresh.id],
  );
  // queued は日数を過ぎても消さない
  assert.equal(store.prune(at(7200)), 2);
  assert.equal(store.get(fresh.id)?.state, "queued");
});

test("CcSendStore.latestPerSession: セッションごとの最新の行のうち、終わっていないか since 以後に変わったもの", (t) => {
  const { clock, store } = setup(t);
  const a1 = store.add({ sessionId: S1, text: "a1", origin: "web", state: "queued" });
  store.transition(a1.id, ["queued"], "cancelled");
  const b1 = store.add({ sessionId: S2, text: "b1", origin: "web", state: "queued" });
  clock.now = at(100);
  const a2 = store.add({ sessionId: S1, text: "a2", origin: "web", state: "queued" });
  store.transition(a2.id, ["queued"], "delivering");
  store.transition(a2.id, ["delivering"], "delivered");
  assert.deepEqual(
    store.latestPerSession(at(50)).map((row) => row.id),
    [b1.id, a2.id],
  );
  // 終わったものは since より前に変わっていれば出さない（終わっていない b1 は出す）
  assert.deepEqual(
    store.latestPerSession(at(200)).map((row) => row.id),
    [b1.id],
  );
});

test("CcSessionStore.setMultilineOk: 変わったときだけ true", (t) => {
  const db = tempDb(t);
  const sessions = new CcSessionStore(db, () => at(0));
  assert.equal(sessions.multilineOk(), true);
  assert.equal(sessions.setMultilineOk(false), true);
  assert.equal(sessions.setMultilineOk(false), false);
  assert.equal(sessions.multilineOk(), false);
  assert.equal(sessions.setMultilineOk(true), true);
  assert.equal(sessions.multilineOk(), true);
});
