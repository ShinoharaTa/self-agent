// app/session-mode.ts（プロジェクトのセッションの許可のモードを見る・変える）。一時 SQLite の本物のストアで見る
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import {
  MODE_PLAN_APPROVED_TEXT,
  modeChangedText,
  type SessionModeDeps,
  sessionModeOf,
  setSessionMode,
} from "../src/app/session-mode.ts";
import { TopicMoveStore } from "../src/store/topic-moves.ts";
import { createStores, tempDb } from "./helpers/db.ts";

const NOW = new Date("2026-11-20T01:00:00Z");
const GUILD = "guild-1";
const TITLE = "秘密の題名";
const PROJECT = "secret-project";
const CHANNEL = "11111111111111111";

/** プロジェクトのセッション CHANNEL（default）、軽いセッション light-1、閉じたプロジェクトのセッション done-1 */
function setup(t: TestContext) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { topicSessions, history } = stores;
  const moves = new TopicMoveStore(db, () => NOW);
  const turnQueue = new KeyedSerialQueue(2);
  const running: Array<{ channelId: string }> = [];
  const logs: string[] = [];
  const deps: SessionModeDeps = {
    topicSessions,
    runningTurns: () => running,
    turnQueue,
    moves,
    history,
    log: (line) => void logs.push(line),
  };
  topicSessions.create({ channelId: CHANNEL, guildId: GUILD, title: TITLE, categoryId: "active-1", projectDir: PROJECT });
  topicSessions.create({ channelId: "light-1", guildId: GUILD, title: "軽い話", categoryId: "active-1" });
  topicSessions.create({ channelId: "done-1", guildId: GUILD, title: "終わった話", categoryId: "active-1", projectDir: PROJECT });
  topicSessions.close("done-1", "要約");
  const modeOf = (channelId: string) => topicSessions.projectDirOf(channelId)?.permissionMode;
  const historyOf = (channelId: string) => history.list(channelId, { limit: 50 });
  return { deps, running, turnQueue, moves, logs, modeOf, historyOf };
}

/** その key のキューを、返す関数を呼ぶまで塞ぐ（枠待ち・前のジョブ待ちの発言の形） */
function block(queue: KeyedSerialQueue, key: string): () => Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const done = queue.run(key, () => gate);
  return async () => {
    release();
    await done;
  };
}

test("★ ターンが実行中のチャンネルは busy で、DB も history も変わらない", (t) => {
  const env = setup(t);
  env.running.push({ channelId: CHANNEL });
  const outcome = setSessionMode({ guildId: GUILD, channelId: CHANNEL, mode: "plan", by: "discord" }, env.deps);
  assert.equal(outcome.result, "busy");
  assert.equal(env.modeOf(CHANNEL), "default");
  assert.equal(env.historyOf(CHANNEL).length, 0);
  // Web からも同じ
  assert.equal(setSessionMode({ guildId: GUILD, channelId: CHANNEL, mode: "acceptEdits", by: "web" }, env.deps).result, "busy");
  assert.equal(env.modeOf(CHANNEL), "default");
});

test("★ 枠待ちの発言が在るチャンネルは busy", { timeout: 5000 }, async (t) => {
  const env = setup(t);
  const release = block(env.turnQueue, CHANNEL);
  assert.equal(setSessionMode({ guildId: GUILD, channelId: CHANNEL, mode: "plan", by: "web" }, env.deps).result, "busy");
  assert.equal(env.modeOf(CHANNEL), "default");
  assert.equal(env.historyOf(CHANNEL).length, 0);
  await release();
});

test("★ 場所の付け替え中のチャンネルは busy", (t) => {
  const env = setup(t);
  assert.notEqual(env.moves.start({ channelId: CHANNEL, fromDir: PROJECT, toDir: "other", by: "web" }), undefined);
  assert.equal(setSessionMode({ guildId: GUILD, channelId: CHANNEL, mode: "plan", by: "discord" }, env.deps).result, "busy");
  assert.equal(env.modeOf(CHANNEL), "default");
  assert.equal(env.historyOf(CHANNEL).length, 0);
});

