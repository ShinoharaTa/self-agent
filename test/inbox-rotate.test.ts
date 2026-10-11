import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import type { RunResult } from "../src/agent/runner.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { createHandler } from "../src/app/handler.ts";
import {
  InboxRotator,
  ROTATE_PROMPT,
  ROTATED_NOTICE,
  ROTATED_NOTICE_FRESH,
  TASKS_ROTATE_PROMPT,
} from "../src/app/inbox-rotate.ts";
import { buildTurnPrompt } from "../src/app/prompt.ts";
import { rotatedSeed } from "../src/app/summary.ts";
import { RESUME_FAILURE_LIMIT, type TurnDeps } from "../src/app/turn.ts";
import type { TimeOfDay } from "../src/config.ts";
import type { IncomingMessage } from "../src/discord/gateway.ts";
import type { SummaryChannelKind } from "../src/store/inbox-summaries.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingQueue } from "./helpers/recording.ts";
import { FakeRunner } from "./helpers/runner.ts";

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

const CHANNEL_OF: Record<SummaryChannelKind, string> = { inbox: "inbox-1", tasks: "tasks-1" };

type Options = {
  timeZone?: string;
  rotateAt?: TimeOfDay;
  maxInputTokens?: number;
  allowedGuildIds?: string[];
  /** guild-1 の最後に切り替えた日。既定は前日（2026-10-02）。null はまだ一度も切り替えていない（時刻も無い） */
  rotatedDate?: string | null;
  /** guild-1 に #inbox（inbox-1）があるか。既定 true */
  inbox?: boolean;
  /** 指定すれば guild-1 に #tasks（tasks-1）を作り、最後に切り替えた時刻を記録する。null はまだ一度も切り替えていない。既定は #tasks なし */
  tasksRotatedAt?: Date | null;
};

/** 切り替えた日の 04:00 JST（setup で記録する、前回の切り替えの時刻） */
function rotatedAtOf(date: string): Date {
  return new Date(`${date}T04:00:00+09:00`);
}

function setup(t: TestContext, results: Array<RunResult | Error> = [], options: Options = {}) {
  const db = tempDb(t);
  const clock = { now: ROTATE_AT };
  const now = (): Date => clock.now;
  const { guildSettings, inboxSummaries, sessions, seeds, usage, topicSessions, memories } = createStores(db, now);
  const runner = new FakeRunner(results);
  const gateway = new FakeGateway({
    allow: ["start", "startTyping", "isInGuild", "registerGuildCommands", "stop"],
    record: ["send", "sendMessage"],
  });
  /** 発言の返信（send）と切り替えの知らせ（sendMessage）を順に、本文だけで */
  const events = () =>
    gateway.calls.flatMap<{ method: "send" | "sendMessage"; channelId: string; text: string }>((call) => {
      if (call.method === "send") return [call];
      if (call.method === "sendMessage") return [{ method: call.method, channelId: call.channelId, text: call.message.text }];
      return [];
    });
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
  const turn: TurnDeps = { runner, sessions, seeds, topicSessions, inboxSummaries, memories, usage, log };
  const rotator = new InboxRotator({ cfg, guildSettings, inboxSummaries, turnQueue: queue, turn, gateway, now, log });

  // guild-1 は /setup 済み（#inbox は inbox-1。#tasks は tasks-1）
  if (options.inbox ?? true) guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  const rotatedDate = options.rotatedDate === undefined ? "2026-10-02" : options.rotatedDate;
  if (rotatedDate !== null) guildSettings.setInboxRotated("guild-1", rotatedDate, rotatedAtOf(rotatedDate));
  if (options.tasksRotatedAt !== undefined) {
    guildSettings.setChannel("guild-1", "tasksChannelId", "tasks-1");
    if (options.tasksRotatedAt !== null) guildSettings.setTasksRotated("guild-1", options.tasksRotatedAt);
  }

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
      memories,
      channelOps: { enqueueMove: () => assert.fail("想定外の呼び出し") },
      usage,
      queue,
      now: () => clock.now,
      log,
    }).handleMessage;
  /** guild-1 の切り替えまわりの状態 */
  const state = () => ({
    rotatedDate: guildSettings.get("guild-1")?.inboxRotatedDate ?? null,
    summary: inboxSummaries.latest("guild-1"),
    session: sessions.get("inbox-1"),
    seed: seeds.get("inbox-1"),
  });
  /** guild-1 の #inbox か #tasks の切り替えまわりの状態（前回の切り替えの時刻・その種類の直近の要約・SDK セッション・seed） */
  const view = (kind: SummaryChannelKind) => {
    const settings = guildSettings.get("guild-1");
    const channelId = CHANNEL_OF[kind];
    return {
      rotatedAt: (kind === "inbox" ? settings?.inboxRotatedAt : settings?.tasksRotatedAt) ?? null,
      summary: inboxSummaries.latest("guild-1", kind),
      session: sessions.get(channelId),
      seed: seeds.get(channelId),
    };
  };
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
    events,
    queue,
    logs,
    rotator,
    chatAt,
    handler,
    state,
    view,
    rotate: (): Promise<void> => rotator.rotateDue(() => false),
  };
}

