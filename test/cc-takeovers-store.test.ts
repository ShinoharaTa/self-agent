import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CcTakeoverStore, type CcTakeoverPropose } from "../src/store/cc-takeovers.ts";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const BASE = Date.parse("2026-11-13T00:00:00.000Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

function setup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const store = new CcTakeoverStore(db, () => new Date(clock.now));
  const propose = (overrides: Partial<CcTakeoverPropose> = {}) =>
    store.propose({
      sessionId: S1,
      source: "alive",
      project: "alpha",
      guildId: "guild-1",
      channelId: "ch-1",
      entry: "discord",
      permissionMode: "default",
      terminalMode: "auto",
      ...overrides,
    });
  return { db, clock, store, propose };
}

test("cc_takeovers: 新しい DB は最新の版で、表と索引 2 つがある", (t) => {
  const { db } = setup(t);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 42);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cc_takeovers' AND sql IS NOT NULL ORDER BY name")
    .all();
  assert.deepEqual(indexes.map((index) => index.name), ["cc_takeovers_active", "cc_takeovers_channel"]);
  // CHECK: 知らない状態・モードは入らない
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO cc_takeovers (session_id, source, project, guild_id, channel_id, entry, state, permission_mode, created_at, updated_at) VALUES ('s', 'alive', 'p', 'g', 'c', 'discord', 'done', 'auto', 'a', 'a')",
      )
      .run(),
  );
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO cc_takeovers (session_id, source, project, guild_id, channel_id, entry, state, permission_mode, created_at, updated_at) VALUES ('s', 'alive', 'p', 'g', 'c', 'discord', 'closed', 'default', 'a', 'a')",
      )
      .run(),
  );
});

test("openDb: 1 つ前の版の DB を上げると最新の版になり、cc_takeovers ができる", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const before = MIGRATIONS.length - 1;
  const old = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
  old.exec(`PRAGMA user_version = ${before}`);
  assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE name = 'cc_takeovers'").get(), undefined);
  old.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'cc_takeovers'").get()?.name, "cc_takeovers");
});

test("propose: 確認待ちの行を作る。同じ session_id に確認待ち・実行中があれば undefined、done の後は作れる", (t) => {
  const { store, propose } = setup(t);
  const row = propose();
  assert.ok(row);
  assert.equal(row.state, "awaiting_confirm");
  assert.equal(row.step, null);
  assert.equal(row.sessionId, S1);
  assert.equal(row.source, "alive");
  assert.equal(row.project, "alpha");
  assert.equal(row.entry, "discord");
  assert.equal(row.permissionMode, "default");
  assert.equal(row.terminalMode, "auto");
  assert.equal(row.endedHeld, false);
  assert.equal(row.notePending, false);
  assert.equal(row.interrupted, false);
  assert.equal(row.createdAt, new Date(BASE).toISOString());
  assert.deepEqual(store.get(row.id), row);
  assert.equal(propose(), undefined);
  // 別の session_id は作れる
  assert.ok(propose({ sessionId: S2, channelId: "ch-2" }));
  // 実行中でも作れない
  assert.equal(store.start(row.id), true);
  assert.equal(propose(), undefined);
  // done の後は作れる
  assert.equal(store.finish(row.id), true);
  assert.ok(propose());
});

test("propose: failed・cancelled の後も作れる", (t) => {
  const { store, propose } = setup(t);
  const a = propose()!;
  assert.equal(store.cancel(a.id), true);
  const b = propose()!;
  assert.ok(b);
  assert.equal(store.start(b.id), true);
  assert.equal(store.fail(b.id, "changed"), true);
  assert.ok(propose());
});

test("activeFor・runningFor: 確認待ちは active だけ、実行中は両方", (t) => {
  const { store, propose } = setup(t);
  assert.equal(store.activeFor(S1), undefined);
  const row = propose()!;
  assert.equal(store.activeFor(S1)?.id, row.id);
  assert.equal(store.runningFor(S1), undefined);
  store.start(row.id);
  assert.equal(store.activeFor(S1)?.id, row.id);
  assert.equal(store.runningFor(S1)?.id, row.id);
  store.finish(row.id);
  assert.equal(store.activeFor(S1), undefined);
  assert.equal(store.runningFor(S1), undefined);
});

