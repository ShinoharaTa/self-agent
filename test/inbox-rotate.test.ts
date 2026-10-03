import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import type { AgentRunner, RunInput, RunResult } from "../src/agent/runner.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { createHandler } from "../src/app/handler.ts";
import {
  InboxRotator,
  ROTATE_PROMPT,
  ROTATE_RETRY_MS,
  ROTATED_NOTICE,
  ROTATED_NOTICE_FRESH,
} from "../src/app/inbox-rotate.ts";
import { buildTurnPrompt } from "../src/app/prompt.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { EMPTY_SUMMARY, rotatedSeed } from "../src/app/summary.ts";
import { RESUME_FAILURE_LIMIT, type TurnDeps } from "../src/app/turn.ts";
import type { TimeOfDay } from "../src/config.ts";
import type { Gateway, IncomingMessage, OutgoingMessage } from "../src/discord/gateway.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { InboxSummaryStore } from "../src/store/inbox-summaries.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";

/** 2026-10-03(土) 04:00 JST（UTC ではまだ 10/02） */
const ROTATE_AT = new Date("2026-10-02T19:00:00.000Z");
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function at(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** 呼ばれた順に結果を返す。gates[i] があれば i 回目の呼び出しは結果を返す前にそれを待つ */
class FakeRunner implements AgentRunner {
  inputs: RunInput[] = [];
  gates: Array<Promise<void> | undefined> = [];
  private readonly results: Array<RunResult | Error>;

  constructor(results: Array<RunResult | Error>) {
    this.results = results;
  }

  async run(input: RunInput): Promise<RunResult> {
    const index = this.inputs.length;
    this.inputs.push(input);
    await this.gates[index];
    const next = this.results.shift();
    if (next === undefined) throw new Error("想定外の呼び出し");
    if (next instanceof Error) throw next;
    return next;
  }
}

/** 発言の返信（send）と切り替えの知らせ（sendMessage）を順に記録する */
class FakeGateway implements Gateway {
  events: Array<{ method: "send" | "sendMessage"; channelId: string; text: string }> = [];
  /** sendMessage の直前に呼ばれる。投げればその送信は失敗する */
  beforeSendMessage: (channelId: string) => void = () => {};

  async start(): Promise<void> {}
  async send(channelId: string, text: string): Promise<void> {
    this.events.push({ method: "send", channelId, text });
  }
  async sendMessage(channelId: string, message: OutgoingMessage): Promise<string> {
    this.beforeSendMessage(channelId);
    this.events.push({ method: "sendMessage", channelId, text: message.text });
    return `message-${this.events.length}`;
  }
  async pinMessage(): Promise<void> {
    throw new Error("想定外の呼び出し");
  }
  async messageExists(): Promise<boolean> {
    throw new Error("想定外の呼び出し");
  }
  startTyping(): () => void {
    return () => {};
  }
  isInGuild(): boolean {
    return true;
  }
  async registerGuildCommands(): Promise<void> {}
  async createCategory(): Promise<string> {
    throw new Error("想定外の呼び出し");
  }
  async createTextChannel(): Promise<string> {
    throw new Error("想定外の呼び出し");
  }
  async channelExists(): Promise<boolean> {
    throw new Error("想定外の呼び出し");
  }
  async countChannelsIn(): Promise<number> {
    throw new Error("想定外の呼び出し");
  }
  async listChannelParents(): Promise<Map<string, string | null>> {
    throw new Error("想定外の呼び出し");
  }
  async moveChannel(): Promise<void> {
    throw new Error("想定外の呼び出し");
  }
  async getParentId(): Promise<string | null> {
    throw new Error("想定外の呼び出し");
  }
  async deleteChannel(): Promise<void> {
    throw new Error("想定外の呼び出し");
  }
  async stop(): Promise<void> {}
}

/** 受け取った key を記録する（発言と同じキュー・同じ key を使うかを見る） */
class RecordingQueue extends KeyedSerialQueue {
  keys: string[] = [];

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.keys.push(key);
    return super.run(key, fn);
  }
}

/** ターンのトークン。input・read・creation は各ステップの合算、context は最後のステップの入力 */
type Tokens = { input: number; read: number; creation: number; context: number };

const SMALL: Tokens = { input: 10, read: 2000, creation: 300, context: 2310 };

function ok(text: string, sessionId: string = "session-1", tokens: Tokens = SMALL): RunResult {
  return {
    ok: true,
    text,
    sessionId,
    usage: { inputTokens: tokens.input, cacheReadInputTokens: tokens.read, cacheCreationInputTokens: tokens.creation },
    durationMs: 4200,
    toolCalls: 0,
    contextTokens: tokens.context,
  };
}

/** result まで届いた失敗（SDK は会話を記録済み） */
const FAILED: RunResult = {
  ok: false,
  errorMessage: "error_during_execution: boom",
  sessionId: "session-1",
  sessionRecorded: true,
  toolCalls: 0,
};

/** resume 先の会話の記録が SDK 側に無いときの失敗 */
const RESUME_FAILURE: RunResult = {
  ok: false,
  errorMessage: "error_during_execution: No conversation found with session ID: session-1",
  sessionRecorded: false,
  toolCalls: 0,
};