function message(content: string, createdAt: Date, channelId: string = "inbox-1"): IncomingMessage {
  return {
    id: `message-${createdAt.getTime()}`,
    channelId,
    guildId: "guild-1",
    authorId: "owner-1",
    authorIsBot: false,
    isWebhook: false,
    content,
    createdAt,
  };
}

/** #inbox 版と #tasks 版の違い（チャンネル・要約を頼む prompt・setup の options）。同じ規則なので、どちらも同じテストで確かめる */
const KINDS = [
  {
    kind: "inbox",
    other: "tasks",
    channelId: "inbox-1",
    prompt: ROTATE_PROMPT,
    /** 前回の切り替えは前日（10/02 04:00 JST） */
    options: {},
    /** 今日（10/03 04:00 JST）切り替え済み */
    rotatedToday: { rotatedDate: "2026-10-03" },
    /** まだ一度も切り替えていない */
    firstTime: { rotatedDate: null },
  },
  {
    kind: "tasks",
    other: "inbox",
    channelId: "tasks-1",
    prompt: TASKS_ROTATE_PROMPT,
    options: { inbox: false, tasksRotatedAt: rotatedAtOf("2026-10-02") },
    rotatedToday: { inbox: false, tasksRotatedAt: ROTATE_AT },
    firstTime: { inbox: false, tasksRotatedAt: null },
  },
] as const satisfies ReadonlyArray<{
  kind: SummaryChannelKind;
  other: SummaryChannelKind;
  channelId: string;
  prompt: string;
  options: Options;
  rotatedToday: Options;
  firstTime: Options;
}>;

/** log は件数だけ確かめる。チャンネル ID・要約の本文は出さない */
function assertLogs(logs: string[], count: number, label?: string): void {
  assert.equal(logs.length, count, `${label ?? ""}\n${logs.join("\n")}`);
  for (const line of logs) {
    for (const secret of ["inbox-1", "tasks-1", "金曜までに見積もり"]) {
      assert.ok(!line.includes(secret), `${label ?? ""}: ${line}`);
    }
  }
}

test("日次: rotateAt（04:00 JST）の直前は切り替えず、ちょうどから切り替える", async (t) => {
  for (const k of KINDS) {
    const env = setup(t, [ok(SUMMARY)], k.options);
    env.chatAt(at(ROTATE_AT, -HOUR_MS), SMALL, k.channelId);

    env.clock.now = at(ROTATE_AT, -1);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 0, k.kind);
    assert.deepEqual(env.queue.keys, [], k.kind);
    assert.equal(env.view(k.kind).rotatedAt, rotatedAtOf("2026-10-02").toISOString(), k.kind);

    env.clock.now = ROTATE_AT;
    await env.rotate();
    assert.equal(env.runner.inputs.length, 1, k.kind);
    assert.equal(env.view(k.kind).rotatedAt, ROTATE_AT.toISOString(), k.kind);
  }
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

test("日次: まだ一度も切り替えていない（/setup 直後・更新直後）は、今を基準として記録するだけで切り替えない。翌日の rotateAt から切り替える", async (t) => {
  for (const k of KINDS) {
    const env = setup(t, [ok(SUMMARY)], k.firstTime);
    env.chatAt(at(ROTATE_AT, 5 * HOUR_MS), SMALL, k.channelId);

    // rotateAt を過ぎていても、最初の tick は基準を記録するだけ（LLM を呼ばない・知らせない）
    env.clock.now = at(ROTATE_AT, 6 * HOUR_MS);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 0, k.kind);
    assert.deepEqual(env.queue.keys, [], k.kind);
    assert.deepEqual(env.events(), [], k.kind);
    assert.deepEqual(env.logs, [], k.kind);
    assert.equal(env.view(k.kind).rotatedAt, at(ROTATE_AT, 6 * HOUR_MS).toISOString(), k.kind);

    // 同じ日の後の tick でも切り替えない
    env.chatAt(at(ROTATE_AT, 7 * HOUR_MS), SMALL, k.channelId);
    env.clock.now = at(ROTATE_AT, 8 * HOUR_MS);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 0, k.kind);

    // 翌日の rotateAt を過ぎたら切り替える
    env.clock.now = at(ROTATE_AT, 24 * HOUR_MS);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 1, k.kind);
    assert.equal(env.view(k.kind).summary?.date, "2026-10-04", k.kind);
  }
});

