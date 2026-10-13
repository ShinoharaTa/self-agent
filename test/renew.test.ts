import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunner, RunResult } from "../src/agent/runner.ts";
import { ALREADY_CLOSED_REPLY } from "../src/app/commands/close.ts";
import {
  createRenewCommand,
  NO_CONVERSATION_REPLY,
  NOT_RENEWABLE_REPLY,
  NOT_SET_UP_REPLY,
  RENEW_FAILURE_REPLY,
  RENEWED_FRESH_REPLY,
  renewedText,
} from "../src/app/commands/renew.ts";
import { ROTATED_NOTICE, ROTATED_NOTICE_FRESH, type RotateNowResult } from "../src/app/inbox-rotate.ts";
import { RENEW_PROMPT, renewedSeed } from "../src/app/session-renew.ts";
import { EMPTY_SUMMARY } from "../src/app/summary.ts";
import { MEMORY_BLOCK_HEADER, RESUME_SEED_HEADER, resumeSeed, runChannelTurn, type TurnDeps } from "../src/app/turn.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import type { SummaryChannelKind } from "../src/store/inbox-summaries.ts";
import { RENEW_SUMMARY_MAX_LENGTH } from "../src/store/topic-sessions.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { RecordingQueue } from "./helpers/recording.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

const NOW = new Date("2026-10-11T00:12:00Z");
const RENEWED_AT = new Date("2026-10-11T00:15:00Z");
const PROMPT = "[2026-10-11(日) 09:20 JST #旅行の計画]\n続きをお願い";

/** #inbox・#tasks の /renew で呼ばれた切り替えを記録し、決めた結果を返す */
class FakeRotator {
  calls: Array<{ guildId: string; kind: SummaryChannelKind }> = [];
  result: RotateNowResult = "rotated";

  async rotateNow(guildId: string, kind: SummaryChannelKind): Promise<RotateNowResult> {
    this.calls.push({ guildId, kind });
    return this.result;
  }
}

function ok(text: string, sessionId: string = "session-1"): RunResult {
  return {
    ok: true,
    text,
    sessionId,
    usage: turnUsage(10, 2000, 300),
    durationMs: 4200,
    toolCalls: 0,
    contextTokens: 2310,
  };
}

/** resume 先の会話の記録が SDK 側に無いときの失敗 */
const RESUME_FAILURE: RunResult = {
  ok: false,
  errorMessage: "error_during_execution: No conversation found with session ID: session-1",
  sessionRecorded: false,
  toolCalls: 0,
};

/** result まで届いた失敗（SDK は会話を記録済み） */
const FAILED: RunResult = {
  ok: false,
  errorMessage: "error_during_execution: boom",
  sessionId: "session-1",
  sessionRecorded: true,
  toolCalls: 0,
};

const SUMMARY = "- 目的: 京都旅行の計画\n- 宿は候補を 2 つに絞った\n- やり残し: 新幹線の時刻";

const BASE = { guildId: "guild-1", channelId: "topic-1", userId: "owner-1", createdAt: NOW };
const RENEW: Extract<Interaction, { kind: "command" }> = { ...BASE, kind: "command", name: "renew", options: {} };