const SUMMARY = "- 金曜までに見積もりを送る\n- 歯医者は来週に変更";

type Options = {
  timeZone?: string;
  rotateAt?: TimeOfDay;
  maxInputTokens?: number;
  allowedGuildIds?: string[];
  /** guild-1 の最後に切り替えた日。既定は前日（2026-10-02）。null はまだ一度も切り替えていない（時刻も無い） */
  rotatedDate?: string | null;
};

/** 切り替えた日の 04:00 JST（setup で記録する、前回の切り替えの時刻） */
function rotatedAtOf(date: string): Date {
  return new Date(`${date}T04:00:00+09:00`);
}

function setup(t: TestContext, results: Array<RunResult | Error> = [], options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: ROTATE_AT };
  const now = (): Date => clock.now;
  const guildSettings = new GuildSettingsStore(db, now);
  const inboxSummaries = new InboxSummaryStore(db, now);
  const sessions = new SdkSessionStore(db, now);
  const seeds = new ChannelSeedStore(db, now);
  const usage = new UsageStore(db, now);
  const topicSessions = new TopicSessionStore(db, now);
  const runner = new FakeRunner(results);
  const gateway = new FakeGateway();
  const queue = new RecordingQueue(2);
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const cfg = {
    allowedGuildIds: options.allowedGuildIds ?? ["guild-1"],
    timeZone: options.timeZone ?? "Asia/Tokyo",
    inboxRotateAt: options.rotateAt ?? { hour: 4, minute: 0 },
    inboxMaxInputTokens: options.maxInputTokens ?? 150000,
  };
  const turn: TurnDeps = { runner, sessions, seeds, topicSessions, inboxSummaries, usage, log };
  const rotator = new InboxRotator({ cfg, guildSettings, inboxSummaries, turnQueue: queue, turn, gateway, now, log });

  // guild-1 は /setup 済み（#inbox は inbox-1）
  guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  const rotatedDate = options.rotatedDate === undefined ? "2026-10-02" : options.rotatedDate;
  if (rotatedDate !== null) guildSettings.setInboxRotated("guild-1", rotatedDate, rotatedAtOf(rotatedDate));

  /** when の時刻に #inbox（channelId）で成功したターンがあったことにする（usage の記録と SDK セッション） */
  const chatAt = (
    when: Date,
    tokens: Tokens = SMALL,
    channelId: string = "inbox-1",
    sessionId: string = "session-1",
  ): void => {
    const saved = clock.now;
    clock.now = when;
    usage.record({
      key: channelId,
      sessionId,
      ok: true,
      durationMs: 1000,
      inputTokens: tokens.input,
      cacheReadInputTokens: tokens.read,
      cacheCreationInputTokens: tokens.creation,
      contextTokens: tokens.context,
    });
    sessions.set(channelId, sessionId);
    clock.now = saved;
  };
  /** 発言のハンドラ（同じキュー・同じストア） */
  const handler = () =>
    createHandler({
      cfg: { allowedGuildIds: cfg.allowedGuildIds, ownerUserId: "owner-1", timeZone: cfg.timeZone },
      resolveChannel: createChannelResolver({ inboxChannelId: undefined }, guildSettings, topicSessions),
      gateway,
      runner,
      sessions,
      seeds,
      topicSessions,
      inboxSummaries,
      channelOps: { enqueueMove: () => assert.fail("想定外の呼び出し") },
      usage,
      queue,
      log,
    });
  /** guild-1 の切り替えまわりの状態 */
  const state = () => ({
    rotatedDate: guildSettings.get("guild-1")?.inboxRotatedDate ?? null,
    summary: inboxSummaries.latest("guild-1"),
    session: sessions.get("inbox-1"),
    seed: seeds.get("inbox-1"),
  });
  return {
    db,
    clock,
    guildSettings,
    inboxSummaries,
    sessions,
    seeds,
    usage,
    runner,
    gateway,
    queue,
    logs,
    rotator,
    chatAt,
    handler,
    state,
    rotate: (): Promise<void> => rotator.rotateDue(() => false),
  };
}

function message(content: string, createdAt: Date): IncomingMessage {
  return {
    id: `message-${createdAt.getTime()}`,
    channelId: "inbox-1",
    guildId: "guild-1",
    authorId: "owner-1",
    authorIsBot: false,
    isWebhook: false,
    content,
    createdAt,
  };
}

const ROTATED_LOG = "#inbox の会話を要約して新しいセッションに切り替えました（guild=guild-1、日次）";
const NO_TURNS_LOG = "#inbox に前回の切り替えからの会話が無いため、要約せずに切り替えた日だけ記録しました（guild=guild-1）";

test("文言: 要約を頼む prompt は静的で、日次・サイズのどちらでも通じる。seed は「これまでの #inbox の要約:」に続けて要約を入れる", () => {
  assert.equal(
    ROTATE_PROMPT,
    "会話を新しくするので、ここまでの #inbox のやり取りのうち、今後も必要なこと（未完了の話題・決めたこと・約束）だけを 600 字以内の箇条書きで返答してください。ツールは使わないでください。",
  );
  assert.equal(ROTATED_NOTICE, "（会話を新しくしました。これまでの要約を引き継いでいます）");
  assert.equal(rotatedSeed("- a\n- b"), "これまでの #inbox の要約:\n- a\n- b");
  assert.equal(ROTATE_RETRY_MS, HOUR_MS);
});