test("会話なし: 前回の切り替えの時刻（最後の要約の時刻ではない）より後にそのチャンネルのターンが無い・SDK セッションが無ければ、LLM を呼ばずに切り替えた時刻だけ記録する（SDK セッションも seed もそのまま）", async (t) => {
  for (const k of KINDS) {
    const env = setup(t, [], k.options);
    // 要約は前回の切り替えより前に残したもの。要約の時刻を基準にすると、その後のターンを数えてしまう
    env.clock.now = at(ROTATE_AT, -30 * HOUR_MS);
    env.inboxSummaries.add("guild-1", "2026-10-01", "前回の要約", k.kind);
    env.clock.now = ROTATE_AT;
    // 前回の切り替えの時刻（10/02 04:00 JST = 24 時間前）ちょうどまでのターンは数えない。もう一方のチャンネルのターンも数えない
    env.chatAt(at(ROTATE_AT, -25 * HOUR_MS), SMALL, k.channelId);
    env.chatAt(at(ROTATE_AT, -24 * HOUR_MS), SMALL, k.channelId);
    env.chatAt(at(ROTATE_AT, -HOUR_MS), SMALL, CHANNEL_OF[k.other]);
    env.seeds.set(k.channelId, rotatedSeed("前回の要約", k.kind));

    await env.rotate();

    assert.equal(env.runner.inputs.length, 0, k.kind);
    assert.deepEqual(env.queue.keys, [k.channelId], k.kind);
    const view = env.view(k.kind);
    assert.equal(view.rotatedAt, ROTATE_AT.toISOString(), k.kind);
    assert.equal(view.summary?.summary, "前回の要約", k.kind);
    assert.equal(view.session, "session-1", k.kind);
    assert.equal(view.seed, rotatedSeed("前回の要約", k.kind), k.kind);
    assert.deepEqual(env.events(), [], k.kind);
    assertLogs(env.logs, 1, k.kind);

    // 翌日: ターンはあっても SDK セッションが無ければ同じ
    env.chatAt(at(ROTATE_AT, HOUR_MS), SMALL, k.channelId);
    env.sessions.delete(k.channelId);
    env.clock.now = at(ROTATE_AT, 24 * HOUR_MS);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 0, k.kind);
    assert.equal(env.view(k.kind).rotatedAt, at(ROTATE_AT, 24 * HOUR_MS).toISOString(), k.kind);
    assert.equal(env.view(k.kind).seed, rotatedSeed("前回の要約", k.kind), k.kind);

    // 記録したので、その日はもう何もしない
    env.clock.now = at(ROTATE_AT, 24 * HOUR_MS + 5 * MINUTE_MS);
    await env.rotate();
    assert.equal(env.queue.keys.length, 2, k.kind);
  }
});