const TOPIC = { channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" };

function setup(t: TestContext, results: RunResult[] = []) {
  const db = tempDb(t);
  const clock = { now: NOW };
  const now = (): Date => clock.now;
  const { topicSessions, guildSettings, sessions, seeds, memories, usage, inboxSummaries } = createStores(db, now);
  const runner = new FakeRunner(results);
  const turnQueue = new RecordingQueue(2);
  const inboxRotator = new FakeRotator();
  const logs: string[] = [];
  // ターンのトークンの行（recordTurnUsage）は tokenLogs に分ける
  const tokenLogs: string[] = [];
  const log = (line: string): number => (line.startsWith("トークン（") ? tokenLogs : logs).push(line);
  const turn: TurnDeps = {
    runner,
    sessions,
    seeds,
    topicSessions,
    inboxSummaries,
    memories,
    usage,
    log,
  };
  const command = createRenewCommand({ guildSettings, topicSessions, turnQueue, turn, inboxRotator, log });
  // guild-1 は /setup 済み（#inbox は inbox-1、#tasks は tasks-1）
  guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  guildSettings.setChannel("guild-1", "tasksChannelId", "tasks-1");
  topicSessions.create(TOPIC);
  sessions.set("topic-1", "session-1");

  const runRenew = async (interaction: Extract<Interaction, { kind: "command" }> = RENEW): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await command.handle(interaction, responder);
    return responder.calls;
  };
  /** topic-1 の会話まわりの状態 */
  const state = () => {
    const session = topicSessions.get("topic-1");
    return {
      sdkSession: sessions.get("topic-1"),
      seed: seeds.get("topic-1"),
      renewedSummary: session?.renewedSummary ?? null,
      renewedAt: session?.renewedAt ?? null,
    };
  };
  return { db, clock, runner, topicSessions, guildSettings, sessions, seeds, memories, usage, turnQueue, inboxRotator, logs, tokenLogs, turn, runRenew, state };
}

test("/renew: セッションでも #inbox・#tasks でもないチャンネルと、閉じたセッション（done・deleted）では ephemeral で断り、何もしない", async (t) => {
  const env = setup(t);
  env.topicSessions.create({ ...TOPIC, channelId: "topic-9", guildId: "guild-9" });
  const notRenewable = [{ method: "reply", message: { text: NOT_RENEWABLE_REPLY, ephemeral: true } }];
  const closed = [{ method: "reply", message: { text: ALREADY_CLOSED_REPLY, ephemeral: true } }];
  // guild-2 は /setup 前（env の #inbox で受け付けているサーバー）。DB に #inbox が無いので対象外
  const others: Array<[string, Extract<Interaction, { kind: "command" }>]> = [
    ["/setup 前の env の #inbox", { ...RENEW, guildId: "guild-2", channelId: "env-inbox-1" }],
    ["知らないチャンネル", { ...RENEW, channelId: "unknown-1" }],
    ["別サーバーのセッション", { ...RENEW, channelId: "topic-9" }],
    ["別サーバーの同じ ID の #inbox", { ...RENEW, guildId: "guild-2", channelId: "inbox-1" }],
    ["チャンネル無し", { ...RENEW, channelId: null }],
  ];

  for (const [label, interaction] of others) {
    assert.deepEqual(await env.runRenew(interaction), notRenewable, label);
  }
  for (const state of ["done", "deleted"]) {
    env.db.prepare("UPDATE sessions SET state = ? WHERE channel_id = 'topic-1'").run(state);
    assert.deepEqual(await env.runRenew(), closed, state);
  }
  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.inboxRotator.calls, []);
  assert.deepEqual(env.turnQueue.keys, []);
  assert.equal(env.state().sdkSession, "session-1");
});

test("/renew（セッション）: 公開で defer → 静的な prompt で resume → 要約を保存 → SDK セッションを捨てる → seed → 要約付きで返信。状態とカテゴリは変えない", async (t) => {
  const env = setup(t, [ok(`  ${SUMMARY}\n`)]);
  env.db.prepare("UPDATE sessions SET state = 'waiting' WHERE channel_id = 'topic-1'").run();
  env.clock.now = RENEWED_AT;

  const calls = await env.runRenew();

  // context も WebFetch に許す URL も渡さない
  assert.deepEqual(env.runner.inputs, [{ prompt: RENEW_PROMPT, sessionId: "session-1", context: undefined, allowedUrls: [] }]);
  assert.deepEqual(calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: renewedText(SUMMARY) } },
  ]);
  assert.deepEqual(env.state(), {
    sdkSession: undefined,
    seed: renewedSeed(SUMMARY),
    renewedSummary: SUMMARY,
    renewedAt: RENEWED_AT.toISOString(),
  });
  const session = env.topicSessions.get("topic-1");
  assert.equal(session?.state, "waiting");
  assert.equal(session?.categoryId, "active-1");
  assert.equal(session?.summary, null);
  // 発言と同じキューで、セッションのジョブとして実行する
  assert.deepEqual(env.turnQueue.options, [{ session: true }]);
  // 要約のターンも usage に記録する
  const [entry] = env.usage.recent(1);
  assert.equal(entry?.key, "topic-1");
  assert.equal(entry?.ok, true);
  assert.equal(entry?.kind, "session-renew");
  assert.equal(env.tokenLogs.length, 1);
  assert.match(env.tokenLogs[0]!, /^トークン（session-renew・成功）: /);
  assert.equal(env.logs.length, 1);
  assert.ok(!env.logs[0]!.includes("topic-1"));
  assert.deepEqual(env.inboxRotator.calls, []);
});