test("★ 軽いセッションは not_project、#inbox のチャンネルは not_session、閉じたセッションは closed", (t) => {
  const env = setup(t);
  const set = (channelId: string, guildId = GUILD) =>
    setSessionMode({ guildId, channelId, mode: "plan", by: "discord" }, env.deps).result;
  assert.equal(set("light-1"), "not_project");
  assert.equal(set("inbox-1"), "not_session");
  assert.equal(set("done-1"), "closed");
  // 別のサーバーのチャンネルとしては見ない
  assert.equal(set(CHANNEL, "guild-9"), "not_session");
  assert.equal(env.modeOf("done-1"), "default");
  assert.equal(env.modeOf(CHANNEL), "default");
  for (const channelId of ["light-1", "inbox-1", "done-1", CHANNEL]) assert.equal(env.historyOf(channelId).length, 0, channelId);
  // 今のモードを見る口も同じ順で断る
  assert.deepEqual(sessionModeOf(GUILD, "light-1", env.deps), { result: "not_project" });
  assert.deepEqual(sessionModeOf(GUILD, "inbox-1", env.deps), { result: "not_session" });
  assert.deepEqual(sessionModeOf(GUILD, "done-1", env.deps), { result: "closed" });
  assert.deepEqual(sessionModeOf(GUILD, CHANNEL, env.deps), { result: "ok", mode: "default" });
});

test("同じモードは unchanged で、history に書かない", (t) => {
  const env = setup(t);
  assert.deepEqual(setSessionMode({ guildId: GUILD, channelId: CHANNEL, mode: "default", by: "web" }, env.deps), {
    result: "unchanged",
    mode: "default",
  });
  assert.equal(env.historyOf(CHANNEL).length, 0);
  assert.deepEqual(env.logs, []);
});

test("変えると sessions.permission_mode が変わり、history に notice が 1 行", (t) => {
  const env = setup(t);
  assert.deepEqual(setSessionMode({ guildId: GUILD, channelId: CHANNEL, mode: "acceptEdits", by: "discord" }, env.deps), {
    result: "changed",
    mode: "acceptEdits",
  });
  assert.equal(env.modeOf(CHANNEL), "acceptEdits");
  const rows = env.historyOf(CHANNEL);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "notice");
  assert.equal(rows[0]!.source, "system");
  assert.equal(rows[0]!.persona, "default");
  assert.equal(rows[0]!.text, modeChangedText("acceptEdits"));
  assert.deepEqual(env.logs, [`許可のモードを変えました（guild=${GUILD}、discord、acceptEdits）`]);
});

test("by plan は実行中でも変える", (t) => {
  const env = setup(t);
  assert.equal(setSessionMode({ guildId: GUILD, channelId: CHANNEL, mode: "plan", by: "discord" }, env.deps).result, "changed");
  env.running.push({ channelId: CHANNEL });
  const release = block(env.turnQueue, CHANNEL);
  assert.equal(setSessionMode({ guildId: GUILD, channelId: CHANNEL, mode: "default", by: "plan" }, env.deps).result, "changed");
  assert.equal(env.modeOf(CHANNEL), "default");
  assert.equal(env.historyOf(CHANNEL).at(-1)?.text, MODE_PLAN_APPROVED_TEXT);
  return release();
});

test("★ log にチャンネル ID・題名・プロジェクトの名前が出ない", (t) => {
  const env = setup(t);
  setSessionMode({ guildId: GUILD, channelId: CHANNEL, mode: "plan", by: "web" }, env.deps);
  setSessionMode({ guildId: GUILD, channelId: CHANNEL, mode: "default", by: "plan" }, env.deps);
  assert.equal(env.logs.length, 2);
  for (const line of env.logs) {
    for (const secret of [CHANNEL, TITLE, PROJECT]) assert.ok(!line.includes(secret), line);
  }
});