test("日次: rotateAt（04:00 JST）の直前は切り替えず、ちょうどから切り替える", async (t) => {
  const env = setup(t, [ok(SUMMARY)]);
  env.chatAt(at(ROTATE_AT, -HOUR_MS));

  env.clock.now = at(ROTATE_AT, -1);
  await env.rotate();
  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.queue.keys, []);
  assert.equal(env.state().rotatedDate, "2026-10-02");

  env.clock.now = ROTATE_AT;
  await env.rotate();
  assert.deepEqual(env.runner.inputs, [
    { prompt: ROTATE_PROMPT, sessionId: "session-1", context: undefined },
  ]);
  assert.equal(env.state().rotatedDate, "2026-10-03");
});

test("日次: 日付は SELF_AGENT_TZ で決める（UTC の日付ではない）。日付が変わっても rotateAt までは切り替えない", async (t) => {
  // 05:00 JST（UTC ではまだ 10/02）。JST の今日（10/03）に切り替え済みなら何もしない
  const env = setup(t, [ok(SUMMARY)], { rotatedDate: "2026-10-03" });
  env.chatAt(at(ROTATE_AT, -HOUR_MS));
  env.clock.now = at(ROTATE_AT, HOUR_MS);
  await env.rotate();
  assert.equal(env.runner.inputs.length, 0);

  // 前日（10/02）のままなら切り替え、JST の日付（10/03）を記録する
  env.guildSettings.setInboxRotated("guild-1", "2026-10-02", rotatedAtOf("2026-10-02"));
  await env.rotate();
  assert.equal(env.runner.inputs.length, 1);
  assert.equal(env.state().rotatedDate, "2026-10-03");
  assert.equal(env.state().summary?.date, "2026-10-03");

  // JST の翌日（10/04）になっても 04:00 の前は切り替えない
  env.clock.now = new Date("2026-10-03T18:59:59.999Z");
  await env.rotate();
  assert.equal(env.state().rotatedDate, "2026-10-03");
  // 04:00 を過ぎたら切り替える（会話が無いので日付だけ）
  env.clock.now = new Date("2026-10-03T19:00:00.000Z");
  await env.rotate();
  assert.equal(env.state().rotatedDate, "2026-10-04");
  assert.equal(env.runner.inputs.length, 1);
});

test("日次: SELF_AGENT_TZ と SELF_AGENT_INBOX_ROTATE_AT の値で判定する（UTC・23:30）", async (t) => {
  const env = setup(t, [], { timeZone: "UTC", rotateAt: { hour: 23, minute: 30 }, rotatedDate: "2026-10-01" });

  env.clock.now = new Date("2026-10-02T23:29:59.999Z");
  await env.rotate();
  assert.equal(env.state().rotatedDate, "2026-10-01");

  env.clock.now = new Date("2026-10-02T23:30:00.000Z");
  await env.rotate();
  assert.equal(env.state().rotatedDate, "2026-10-02");
});

test("日次: まだ一度も切り替えていないサーバーは、rotateAt を過ぎた最初の tick で切り替える", async (t) => {
  const env = setup(t, [ok(SUMMARY)], { rotatedDate: null });
  env.chatAt(at(ROTATE_AT, -48 * HOUR_MS));

  env.clock.now = at(ROTATE_AT, -1);
  await env.rotate();
  assert.equal(env.state().rotatedDate, null);

  env.clock.now = at(ROTATE_AT, 6 * HOUR_MS);
  await env.rotate();
  assert.equal(env.runner.inputs.length, 1);
  assert.equal(env.state().rotatedDate, "2026-10-03");
});

test("日次: その日に既に切り替えていれば、会話があっても何もしない", async (t) => {
  const env = setup(t, [], { rotatedDate: "2026-10-03" });
  env.chatAt(at(ROTATE_AT, HOUR_MS));
  env.clock.now = at(ROTATE_AT, 2 * HOUR_MS);

  await env.rotate();

  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.queue.keys, []);
  assert.deepEqual(env.gateway.events, []);
  assert.deepEqual(env.logs, []);
  assert.deepEqual(env.state(), { rotatedDate: "2026-10-03", summary: undefined, session: "session-1", seed: undefined });
});

test("SDK セッションが無ければ、ターンの記録があっても LLM を呼ばずに切り替えた日だけ記録する", async (t) => {
  const env = setup(t);
  env.chatAt(at(ROTATE_AT, -HOUR_MS));
  env.sessions.delete("inbox-1");

  await env.rotate();

  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.queue.keys, ["inbox-1"]);
  assert.deepEqual(env.state(), { rotatedDate: "2026-10-03", summary: undefined, session: undefined, seed: undefined });
  assert.equal(env.guildSettings.get("guild-1")?.inboxRotatedAt, ROTATE_AT.toISOString());
  assert.deepEqual(env.gateway.events, []);
  assert.deepEqual(env.logs, [NO_TURNS_LOG]);

  // 記録したので、その日はもう何もしない
  env.clock.now = at(ROTATE_AT, 5 * MINUTE_MS);
  await env.rotate();
  assert.deepEqual(env.queue.keys, ["inbox-1"]);
});

