import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRunner, RunInput, RunResult } from "../src/agent/runner.ts";
import { SYSTEM_PROMPT } from "../src/agent/system-prompt.ts";
import { ALREADY_CLOSED_REPLY } from "../src/app/commands/close.ts";
import { HELP_TEXT } from "../src/app/commands/help.ts";
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
import { KeyedSerialQueue, type QueueRunOptions } from "../src/app/queue.ts";
import { RENEW_PROMPT, RENEWED_SEED_HEADER, renewedSeed } from "../src/app/session-renew.ts";
import { EMPTY_SUMMARY } from "../src/app/summary.ts";
import { MEMORY_BLOCK_HEADER, RESUME_SEED_HEADER, resumeSeed, runChannelTurn, type TurnDeps } from "../src/app/turn.ts";
import type { Interaction, InteractionResponder, ModalDef, OutgoingMessage } from "../src/discord/gateway.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { InboxSummaryStore, type SummaryChannelKind } from "../src/store/inbox-summaries.ts";
import { MemoryStore } from "../src/store/memories.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { RENEW_SUMMARY_MAX_LENGTH, type TopicSession, TopicSessionStore } from "../src/store/topic-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";

const NOW = new Date("2026-10-11T00:12:00Z");
const RENEWED_AT = new Date("2026-10-11T00:15:00Z");
const PROMPT = "[2026-10-11(日) 09:20 JST #旅行の計画]\n続きをお願い";

/** 呼ばれた順に結果を返す */
class FakeRunner implements AgentRunner {
  inputs: RunInput[] = [];
  private readonly results: RunResult[];

  constructor(results: RunResult[]) {
    this.results = results;
  }

  async run(input: RunInput): Promise<RunResult> {
    this.inputs.push(input);
    const next = this.results.shift();
    if (next === undefined) throw new Error("想定外の呼び出し");
    return next;
  }
}

type ResponderCall =
  | { method: "defer"; ephemeral: boolean }
  | { method: "deferUpdate" }
  | { method: "reply" | "update"; message: OutgoingMessage }
  | { method: "showModal"; modal: ModalDef };

class FakeResponder implements InteractionResponder {
  calls: ResponderCall[] = [];

  async defer(ephemeral: boolean): Promise<void> {
    this.calls.push({ method: "defer", ephemeral });
  }
  async deferUpdate(): Promise<void> {
    this.calls.push({ method: "deferUpdate" });
  }
  async reply(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "reply", message });
  }
  async update(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "update", message });
  }
  async showModal(modal: ModalDef): Promise<void> {
    this.calls.push({ method: "showModal", modal });
  }
}

/** 受け取った key と指定（セッションのジョブか）を記録する */
class RecordingQueue extends KeyedSerialQueue {
  keys: string[] = [];
  options: Array<QueueRunOptions | undefined> = [];

  run<T>(key: string, fn: () => Promise<T>, options?: QueueRunOptions): Promise<T> {
    this.keys.push(key);
    this.options.push(options);
    return super.run(key, fn, options);
  }
}

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
    usage: { inputTokens: 10, cacheReadInputTokens: 2000, cacheCreationInputTokens: 300 },
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
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db: DatabaseSync = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: NOW };
  const now = (): Date => clock.now;
  const topicSessions = new TopicSessionStore(db, now);
  const guildSettings = new GuildSettingsStore(db, now);
  const sessions = new SdkSessionStore(db, now);
  const seeds = new ChannelSeedStore(db, now);
  const memories = new MemoryStore(db, now);
  const usage = new UsageStore(db, now);
  const runner = new FakeRunner(results);
  const turnQueue = new RecordingQueue(2);
  const inboxRotator = new FakeRotator();
  const logs: string[] = [];
  const log = (line: string): number => logs.push(line);
  const turn: TurnDeps = {
    runner,
    sessions,
    seeds,
    topicSessions,
    inboxSummaries: new InboxSummaryStore(db, now),
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
  return { db, clock, runner, topicSessions, guildSettings, sessions, seeds, memories, usage, turnQueue, inboxRotator, logs, turn, runRenew, state };
}

test("文言: 要約を頼む prompt は静的で、seed は「会話を新しくしました。前の会話の要約:」に続けて要約を入れる", () => {
  assert.equal(
    RENEW_PROMPT,
    "会話を新しくするので、続きに必要なこと（目的・決めたこと・やり残し・約束・作っているものの URL）だけを 1200 字以内の箇条書きで返答してください。SPEC.md に書いてあることは書き写さず、SPEC.md があることだけ書いてください。ツールは使わないでください。",
  );
  assert.equal(RENEW_SUMMARY_MAX_LENGTH, 1200);
  assert.equal(RENEWED_SEED_HEADER, "会話を新しくしました。前の会話の要約:");
  assert.equal(renewedSeed("- a\n- b"), "会話を新しくしました。前の会話の要約:\n- a\n- b");
  assert.equal(renewedText("- a"), "会話を新しくしました。次の発言から新しい設定で続けます。\n\n**要約**\n- a");
  assert.equal(RENEWED_FRESH_REPLY, "前の会話の記録が見つからないため、要約せずに新しくしました。次の発言から新しい設定で続けます");
  assert.equal(NO_CONVERSATION_REPLY, "まだ会話がありません。次の発言から新しい設定で始まります");
  assert.equal(NOT_RENEWABLE_REPLY, "セッションのチャンネルか #inbox・#tasks で実行してください");
  assert.equal(NOT_SET_UP_REPLY, "/setup を実行してください");
  assert.equal(RENEW_FAILURE_REPLY, "失敗しました。もう一度 /renew を実行してください");
});

