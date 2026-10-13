import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { SandboxCheckResult } from "../src/agent/sandbox-check.ts";
import { Scheduler } from "../src/app/scheduler.ts";
import { SHELL_CHECK_ERROR_ITEM, SHELL_RESUMED_NOTICE, ShellState, shellDisabledNotice } from "../src/app/shell-state.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";

const OK: SandboxCheckResult = { ok: true };
const NG: SandboxCheckResult = { ok: false, failed: ["bwrap が見つからない", "socat が見つからない"] };
const NG_OTHER: SandboxCheckResult = { ok: false, failed: ["作業ディレクトリが別のファイルシステムでない"] };

/** guild-1・guild-2 は /setup 済み（#system あり）、guild-3 は #system なし */
function setup(t: TestContext) {
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

test("ShellState: log と #system の知らせは状態が変わったときだけ。最初の診断は log に出し、知らせは使えないときだけ", async (t) => {
  const disabled = shellDisabledNotice(NG.ok ? [] : NG.failed);
  assert.equal(disabled, "シェル（Bash）を止めています: bwrap が見つからない、socat が見つからない");
  const toSystem = (text: string): Array<[string, string]> => [
    ["system-1", text],
    ["system-2", text],
  ];
  const cases: Array<{ name: string; sequence: SandboxCheckResult[]; logs: string[]; posts: Array<[string, string]> }> = [
    { name: "最初から有効", sequence: [OK, OK], logs: ["Bash を有効にしました"], posts: [] },
    {
      name: "最初から無効（項目が変わっても無効のままなら出さない）",
      sequence: [NG, NG, NG_OTHER],
      logs: ["Bash を無効にしました（bwrap が見つからない、socat が見つからない）"],
      posts: toSystem(disabled),
    },
    {
      name: "有効 → 無効 → 有効",
      sequence: [OK, NG, NG, OK, OK],
      logs: ["Bash を有効にしました", "Bash を無効にしました（bwrap が見つからない、socat が見つからない）", "Bash を有効にしました"],
      posts: [...toSystem(disabled), ...toSystem(SHELL_RESUMED_NOTICE)],
    },
    {
      name: "無効 → 有効",
      sequence: [NG, OK],
      logs: ["Bash を無効にしました（bwrap が見つからない、socat が見つからない）", "Bash を有効にしました"],
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
  assert.deepEqual(env.logs, ["Bash を有効にしました", `Bash を無効にしました（${SHELL_CHECK_ERROR_ITEM}）`]);
  assert.deepEqual(env.posts().map(([channelId]) => channelId), ["system-1", "system-2"]);
});

test("ShellState: 投稿の失敗は log だけで、残りのサーバーには投稿し、やり直さない", async (t) => {
  const env = setup(t);
  env.gateway.beforeSendMessage = (channelId) => {
    if (channelId === "system-1") throw new Error("Missing Access");
  };
  env.results.push(NG, NG);
  await env.state.refresh();
  await env.state.refresh();
  assert.deepEqual(env.posts().map(([channelId]) => channelId), ["system-2"]);
  assert.deepEqual(env.logs.slice(1), ["シェルの状態の知らせの投稿に失敗しました（guild=guild-1）: Missing Access"]);
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
    pruneProjectTrash: () => {},
    refreshShell,
    now: () => new Date("2026-10-13T00:00:00.000Z"),
    log: (line) => logs.push(line),
  });
}

test("tick: SELF_AGENT_SHELL=1（refreshShell あり）なら tick ごとに診断し直す。無ければ診断も log も投稿もしない", async (t) => {
  const env = setup(t);
  env.results.push(NG, NG);
  const logs: string[] = [];
  const enabled = scheduler(t, () => env.state.refresh(), logs);
  await enabled.tick();
  await enabled.tick();
  assert.equal(env.checks(), 2);
  assert.equal(env.posts().length, 2);

  const off = setup(t);
  const offLogs: string[] = [];
  const disabled = scheduler(t, undefined, offLogs);
  await disabled.tick();
  assert.equal(off.checks(), 0);
  assert.deepEqual(off.logs, []);
  assert.deepEqual(off.posts(), []);
  assert.deepEqual(offLogs, []);
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