test("切り替え: 要約のターン → 要約を保存 → SDK セッションを捨てる → seed → 切り替えた時刻 → そのチャンネルに知らせる", async (t) => {
  for (const k of KINDS) {
    const env = setup(t, [ok(`  ${SUMMARY}\n`)], k.options);
    env.chatAt(at(ROTATE_AT, -HOUR_MS), SMALL, k.channelId);
    // 知らせを投稿する時点で DB の更新は済んでいる
    const atNotice: unknown[] = [];
    env.gateway.beforeSendMessage = () => {
      atNotice.push(env.view(k.kind));
    };

    await env.rotate();

    // 要約のターンには context を渡さない（session_report・session_open は使えない）。WebFetch に許す URL も無い
    assert.deepEqual(
      env.runner.inputs,
      [{ prompt: k.prompt, sessionId: "session-1", context: undefined, allowedUrls: [] }],
      k.kind,
    );
    assert.deepEqual(env.queue.keys, [k.channelId], k.kind);
    const expected = {
      rotatedAt: ROTATE_AT.toISOString(),
      summary: { id: 1, guildId: "guild-1", date: "2026-10-03", summary: SUMMARY, createdAt: ROTATE_AT.toISOString() },
      session: undefined,
      seed: rotatedSeed(SUMMARY, k.kind),
    };
    assert.deepEqual(atNotice, [expected], k.kind);
    assert.deepEqual(env.view(k.kind), expected, k.kind);
    // もう一方の種類の要約としては読まない
    assert.equal(env.inboxSummaries.latest("guild-1", k.other), undefined, k.kind);
    assert.deepEqual(env.events(), [{ method: "sendMessage", channelId: k.channelId, text: ROTATED_NOTICE }], k.kind);
    // 要約のターンも usage に記録する
    const [entry] = env.usage.recent(1);
    assert.equal(entry?.key, k.channelId, k.kind);
    assert.equal(entry?.ok, true, k.kind);
    assert.equal(entry?.at, ROTATE_AT.toISOString(), k.kind);
    assert.equal(entry?.contextTokens, 2310, k.kind);
    assertLogs(env.logs, 1, k.kind);

    // 切り替えた後の tick では何もしない（要約のターンの記録でまた切り替えない）
    env.clock.now = at(ROTATE_AT, 5 * MINUTE_MS);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 1, k.kind);
    assert.equal(env.events().length, 1, k.kind);
  }
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

test("切り替え: 要約が次の発言の最初のターンの prompt の先頭に付き（新しいセッション）、成功したら seed を消す。切り替え中の発言は切り替えの後に処理する", async (t) => {
  for (const k of KINDS) {
    const env = setup(t, [ok(SUMMARY), ok("10 時からです", "session-2"), ok("どういたしまして", "session-2")], k.options);
    env.chatAt(at(ROTATE_AT, -HOUR_MS), SMALL, k.channelId);
    const summaryTurn = deferred();
    env.runner.gates[0] = summaryTurn.promise;
    const handle = env.handler();

    const rotating = env.rotate();
    await flush();
    assert.equal(env.runner.inputs.length, 1, k.kind);
    // 要約のターンの途中に来た発言は、同じキュー（key はそのチャンネル）で待つ
    const first = message("明日の予定は？", at(ROTATE_AT, MINUTE_MS), k.channelId);
    const replying = handle(first);
    await flush();
    assert.equal(env.runner.inputs.length, 1, k.kind);

    summaryTurn.resolve();
    await Promise.all([rotating, replying]);
    const second = message("ありがとう", at(ROTATE_AT, 2 * MINUTE_MS), k.channelId);
    await handle(second);

    assert.deepEqual(
      env.runner.inputs.map((input) => [input.prompt, input.sessionId]),
      [
        [k.prompt, "session-1"],
        [`${rotatedSeed(SUMMARY, k.kind)}\n\n${buildTurnPrompt(first.content, first.createdAt, "Asia/Tokyo", k.kind)}`, undefined],
        [buildTurnPrompt(second.content, second.createdAt, "Asia/Tokyo", k.kind), "session-2"],
      ],
      k.kind,
    );
    assert.deepEqual(env.queue.keys, [k.channelId, k.channelId, k.channelId], k.kind);
    assert.equal(env.view(k.kind).seed, undefined, k.kind);
    assert.equal(env.view(k.kind).session, "session-2", k.kind);
    // 知らせは発言への返信より先
    assert.deepEqual(
      env.events().map((event) => `${event.method}:${event.text}`),
      [`sendMessage:${ROTATED_NOTICE}`, "send:10 時からです", "send:どういたしまして"],
      k.kind,
    );
  }
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

  assert.deepEqual(env.runner.inputs[1], { prompt: ROTATE_PROMPT, sessionId: "session-2", context: undefined, allowedUrls: [] });
  assert.deepEqual(env.queue.keys, ["inbox-1", "inbox-1"]);
  assert.deepEqual(
    env.events().map((event) => `${event.method}:${event.text}`),
    ["send:了解です", `sendMessage:${ROTATED_NOTICE}`],
  );
  assert.equal(env.state().session, undefined);
  assert.equal(env.state().rotatedDate, "2026-10-03");
});

test("要約のターンが失敗したら何も変えずに log に出し、そのチャンネルは 1 時間経つまでやり直さない。失敗は #inbox と #tasks で別に数える", async (t) => {
  for (const k of KINDS) {
    // 同じ tick で #inbox → #tasks の順に切り替え、k のほうだけ失敗する
    const first = k.kind === "inbox" ? [FAILED, ok(SUMMARY)] : [ok(SUMMARY), FAILED];
    const env = setup(t, [...first, ok(SUMMARY)], { tasksRotatedAt: rotatedAtOf("2026-10-02") });
    env.chatAt(at(ROTATE_AT, -HOUR_MS), SMALL, "inbox-1");
    env.chatAt(at(ROTATE_AT, -HOUR_MS), SMALL, "tasks-1");

    await env.rotate();

    assert.deepEqual(env.queue.keys, ["inbox-1", "tasks-1"], k.kind);
    assert.deepEqual(
      env.view(k.kind),
      { rotatedAt: rotatedAtOf("2026-10-02").toISOString(), summary: undefined, session: "session-1", seed: undefined },
      k.kind,
    );
    // もう一方は切り替わる
    assert.equal(env.view(k.other).session, undefined, k.kind);
    assert.deepEqual(
      env.events().map((event) => event.channelId),
      [CHANNEL_OF[k.other]],
      k.kind,
    );
    assertLogs(env.logs, 2, k.kind);
    // 失敗したターンも usage に残る。resume の連続失敗には数えない
    assert.ok(env.usage.recent(2).some((entry) => entry.key === k.channelId && !entry.ok), k.kind);
    assert.equal(env.sessions.failureCount(k.channelId), 0, k.kind);

    // 1 時間に 1 ms 足りなければやり直さない
    env.clock.now = at(ROTATE_AT, HOUR_MS - 1);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 2, k.kind);

    // ちょうど 1 時間後にやり直す
    env.clock.now = at(ROTATE_AT, HOUR_MS);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 3, k.kind);
    assert.deepEqual(
      env.runner.inputs[2],
      { prompt: k.prompt, sessionId: "session-1", context: undefined, allowedUrls: [] },
      k.kind,
    );
    assert.equal(env.view(k.kind).summary?.summary, SUMMARY, k.kind);
    assert.equal(env.view(k.kind).rotatedAt, at(ROTATE_AT, HOUR_MS).toISOString(), k.kind);
  }
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

test("会話の記録が無い（No conversation found）なら要約を作らずに SDK セッションを捨て、同じ種類の直近の要約を seed にして知らせる。もう一方の種類の要約は引き継がない", async (t) => {
  for (const k of KINDS) {
    for (const carried of [true, false]) {
      const label = `${k.kind} ${carried ? "前回の要約あり" : "前回の要約なし"}`;
      const env = setup(t, [RESUME_FAILURE], k.options);
      if (carried) {
        env.clock.now = at(ROTATE_AT, -30 * HOUR_MS);
        env.inboxSummaries.add("guild-1", "2026-10-01", "前回の要約", k.kind);
      }
      // もう一方の種類の要約はそれより新しい
      env.clock.now = at(ROTATE_AT, -24 * HOUR_MS);
      env.inboxSummaries.add("guild-1", "2026-10-02", "もう一方の要約", k.other);
      env.clock.now = ROTATE_AT;
      env.chatAt(at(ROTATE_AT, -HOUR_MS), SMALL, k.channelId);

      await env.rotate();

      // 新しいセッションで要約し直さない（空の会話の要約を保存しない）
      assert.equal(env.runner.inputs.length, 1, label);
      assert.equal(Number(env.db.prepare("SELECT COUNT(*) AS n FROM inbox_summaries").get()?.n), carried ? 2 : 1, label);
      const view = env.view(k.kind);
      assert.equal(view.rotatedAt, ROTATE_AT.toISOString(), label);
      assert.equal(view.session, undefined, label);
      assert.equal(view.seed, carried ? rotatedSeed("前回の要約", k.kind) : undefined, label);
      assert.deepEqual(
        env.events(),
        [{ method: "sendMessage", channelId: k.channelId, text: carried ? ROTATED_NOTICE : ROTATED_NOTICE_FRESH }],
        label,
      );
      assert.equal(env.usage.recent(1)[0]?.ok, false, label);
      assertLogs(env.logs, 1, label);

      // その日はもう切り替えない
      env.clock.now = at(ROTATE_AT, 5 * MINUTE_MS);
      await env.rotate();
      assert.equal(env.runner.inputs.length, 1, label);
    }
  }
});

test("要約のターンが例外で終わっても何も変えずに log に出し、1 時間経つまでやり直さない", async (t) => {
  for (const k of KINDS) {
    const env = setup(t, [new Error("spawn failed"), ok(SUMMARY)], k.options);
    env.chatAt(at(ROTATE_AT, -HOUR_MS), SMALL, k.channelId);

    await env.rotate();

    assert.deepEqual(
      env.view(k.kind),
      { rotatedAt: rotatedAtOf("2026-10-02").toISOString(), summary: undefined, session: "session-1", seed: undefined },
      k.kind,
    );
    assertLogs(env.logs, 1, k.kind);
    assert.ok(env.logs[0]?.includes("spawn failed"), k.kind);

    env.clock.now = at(ROTATE_AT, HOUR_MS - 1);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 1, k.kind);
    env.clock.now = at(ROTATE_AT, HOUR_MS);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 2, k.kind);
    assert.equal(env.view(k.kind).seed, rotatedSeed(SUMMARY, k.kind), k.kind);
  }
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
  // 切り替えの log と、投稿の失敗の log
  assertLogs(env.logs, 2);
  assert.ok(env.logs[1]?.includes("Missing Access"));
});