test("/renew: セッションでも #inbox・#tasks でもないチャンネル（/setup 前の env の #inbox・別サーバーのセッション・チャンネル無し）では ephemeral で断り、何もしない", async (t) => {
  const env = setup(t);
  env.topicSessions.create({ ...TOPIC, channelId: "topic-9", guildId: "guild-9" });
  // guild-2 は /setup 前（env の #inbox で受け付けているサーバー）。DB に #inbox が無いので対象外
  const others: Array<Extract<Interaction, { kind: "command" }>> = [
    { ...RENEW, guildId: "guild-2", channelId: "env-inbox-1" },
    { ...RENEW, channelId: "unknown-1" },
    { ...RENEW, channelId: "topic-9" },
    { ...RENEW, guildId: "guild-2", channelId: "inbox-1" },
    { ...RENEW, channelId: null },
  ];

  for (const interaction of others) {
    const calls = await env.runRenew(interaction);
    assert.deepEqual(calls, [{ method: "reply", message: { text: NOT_RENEWABLE_REPLY, ephemeral: true } }], String(interaction.channelId));
  }
  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.inboxRotator.calls, []);
  assert.deepEqual(env.turnQueue.keys, []);
});

test("/renew: 閉じたセッション（done・deleted）では ephemeral で「このセッションは閉じています」と返し、何もしない", async (t) => {
  const env = setup(t);

  for (const state of ["done", "deleted"]) {
    env.db.prepare("UPDATE sessions SET state = ? WHERE channel_id = 'topic-1'").run(state);
    const calls = await env.runRenew();
    assert.deepEqual(calls, [{ method: "reply", message: { text: ALREADY_CLOSED_REPLY, ephemeral: true } }], state);
  }
  assert.equal(env.runner.inputs.length, 0);
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
  assert.ok("context" in env.runner.inputs[0]!);
  assert.deepEqual(calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: renewedText(SUMMARY) } },
  ]);
  assert.deepEqual(env.state(), {
    sdkSession: undefined,
    seed: `${RENEWED_SEED_HEADER}\n${SUMMARY}`,
    renewedSummary: SUMMARY,
    renewedAt: RENEWED_AT.toISOString(),
  });
  const session = env.topicSessions.get("topic-1");
  assert.equal(session?.state, "waiting");
  assert.equal(session?.categoryId, "active-1");
  assert.equal(session?.summary, null);
  // 発言と同じキューの同じ key（channelId）で、セッションのジョブとして実行する
  assert.deepEqual(env.turnQueue.keys, ["topic-1"]);
  assert.deepEqual(env.turnQueue.options, [{ session: true }]);
  // 要約のターンも usage に記録する
  const [entry] = env.usage.recent(1);
  assert.equal(entry?.key, "topic-1");
  assert.equal(entry?.ok, true);
  assert.deepEqual(env.logs, ["/renew でセッションの会話を新しくしました（guild=guild-1）"]);
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

test("/renew（セッション）: 要約は返答本文の前後の空白を除いた先頭 1,200 字。空なら「（要約なし）」", async (t) => {
  const long = "あ".repeat(1199) + "🍣" + "い".repeat(10);
  const env = setup(t, [ok(long), ok(" \n ", "session-2")]);

  await env.runRenew();
  // 1,200 字目がサロゲートペアの途中なら、その前で切る
  assert.equal(env.state().renewedSummary, "あ".repeat(1199));
  assert.equal(env.state().seed, renewedSeed("あ".repeat(1199)));

  env.sessions.set("topic-1", "session-2");
  const calls = await env.runRenew();
  assert.equal(env.state().renewedSummary, EMPTY_SUMMARY);
  assert.equal(env.state().seed, renewedSeed(EMPTY_SUMMARY));
  assert.deepEqual(calls[1], { method: "reply", message: { text: renewedText(EMPTY_SUMMARY) } });

  // 最大の要約でも返信は 2,000 字に収まる
  assert.ok(renewedText("あ".repeat(RENEW_SUMMARY_MAX_LENGTH)).length <= 2000);
});

