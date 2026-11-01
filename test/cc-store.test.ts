import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupBeforeMigration, backupPath, MIGRATIONS, openDb } from "../src/store/db.ts";
import { CC_PROMPT_MAX_CHARS, CcSessionStore } from "../src/store/cc-sessions.ts";
import { NoticeStore } from "../src/store/notices.ts";
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
  const store = new CcSessionStore(db, () => clock.now);
  return { db, clock, store };
}

test("openDb: v26 の DB を v27 に上げても既存のデータは残り、cc_sessions は空・cc_state は 1 行（multiline_ok = 1）", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const v26 = new DatabaseSync(path);
  v26.exec("PRAGMA journal_mode=WAL");
  for (const migration of MIGRATIONS.slice(0, 26)) v26.exec(migration);
  v26.exec("PRAGMA user_version = 26");
  new NoticeStore(v26, () => at(0)).add({ guildId: "g", level: "info", text: "残る" });
  v26.close();

  await backupBeforeMigration(path, () => {});
  assert.ok(existsSync(backupPath(path, 26)));
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 27);
  assert.deepEqual(new NoticeStore(db).listRecent(10).map((row) => row.text), ["残る"]);
  assert.deepEqual(new CcSessionStore(db).listAlive(), []);
  assert.deepEqual(
    db.prepare("SELECT id, multiline_ok FROM cc_state").all().map((row) => ({ ...row })),
    [{ id: 1, multiline_ok: 1 }],
  );
  assert.throws(() => db.prepare("INSERT INTO cc_state (id) VALUES (2)").run());
});

test("CcSessionStore.upsertSeen・markGone: 見たセッションを書き、一覧から消えたら gone_at、また現れたら外す", (t) => {
  const { clock, store } = setup(t);
  store.upsertSeen([
    { sessionId: S1, cwd: "/w/a", name: "a", pid: 10 },
    { sessionId: S2, cwd: null, name: null, pid: 20 },
  ]);
  clock.now = at(10);
  store.upsertSeen([{ sessionId: S1, cwd: "/w/a2", name: "a2", pid: 11 }]);
  assert.equal(store.markGone([S1]), 1);
  assert.equal(store.markGone([S1]), 0);
  const first = store.get(S1)!;
  assert.equal(first.firstSeenAt, at(0).toISOString());
  assert.equal(first.lastSeenAt, at(10).toISOString());
  assert.equal(first.cwd, "/w/a2");
  assert.equal(first.pid, 11);
  assert.equal(store.get(S2)?.goneAt, at(10).toISOString());
  assert.deepEqual(store.listAlive().map((row) => row.sessionId), [S1]);
  // また現れたら gone_at を外す
  clock.now = at(20);
  store.upsertSeen([{ sessionId: S2, cwd: null, name: null, pid: 21 }]);
  assert.equal(store.get(S2)?.goneAt, null);
});

test("CcSessionStore.applyEvent: UserPromptSubmit は最後の指示（本文は先頭 200 字）、Notification は判断待ち（始まりは進めない）、Stop で外す", (t) => {
  const { store } = setup(t);
  assert.equal(store.applyEvent(S1, { event: "Stop" }, at(1)), false);
  store.upsertSeen([{ sessionId: S1, cwd: "/w/a", name: "a", pid: 10 }]);
  const long = "あ".repeat(CC_PROMPT_MAX_CHARS + 50);
  assert.equal(store.applyEvent(S1, { event: "UserPromptSubmit", promptText: long, permissionMode: "auto" }, at(5)), true);
  let row = store.get(S1)!;
  assert.equal(row.lastPromptAt, at(5).toISOString());
  assert.equal(row.lastPromptText, "あ".repeat(CC_PROMPT_MAX_CHARS));
  assert.equal(row.permissionMode, "auto");
  assert.equal(row.lastEvent, "UserPromptSubmit");

  store.applyEvent(S1, { event: "Notification", waitingKind: "permission_prompt" }, at(8));
  store.applyEvent(S1, { event: "Notification", waitingKind: "agent_needs_input" }, at(9));
  row = store.get(S1)!;
  assert.equal(row.waitingKind, "agent_needs_input");
  assert.equal(row.waitingSince, at(8).toISOString());
  // 判断待ちにしない Notification は last_event だけ
  store.applyEvent(S1, { event: "Notification" }, at(10));
  assert.equal(store.get(S1)?.waitingKind, "agent_needs_input");
  assert.equal(store.get(S1)?.permissionMode, "auto");

  store.applyEvent(S1, { event: "Stop" }, at(12));
  row = store.get(S1)!;
  assert.equal(row.waitingKind, null);
  assert.equal(row.waitingSince, null);
  assert.equal(row.lastEvent, "Stop");
  assert.equal(row.lastEventAt, at(12).toISOString());
  // 最後の指示は Stop では変わらない
  assert.equal(row.lastPromptAt, at(5).toISOString());
});