test("サイズ: 今日切り替え済みでも、前回の切り替えより後の最新の成功したターンの最後のステップの入力が上限を超えたら切り替える（各ステップの合算では判定しない）", async (t) => {
  for (const k of KINDS) {
    // 12:00 JST。今日（10/03）は切り替え済み
    const noon = at(ROTATE_AT, 8 * HOUR_MS);
    const env = setup(t, [ok(SUMMARY, "session-1", { input: 5, read: 200000, creation: 1000, context: 201005 })], k.rotatedToday);
    env.clock.now = noon;

    // ツールを何度も呼んで合算は上限を大きく超えても、最後のステップがちょうど上限なら切り替えない
    env.chatAt(at(noon, -2 * HOUR_MS), { input: 30, read: 450000, creation: 9000, context: 150000 }, k.channelId);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 0, k.kind);

    // 上限を超えたターンの後に失敗したターンがあっても、最新の成功したターンで判定する
    env.chatAt(at(noon, -HOUR_MS), { input: 1, read: 140000, creation: 10000, context: 150001 }, k.channelId);
    env.usage.record({ key: k.channelId, sessionId: "session-1", ok: false, toolCalls: 0 });
    await env.rotate();

    assert.deepEqual(
      env.runner.inputs,
      [{ prompt: k.prompt, sessionId: "session-1", context: undefined, allowedUrls: [] }],
      k.kind,
    );
    const view = env.view(k.kind);
    assert.equal(view.rotatedAt, noon.toISOString(), k.kind);
    assert.equal(view.summary?.summary, SUMMARY, k.kind);
    assert.equal(view.session, undefined, k.kind);
    assert.equal(view.seed, rotatedSeed(SUMMARY, k.kind), k.kind);
    assert.deepEqual(env.events(), [{ method: "sendMessage", channelId: k.channelId, text: ROTATED_NOTICE }], k.kind);
    assertLogs(env.logs, 1, k.kind);

    // 要約のターン自身（最後のステップの入力 201005）の記録では切り替えない（SDK セッションを記録した失敗のターンの後でも）。新しいセッションの小さいターンでも切り替えない
    env.clock.now = at(noon, 5 * MINUTE_MS);
    await env.rotate();
    env.sessions.set(k.channelId, "session-2");
    env.usage.record({ key: k.channelId, sessionId: "session-2", ok: false, toolCalls: 0 });
    await env.rotate();
    env.chatAt(at(noon, 6 * MINUTE_MS), SMALL, k.channelId, "session-2");
    env.clock.now = at(noon, 10 * MINUTE_MS);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 1, k.kind);
  }
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
  env.guildSettings.setInboxRotated("guild-2", "2026-10-02", rotatedAtOf("2026-10-02"));
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
  assert.deepEqual(env.events(), [{ method: "sendMessage", channelId: "inbox-2", text: ROTATED_NOTICE }]);
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

