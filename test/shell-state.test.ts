import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { SandboxCheckResult } from "../src/agent/sandbox-check.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { Scheduler } from "../src/app/scheduler.ts";
import { SHELL_CHECK_ERROR_ITEM, SHELL_RESUMED_NOTICE, ShellState, shellDisabledNotice, shellRefresher } from "../src/app/shell-state.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";

const OK: SandboxCheckResult = { ok: true };
const NG: SandboxCheckResult = { ok: false, failed: ["bwrap が見つからない", "socat が見つからない"] };
const NG_OTHER: SandboxCheckResult = { ok: false, failed: ["作業ディレクトリが別のファイルシステムでない"] };
/** NG と同じ項目の集合（順序だけ違う） */
const NG_REORDERED: SandboxCheckResult = { ok: false, failed: ["socat が見つからない", "bwrap が見つからない"] };
const LOG_OK = "シェルの自己診断が通りました";
const LOG_NG = "シェルの自己診断が通りません（bwrap が見つからない、socat が見つからない）";
const LOG_NG_OTHER = "シェルの自己診断が通りません（作業ディレクトリが別のファイルシステムでない）";

/** guild-1・guild-2 は /setup 済み（#system あり）、guild-3 は #system なし */
function setup(t: TestContext, noticeTimeoutMs?: number) {
  const db = tempDb(t);
  const { guildSettings } = createStores(db, () => new Date("2026-10-13T00:00:00.000Z"));
  guildSettings.setChannel("guild-1", "systemChannelId", "system-1");
  guildSettings.setChannel("guild-2", "systemChannelId", "system-2");
  guildSettings.setChannel("guild-3", "inboxChannelId", "inbox-3");
  const gateway = new FakeGateway({ allow: ["sendMessage"] });
  const logs: string[] = [];
  const results: Array<SandboxCheckResult | Error> = [];
  let checks = 0;
  const state = new ShellState({
    cfg: { allowedGuildIds: ["guild-1", "guild-2", "guild-3", "guild-4"] },
    check: async () => {
      checks++;
      const next = results.shift();
      if (next === undefined) throw new Error("想定外の診断");
      if (next instanceof Error) throw next;
      return next;
    },
    guildSettings,
    gateway,
    log: (line) => logs.push(line),
    noticeTimeoutMs,
  });
  /** 送れた #system への投稿（チャンネルと本文） */
  const posts = (): Array<[string, string]> => gateway.posts.map(({ channelId, message }) => [channelId, message.text]);
  return { db, guildSettings, gateway, logs, results, state, posts, checks: () => checks };
}

test("ShellState: 診断前は無効。結果に合わせて enabled が変わる", async (t) => {
  const env = setup(t);
  assert.equal(env.state.enabled(), false);
  env.results.push(OK, NG, OK);
  await env.state.refresh();
  assert.equal(env.state.enabled(), true);
  await env.state.refresh();
  assert.equal(env.state.enabled(), false);
  await env.state.refresh();
  assert.equal(env.state.enabled(), true);
});