test("/renew の後の最初の発言のターン: [記憶のブロック, 新しくした seed, 発言] で新しいセッションを始め、成功したら seed を消す", async (t) => {
  const env = setup(t, [ok(SUMMARY), ok("続けます", "session-2"), ok("はい", "session-2")]);
  env.memories.add("住んでいる地域: 東京都練馬区");
  await env.runRenew();

  const turn = { guildId: "guild-1", channelId: "topic-1", kind: "session" as const, prompt: PROMPT, allowedUrls: [] };
  await runChannelTurn(env.turn, turn);
  await runChannelTurn(env.turn, turn);

  assert.deepEqual(
    env.runner.inputs.map((input) => [input.prompt, input.sessionId]),
    [
      [RENEW_PROMPT, "session-1"],
      [`${MEMORY_BLOCK_HEADER}\n- [#1] 住んでいる地域: 東京都練馬区\n\n${renewedSeed(SUMMARY)}\n\n${PROMPT}`, undefined],
      [PROMPT, "session-2"],
    ],
  );
  assert.equal(env.state().seed, undefined);
  assert.equal(env.state().sdkSession, "session-2");
});

test("/renew（セッション）: 要約は返答本文の前後の空白を除いた先頭 1,200 字", async (t) => {
  const long = "あ".repeat(1199) + "🍣" + "い".repeat(10);
  const env = setup(t, [ok(long)]);

  await env.runRenew();
  // 1,200 字目がサロゲートペアの途中なら、その前で切る
  assert.equal(env.state().renewedSummary, "あ".repeat(1199));
  assert.equal(env.state().seed, renewedSeed("あ".repeat(1199)));

  // 最大の要約でも返信は 2,000 字に収まる
  assert.ok(renewedText("あ".repeat(RENEW_SUMMARY_MAX_LENGTH)).length <= 2000);
});

test("/renew（セッション）: 返答本文が空なら要約は保存せず（前の要約を残す）、seed は題名にして SDK セッションを捨てる。返信の要約は「（要約なし）」", async (t) => {
  const env = setup(t, [ok(" \n ")]);
  env.topicSessions.setRenewed("topic-1", "前の要約");
  env.clock.now = RENEWED_AT;

  const calls = await env.runRenew();

  assert.deepEqual(calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: renewedText(EMPTY_SUMMARY) } },
  ]);
  assert.deepEqual(env.state(), {
    sdkSession: undefined,
    seed: renewedSeed("題名: 旅行の計画"),
    renewedSummary: "前の要約",
    renewedAt: NOW.toISOString(),
  });
  assert.equal(env.logs.length, 1);
});

test("/renew（セッション）: 会話の記録が無ければ要約を作らずに SDK セッションを捨て、resume 失敗の復旧と同じ seed（前の /renew の要約か題名）を入れる", async (t) => {
  const cases = [
    { label: "前の /renew の要約なし", renewed: null, seed: `${RESUME_SEED_HEADER}\n題名: 旅行の計画`, renewedAt: null },
    { label: "前の /renew の要約あり", renewed: "前の要約", seed: `${RESUME_SEED_HEADER}\n前の要約`, renewedAt: NOW.toISOString() },
  ];

  for (const { label, renewed, seed, renewedAt } of cases) {
    const env = setup(t, [RESUME_FAILURE]);
    if (renewed !== null) env.topicSessions.setRenewed("topic-1", renewed);

    const calls = await env.runRenew();

    assert.equal(env.runner.inputs.length, 1, label);
    assert.deepEqual(
      calls,
      [
        { method: "defer", ephemeral: false },
        { method: "reply", message: { text: RENEWED_FRESH_REPLY } },
      ],
      label,
    );
    // 要約は前のまま
    assert.deepEqual(env.state(), { sdkSession: undefined, seed, renewedSummary: renewed, renewedAt }, label);
    assert.equal(env.usage.recent(1)[0]?.ok, false, label);
    assert.equal(env.logs.length, 1, label);
  }
});