test("rotateNow（/renew）: 今日切り替え済みでも、失敗の後の 1 時間の待ちの間でも、判定を飛ばして同じキューで切り替える。知らせは投稿しない", async (t) => {
  for (const k of KINDS) {
    const env = setup(t, [FAILED, ok(`  ${SUMMARY}\n`)], k.rotatedToday);
    env.chatAt(at(ROTATE_AT, HOUR_MS), SMALL, k.channelId);
    env.clock.now = at(ROTATE_AT, 2 * HOUR_MS);
    assert.equal(await env.rotator.rotateNow("guild-1", k.kind), "failed", k.kind);

    const renewedAt = at(ROTATE_AT, 2 * HOUR_MS + MINUTE_MS);
    env.clock.now = renewedAt;
    assert.equal(await env.rotator.rotateNow("guild-1", k.kind), "rotated", k.kind);

    assert.deepEqual(
      env.runner.inputs[1],
      { prompt: k.prompt, sessionId: "session-1", context: undefined, allowedUrls: [] },
      k.kind,
    );
    // 発言と同じキューの同じ key で行う
    assert.deepEqual(env.queue.keys, [k.channelId, k.channelId], k.kind);
    assert.deepEqual(
      env.view(k.kind),
      {
        rotatedAt: renewedAt.toISOString(),
        summary: { id: 1, guildId: "guild-1", date: "2026-10-03", summary: SUMMARY, createdAt: renewedAt.toISOString() },
        session: undefined,
        seed: rotatedSeed(SUMMARY, k.kind),
      },
      k.kind,
    );
    // もう一方は変えない
    assert.equal(env.view(k.other).rotatedAt, k.kind === "inbox" ? null : rotatedAtOf("2026-10-02").toISOString(), k.kind);
    assert.deepEqual(env.events(), [], k.kind);
    assertLogs(env.logs, 2, k.kind);
  }
});