test("ShellState: log は結果（通る・通らない、通らない項目の集合）が変わったときだけ。#system は通る・通らないが変わったときだけで、最初の診断は通らないときだけ", async (t) => {
  const disabled = shellDisabledNotice(NG.ok ? [] : NG.failed);
  assert.equal(disabled, "シェル（Bash）を使えない状態です: bwrap が見つからない、socat が見つからない");
  assert.equal(SHELL_RESUMED_NOTICE, "シェル（Bash）の自己診断が通りました");
  const toSystem = (text: string): Array<[string, string]> => [
    ["system-1", text],
    ["system-2", text],
  ];
  const cases: Array<{ name: string; sequence: SandboxCheckResult[]; logs: string[]; posts: Array<[string, string]> }> = [
    { name: "最初から通る", sequence: [OK, OK], logs: [LOG_OK], posts: [] },
    { name: "最初から通らず、同じ項目のまま（順序だけ違っても同じ）", sequence: [NG, NG, NG_REORDERED], logs: [LOG_NG], posts: toSystem(disabled) },
    {
      name: "通らないまま項目が変わる（log だけ）",
      sequence: [NG, NG_OTHER, NG_OTHER, NG],
      logs: [LOG_NG, LOG_NG_OTHER, LOG_NG],
      posts: toSystem(disabled),
    },
    {
      name: "通る → 通らない → 通る",
      sequence: [OK, NG, NG, OK, OK],
      logs: [LOG_OK, LOG_NG, LOG_OK],
      posts: [...toSystem(disabled), ...toSystem(SHELL_RESUMED_NOTICE)],
    },
    {
      name: "通らない → 通る",
      sequence: [NG, OK],
      logs: [LOG_NG, LOG_OK],
      posts: [...toSystem(disabled), ...toSystem(SHELL_RESUMED_NOTICE)],
    },
  ];
  for (const { name, sequence, logs, posts } of cases) {
    const env = setup(t);
    env.results.push(...sequence);
    for (let i = 0; i < sequence.length; i++) await env.state.refresh();
    assert.deepEqual(env.logs, logs, name);
    assert.deepEqual(env.posts(), posts, name);
  }
});

test("ShellState: 起動時の check（知らせない）の後、最初の refresh で使えなければ 1 回だけ知らせる", async (t) => {
  const env = setup(t);
  env.results.push(NG, NG, NG);
  await env.state.check();
  assert.deepEqual(env.posts(), []);
  assert.equal(env.logs.length, 1);
  await env.state.refresh();
  await env.state.refresh();
  assert.equal(env.posts().length, 2);
  assert.equal(env.logs.length, 1);
});

test("ShellState: 診断が例外なら無効（自己診断に失敗した）にする", async (t) => {
  const env = setup(t);
  env.results.push(OK, new Error("boom"));
  await env.state.refresh();
  await env.state.refresh();
  assert.equal(env.state.enabled(), false);
  assert.deepEqual(env.logs, [LOG_OK, `シェルの自己診断が通りません（${SHELL_CHECK_ERROR_ITEM}）`]);
  assert.deepEqual(env.posts().map(([channelId]) => channelId), ["system-1", "system-2"]);
});

test("ShellState: 投稿に失敗したサーバーだけ、状態が変わらなければ次の tick でやり直す。投稿できたサーバーには重ねて投稿しない", async (t) => {
  const env = setup(t);
  let failures = 1;
  env.gateway.beforeSendMessage = (channelId) => {
    if (channelId === "system-1" && failures-- > 0) throw new Error("Missing Access");
  };
  env.results.push(NG, NG, NG);
  await env.state.refresh();
  assert.deepEqual(env.posts().map(([channelId]) => channelId), ["system-2"]);
  await env.state.refresh();
  await env.state.refresh();
  assert.deepEqual(env.posts().map(([channelId]) => channelId), ["system-2", "system-1"]);
  assert.deepEqual(env.logs, [LOG_NG, "シェルの状態の知らせの投稿に失敗しました（guild=guild-1）: Missing Access"]);
});

test("ShellState: #system が無いサーバーは、状態が変わらないうちに /setup されたら次の tick で知らせる", async (t) => {
  const env = setup(t);
  env.results.push(NG, NG, NG);
  await env.state.refresh();
  assert.deepEqual(env.posts().map(([channelId]) => channelId), ["system-1", "system-2"]);
  env.guildSettings.setChannel("guild-3", "systemChannelId", "system-3");
  await env.state.refresh();
  await env.state.refresh();
  assert.deepEqual(env.posts().map(([channelId]) => channelId), ["system-1", "system-2", "system-3"]);
  assert.deepEqual(env.logs, [LOG_NG]);
});

