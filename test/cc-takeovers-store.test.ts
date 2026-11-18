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
      entry: "discord",
      confirmChannelId: "confirm-1",
      permissionMode: "default",
      terminalMode: "auto",
      ...overrides,
    });
  // 実行中にして行き先を書く（finish の前に要る）
  const run = (id: number, target: string) => {
    assert.equal(store.start(id), true);
    assert.equal(store.setTarget(id, target), true);
  };
  return { db, clock, store, propose, run };
}

const INSERT = "INSERT INTO cc_takeovers (session_id, source, project, guild_id, entry, confirm_channel_id, target_channel_id, state, permission_mode, created_at, updated_at)";

test("cc_takeovers: 新しい DB は最新の版で、表と索引 2 つがある", (t) => {
  const { db } = setup(t);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 45);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cc_takeovers' AND sql IS NOT NULL ORDER BY name")
    .all();
  assert.deepEqual(indexes.map((index) => index.name), ["cc_takeovers_active", "cc_takeovers_target"]);
  // CHECK: 知らない状態・モードは入らない
  assert.throws(() => db.prepare(`${INSERT} VALUES ('s', 'alive', 'p', 'g', 'discord', 'c', 't', 'done', 'auto', 'a', 'a')`).run());
  assert.throws(() => db.prepare(`${INSERT} VALUES ('s', 'alive', 'p', 'g', 'discord', 'c', NULL, 'closed', 'default', 'a', 'a')`).run());
  // CHECK: 行き先が空のまま done にはできない
  assert.throws(() => db.prepare(`${INSERT} VALUES ('s', 'alive', 'p', 'g', 'discord', 'c', NULL, 'done', 'default', 'a', 'a')`).run());
  // CHECK: 確認の投稿は確認を出したチャンネルがあるときだけ
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO cc_takeovers (session_id, source, project, guild_id, entry, confirm_message_id, state, permission_mode, created_at, updated_at) VALUES ('s', 'alive', 'p', 'g', 'web', 'm', 'awaiting_confirm', 'default', 'a', 'a')",
      )
      .run(),
  );
  // 知らない段は入らない
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO cc_takeovers (session_id, source, project, guild_id, entry, state, step, permission_mode, created_at, updated_at) VALUES ('s', 'alive', 'p', 'g', 'web', 'running', 'category', 'default', 'a', 'a')",
      )
      .run(),
  );
});

test("openDb: v44 までの DB を上げると最新の版になり、cc_takeovers ができる。channel_id・ended_held の列は無い", (t) => {
  assert.ok(MIGRATIONS.length >= 45);
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const before = 44;
  const old = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
  old.exec(`PRAGMA user_version = ${before}`);
  assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE name = 'cc_takeovers'").get(), undefined);
  old.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'cc_takeovers'").get()?.name, "cc_takeovers");
  const columns = db.prepare("PRAGMA table_info(cc_takeovers)").all().map((column) => String(column.name));
  assert.ok(columns.includes("confirm_channel_id"));
  assert.ok(columns.includes("target_channel_id"));
  assert.equal(columns.includes("channel_id"), false);
  assert.equal(columns.includes("ended_held"), false);
});