test("前回の切り替えの時刻（inbox_rotated_at。最後の要約の時刻ではない）より後に #inbox のターンが無ければ、LLM を呼ばずに切り替えた日と時刻だけ記録する（SDK セッションも seed もそのまま）", async (t) => {
  const env = setup(t);
  // 要約はそれより前に残したもの。要約の時刻を基準にすると、その後のターンを数えてしまう
  env.clock.now = at(ROTATE_AT, -30 * HOUR_MS);
  env.inboxSummaries.add("guild-1", "2026-10-01", "前回の要約");
  env.clock.now = ROTATE_AT;
  // 前回の切り替えの時刻（setup で 10/02 04:00 JST = 24 時間前）ちょうどまでのターンは数えない
  assert.equal(env.guildSettings.get("guild-1")?.inboxRotatedAt, at(ROTATE_AT, -24 * HOUR_MS).toISOString());
  env.chatAt(at(ROTATE_AT, -25 * HOUR_MS));
  env.chatAt(at(ROTATE_AT, -24 * HOUR_MS));
  env.seeds.set("inbox-1", rotatedSeed("前回の要約"));

  await env.rotate();

  assert.equal(env.runner.inputs.length, 0);
  assert.equal(env.state().rotatedDate, "2026-10-03");
  assert.equal(env.guildSettings.get("guild-1")?.inboxRotatedAt, ROTATE_AT.toISOString());
  assert.equal(env.state().summary?.summary, "前回の要約");
  assert.equal(env.state().session, "session-1");
  assert.equal(env.state().seed, rotatedSeed("前回の要約"));
  assert.deepEqual(env.logs, [NO_TURNS_LOG]);
});

test("切り替え: 要約のターン → 要約を保存 → SDK セッションを捨てる → seed → 切り替えた日 → #inbox に知らせる", async (t) => {
  const env = setup(t, [ok(`  ${SUMMARY}\n`)]);
  // 前回の要約より後のターンがある
  env.clock.now = at(ROTATE_AT, -24 * HOUR_MS);
  env.inboxSummaries.add("guild-1", "2026-10-02", "前回の要約");
  env.clock.now = ROTATE_AT;
  env.chatAt(at(ROTATE_AT, -HOUR_MS));
  // 知らせを投稿する時点で DB の更新は済んでいる
  const atNotice: unknown[] = [];
  env.gateway.beforeSendMessage = () => {
    atNotice.push(env.state());
  };

  await env.rotate();

  assert.deepEqual(env.runner.inputs, [
    { prompt: ROTATE_PROMPT, sessionId: "session-1", context: undefined },
  ]);
  assert.deepEqual(env.queue.keys, ["inbox-1"]);
  const expected = {
    rotatedDate: "2026-10-03",
    summary: { id: 2, guildId: "guild-1", date: "2026-10-03", summary: SUMMARY, createdAt: ROTATE_AT.toISOString() },
    session: undefined,
    seed: rotatedSeed(SUMMARY),
  };
  assert.deepEqual(atNotice, [expected]);
  assert.deepEqual(env.state(), expected);
  assert.equal(env.guildSettings.get("guild-1")?.inboxRotatedAt, ROTATE_AT.toISOString());
  assert.deepEqual(env.gateway.events, [{ method: "sendMessage", channelId: "inbox-1", text: ROTATED_NOTICE }]);
  // 要約のターンも usage に記録する
  const [entry] = env.usage.recent(1);
  assert.equal(entry?.key, "inbox-1");
  assert.equal(entry?.ok, true);
  assert.equal(entry?.at, ROTATE_AT.toISOString());
  assert.equal(entry?.sessionId, "session-1");
  assert.equal(entry?.cacheReadInputTokens, 2000);
  assert.equal(entry?.contextTokens, 2310);
  assert.deepEqual(env.logs, [ROTATED_LOG]);

  // 切り替えた後の tick では何もしない（要約のターンの記録でまた切り替えない）
  env.clock.now = at(ROTATE_AT, 5 * MINUTE_MS);
  await env.rotate();
  assert.equal(env.runner.inputs.length, 1);
  assert.equal(env.gateway.events.length, 1);
});

test("切り替え: 要約のターンには context を渡さない（session_report・session_open は使えない）", async (t) => {
  const env = setup(t, [ok(SUMMARY)]);
  env.chatAt(at(ROTATE_AT, -HOUR_MS));

  await env.rotate();

  assert.equal(env.runner.inputs.length, 1);
  assert.ok("context" in env.runner.inputs[0]!);
  assert.equal(env.runner.inputs[0]?.context, undefined);
});