test("/renew（セッション）: それ以外の失敗では seed・要約を変えずに失敗を返す。SDK が記録した別の session_id は残し、打ち切り・中断で受け取ったものでは置き換えない", async (t) => {
  const cases: Array<{ label: string; result: RunResult; sdkSession: string }> = [
    { label: "result まで届いた失敗", result: FAILED, sdkSession: "session-1" },
    // 途中まで記録された会話（別の session_id）は次の発言で続ける
    { label: "別の session_id を記録した失敗", result: { ...FAILED, sessionId: "session-2" }, sdkSession: "session-2" },
    {
      label: "打ち切り",
      result: { ok: false, errorMessage: "timeout", sessionId: "session-2", sessionRecorded: false, toolCalls: 1 },
      sdkSession: "session-1",
    },
    {
      label: "中断",
      result: { ok: false, errorMessage: "aborted", sessionId: "session-3", sessionRecorded: false, toolCalls: 0 },
      sdkSession: "session-1",
    },
  ];

  for (const { label, result, sdkSession } of cases) {
    const env = setup(t, [result]);
    env.topicSessions.setRenewed("topic-1", "前の要約");
    env.seeds.set("topic-1", "残っている seed");

    const calls = await env.runRenew();

    assert.deepEqual(
      calls,
      [
        { method: "defer", ephemeral: false },
        { method: "reply", message: { text: RENEW_FAILURE_REPLY } },
      ],
      label,
    );
    assert.deepEqual(
      env.state(),
      { sdkSession, seed: "残っている seed", renewedSummary: "前の要約", renewedAt: NOW.toISOString() },
      label,
    );
    assert.equal(env.logs.length, 1, label);
    // resume の連続失敗には数えない
    assert.equal(env.sessions.failureCount("topic-1"), 0, label);
  }
});

test("/renew（セッション）: 要約のターンが例外で終わったら何も変えずに handle から投げる（返信は interactions.ts の「処理に失敗しました」に任せる）", async (t) => {
  const env = setup(t);
  const runner: AgentRunner = {
    run: async () => {
      throw new Error("spawn failed");
    },
  };
  const command = createRenewCommand({
    guildSettings: env.guildSettings,
    topicSessions: env.topicSessions,
    turnQueue: env.turnQueue,
    turn: { ...env.turn, runner },
    inboxRotator: env.inboxRotator,
    log: () => {},
  });
  env.topicSessions.setRenewed("topic-1", "前の要約");
  env.seeds.set("topic-1", "残っている seed");
  const responder = new FakeResponder();

  await assert.rejects(command.handle(RENEW, responder), /spawn failed/);

  // 保留だけ済んでいる（interactions.ts が保留中の応答を失敗の文面で埋める）
  assert.deepEqual(responder.calls, [{ method: "defer", ephemeral: false }]);
  assert.deepEqual(env.state(), {
    sdkSession: "session-1",
    seed: "残っている seed",
    renewedSummary: "前の要約",
    renewedAt: NOW.toISOString(),
  });
});

test("/renew（セッション）: SDK セッションが無ければ（まだ会話が無い・続けて 2 回目）runner を呼ばずに何も変えない", async (t) => {
  const never = setup(t);
  never.sessions.delete("topic-1");
  never.seeds.set("topic-1", "#inbox からの続き:\n…");
  const twice = setup(t, [ok(SUMMARY)]);
  await twice.runRenew();
  const cases = [
    { label: "まだ会話が無い", env: never, runs: 0 },
    { label: "続けて 2 回目", env: twice, runs: 1 },
  ];

  for (const { label, env, runs } of cases) {
    const before = env.state();
    env.logs.length = 0;

    const calls = await env.runRenew();

    assert.deepEqual(
      calls,
      [
        { method: "defer", ephemeral: false },
        { method: "reply", message: { text: NO_CONVERSATION_REPLY } },
      ],
      label,
    );
    assert.equal(env.runner.inputs.length, runs, label);
    assert.deepEqual(env.state(), before, label);
    assert.deepEqual(env.logs, [], label);
  }
});