test("rotateNow（/renew）: SDK セッションが無ければ（ターンの記録があっても）LLM を呼ばずに no_conversation を返し、切り替えた日も時刻も記録しない（その日の日次の切り替えは行う）", async (t) => {
  // 02:00 JST（10/03）。前回は 10/02
  const early = at(ROTATE_AT, -2 * HOUR_MS);
  const env = setup(t, [ok(SUMMARY)]);
  env.chatAt(at(ROTATE_AT, -3 * HOUR_MS));
  env.sessions.delete("inbox-1");
  env.clock.now = early;

  assert.equal(await env.rotator.rotateNow("guild-1", "inbox"), "no_conversation");

  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.queue.keys, ["inbox-1"]);
  assert.deepEqual(env.state(), { rotatedDate: "2026-10-02", summary: undefined, session: undefined, seed: undefined });
  assert.equal(env.guildSettings.get("guild-1")?.inboxRotatedAt, rotatedAtOf("2026-10-02").toISOString());
  assert.deepEqual(env.events(), []);
  assert.deepEqual(env.logs, []);

  // その後に会話があれば、rotateAt（04:00）の日次の切り替えで要約する
  env.chatAt(at(ROTATE_AT, -HOUR_MS));
  env.clock.now = ROTATE_AT;
  await env.rotate();
  assert.equal(env.runner.inputs.length, 1);
  assert.equal(env.state().rotatedDate, "2026-10-03");
  assert.equal(env.state().seed, rotatedSeed(SUMMARY));
  assert.deepEqual(env.events(), [{ method: "sendMessage", channelId: "inbox-1", text: ROTATED_NOTICE }]);
  assertLogs(env.logs, 1);
});