test("切り替えた時刻は要約のターンの usage を記録した後に取り直す（ターン中に時刻が進んでも、要約のターン自身の記録を次の判定に数えない）", async (t) => {
  const big: Tokens = { input: 5, read: 200000, creation: 1000, context: 201005 };
  const env = setup(t, [ok(SUMMARY, "session-1", big)]);
  env.chatAt(at(ROTATE_AT, -HOUR_MS));
  const summaryTurn = deferred();
  env.runner.gates[0] = summaryTurn.promise;

  const rotating = env.rotate();
  await flush();
  // 要約のターンに 2 分かかった
  const finishedAt = at(ROTATE_AT, 2 * MINUTE_MS);
  env.clock.now = finishedAt;
  summaryTurn.resolve();
  await rotating;

  assert.equal(env.usage.recent(1)[0]?.at, finishedAt.toISOString());
  assert.equal(env.guildSettings.get("guild-1")?.inboxRotatedAt, finishedAt.toISOString());
  // 日付は切り替えを始めたときのもの
  assert.equal(env.state().rotatedDate, "2026-10-03");

  // 新しいセッションができても、要約のターン自身の大きな入力（201005 トークン）では切り替えない
  env.sessions.set("inbox-1", "session-2");
  env.clock.now = at(ROTATE_AT, 10 * MINUTE_MS);
  await env.rotate();
  assert.equal(env.runner.inputs.length, 1);
});

test("切り替え: 要約は返答本文の前後の空白を除いた先頭 600 字。空なら「（要約なし）」", async (t) => {
  const long = "あ".repeat(599) + "🍣" + "い".repeat(10);
  const env = setup(t, [ok(long), ok("  \n ")]);
  env.chatAt(at(ROTATE_AT, -HOUR_MS));

  await env.rotate();
  // 600 字目がサロゲートペアの途中なら、その前で切る
  assert.equal(env.state().summary?.summary, "あ".repeat(599));

  // 翌日
  env.clock.now = at(ROTATE_AT, 24 * HOUR_MS);
  env.chatAt(at(ROTATE_AT, 23 * HOUR_MS));
  await env.rotate();
  assert.equal(env.state().summary?.summary, EMPTY_SUMMARY);
  assert.equal(env.state().seed, rotatedSeed(EMPTY_SUMMARY));
});

test("切り替え: 要約が次の発言の最初のターンの prompt の先頭に付き（新しいセッション）、成功したら seed を消す。切り替え中の発言は切り替えの後に処理する", async (t) => {
  const env = setup(t, [ok(SUMMARY), ok("10 時からです", "session-2"), ok("どういたしまして", "session-2")]);
  env.chatAt(at(ROTATE_AT, -HOUR_MS));
  const summaryTurn = deferred();
  env.runner.gates[0] = summaryTurn.promise;
  const handle = env.handler();

  const rotating = env.rotate();
  await flush();
  assert.equal(env.runner.inputs.length, 1);
  // 要約のターンの途中に来た発言は、同じキュー（key は #inbox）で待つ
  const first = message("明日の予定は？", at(ROTATE_AT, MINUTE_MS));
  const replying = handle(first);
  await flush();
  assert.equal(env.runner.inputs.length, 1);

  summaryTurn.resolve();
  await Promise.all([rotating, replying]);
  const second = message("ありがとう", at(ROTATE_AT, 2 * MINUTE_MS));
  await handle(second);

  assert.deepEqual(
    env.runner.inputs.map((input) => [input.prompt, input.sessionId]),
    [
      [ROTATE_PROMPT, "session-1"],
      [`${rotatedSeed(SUMMARY)}\n\n${buildTurnPrompt(first.content, first.createdAt, "Asia/Tokyo", "inbox")}`, undefined],
      [buildTurnPrompt(second.content, second.createdAt, "Asia/Tokyo", "inbox"), "session-2"],
    ],
  );
  assert.deepEqual(env.queue.keys, ["inbox-1", "inbox-1", "inbox-1"]);
  assert.equal(env.state().seed, undefined);
  assert.equal(env.state().session, "session-2");
  // 知らせは発言への返信より先
  assert.deepEqual(
    env.gateway.events.map((event) => `${event.method}:${event.text}`),
    [`sendMessage:${ROTATED_NOTICE}`, "send:10 時からです", "send:どういたしまして"],
  );
});

test("切り替え: 発言のターンの途中なら、同じキュー（key は #inbox）でそのターンの後に行い、そのターンで保存した SDK セッションを要約する", async (t) => {
  const env = setup(t, [ok("了解です", "session-2"), ok(SUMMARY, "session-2")]);
  env.chatAt(at(ROTATE_AT, -HOUR_MS));
  const userTurn = deferred();
  env.runner.gates[0] = userTurn.promise;
  const handle = env.handler();

  const replying = handle(message("牛乳を買う", at(ROTATE_AT, -MINUTE_MS)));
  await flush();
  assert.equal(env.runner.inputs.length, 1);
  const rotating = env.rotate();
  await flush();
  // 発言のターンが終わるまで要約のターンは始めない
  assert.equal(env.runner.inputs.length, 1);

  userTurn.resolve();
  await Promise.all([replying, rotating]);

  assert.deepEqual(env.runner.inputs[1], { prompt: ROTATE_PROMPT, sessionId: "session-2", context: undefined });
  assert.deepEqual(env.queue.keys, ["inbox-1", "inbox-1"]);
  assert.deepEqual(
    env.gateway.events.map((event) => `${event.method}:${event.text}`),
    ["send:了解です", `sendMessage:${ROTATED_NOTICE}`],
  );
  assert.equal(env.state().session, undefined);
  assert.equal(env.state().rotatedDate, "2026-10-03");
});