test("/renew（セッション）: 同じチャンネルの発言のターンが終わるのを待ち、その間に閉じられていたらターンを実行せずに「このセッションは閉じています」と返す", async (t) => {
  const env = setup(t);
  let release = (): void => {};
  const running = env.turnQueue.run("topic-1", () => new Promise<void>((resolve) => (release = resolve)));

  const renewing = env.runRenew();
  await new Promise((resolve) => setImmediate(resolve));
  env.topicSessions.close("topic-1", "先に閉じた");
  release();
  await running;

  assert.deepEqual(await renewing, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: ALREADY_CLOSED_REPLY } },
  ]);
  assert.equal(env.runner.inputs.length, 0);
  assert.equal(env.state().sdkSession, "session-1");
});

test("/renew（#inbox・#tasks）: 公開で defer → そのチャンネルの rotateNow → 結果ごとの文言で返信する", async (t) => {
  const env = setup(t);
  const expected: Array<[RotateNowResult, string]> = [
    ["rotated", ROTATED_NOTICE],
    ["rotated_fresh", ROTATED_NOTICE_FRESH],
    ["no_conversation", NO_CONVERSATION_REPLY],
    ["not_set_up", NOT_SET_UP_REPLY],
    ["failed", RENEW_FAILURE_REPLY],
  ];

  for (const [channelId, kind] of [["inbox-1", "inbox"], ["tasks-1", "tasks"]] as const) {
    for (const [result, text] of expected) {
      env.inboxRotator.result = result;
      env.inboxRotator.calls = [];
      const calls = await env.runRenew({ ...RENEW, channelId });
      assert.deepEqual(calls, [
        { method: "defer", ephemeral: false },
        { method: "reply", message: { text } },
      ], `${channelId} ${result}`);
      assert.deepEqual(env.inboxRotator.calls, [{ guildId: "guild-1", kind }]);
    }
  }
  // セッションのターンは行わない
  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.turnQueue.keys, []);
});

test("resumeSeed（セッション）: 最後に残した要約（/renew か /close）を使い、どちらも無ければ題名（/renew の要約は /close で消える）", async (t) => {
  const env = setup(t);
  const seed = (): string | undefined => resumeSeed(env.topicSessions.get("topic-1"), undefined, "inbox");

  assert.equal(seed(), `${RESUME_SEED_HEADER}\n題名: 旅行の計画`);

  // /renew → /close → 復活なら /close の要約
  env.topicSessions.setRenewed("topic-1", "1 回目の /renew の要約");
  assert.equal(seed(), `${RESUME_SEED_HEADER}\n1 回目の /renew の要約`);
  env.topicSessions.close("topic-1", "1 回目の /close の要約");
  env.topicSessions.setActive("topic-1");
  assert.equal(env.topicSessions.get("topic-1")?.renewedSummary, null);
  assert.equal(env.topicSessions.get("topic-1")?.renewedAt, null);
  assert.equal(seed(), `${RESUME_SEED_HEADER}\n1 回目の /close の要約`);

  // → /renew なら /renew の要約（残っている /renew の要約は最後の /close より新しい）
  env.topicSessions.setRenewed("topic-1", "2 回目の /renew の要約");
  assert.equal(seed(), `${RESUME_SEED_HEADER}\n2 回目の /renew の要約`);

  // → /close → 復活なら 2 回目の /close の要約
  env.topicSessions.close("topic-1", "2 回目の /close の要約");
  env.topicSessions.setActive("topic-1");
  assert.equal(seed(), `${RESUME_SEED_HEADER}\n2 回目の /close の要約`);
});