test("rotateNow（/renew）: まだ一度も切り替えていなくても・前回の切り替えより後のターンが 0 件でも、SDK セッションがあれば要約して切り替える（rotateDue は要約しない）", async (t) => {
  const cases = KINDS.flatMap((k) => [
    { label: `${k.kind}: まだ一度も切り替えていない`, k, options: k.firstTime, chattedAt: at(ROTATE_AT, -HOUR_MS) },
    // ターンは前回の切り替え（10/02 04:00 JST）ちょうどまでで、その後は無い
    { label: `${k.kind}: 前回の切り替えより後のターンが 0 件`, k, options: k.options, chattedAt: at(ROTATE_AT, -24 * HOUR_MS) },
  ]);
  const now = at(ROTATE_AT, HOUR_MS);
  for (const { label, k, options, chattedAt } of cases) {
    const env = setup(t, [ok(SUMMARY)], options);
    env.chatAt(chattedAt, SMALL, k.channelId);
    env.clock.now = now;

    assert.equal(await env.rotator.rotateNow("guild-1", k.kind), "rotated", label);

    assert.deepEqual(
      env.runner.inputs,
      [{ prompt: k.prompt, sessionId: "session-1", context: undefined, allowedUrls: [] }],
      label,
    );
    const view = env.view(k.kind);
    assert.equal(view.session, undefined, label);
    assert.equal(view.seed, rotatedSeed(SUMMARY, k.kind), label);
    assert.equal(view.rotatedAt, now.toISOString(), label);
    assert.deepEqual(env.events(), [], label);

    // 同じ状態で rotateDue なら、要約せずに今を基準として（ターンが 0 件なら切り替えた時刻だけ）記録する
    const due = setup(t, [ok(SUMMARY)], options);
    due.chatAt(chattedAt, SMALL, k.channelId);
    due.clock.now = now;
    await due.rotate();
    assert.equal(due.runner.inputs.length, 0, label);
    assert.equal(due.view(k.kind).session, "session-1", label);
    assert.equal(due.view(k.kind).rotatedAt, now.toISOString(), label);
  }
});

test("rotateNow（/renew）: 結果を返す。要約の失敗・例外は何も変えずに failed（reject しない）で失敗の時刻を覚え、記録切れは要約を引き継げば rotated・無ければ rotated_fresh", async (t) => {
  const cases = [
    { label: "要約のターンが失敗", result: FAILED, carried: false, expected: "failed" },
    { label: "例外", result: new Error("spawn failed"), carried: false, expected: "failed" },
    { label: "記録切れ・前回の要約なし", result: RESUME_FAILURE, carried: false, expected: "rotated_fresh" },
    { label: "記録切れ・前回の要約あり", result: RESUME_FAILURE, carried: true, expected: "rotated" },
  ] as const;
  for (const { label, result, carried, expected } of cases) {
    const env = setup(t, [result, ok(SUMMARY)]);
    if (carried) {
      env.clock.now = at(ROTATE_AT, -24 * HOUR_MS);
      env.inboxSummaries.add("guild-1", "2026-10-02", "前回の要約");
      env.clock.now = ROTATE_AT;
    }
    env.chatAt(at(ROTATE_AT, -HOUR_MS));

    assert.equal(await env.rotator.rotateNow("guild-1", "inbox"), expected, label);

    assert.deepEqual(env.events(), [], label);
    assertLogs(env.logs, 1, label);
    if (expected !== "failed") {
      assert.equal(env.state().rotatedDate, "2026-10-03", label);
      assert.equal(env.state().session, undefined, label);
      assert.equal(env.state().seed, carried ? rotatedSeed("前回の要約") : undefined, label);
      continue;
    }
    assert.deepEqual(
      env.state(),
      { rotatedDate: "2026-10-02", summary: undefined, session: "session-1", seed: undefined },
      label,
    );
    // rotateDue は 1 時間やり直さない
    env.clock.now = at(ROTATE_AT, HOUR_MS - 1);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 1, label);
    env.clock.now = at(ROTATE_AT, HOUR_MS);
    await env.rotate();
    assert.equal(env.runner.inputs.length, 2, label);
    assert.equal(env.state().rotatedDate, "2026-10-03", label);
  }
});

test("rotateNow（/renew）: /setup していないサーバー・そのチャンネルが無いサーバーでは not_set_up を返し、何もしない", async (t) => {
  const env = setup(t, [], { allowedGuildIds: ["guild-1", "guild-2"] });

  assert.equal(await env.rotator.rotateNow("guild-2", "inbox"), "not_set_up");
  // guild-1 には #tasks が無い
  assert.equal(await env.rotator.rotateNow("guild-1", "tasks"), "not_set_up");

  const noInbox = setup(t, [], { inbox: false, tasksRotatedAt: ROTATE_AT });
  assert.equal(await noInbox.rotator.rotateNow("guild-1", "inbox"), "not_set_up");

  assert.equal(env.runner.inputs.length + noInbox.runner.inputs.length, 0);
  assert.deepEqual([...env.queue.keys, ...noInbox.queue.keys], []);
  assert.deepEqual([...env.logs, ...noInbox.logs], []);
});