test("要約のターンが失敗したら何も変えずに log に出し、同じサーバーは 1 時間経つまでやり直さない", async (t) => {
  const env = setup(t, [FAILED, ok(SUMMARY)]);
  env.chatAt(at(ROTATE_AT, -HOUR_MS));

  await env.rotate();

  assert.deepEqual(env.state(), { rotatedDate: "2026-10-02", summary: undefined, session: "session-1", seed: undefined });
  assert.equal(env.guildSettings.get("guild-1")?.inboxRotatedAt, rotatedAtOf("2026-10-02").toISOString());
  assert.deepEqual(env.gateway.events, []);
  assert.deepEqual(env.logs, [
    "#inbox の要約に失敗したため、切り替えませんでした（guild=guild-1）。1 時間後以降にやり直します: error_during_execution: boom",
  ]);
  // 失敗したターンも usage に残る。resume の連続失敗には数えない
  assert.equal(env.usage.recent(1)[0]?.ok, false);
  assert.equal(env.sessions.failureCount("inbox-1"), 0);

  // 1 時間に 1 ms 足りなければやり直さない
  env.clock.now = at(ROTATE_AT, HOUR_MS - 1);
  await env.rotate();
  assert.equal(env.runner.inputs.length, 1);
  assert.deepEqual(env.queue.keys, ["inbox-1"]);

  // ちょうど 1 時間後にやり直す
  env.clock.now = at(ROTATE_AT, HOUR_MS);
  await env.rotate();
  assert.equal(env.runner.inputs.length, 2);
  assert.equal(env.runner.inputs[1]?.sessionId, "session-1");
  assert.equal(env.state().rotatedDate, "2026-10-03");
  assert.equal(env.state().summary?.summary, SUMMARY);
});

test("要約のターンが何度失敗しても新しいセッションでやり直さず（runChannelTurn の復旧はしない）、SDK が記録した別の session_id は残す", async (t) => {
  const failed: RunResult = { ...FAILED, sessionId: "session-2" };
  const env = setup(t, Array.from({ length: RESUME_FAILURE_LIMIT + 2 }, () => failed));
  env.chatAt(at(ROTATE_AT, -HOUR_MS));

  await env.rotate();
  // 途中まで記録された会話（別の session_id）は次の発言で続ける
  assert.equal(env.state().session, "session-2");

  for (let hour = 1; hour <= RESUME_FAILURE_LIMIT + 1; hour++) {
    env.clock.now = at(ROTATE_AT, hour * HOUR_MS);
    await env.rotate();
  }

  // 毎回 resume だけで、sessionId 無しの run は無い
  assert.deepEqual(
    env.runner.inputs.map((input) => input.sessionId),
    ["session-1", ...Array.from({ length: RESUME_FAILURE_LIMIT + 1 }, () => "session-2")],
  );
  assert.equal(env.sessions.failureCount("inbox-1"), 0);
  assert.deepEqual(env.state(), { rotatedDate: "2026-10-02", summary: undefined, session: "session-2", seed: undefined });
});

test("会話の記録が無い（No conversation found）なら要約を作らずに SDK セッションを捨て、切り替えた日を記録し、直近の要約を seed にして知らせる", async (t) => {
  const env = setup(t, [RESUME_FAILURE, ok("10 時からです", "session-2")]);
  env.clock.now = at(ROTATE_AT, -24 * HOUR_MS);
  env.inboxSummaries.add("guild-1", "2026-10-02", "前回の要約");
  env.clock.now = ROTATE_AT;
  env.chatAt(at(ROTATE_AT, -HOUR_MS));

  await env.rotate();

  // 新しいセッションで要約し直さない（空の会話の要約を保存しない）
  assert.equal(env.runner.inputs.length, 1);
  assert.equal(Number(env.db.prepare("SELECT COUNT(*) AS n FROM inbox_summaries").get()?.n), 1);
  assert.deepEqual(env.state(), {
    rotatedDate: "2026-10-03",
    summary: { id: 1, guildId: "guild-1", date: "2026-10-02", summary: "前回の要約", createdAt: at(ROTATE_AT, -24 * HOUR_MS).toISOString() },
    session: undefined,
    seed: rotatedSeed("前回の要約"),
  });
  assert.equal(env.guildSettings.get("guild-1")?.inboxRotatedAt, ROTATE_AT.toISOString());
  assert.deepEqual(env.gateway.events, [{ method: "sendMessage", channelId: "inbox-1", text: ROTATED_NOTICE }]);
  assert.equal(env.usage.recent(1)[0]?.ok, false);
  assert.deepEqual(env.logs, [
    "#inbox の会話の記録が見つからないため、要約せずに新しいセッションに切り替えました（guild=guild-1、前回の要約を引き継ぎ）: " +
      RESUME_FAILURE.errorMessage,
  ]);

  // 次の発言の最初のターンに直近の要約が付く
  const first = message("明日の予定は？", at(ROTATE_AT, MINUTE_MS));
  await env.handler()(first);
  assert.deepEqual(env.runner.inputs[1], {
    prompt: `${rotatedSeed("前回の要約")}\n\n${buildTurnPrompt(first.content, first.createdAt, "Asia/Tokyo", "inbox")}`,
    sessionId: undefined,
    context: { guildId: "guild-1", channelId: "inbox-1" },
  });
  assert.equal(env.state().seed, undefined);

  // その日はもう切り替えない
  env.clock.now = at(ROTATE_AT, 5 * MINUTE_MS);
  await env.rotate();
  assert.equal(env.runner.inputs.length, 2);
});