test("propose: 確認待ちの行を作る。同じ session_id に確認待ち・実行中があれば undefined、done の後は作れる", (t) => {
  const { store, propose, run } = setup(t);
  const row = propose();
  assert.ok(row);
  assert.equal(row.state, "awaiting_confirm");
  assert.equal(row.step, null);
  assert.equal(row.sessionId, S1);
  assert.equal(row.source, "alive");
  assert.equal(row.project, "alpha");
  assert.equal(row.entry, "discord");
  assert.equal(row.confirmChannelId, "confirm-1");
  assert.equal(row.targetChannelId, null);
  assert.equal(row.permissionMode, "default");
  assert.equal(row.terminalMode, "auto");
  assert.equal(row.notePending, false);
  assert.equal(row.interrupted, false);
  assert.equal(row.createdAt, new Date(BASE).toISOString());
  assert.deepEqual(store.get(row.id), row);
  assert.equal(propose(), undefined);
  // 別の session_id は作れる
  assert.ok(propose({ sessionId: S2 }));
  // 実行中でも作れない
  run(row.id, "ch-1");
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

test("propose: discord で confirmChannelId が無い・web で有る行は表の CHECK が投げる。web で無いのは作れる", (t) => {
  const { propose } = setup(t);
  assert.throws(() => propose({ confirmChannelId: undefined }));
  assert.throws(() => propose({ entry: "web" }));
  const web = propose({ entry: "web", confirmChannelId: undefined });
  assert.ok(web);
  assert.equal(web.entry, "web");
  assert.equal(web.confirmChannelId, null);
});

test("activeFor・runningFor: 確認待ちは active だけ、実行中は両方", (t) => {
  const { store, propose, run } = setup(t);
  assert.equal(store.activeFor(S1), undefined);
  const row = propose()!;
  assert.equal(store.activeFor(S1)?.id, row.id);
  assert.equal(store.runningFor(S1), undefined);
  run(row.id, "ch-1");
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
  assert.equal(store.setStep(row.id, "channel"), true);
  assert.equal(store.setTarget(row.id, "ch-1"), true);
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
  const running = propose({ sessionId: S2 })!;
  store.start(running.id);
  clock.now += 10 * 60_000;
  const fresh = propose({ sessionId: "33333333-3333-4333-8333-333333333333" })!;
  const expired = store.expire(new Date(BASE + 60_000).toISOString());
  assert.deepEqual(expired.map((row) => row.id), [old.id]);
  assert.equal(expired[0]?.state, "cancelled");
  assert.equal(store.get(old.id)?.state, "cancelled");
  assert.equal(store.get(running.id)?.state, "running");
  assert.equal(store.get(fresh.id)?.state, "awaiting_confirm");
  assert.deepEqual(store.expire(new Date(BASE + 60_000).toISOString()), []);
});

test("resetRunning: 実行中を failed（restart）にして行を返す。ほかは変えない", (t) => {
  const { store, propose, run } = setup(t);
  const a = propose()!;
  const b = propose({ sessionId: S2 })!;
  run(b.id, "ch-2");
  store.setStep(b.id, "term");
  const reset = store.resetRunning();
  assert.deepEqual(reset.map((row) => row.id), [b.id]);
  assert.equal(reset[0]?.state, "failed");
  assert.equal(reset[0]?.failure, "restart");
  assert.equal(reset[0]?.step, "term");
  // 行き先は変えない（片付けは listTargetLeft から）
  assert.equal(reset[0]?.targetChannelId, "ch-2");
  assert.equal(store.get(a.id)?.state, "awaiting_confirm");
  assert.deepEqual(store.resetRunning(), []);
});

test("takenFor・clearNote: 行き先（target_channel_id）で引き、確認を出したチャンネルでは引かない", (t) => {
  const { store, propose, run } = setup(t);
  assert.equal(store.takenFor("ch-1"), undefined);
  const first = propose()!;
  run(first.id, "ch-1");
  store.finish(first.id);
  const second = propose()!;
  run(second.id, "ch-2");
  store.finish(second.id);
  // 確認待ちのままの行は数えない
  propose();
  assert.equal(store.takenFor("ch-1")?.id, first.id);
  assert.equal(store.takenFor("ch-2")?.id, second.id);
  assert.equal(store.takenFor("confirm-1"), undefined);
  assert.equal(store.clearNote("confirm-1"), false);
  assert.equal(store.clearNote("ch-2"), true);
  assert.equal(store.get(second.id)?.notePending, false);
  assert.equal(store.get(first.id)?.notePending, true);
  assert.equal(store.clearNote("ch-2"), false);
});

test("setTarget: 実行中で行き先が空の行だけ。2 回目は false", (t) => {
  const { store, propose } = setup(t);
  const row = propose()!;
  assert.equal(store.setTarget(row.id, "ch-1"), false);
  assert.equal(store.get(row.id)?.targetChannelId, null);
  store.start(row.id);
  assert.equal(store.setTarget(row.id, "ch-1"), true);
  assert.equal(store.get(row.id)?.targetChannelId, "ch-1");
  assert.equal(store.setTarget(row.id, "ch-9"), false);
  assert.equal(store.get(row.id)?.targetChannelId, "ch-1");
  store.fail(row.id, "copy_failed");
  assert.equal(store.setTarget(row.id, "ch-9"), false);
});

test("setTarget: 同じ行き先を 2 つの行に書くと投げる", (t) => {
  const { store, propose, run } = setup(t);
  const a = propose()!;
  run(a.id, "ch-1");
  const b = propose({ sessionId: S2 })!;
  store.start(b.id);
  assert.throws(() => store.setTarget(b.id, "ch-1"));
  assert.equal(store.get(b.id)?.targetChannelId, null);
});

test("finish: 行き先が空なら false で running のまま。SQL で直接 done にすると投げる", (t) => {
  const { db, store, propose } = setup(t);
  const row = propose()!;
  store.start(row.id);
  assert.equal(store.finish(row.id), false);
  assert.equal(store.get(row.id)?.state, "running");
  assert.throws(() => db.prepare("UPDATE cc_takeovers SET state = 'done' WHERE id = ?").run(row.id));
  assert.equal(store.get(row.id)?.state, "running");
});

test("clearTarget・listTargetLeft: failed の行だけ行き先を空に戻し、残る行を古い順に返す", (t) => {
  const { store, propose, run } = setup(t);
  const a = propose()!;
  run(a.id, "ch-1");
  // 実行中は戻さない・数えない
  assert.equal(store.clearTarget(a.id), false);
  assert.deepEqual(store.listTargetLeft(), []);
  const b = propose({ sessionId: S2 })!;
  run(b.id, "ch-2");
  const c = propose({ sessionId: "33333333-3333-4333-8333-333333333333" })!;
  store.start(c.id);
  store.fail(a.id, "not_exited");
  store.fail(b.id, "copy_failed");
  // 行き先を書く前に失敗した行は数えない
  store.fail(c.id, "no_channel");
  assert.deepEqual(store.listTargetLeft().map((row) => row.id), [a.id, b.id]);
  assert.equal(store.clearTarget(a.id), true);
  assert.equal(store.get(a.id)?.targetChannelId, null);
  assert.equal(store.clearTarget(a.id), false);
  assert.equal(store.clearTarget(c.id), false);
  assert.deepEqual(store.listTargetLeft().map((row) => row.id), [b.id]);
  // done の行は戻さない
  const d = propose()!;
  run(d.id, "ch-4");
  store.finish(d.id);
  assert.equal(store.clearTarget(d.id), false);
  assert.equal(store.get(d.id)?.targetChannelId, "ch-4");
});

test("setConfirmMessage・markEffects・listEffectsPending", (t) => {
  const { store, propose, run } = setup(t);
  const a = propose()!;
  store.setConfirmMessage(a.id, "msg-1");
  assert.equal(store.get(a.id)?.confirmMessageId, "msg-1");
  assert.equal(store.markEffects(a.id), false);
  run(a.id, "ch-1");
  store.finish(a.id);
  const b = propose({ sessionId: S2 })!;
  run(b.id, "ch-2");
  store.finish(b.id);
  assert.deepEqual(store.listEffectsPending().map((row) => row.id), [a.id, b.id]);
  assert.equal(store.markEffects(a.id), true);
  assert.ok(store.get(a.id)?.effectsAt);
  assert.equal(store.markEffects(a.id), false);
  assert.deepEqual(store.listEffectsPending().map((row) => row.id), [b.id]);
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