test("ShellState: 止まった投稿は noticeTimeoutMs で失敗として扱い、tick を止めずに残りのサーバーへ進み、次の tick でやり直す", async (t) => {
  const env = setup(t, 20);
  let hang = true;
  env.gateway.beforeSendMessage = (channelId) => {
    if (channelId === "system-1" && hang) return new Promise<void>(() => {});
  };
  env.results.push(NG, NG);
  const started = Date.now();
  await env.state.refresh();
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(env.posts().map(([channelId]) => channelId), ["system-2"]);
  assert.deepEqual(env.logs, [LOG_NG, "シェルの状態の知らせの投稿に失敗しました（guild=guild-1）: 20 ms で終わりませんでした"]);
  hang = false;
  await env.state.refresh();
  assert.deepEqual(env.posts().map(([channelId]) => channelId), ["system-2", "system-1"]);
});

test("ShellState: 通る・通らないが変わったら、やり直し待ちも含めて全サーバーを知らせる対象に戻す", async (t) => {
  const env = setup(t);
  let failing = true;
  env.gateway.beforeSendMessage = (channelId) => {
    if (channelId === "system-1" && failing) throw new Error("Missing Access");
  };
  env.results.push(NG, OK, OK, NG);
  await env.state.refresh();
  failing = false;
  await env.state.refresh();
  await env.state.refresh();
  await env.state.refresh();
  const disabled = shellDisabledNotice(NG.ok ? [] : NG.failed);
  assert.deepEqual(env.posts(), [
    ["system-2", disabled],
    ["system-1", SHELL_RESUMED_NOTICE],
    ["system-2", SHELL_RESUMED_NOTICE],
    ["system-1", disabled],
    ["system-2", disabled],
  ]);
});

/** scheduler の最低限の依存（他の処理は対象が無い） */
function scheduler(
  t: TestContext,
  refreshShell: (() => Promise<void>) | undefined,
  logs: string[],
  rotateDue: () => Promise<void> = async () => {},
) {
  const db = tempDb(t);
  const stores = createStores(db, () => new Date("2026-10-13T00:00:00.000Z"));
  return new Scheduler({
    cfg: { allowedGuildIds: [], idleHours: 12, deleteAfterDays: 30 },
    topicSessions: stores.topicSessions,
    guildSettings: stores.guildSettings,
    sessions: stores.sessions,
    seeds: stores.seeds,
    channelOps: new RecordingChannelOps(),
    gateway: new FakeGateway({ allow: ["sendMessage", "listChannelParents", "isInGuild"] }),
    inboxRotator: { rotateDue },
    pruneDevLogs: () => {},
    pruneProjectTrash: async () => {},
    refreshShell,
    pruneWorkDir: async () => {},
    turnQueue: new KeyedSerialQueue(2),
    now: () => new Date("2026-10-13T00:00:00.000Z"),
    log: (line) => logs.push(line),
  });
}

test("shellRefresher: SELF_AGENT_SHELL=1 なら tick ごとに診断し直す関数を返し、無効なら undefined（tick は診断も log も投稿もしない）", async (t) => {
  for (const shell of [true, false]) {
    const label = `shell=${shell}`;
    const env = setup(t);
    env.results.push(NG, NG);
    const refreshShell = shellRefresher({ shell }, env.state);
    assert.equal(refreshShell === undefined, !shell, label);
    const logs: string[] = [];
    const ticking = scheduler(t, refreshShell, logs);
    await ticking.tick();
    await ticking.tick();
    assert.equal(env.checks(), shell ? 2 : 0, label);
    assert.deepEqual(env.logs, shell ? [LOG_NG] : [], label);
    assert.equal(env.posts().length, shell ? 2 : 0, label);
    assert.equal(env.state.enabled(), false, label);
    assert.deepEqual(logs, [], label);
  }
});

test("tick: refreshShell が投げても log に出して残りを続ける", async (t) => {
  const logs: string[] = [];
  let rotated = 0;
  const failing = scheduler(
    t,
    async () => {
      throw new Error("boom");
    },
    logs,
    async () => void rotated++,
  );
  await failing.tick();
  assert.deepEqual(logs, ["シェルの自己診断に失敗しました: boom"]);
  // 最後の処理（#inbox・#tasks の切り替え）まで進んでいる
  assert.equal(rotated, 1);
});