test("会話の記録が無く、前回の要約も無ければ seed は入れずに切り替え、引き継ぎの無い文言で知らせる", async (t) => {
  const env = setup(t, [RESUME_FAILURE]);
  env.chatAt(at(ROTATE_AT, -HOUR_MS));

  await env.rotate();

  assert.equal(env.runner.inputs.length, 1);
  assert.deepEqual(env.state(), { rotatedDate: "2026-10-03", summary: undefined, session: undefined, seed: undefined });
  assert.deepEqual(env.gateway.events, [{ method: "sendMessage", channelId: "inbox-1", text: ROTATED_NOTICE_FRESH }]);
  assert.deepEqual(env.logs, [
    "#inbox の会話の記録が見つからないため、要約せずに新しいセッションに切り替えました（guild=guild-1、前回の要約なし）: " +
      RESUME_FAILURE.errorMessage,
  ]);
});

test("要約のターンが例外で終わっても何も変えずに log に出し、1 時間経つまでやり直さない", async (t) => {
  const env = setup(t, [new Error("spawn failed"), ok(SUMMARY)]);
  env.chatAt(at(ROTATE_AT, -HOUR_MS));

  await env.rotate();

  assert.deepEqual(env.state(), { rotatedDate: "2026-10-02", summary: undefined, session: "session-1", seed: undefined });
  assert.deepEqual(env.logs, ["#inbox の切り替えに失敗しました（guild=guild-1）: spawn failed"]);

  env.clock.now = at(ROTATE_AT, HOUR_MS - 1);
  await env.rotate();
  assert.equal(env.runner.inputs.length, 1);
  env.clock.now = at(ROTATE_AT, HOUR_MS);
  await env.rotate();
  assert.equal(env.runner.inputs.length, 2);
  assert.equal(env.state().rotatedDate, "2026-10-03");
});

test("切り替えの知らせの投稿に失敗しても、切り替えは済ませて log に出す", async (t) => {
  const env = setup(t, [ok(SUMMARY)]);
  env.chatAt(at(ROTATE_AT, -HOUR_MS));
  env.gateway.beforeSendMessage = () => {
    throw new Error("Missing Access");
  };

  await env.rotate();

  assert.equal(env.state().rotatedDate, "2026-10-03");
  assert.equal(env.state().seed, rotatedSeed(SUMMARY));
  assert.deepEqual(env.logs, [
    ROTATED_LOG,
    "#inbox への切り替えの知らせの投稿に失敗しました（guild=guild-1）: Missing Access",
  ]);
});

test("サイズ: 今日切り替え済みでも、前回の切り替えより後の最新の成功したターンの最後のステップの入力が上限を超えたら切り替える（各ステップの合算では判定しない）", async (t) => {
  // 12:00 JST。今日（10/03）は切り替え済み
  const noon = at(ROTATE_AT, 8 * HOUR_MS);
  const env = setup(t, [ok(SUMMARY, "session-1", { input: 5, read: 200000, creation: 1000, context: 201005 })], {
    rotatedDate: "2026-10-03",
  });
  env.clock.now = at(ROTATE_AT, MINUTE_MS);
  env.inboxSummaries.add("guild-1", "2026-10-03", "今朝の要約");
  env.clock.now = noon;

  // ツールを何度も呼んで合算は上限を大きく超えても、最後のステップがちょうど上限なら切り替えない
  env.chatAt(at(noon, -2 * HOUR_MS), { input: 30, read: 450000, creation: 9000, context: 150000 });
  await env.rotate();
  assert.equal(env.runner.inputs.length, 0);

  // 上限を超えたターンの後に失敗したターンがあっても、最新の成功したターンで判定する
  env.chatAt(at(noon, -HOUR_MS), { input: 1, read: 140000, creation: 10000, context: 150001 });
  env.usage.record({ key: "inbox-1", sessionId: "session-1", ok: false, toolCalls: 0 });
  await env.rotate();

  assert.deepEqual(env.runner.inputs, [
    { prompt: ROTATE_PROMPT, sessionId: "session-1", context: undefined },
  ]);
  assert.deepEqual(env.state(), {
    rotatedDate: "2026-10-03",
    summary: { id: 2, guildId: "guild-1", date: "2026-10-03", summary: SUMMARY, createdAt: noon.toISOString() },
    session: undefined,
    seed: rotatedSeed(SUMMARY),
  });
  assert.deepEqual(env.gateway.events, [{ method: "sendMessage", channelId: "inbox-1", text: ROTATED_NOTICE }]);
  assert.deepEqual(env.logs, [
    "#inbox の会話を要約して新しいセッションに切り替えました（guild=guild-1、直近の入力 150001 トークン）",
  ]);

  // 要約のターン自身（最後のステップの入力 201005）の記録では切り替えない（SDK セッションを記録した失敗のターンの後でも）。新しいセッションの小さいターンでも切り替えない
  env.clock.now = at(noon, 5 * MINUTE_MS);
  await env.rotate();
  env.sessions.set("inbox-1", "session-2");
  env.usage.record({ key: "inbox-1", sessionId: "session-2", ok: false, toolCalls: 0 });
  await env.rotate();
  env.chatAt(at(noon, 6 * MINUTE_MS), SMALL, "inbox-1", "session-2");
  env.clock.now = at(noon, 10 * MINUTE_MS);
  await env.rotate();
  assert.equal(env.runner.inputs.length, 1);
});