test("start・setStep・setInterrupted・finish: compare-and-set で、当たらなければ false", (t) => {
  const { clock, store, propose } = setup(t);
  const row = propose()!;
  assert.equal(store.setStep(row.id, "check"), false);
  assert.equal(store.setInterrupted(row.id), false);
  assert.equal(store.finish(row.id), false);
  assert.equal(store.start(row.id), true);
  assert.equal(store.start(row.id), false);
  assert.equal(store.setStep(row.id, "term"), true);
  assert.equal(store.setInterrupted(row.id), true);
  clock.now += 1000;
  assert.equal(store.finish(row.id), true);
  const done = store.get(row.id)!;
  assert.equal(done.state, "done");
  assert.equal(done.step, "term");
  assert.equal(done.interrupted, true);
  assert.equal(done.notePending, true);
  assert.equal(done.finishedAt, new Date(BASE + 1000).toISOString());
  assert.equal(store.cancel(row.id), false);
  assert.equal(store.fail(row.id, "copy_failed"), false);
  assert.equal(store.setStep(row.id, "copy"), false);
  assert.equal(store.start(999), false);
});

test("fail: 実行中だけ failed にして符号を残す。cancel: 確認待ちだけ", (t) => {
  const { store, propose } = setup(t);
  const row = propose()!;
  assert.equal(store.fail(row.id, "changed"), false);
  store.start(row.id);
  assert.equal(store.cancel(row.id), false);
  assert.equal(store.fail(row.id, "not_exited"), true);
  const failed = store.get(row.id)!;
  assert.equal(failed.state, "failed");
  assert.equal(failed.failure, "not_exited");
  assert.ok(failed.finishedAt);
  const other = propose()!;
  assert.equal(store.cancel(other.id), true);
  assert.equal(store.get(other.id)?.state, "cancelled");
  assert.ok(store.get(other.id)?.finishedAt);
});

test("expire: cutoff 以前の確認待ちだけを cancelled にして行を返す", (t) => {
  const { clock, store, propose } = setup(t);
  const old = propose()!;
  const running = propose({ sessionId: S2, channelId: "ch-2" })!;
  store.start(running.id);
  clock.now += 10 * 60_000;
  const fresh = propose({ sessionId: "33333333-3333-4333-8333-333333333333", channelId: "ch-3" })!;
  const expired = store.expire(new Date(BASE + 60_000).toISOString());
  assert.deepEqual(expired.map((row) => row.id), [old.id]);
  assert.equal(expired[0]?.state, "cancelled");
  assert.equal(store.get(old.id)?.state, "cancelled");
  assert.equal(store.get(running.id)?.state, "running");
  assert.equal(store.get(fresh.id)?.state, "awaiting_confirm");
  assert.deepEqual(store.expire(new Date(BASE + 60_000).toISOString()), []);
});

test("resetRunning: 実行中を failed（restart）にして行を返す。ほかは変えない", (t) => {
  const { store, propose } = setup(t);
  const a = propose()!;
  const b = propose({ sessionId: S2, channelId: "ch-2" })!;
  store.start(b.id);
  store.setStep(b.id, "term");
  const reset = store.resetRunning();
  assert.deepEqual(reset.map((row) => row.id), [b.id]);
  assert.equal(reset[0]?.state, "failed");
  assert.equal(reset[0]?.failure, "restart");
  assert.equal(reset[0]?.step, "term");
  assert.equal(store.get(a.id)?.state, "awaiting_confirm");
  assert.deepEqual(store.resetRunning(), []);
});

test("takenFor・clearNote: そのチャンネルの最新の done と、前置きの印を外す", (t) => {
  const { store, propose } = setup(t);
  assert.equal(store.takenFor("ch-1"), undefined);
  const first = propose()!;
  store.start(first.id);
  store.finish(first.id);
  const second = propose()!;
  store.start(second.id);
  store.finish(second.id);
  // 確認待ちのままの行は数えない
  propose();
  assert.equal(store.takenFor("ch-1")?.id, second.id);
  assert.equal(store.takenFor("ch-2"), undefined);
  assert.equal(store.clearNote("ch-1"), true);
  assert.equal(store.get(second.id)?.notePending, false);
  assert.equal(store.get(first.id)?.notePending, false);
  assert.equal(store.clearNote("ch-1"), false);
});