test("CcSessionStore.prune: gone_at が cutoff より前の行だけ消す（生きている行は消さない）", (t) => {
  const { clock, store } = setup(t);
  store.upsertSeen([
    { sessionId: S1, cwd: null, name: null, pid: 1 },
    { sessionId: S2, cwd: null, name: null, pid: 2 },
  ]);
  clock.now = at(100);
  store.markGone([S1]);
  assert.equal(store.prune(at(100)), 0);
  assert.equal(store.prune(at(101)), 1);
  assert.equal(store.get(S1)?.goneAt, null);
  assert.equal(store.get(S2), undefined);
});

test("CcSessionStore.multilineOk: cc_state の multiline_ok（既定 1 で true、0 で false）", (t) => {
  const { db, store } = setup(t);
  assert.equal(store.multilineOk(), true);
  db.exec("UPDATE cc_state SET multiline_ok = 0");
  assert.equal(store.multilineOk(), false);
});

test("openDb: v28 の DB を v29 に上げても cc_sessions の行は残り、started_by は owner・起動の列と waiting_for は NULL。started_by の語は CHECK", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const v28 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 28)) v28.exec(migration);
  v28.exec("PRAGMA user_version = 28");
  v28
    .prepare("INSERT INTO cc_sessions (session_id, cwd, name, pid, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(S1, "/w/a", "a", 10, at(0).toISOString(), at(0).toISOString());
  v28.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.ok(MIGRATIONS.length >= 29);
  const row = new CcSessionStore(db).get(S1)!;
  assert.deepEqual(
    [row.startedBy, row.tmuxSession, row.tmuxSessionId, row.startPaneId, row.trustPendingAt, row.waitingFor],
    ["owner", null, null, null, null, null],
  );
  assert.throws(() => db.prepare("UPDATE cc_sessions SET started_by = 'other' WHERE session_id = ?").run(S1));
});

test("CcSessionStore: upsertSeen は waitingFor を書き（無ければ NULL）、recordStart は 1 回だけ、trust の確認待ちを書いて外す", (t) => {
  const { clock, store } = setup(t);
  store.upsertSeen([{ sessionId: S1, cwd: "/w/a", name: "a", pid: 10, waitingFor: "permission prompt" }, { sessionId: S2, cwd: null, name: null, pid: 20 }]);
  assert.equal(store.get(S1)!.waitingFor, "permission prompt");
  assert.equal(store.get(S2)!.waitingFor, null);
  store.upsertSeen([{ sessionId: S1, cwd: "/w/a", name: "a", pid: 10, waitingFor: null }]);
  assert.equal(store.get(S1)!.waitingFor, null);

  const record = { startedBy: "web" as const, tmuxSession: "alpha", tmuxSessionId: "$3", paneId: "%4", trustPendingAt: at(5) };
  assert.equal(store.recordStart(S1, record), true);
  assert.equal(store.recordStart(S1, { ...record, startedBy: "tool", paneId: "%5" }), false);
  const row = store.get(S1)!;
  assert.deepEqual(
    [row.startedBy, row.tmuxSession, row.tmuxSessionId, row.startPaneId, row.trustPendingAt],
    ["web", "alpha", "$3", "%4", at(5).toISOString()],
  );
  assert.equal(store.recordStart("33333333-3333-4333-8333-333333333333", record), false);
  assert.deepEqual(store.listTrustPending().map((r) => r.sessionId), [S1]);
  clock.now = at(10);
  assert.equal(store.setTrustPending(S1, null), true);
  assert.deepEqual(store.listTrustPending(), []);
  // 一覧から消えたものは確かめ直さない
  store.setTrustPending(S2, at(11));
  store.markGone([S1]);
  assert.deepEqual(store.listTrustPending(), []);
});