test("サイズ: 上限を超えた後に小さい成功したターンがあれば、最新のほうで判定して切り替えない。SDK セッションが無ければ切り替えない", async (t) => {
  const env = setup(t, [], { rotatedDate: "2026-10-03", maxInputTokens: 1000 });
  env.clock.now = at(ROTATE_AT, 8 * HOUR_MS);
  env.chatAt(at(ROTATE_AT, 6 * HOUR_MS), { ...SMALL, context: 1001 });
  env.chatAt(at(ROTATE_AT, 7 * HOUR_MS), { ...SMALL, context: 1000 });

  await env.rotate();
  assert.deepEqual(env.queue.keys, []);

  // 最新が上限を超えていても、SDK セッションが無ければ（切り替える会話が無い）何もしない
  env.chatAt(at(ROTATE_AT, 7.5 * HOUR_MS), { ...SMALL, context: 5000 });
  env.sessions.delete("inbox-1");
  await env.rotate();
  assert.deepEqual(env.queue.keys, []);
  assert.deepEqual(env.logs, []);
});

test("対象は許可サーバーのうち /setup 済み（DB に #inbox がある）のサーバーだけ。env の #inbox で受け付けているサーバーには何もしない", async (t) => {
  const env = setup(t, [], { allowedGuildIds: ["guild-2", "guild-3"] });
  // guild-2 は /setup 前（env の #inbox）、guild-3 は #inbox を作る前に止まった
  env.chatAt(at(ROTATE_AT, -HOUR_MS), undefined, "env-inbox");
  env.guildSettings.setChannel("guild-3", "systemChannelId", "system-3");
  // guild-1 は /setup 済みだが許可サーバーではない
  env.chatAt(at(ROTATE_AT, -HOUR_MS));

  await env.rotate();

  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.queue.keys, []);
  // env の #inbox のサーバーに guild_settings の行を作らない（作ると /setup 済み扱いになる）
  assert.equal(env.guildSettings.get("guild-2"), undefined);
  assert.equal(env.guildSettings.get("guild-3")?.inboxRotatedDate, null);
  assert.equal(env.state().rotatedDate, "2026-10-02");
  assert.equal(env.sessions.get("env-inbox"), "session-1");
  assert.deepEqual(env.logs, []);
});

test("複数のサーバーは 1 つずつ切り替え、1 つが失敗しても残りは切り替える", async (t) => {
  const env = setup(t, [FAILED, ok(SUMMARY, "session-2")], { allowedGuildIds: ["guild-1", "guild-2"] });
  env.guildSettings.setChannel("guild-2", "inboxChannelId", "inbox-2");
  env.chatAt(at(ROTATE_AT, -HOUR_MS));
  env.chatAt(at(ROTATE_AT, -HOUR_MS), undefined, "inbox-2", "session-2");

  await env.rotate();

  assert.deepEqual(
    env.runner.inputs.map((input) => input.sessionId),
    ["session-1", "session-2"],
  );
  assert.equal(env.state().rotatedDate, "2026-10-02");
  assert.equal(env.guildSettings.get("guild-2")?.inboxRotatedDate, "2026-10-03");
  assert.equal(env.inboxSummaries.latest("guild-2")?.summary, SUMMARY);
  assert.equal(env.sessions.get("inbox-2"), undefined);
  assert.equal(env.seeds.get("inbox-2"), rotatedSeed(SUMMARY));
  assert.deepEqual(env.gateway.events, [{ method: "sendMessage", channelId: "inbox-2", text: ROTATED_NOTICE }]);
});

test("停止: 停止を始めていたら切り替えを始めない。キュー待ちの間に停止を始めたら、そのサーバーも残りのサーバーも何もしない", async (t) => {
  const env = setup(t, [], { allowedGuildIds: ["guild-1", "guild-2"] });
  env.guildSettings.setChannel("guild-2", "inboxChannelId", "inbox-2");
  env.chatAt(at(ROTATE_AT, -HOUR_MS));
  env.chatAt(at(ROTATE_AT, -HOUR_MS), undefined, "inbox-2", "session-2");

  await env.rotator.rotateDue(() => true);
  assert.deepEqual(env.queue.keys, []);

  // #inbox のキューに先客（発言のターン）がいる間に停止を始める
  const userTurn = deferred();
  const occupied = env.queue.run("inbox-1", () => userTurn.promise);
  let stopping = false;
  const rotating = env.rotator.rotateDue(() => stopping);
  await flush();
  stopping = true;
  userTurn.resolve();
  await Promise.all([occupied, rotating]);

  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.queue.keys, ["inbox-1", "inbox-1"]);
  assert.equal(env.state().rotatedDate, "2026-10-02");
  assert.equal(env.guildSettings.get("guild-2")?.inboxRotatedDate, null);
  assert.deepEqual(env.logs, []);
});