test("setConfirmMessage・markEffects・listEffectsPending", (t) => {
  const { store, propose } = setup(t);
  const a = propose()!;
  store.setConfirmMessage(a.id, "msg-1");
  assert.equal(store.get(a.id)?.confirmMessageId, "msg-1");
  assert.equal(store.markEffects(a.id), false);
  store.start(a.id);
  store.finish(a.id);
  const b = propose({ sessionId: S2, channelId: "ch-2" })!;
  store.start(b.id);
  store.finish(b.id);
  assert.deepEqual(store.listEffectsPending().map((row) => row.id), [a.id, b.id]);
  assert.equal(store.markEffects(a.id), true);
  assert.ok(store.get(a.id)?.effectsAt);
  assert.equal(store.markEffects(a.id), false);
  assert.deepEqual(store.listEffectsPending().map((row) => row.id), [b.id]);
});

test("runningForChannel: そのチャンネルの実行中の行だけ", (t) => {
  const { store, propose } = setup(t);
  const row = propose()!;
  assert.equal(store.runningForChannel("ch-1"), undefined);
  store.start(row.id);
  assert.equal(store.runningForChannel("ch-1")?.id, row.id);
  assert.equal(store.runningForChannel("ch-2"), undefined);
  store.finish(row.id);
  assert.equal(store.runningForChannel("ch-1"), undefined);
});

test("hold・releaseHeld・listHeld: running だけ差し止められ、流し直しは 1 回だけ", (t) => {
  const { store, propose } = setup(t);
  const row = propose()!;
  assert.equal(store.hold(row.id), false);
  store.start(row.id);
  assert.equal(store.hold(row.id), true);
  assert.equal(store.get(row.id)?.endedHeld, true);
  // running のうちは listHeld に出ず、releaseHeld も false
  assert.deepEqual(store.listHeld(), []);
  assert.equal(store.releaseHeld(row.id), false);
  assert.equal(store.get(row.id)?.endedHeld, true);
  assert.equal(store.fail(row.id, "copy_failed"), true);
  assert.equal(store.get(row.id)?.endedHeld, true);
  assert.equal(store.hold(row.id), false);
  assert.deepEqual(store.listHeld().map((held) => held.id), [row.id]);
  assert.equal(store.releaseHeld(row.id), true);
  assert.equal(store.releaseHeld(row.id), false);
  assert.deepEqual(store.listHeld(), []);
  // release の後の hold は（failed なので）false
  assert.equal(store.hold(row.id), false);
});

test("hold: release の後、新しい取り込みの running の行では hold できる", (t) => {
  const { store, propose } = setup(t);
  const first = propose()!;
  store.start(first.id);
  store.hold(first.id);
  store.fail(first.id, "copy_failed");
  assert.equal(store.releaseHeld(first.id), true);
  const second = propose()!;
  store.start(second.id);
  assert.equal(store.hold(second.id), true);
  assert.equal(store.get(first.id)?.endedHeld, false);
});

test("finish: ended_held を 0 にするので listHeld に出ない", (t) => {
  const { store, propose } = setup(t);
  const row = propose()!;
  store.start(row.id);
  store.hold(row.id);
  assert.equal(store.finish(row.id), true);
  assert.equal(store.get(row.id)?.endedHeld, false);
  assert.deepEqual(store.listHeld(), []);
  assert.equal(store.releaseHeld(row.id), false);
});

test("resetRunning: ended_held を変えないので、差し止めた行は listHeld に出る", (t) => {
  const { store, propose } = setup(t);
  const row = propose()!;
  store.start(row.id);
  store.hold(row.id);
  const reset = store.resetRunning();
  assert.equal(reset[0]?.endedHeld, true);
  assert.deepEqual(store.listHeld().map((held) => held.id), [row.id]);
});

test("SdkSessionStore.hasSessionId: どれかの key に同じ session_id があれば true", (t) => {
  const { db } = setup(t);
  const sessions = new SdkSessionStore(db, () => new Date(BASE));
  assert.equal(sessions.hasSessionId(S1), false);
  sessions.set("other-channel", S1);
  assert.equal(sessions.hasSessionId(S1), true);
  assert.equal(sessions.hasSessionId(S2), false);
  sessions.delete("other-channel");
  assert.equal(sessions.hasSessionId(S1), false);
});