test("/renew（セッション）: 会話の記録が無ければ要約を作らずに SDK セッションを捨て、resume 失敗の復旧と同じ seed（題名）を入れる", async (t) => {
  const env = setup(t, [RESUME_FAILURE]);

  const calls = await env.runRenew();

  assert.equal(env.runner.inputs.length, 1);
  assert.deepEqual(calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: RENEWED_FRESH_REPLY } },
  ]);
  assert.deepEqual(env.state(), {
    sdkSession: undefined,
    seed: `${RESUME_SEED_HEADER}\n題名: 旅行の計画`,
    renewedSummary: null,
    renewedAt: null,
  });
  assert.equal(env.usage.recent(1)[0]?.ok, false);
  assert.deepEqual(env.logs, [
    `/renew でセッションの会話の記録が見つからないため、要約せずに新しくしました（guild=guild-1）: ${RESUME_FAILURE.errorMessage}`,
  ]);
});

test("/renew（セッション）: 会話の記録が無いとき、前の /renew の要約があれば seed にそれを使う（要約は前のまま）", async (t) => {
  const env = setup(t, [RESUME_FAILURE]);
  env.topicSessions.setRenewed("topic-1", "前の要約");

  await env.runRenew();

  assert.deepEqual(env.state(), {
    sdkSession: undefined,
    seed: `${RESUME_SEED_HEADER}\n前の要約`,
    renewedSummary: "前の要約",
    renewedAt: NOW.toISOString(),
  });
});

test("/renew（セッション）: それ以外の失敗では SDK セッション・seed・要約を変えずに失敗を返す。SDK が記録した別の session_id は残す", async (t) => {
  const env = setup(t, [FAILED, { ...FAILED, sessionId: "session-2" }]);
  env.topicSessions.setRenewed("topic-1", "前の要約");
  env.seeds.set("topic-1", "残っている seed");

  const calls = await env.runRenew();

  assert.deepEqual(calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: RENEW_FAILURE_REPLY } },
  ]);
  const unchanged = { sdkSession: "session-1", seed: "残っている seed", renewedSummary: "前の要約", renewedAt: NOW.toISOString() };
  assert.deepEqual(env.state(), unchanged);
  assert.deepEqual(env.logs, [`/renew の要約に失敗しました（guild=guild-1）: ${FAILED.errorMessage}`]);
  // resume の連続失敗には数えない
  assert.equal(env.sessions.failureCount("topic-1"), 0);

  // 途中まで記録された会話（別の session_id）は次の発言で続ける
  await env.runRenew();
  assert.deepEqual(env.state(), { ...unchanged, sdkSession: "session-2" });
});

test("/renew（セッション）: SDK セッションが無ければ（まだ会話が無い）runner を呼ばずに何も変えない", async (t) => {
  const env = setup(t);
  env.sessions.delete("topic-1");
  env.seeds.set("topic-1", "#inbox からの続き:\n…");

  const calls = await env.runRenew();

  assert.deepEqual(calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: NO_CONVERSATION_REPLY } },
  ]);
  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.state(), { sdkSession: undefined, seed: "#inbox からの続き:\n…", renewedSummary: null, renewedAt: null });
  assert.deepEqual(env.logs, []);
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

test("resumeSeed（セッション）: /close の要約 → /renew の要約 → 題名 の順に使う", () => {
  const session: TopicSession = {
    channelId: "topic-1",
    guildId: "guild-1",
    title: "旅行の計画",
    state: "active",
    categoryId: "active-1",
    createdAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
    waitingSince: null,
    closedAt: null,
    summary: null,
    origin: "command",
    deletePromptMessageId: null,
    deletedAt: null,
    renewedSummary: null,
    renewedAt: null,
  };
  assert.equal(resumeSeed(session, undefined, "inbox"), `${RESUME_SEED_HEADER}\n題名: 旅行の計画`);
  const renewed = { ...session, renewedSummary: "/renew の要約", renewedAt: NOW.toISOString() };
  assert.equal(resumeSeed(renewed, undefined, "inbox"), `${RESUME_SEED_HEADER}\n/renew の要約`);
  assert.equal(resumeSeed({ ...renewed, summary: "/close の要約" }, undefined, "inbox"), `${RESUME_SEED_HEADER}\n/close の要約`);
});

test("/help の /close の行の直後に /renew の行がある", () => {
  assert.ok(
    HELP_TEXT.includes(
      "「完了」カテゴリへ移します\n`/renew` 会話を要約して新しくします。設定の変更（話し方の決まりなど）は新しい会話から反映されます。セッション・#inbox・#tasks で使えます\n",
    ),
  );
});

test("システムプロンプトに /renew の seed の見出し（引き継ぎの文）と、このアプリについての /renew がある", () => {
  assert.ok(
    SYSTEM_PROMPT.includes(
      "「前の会話の記録が切れたため、要約から再開します。」「会話を新しくしました。前の会話の要約:」で始まる文がある場合も、アプリが付けた引き継ぎの文脈です。",
    ),
  );
  assert.ok(SYSTEM_PROMPT.includes(`「${RENEWED_SEED_HEADER}」`));
  assert.ok(
    SYSTEM_PROMPT.includes(
      "/close（要約を残し、やることの候補を確認して登録してから閉じる）、/renew（会話を要約して新しくする。設定の変更を反映する）、/wait（待ちにする）",
    ),
  );
});
