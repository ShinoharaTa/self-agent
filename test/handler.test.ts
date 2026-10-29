import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { RunContext, RunInput, RunResult } from "../src/agent/runner.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { createTurnControlsComponent, STALE_TURN_REPLY } from "../src/app/commands/turn-controls.ts";
import {
  ABORTED_REPLY,
  COMPACTED_NOTE,
  CONTINUE_PROMPT,
  createHandler,
  EMPTY_REPLY,
  FAILURE_REPLY,
  MAX_TURNS_REPLY,
  PROGRESS_DELAY_MS,
  PROGRESS_INTERVAL_MS,
  type ProgressTimers,
  REVIVED_NOTE,
} from "../src/app/handler.ts";
import { rotatedSeed } from "../src/app/summary.ts";
import { buildTurnPrompt } from "../src/app/prompt.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { RESUME_FAILURE_LIMIT, RESUME_SEED_HEADER } from "../src/app/turn.ts";
import type { IncomingMessage, Interaction } from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

const cfg = { allowedGuildIds: ["guild-1"], inboxChannelId: "inbox-1", ownerUserId: "owner-1", timeZone: "Asia/Tokyo" };
const NOW = new Date("2026-10-02T00:12:00Z");
// 発言の時刻（ストアの now とは別。prompt の日時ヘッダはこちらを使う）
const CREATED_AT = new Date("2026-10-01T23:59:00Z");

/** 偽のタイマー。advance で経過時間を進め、その間に来た after・every を時刻順に呼ぶ */
class FakeTimers implements ProgressTimers {
  elapsed = 0;
  private timers: Array<{ id: number; at: number; fn: () => void; interval?: number }> = [];
  private nextId = 1;

  after(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.push({ id, at: this.elapsed + ms, fn });
    return () => this.remove(id);
  }
  every(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.push({ id, at: this.elapsed + ms, fn, interval: ms });
    return () => this.remove(id);
  }

  /** 止めていないタイマーの数 */
  get pending(): number {
    return this.timers.length;
  }

  async advance(ms: number): Promise<void> {
    const target = this.elapsed + ms;
    for (;;) {
      await settle();
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.elapsed = due.at;
      if (due.interval === undefined) this.remove(due.id);
      else due.at += due.interval;
      due.fn();
    }
    this.elapsed = target;
    await settle();
  }

  private remove(id: number): void {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }
}

/** 実行中の非同期処理を進める */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: "message-1",
    channelId: "inbox-1",
    guildId: "guild-1",
    authorId: "owner-1",
    authorIsBot: false,
    isWebhook: false,
    content: "明日買い物に行く",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function okResult(sessionId: string, text: string): Extract<RunResult, { ok: true }> {
  return {
    ok: true,
    text,
    sessionId,
    usage: turnUsage(10, 2000, 300),
    durationMs: 4200,
    toolCalls: 3,
    // 3 回ツールを呼んだターンの最後のステップの入力（合算の usage より小さい）
    contextTokens: 900,
  };
}

/** options.history なら history を渡す（渡さなければ書かない） */
function setup(t: TestContext, results: Array<RunResult | Error>, options: { history?: boolean } = {}) {
  const db = tempDb(t);
  // sendMessage で送ったものの ID は posted-<n>
  const gateway = new FakeGateway({
    allow: ["start", "send", "sendMessage", "editMessage", "startTyping", "isInGuild", "registerGuildCommands", "stop"],
    messageIdPrefix: "posted-",
  });
  const runner = new FakeRunner(results);
  const { sessions, usage, seeds, inboxSummaries, memories, guildSettings, history } = createStores(db, () => NOW);
  // last_activity_at の更新を見るため、sessions の時計だけ進められるようにする
  const clock = { now: NOW };
  const { topicSessions } = createStores(db, () => clock.now);
  const channelOps = new RecordingChannelOps();
  const queue = new KeyedSerialQueue(2);
  const logs: string[] = [];
  // ターンのトークンの行（recordTurnUsage）は tokenLogs に分ける
  const tokenLogs: string[] = [];
  // 途中経過の経過時間は偽のタイマーの時刻で測る
  const timers = new FakeTimers();
  // guild_settings が空なので env の #inbox（inbox-1）を受け付ける
  const resolveChannel = createChannelResolver(cfg, guildSettings, topicSessions);
  const handler = createHandler({
    cfg,
    resolveChannel,
    gateway,
    runner,
    sessions,
    seeds,
    topicSessions,
    inboxSummaries,
    memories,
    channelOps,
    usage,
    queue,
    now: () => new Date(NOW.getTime() + timers.elapsed),
    timers,
    ...(options.history === true ? { history } : {}),
    log: (line) => (line.startsWith("トークン（") ? tokenLogs : logs).push(line),
  });
  const handle = handler.handleMessage;
  // [中断]・[続ける] のボタン（interactions.ts と同じく、この handler に渡す）
  const turnControls = createTurnControlsComponent({ resolveChannel, turns: handler, log: (line) => logs.push(line) });
  const press = async (customId: string, createdAt: Date = NOW): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    const interaction: Interaction = {
      kind: "button",
      customId,
      guildId: "guild-1",
      channelId: "topic-1",
      userId: "owner-1",
      createdAt,
      messageId: "posted-1",
    };
    await turnControls.handle(interaction, responder);
    return responder.calls;
  };
  return {
    db,
    gateway,
    runner,
    sessions,
    seeds,
    topicSessions,
    inboxSummaries,
    memories,
    channelOps,
    queue,
    clock,
    usage,
    logs,
    tokenLogs,
    timers,
    handler,
    handle,
    press,
    history,
  };
}

/** ツールのハンドラに渡す、このターンのチャンネル */
function context(channelId: string = "inbox-1"): RunContext {
  return { guildId: "guild-1", channelId, kind: channelId === "inbox-1" ? "inbox" : "session" };
}

/** resume 先の会話の記録が無いときの失敗（実機の文言は未確認） */
const RESUME_FAILURE: RunResult = {
  ok: false,
  errorMessage: "error_during_execution: No conversation found with session ID: session-old",
  sessionRecorded: false,
  toolCalls: 0,
};

/** result が届かなかった失敗（SDK が会話を記録したか分からない） */
const CRASH: RunResult = {
  ok: false,
  errorMessage: "exception: Error: Claude Code process exited with code 1",
  sessionRecorded: false,
  toolCalls: 0,
};

/** /new で作ったセッションのチャンネル（topic-1、guild-1、作成は NOW） */
const TOPIC = { channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" };

/** guild-1 を /setup 済み（#inbox は inbox-1、#tasks は tasks-1）にする。以後は env の #inbox ではなく DB のチャンネルで受け付ける */
function setUpGuild(db: ReturnType<typeof openDb>): GuildSettingsStore {
  const { guildSettings } = createStores(db, () => NOW);
  guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  guildSettings.setChannel("guild-1", "tasksChannelId", "tasks-1");
  return guildSettings;
}

const TASKS_CONTEXT: RunContext = { guildId: "guild-1", channelId: "tasks-1", kind: "tasks" };

test("受け付けた発言で runner を呼び、usage 記録・session 保存・返信をする", async (t) => {
  const { gateway, runner, sessions, usage, logs, tokenLogs, handle } = setup(t, [okResult("session-1", "登録しました")]);
  // 返信の時点で usage と session は記録済み
  gateway.beforeSend = () => {
    assert.equal(usage.recent(10).length, 1);
    assert.equal(sessions.get("inbox-1"), "session-1");
  };

  await handle(message());

  assert.deepEqual(runner.inputs, [
    { prompt: buildTurnPrompt("明日買い物に行く", CREATED_AT, "Asia/Tokyo"), sessionId: undefined, context: context(), allowedUrls: [] },
  ]);
  assert.deepEqual(gateway.sent, [{ channelId: "inbox-1", text: "登録しました", replyToId: "message-1" }]);
  assert.equal(sessions.get("inbox-1"), "session-1");
  assert.deepEqual(usage.recent(10), [
    {
      id: 1,
      at: NOW.toISOString(),
      key: "inbox-1",
      sessionId: "session-1",
      ok: true,
      durationMs: 4200,
      inputTokens: 10,
      cacheReadInputTokens: 2000,
      cacheCreationInputTokens: 300,
      compacted: false,
      toolCalls: 3,
      contextTokens: 900,
      kind: "inbox",
      // 偽の結果に出力の合計が無いので NULL
      outputTokens: null,
      cacheCreation1hInputTokens: 0,
      steps: turnUsage(10, 2000, 300).steps,
    },
  ]);
  assert.equal(gateway.typingStarted, 1);
  assert.equal(gateway.typingStopped, 1);
  assert.deepEqual(logs, []);
  // トークンの行は種類のラベルだけで、チャンネル ID は出さない
  assert.equal(tokenLogs.length, 1);
  assert.match(tokenLogs[0]!, /^トークン（inbox・成功）: /);
  assert.ok(!tokenLogs[0]!.includes("inbox-1"));
});

test("2 ターン目は保存した sessionId で resume する。#inbox と /setup 済みの #tasks で同じ（context の kind とヘッダのチャンネル名はそれぞれ）", async (t) => {
  const cases = [
    { label: "#inbox", channelId: "inbox-1", channelName: "inbox", context: context() },
    { label: "#tasks", channelId: "tasks-1", channelName: "tasks", context: TASKS_CONTEXT },
  ];
  for (const c of cases) {
    const { db, gateway, runner, sessions, handle } = setup(t, [okResult("session-1", "1"), okResult("session-1", "2")]);
    setUpGuild(db);

    await handle(message({ id: "message-1", channelId: c.channelId }));
    await handle(message({ id: "message-2", channelId: c.channelId, content: "一覧を見せて" }));

    assert.deepEqual(
      runner.inputs,
      [
        {
          prompt: buildTurnPrompt("明日買い物に行く", CREATED_AT, "Asia/Tokyo", c.channelName),
          sessionId: undefined,
          context: c.context,
          allowedUrls: [],
        },
        {
          prompt: buildTurnPrompt("一覧を見せて", CREATED_AT, "Asia/Tokyo", c.channelName),
          sessionId: "session-1",
          context: c.context,
          allowedUrls: [],
        },
      ],
      c.label,
    );
    assert.deepEqual(
      gateway.sent.map((sent) => [sent.channelId, sent.replyToId]),
      [
        [c.channelId, "message-1"],
        [c.channelId, "message-2"],
      ],
      c.label,
    );
    assert.equal(sessions.get(c.channelId), "session-1", c.label);
  }
});

test("発言に貼った URL を、そのターンで WebFetch に許す URL（allowedUrls）として渡す。次の発言には引き継がない", async (t) => {
  const { runner, handle } = setup(t, [okResult("session-1", "読みました"), okResult("session-1", "はい")]);

  await handle(message({ id: "message-1", content: "これ読んで <https://example.com/a>、あと https://example.com/b。" }));
  await handle(message({ id: "message-2", content: "要点だけ教えて" }));

  assert.deepEqual(
    runner.inputs.map((input) => input.allowedUrls),
    [["https://example.com/a", "https://example.com/b"], []],
  );
});

test("ok:false（result が届かなかった失敗）なら usage に ok=0 で記録して失敗の返信をし、session は保存しない", async (t) => {
  const { gateway, sessions, usage, logs, handle } = setup(t, [
    { ok: false, errorMessage: "exception: Error: boom", sessionId: "session-x", sessionRecorded: false, toolCalls: 2 },
  ]);
  gateway.beforeSend = () => {
    assert.equal(usage.recent(10).length, 1);
  };

  await handle(message());

  assert.deepEqual(gateway.sent, [{ channelId: "inbox-1", text: FAILURE_REPLY, replyToId: "message-1" }]);
  assert.equal(sessions.get("inbox-1"), undefined);
  const [entry] = usage.recent(10);
  assert.equal(entry?.ok, false);
  assert.equal(entry?.sessionId, "session-x");
  assert.equal(entry?.inputTokens, null);
  // 失敗するまでのツール呼び出しも数える
  assert.equal(entry?.toolCalls, 2);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /exception: Error: boom/);
  assert.equal(gateway.typingStopped, 1);
});

test("返答が空なら「（返答が空でした）」を返信する", async (t) => {
  const { gateway, handle } = setup(t, [okResult("session-1", ""), okResult("session-1", " \n ")]);

  await handle(message({ id: "message-1" }));
  await handle(message({ id: "message-2" }));

  assert.deepEqual(
    gateway.sent.map((sent) => sent.text),
    [EMPTY_REPLY, EMPTY_REPLY],
  );
});

test("compaction が起きたターンは返信の末尾に 1 行足し、usage に compacted を記録して log に出す", async (t) => {
  const { gateway, usage, logs, handle } = setup(t, [
    { ...okResult("session-1", "登録しました"), compacted: { trigger: "auto", preTokens: 150000 } },
    { ...okResult("session-1", ""), compacted: { trigger: "manual" } },
    okResult("session-1", "次"),
  ]);

  await handle(message({ id: "message-1" }));
  await handle(message({ id: "message-2" }));
  await handle(message({ id: "message-3" }));

  assert.deepEqual(
    gateway.sent.map((sent) => sent.text),
    [`登録しました\n${COMPACTED_NOTE}`, `${EMPTY_REPLY}\n${COMPACTED_NOTE}`, "次"],
  );
  assert.deepEqual(
    usage.recent(10).map((entry) => entry.compacted),
    [false, true, true],
  );
  // log は compaction のターンだけ。チャンネル ID は出さない
  assert.equal(logs.length, 2);
  assert.ok(logs.every((line) => !line.includes("inbox-1")), logs.join("\n"));
});

test("返信に失敗しても usage と session は残し、log に出して終える", async (t) => {
  const { gateway, runner, sessions, usage, logs, handle } = setup(t, [
    okResult("session-1", "登録しました"),
    okResult("session-1", "次"),
  ]);
  gateway.beforeSend = () => {
    throw new Error("Unknown Message");
  };

  await handle(message({ id: "message-1" }));

  assert.equal(gateway.sent.length, 0);
  assert.equal(usage.recent(10).length, 1);
  assert.equal(sessions.get("inbox-1"), "session-1");
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /返信に失敗しました: Unknown Message/);

  // 後続のターンは止まらない
  gateway.beforeSend = () => {};
  await handle(message({ id: "message-2" }));
  assert.equal(runner.inputs[1]!.sessionId, "session-1");
  assert.deepEqual(gateway.sent.map((sent) => sent.text), ["次"]);
});

test("受け付けない発言（オーナー以外・削除済みのセッション）では runner を呼ばず何も送らず、last_activity_at も更新しない", async (t) => {
  // どの発言を受け付けるかは access.test.ts で確かめる。ここは弾いたときに何もしないことだけ
  const { db, gateway, runner, usage, topicSessions, clock, handle } = setup(t, []);
  topicSessions.create(TOPIC);
  db.prepare("UPDATE sessions SET state = 'deleted' WHERE channel_id = 'topic-1'").run();
  clock.now = new Date("2026-10-02T03:00:00Z");

  await handle(message({ authorId: "someone-else" }));
  await handle(message({ channelId: "topic-1" }));

  assert.equal(runner.inputs.length, 0);
  assert.deepEqual(gateway.sent, []);
  assert.equal(gateway.typingStarted, 0);
  assert.deepEqual(usage.recent(10), []);
  assert.equal(topicSessions.get("topic-1")?.lastActivityAt, NOW.toISOString());
});

test("処理中の例外は reject せず log に出し、入力中表示を止める", async (t) => {
  const { gateway, logs, handle } = setup(t, [new Error("unexpected")]);

  await handle(message());

  assert.equal(gateway.typingStarted, 1);
  assert.equal(gateway.typingStopped, 1);
  assert.deepEqual(gateway.sent, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /unexpected/);
});

test("セッションのチャンネル: 受け付けて日時ヘッダに題名を出し、会話はチャンネルごとに resume する", async (t) => {
  const { gateway, runner, sessions, topicSessions, handle } = setup(t, [
    okResult("session-a", "了解"),
    okResult("session-a", "続き"),
  ]);
  topicSessions.create(TOPIC);

  await handle(message({ id: "message-1", channelId: "topic-1", content: "行き先を決めたい" }));
  await handle(message({ id: "message-2", channelId: "topic-1", content: "予算は" }));

  assert.equal(runner.inputs.length, 2);
  assert.equal(runner.inputs[0]!.prompt, buildTurnPrompt("行き先を決めたい", CREATED_AT, "Asia/Tokyo", "旅行の計画"));
  assert.equal(runner.inputs[0]!.sessionId, undefined);
  assert.equal(runner.inputs[1]!.sessionId, "session-a");
  assert.deepEqual(runner.inputs[1]!.context, context("topic-1"));
  assert.equal(sessions.get("topic-1"), "session-a");
  assert.equal(sessions.get("inbox-1"), undefined);
  assert.deepEqual(gateway.sent, [
    { channelId: "topic-1", text: "了解", replyToId: "message-1" },
    { channelId: "topic-1", text: "続き", replyToId: "message-2" },
  ]);
});

test("同時実行: セッションのチャンネルのターンは枠を 1 つ #inbox・#tasks 用に残す（maxConcurrent 2 ならセッションは 1 つずつ、その間も #inbox・#tasks は動く）", async (t) => {
  const cases = [
    { label: "#inbox", channelId: "inbox-1", context: context() },
    { label: "#tasks", channelId: "tasks-1", context: TASKS_CONTEXT },
  ];
  for (const c of cases) {
    const { db, runner, topicSessions, handle } = setup(t, [
      okResult("session-a", "1"),
      okResult("session-i", "2"),
      okResult("session-b", "3"),
    ]);
    setUpGuild(db);
    topicSessions.create(TOPIC);
    topicSessions.create({ ...TOPIC, channelId: "topic-2", title: "引っ越し" });
    const releases: Array<() => void> = [];
    runner.beforeResult = () => new Promise<void>((resolve) => releases.push(resolve));
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    const topicA = handle(message({ id: "message-1", channelId: "topic-1" }));
    await flush();
    const topicB = handle(message({ id: "message-2", channelId: "topic-2" }));
    const other = handle(message({ id: "message-3", channelId: c.channelId }));
    await flush();

    // topic-2 は枠が空いていても待ち、後から来た #inbox・#tasks が動く
    assert.deepEqual(
      runner.inputs.map((input) => input.context),
      [context("topic-1"), c.context],
      c.label,
    );

    // topic-1 が終わると topic-2 が動く
    releases[0]!();
    await topicA;
    await flush();
    assert.deepEqual(
      runner.inputs.map((input) => input.context?.channelId),
      ["topic-1", c.channelId, "topic-2"],
      c.label,
    );
    for (const release of releases.slice(1)) release();
    await Promise.all([topicB, other]);
  }
});

test("セッションのチャンネル: 受け付けた発言の last_activity_at はキュー待ちの前に更新し、#inbox の発言では更新しない", async (t) => {
  const { runner, topicSessions, clock, handle } = setup(t, [
    okResult("session-a", "1"),
    okResult("session-a", "2"),
    okResult("session-b", "3"),
  ]);
  topicSessions.create(TOPIC);
  let release = (): void => {};
  runner.beforeResult = () => new Promise<void>((resolve) => (release = resolve));

  const first = handle(message({ id: "message-1", channelId: "topic-1" }));
  await new Promise((resolve) => setImmediate(resolve));
  clock.now = new Date("2026-10-02T03:00:00Z");
  const second = handle(message({ id: "message-2", channelId: "topic-1" }));

  // 1 つ目のターンが終わっておらず、2 つ目はキュー待ちでも更新済み
  assert.equal(runner.inputs.length, 1);
  assert.equal(topicSessions.get("topic-1")?.lastActivityAt, "2026-10-02T03:00:00.000Z");

  runner.beforeResult = async () => {};
  release();
  await Promise.all([first, second]);
  assert.equal(runner.inputs.length, 2);

  clock.now = new Date("2026-10-02T05:00:00Z");
  await handle(message({ id: "message-3", channelId: "inbox-1" }));
  assert.equal(runner.inputs.length, 3);
  assert.equal(topicSessions.get("topic-1")?.lastActivityAt, "2026-10-02T03:00:00.000Z");
});

test("待ち・完了のセッションでの発言: 進行中に戻して進行中カテゴリへの移動を入れ、ターンは通常どおり行い、返信の先頭で戻したことを知らせる", async (t) => {
  const { db, gateway, runner, topicSessions, channelOps, logs, handle } = setup(t, [
    okResult("session-a", "おかえりなさい"),
    okResult("session-b", "再開します"),
  ]);
  topicSessions.create(TOPIC);
  topicSessions.create({ ...TOPIC, channelId: "topic-2" });
  topicSessions.setWaiting("topic-1");
  topicSessions.close("topic-2", "閉じたときの要約");

  // 移動はターンの前（キュー待ちの前）に入れる
  runner.beforeResult = async () => {
    assert.equal(channelOps.moves.length, 2);
  };
  await Promise.all([
    handle(message({ id: "message-1", channelId: "topic-1" })),
    handle(message({ id: "message-2", channelId: "topic-2" })),
  ]);

  for (const channelId of ["topic-1", "topic-2"]) {
    const session = topicSessions.get(channelId);
    assert.equal(session?.state, "active", channelId);
    assert.equal(session?.waitingSince, null, channelId);
    assert.equal(session?.closedAt, null, channelId);
  }
  // 完了から戻しても要約は残す
  assert.equal(topicSessions.get("topic-2")?.summary, "閉じたときの要約");
  assert.deepEqual(channelOps.moves, [
    { channelId: "topic-1", target: { kind: "state", guildId: "guild-1", state: "active" } },
    { channelId: "topic-2", target: { kind: "state", guildId: "guild-1", state: "active" } },
  ]);
  // 返信の先頭に 1 行足す（別の投稿にはしない）
  assert.deepEqual(
    gateway.sent.map((sent) => [sent.channelId, sent.text]),
    [
      ["topic-1", `${REVIVED_NOTE}\nおかえりなさい`],
      ["topic-2", `${REVIVED_NOTE}\n再開します`],
    ],
  );
  assert.equal(runner.inputs.length, 2);
  // 戻したことは 1 件ごとに log に出す。チャンネル ID は出さない
  assert.equal(logs.length, 2);
  assert.ok(logs.every((line) => !line.includes("topic-")), logs.join("\n"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE state = 'active'").get()?.n, 2);
});

test("進行中のセッション・#inbox での発言では移動を入れず、返信にも何も足さない", async (t) => {
  const { gateway, topicSessions, channelOps, handle } = setup(t, [okResult("session-a", "1"), okResult("session-b", "2")]);
  topicSessions.create(TOPIC);

  await handle(message({ channelId: "topic-1" }));
  await handle(message({ channelId: "inbox-1" }));

  assert.equal(topicSessions.get("topic-1")?.state, "active");
  assert.deepEqual(channelOps.moves, []);
  assert.deepEqual(gateway.sent.map((sent) => sent.text), ["1", "2"]);
});

test("進行中に戻したターン: compaction の 1 行は末尾に足す。失敗したら失敗の返信だけで、戻したことは付けない", async (t) => {
  const { gateway, topicSessions, handle } = setup(t, [
    { ...okResult("session-a", "続きです"), compacted: { trigger: "auto" } },
    CRASH,
  ]);
  topicSessions.create(TOPIC);
  topicSessions.create({ ...TOPIC, channelId: "topic-2" });
  topicSessions.setWaiting("topic-1");
  topicSessions.close("topic-2", "要約");

  await handle(message({ id: "message-1", channelId: "topic-1" }));
  await handle(message({ id: "message-2", channelId: "topic-2" }));

  assert.equal(topicSessions.get("topic-2")?.state, "active");
  assert.deepEqual(gateway.sent.map((sent) => sent.text), [`${REVIVED_NOTE}\n続きです\n${COMPACTED_NOTE}`, FAILURE_REPLY]);
});

test("キュー待ちの間に完了になったセッション（/close の確定）への発言は、ターンの前に読み直して進行中に戻す", async (t) => {
  const { gateway, runner, topicSessions, channelOps, queue, logs, handle } = setup(t, [
    okResult("session-a", "続きをどうぞ"),
  ]);
  topicSessions.create(TOPIC);
  // /close のターンが同じキュー（key は channelId）で走っている間に発言が届く
  let release = (): void => {};
  const closing = queue.run("topic-1", () => new Promise<void>((resolve) => (release = resolve)));
  const replying = handle(message({ channelId: "topic-1" }));
  await new Promise((resolve) => setImmediate(resolve));
  // 発言が届いた時点では進行中なので、まだ移動は入れていない
  assert.deepEqual(channelOps.moves, []);
  assert.equal(runner.inputs.length, 0);

  // /close の確定で完了になってから、発言のターンが走る
  topicSessions.close("topic-1", "要約");
  release();
  await Promise.all([closing, replying]);

  assert.equal(topicSessions.get("topic-1")?.state, "active");
  assert.equal(topicSessions.get("topic-1")?.closedAt, null);
  assert.deepEqual(channelOps.moves, [
    { channelId: "topic-1", target: { kind: "state", guildId: "guild-1", state: "active" } },
  ]);
  assert.equal(runner.inputs.length, 1);
  assert.deepEqual(gateway.sent.map((sent) => sent.text), [`${REVIVED_NOTE}\n続きをどうぞ`]);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0]!.includes("topic-1"), logs[0]);
});

test("キュー待ちの前に進行中に戻したら、キューの中では読み直しても重ねて戻さない", async (t) => {
  const { gateway, topicSessions, channelOps, logs, handle } = setup(t, [okResult("session-a", "はい")]);
  topicSessions.create(TOPIC);
  topicSessions.setWaiting("topic-1");

  await handle(message({ channelId: "topic-1" }));

  assert.equal(channelOps.moves.length, 1);
  assert.equal(logs.length, 1);
  assert.deepEqual(gateway.sent.map((sent) => sent.text), [`${REVIVED_NOTE}\nはい`]);
});

test("resume 失敗: SDK セッションを捨てて要約の seed を入れ、sessionId 無しで 1 回だけやり直し、成功したら seed を消す", async (t) => {
  const { db, gateway, runner, sessions, seeds, topicSessions, usage, logs, handle } = setup(t, [
    RESUME_FAILURE,
    okResult("session-new", "続きをどうぞ"),
  ]);
  topicSessions.create(TOPIC);
  db.prepare("UPDATE sessions SET summary = '行き先は京都に決めた' WHERE channel_id = 'topic-1'").run();
  sessions.set("topic-1", "session-old");
  const prompt = buildTurnPrompt("予算は", CREATED_AT, "Asia/Tokyo", "旅行の計画");
  const seed = `${RESUME_SEED_HEADER}\n行き先は京都に決めた`;
  // やり直しの時点で seed が入っていて、古い SDK セッションは消えている
  runner.beforeResult = async () => {
    if (runner.inputs.length === 2) {
      assert.equal(seeds.get("topic-1"), seed);
      assert.equal(sessions.get("topic-1"), undefined);
    }
  };

  await handle(message({ channelId: "topic-1", content: "予算は" }));

  assert.deepEqual(runner.inputs, [
    { prompt, sessionId: "session-old", context: context("topic-1"), allowedUrls: [] },
    { prompt: `${seed}\n\n${prompt}`, sessionId: undefined, context: context("topic-1"), allowedUrls: [] },
  ]);
  assert.equal(sessions.get("topic-1"), "session-new");
  assert.equal(seeds.get("topic-1"), undefined);
  assert.deepEqual(gateway.sent, [{ channelId: "topic-1", text: "続きをどうぞ", replyToId: "message-1" }]);
  assert.deepEqual(
    usage.recent(10).map((entry) => [entry.ok, entry.sessionId]),
    [
      [true, "session-new"],
      [false, null],
    ],
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /resume に失敗したため/);
});

test("resume 失敗のやり直しでも、WebFetch に許すのは発言の URL だけ（seed の要約に含まれる URL は許さない）", async (t) => {
  const { db, runner, sessions, topicSessions, handle } = setup(t, [RESUME_FAILURE, okResult("session-new", "読みました")]);
  topicSessions.create(TOPIC);
  db.prepare("UPDATE sessions SET summary = '参考: https://summary.example/x' WHERE channel_id = 'topic-1'").run();
  sessions.set("topic-1", "session-old");

  await handle(message({ channelId: "topic-1", content: "これも見て https://example.com/c" }));

  assert.equal(runner.inputs.length, 2);
  assert.ok(runner.inputs[1]!.prompt.includes("https://summary.example/x"));
  assert.deepEqual(
    runner.inputs.map((input) => input.allowedUrls),
    [["https://example.com/c"], ["https://example.com/c"]],
  );
});

test("resume 失敗: 要約が無ければ seed は題名だけ。やり直しも失敗したらそれ以上やり直さず、seed は残す", async (t) => {
  const { gateway, runner, sessions, seeds, topicSessions, handle } = setup(t, [
    RESUME_FAILURE,
    CRASH,
  ]);
  topicSessions.create(TOPIC);
  sessions.set("topic-1", "session-old");

  await handle(message({ channelId: "topic-1" }));

  assert.equal(runner.inputs.length, 2);
  assert.equal(runner.inputs[1]!.sessionId, undefined);
  const seed = `${RESUME_SEED_HEADER}\n題名: 旅行の計画`;
  assert.equal(runner.inputs[1]!.prompt, `${seed}\n\n${buildTurnPrompt("明日買い物に行く", CREATED_AT, "Asia/Tokyo", "旅行の計画")}`);
  assert.equal(seeds.get("topic-1"), seed);
  assert.equal(sessions.get("topic-1"), undefined);
  assert.deepEqual(gateway.sent.map((sent) => sent.text), [FAILURE_REPLY]);

  // 次の発言は seed を付けて新しいセッションで始める（resume しない）
  runner.inputs.length = 0;
  await handle(message({ id: "message-2", channelId: "topic-1", content: "続き" }));
  assert.equal(runner.inputs[0]?.sessionId, undefined);
  assert.ok(runner.inputs[0]?.prompt.startsWith(`${seed}\n\n`));
});

test("resume 失敗: #inbox・#tasks はそのサーバーの直近の同じチャンネルの要約を seed にして sessionId 無しで 1 回だけやり直し、成功したら seed を消す。使える要約が無ければ seed を入れない", async (t) => {
  const cases: Array<{
    label: string;
    channelId: string;
    channelName: string;
    context: RunContext;
    summaries: Array<[guildId: string, date: string, summary: string, kind?: "inbox" | "tasks"]>;
    seed: string | undefined;
  }> = [
    {
      label: "#inbox: 直近の #inbox の要約（より新しい #tasks の要約は使わない）",
      channelId: "inbox-1",
      channelName: "inbox",
      context: context(),
      summaries: [
        ["guild-1", "2026-10-01", "古い要約"],
        ["guild-1", "2026-10-02", "- 金曜までに見積もりを送る"],
        ["guild-1", "2026-10-03", "#tasks の要約", "tasks"],
      ],
      seed: rotatedSeed("- 金曜までに見積もりを送る"),
    },
    {
      label: "#inbox: 別のサーバーの要約しか無い",
      channelId: "inbox-1",
      channelName: "inbox",
      context: context(),
      summaries: [["guild-9", "2026-10-01", "別のサーバーの要約"]],
      seed: undefined,
    },
    {
      label: "#tasks: 直近の #tasks の要約（より新しい #inbox の要約・別のサーバーの #tasks の要約は使わない）",
      channelId: "tasks-1",
      channelName: "tasks",
      context: TASKS_CONTEXT,
      summaries: [
        ["guild-1", "2026-10-01", "#tasks の古い要約", "tasks"],
        ["guild-1", "2026-10-02", "#tasks の要約", "tasks"],
        ["guild-1", "2026-10-03", "#inbox の要約"],
        ["guild-9", "2026-10-03", "別のサーバーの #tasks の要約", "tasks"],
      ],
      seed: rotatedSeed("#tasks の要約", "tasks"),
    },
    {
      label: "#tasks: #inbox の要約しか無い",
      channelId: "tasks-1",
      channelName: "tasks",
      context: TASKS_CONTEXT,
      summaries: [["guild-1", "2026-10-02", "#inbox の要約"]],
      seed: undefined,
    },
  ];
  for (const c of cases) {
    const { db, runner, sessions, seeds, inboxSummaries, handle } = setup(t, [
      RESUME_FAILURE,
      okResult("session-new", "はい"),
    ]);
    setUpGuild(db);
    sessions.set(c.channelId, "session-old");
    for (const [guildId, date, summary, kind] of c.summaries) inboxSummaries.add(guildId, date, summary, kind);
    // やり直しの時点の seed
    let seedAtRetry: string | undefined;
    runner.beforeResult = async () => {
      if (runner.inputs.length === 2) seedAtRetry = seeds.get(c.channelId);
    };

    await handle(message({ channelId: c.channelId }));

    const prompt = buildTurnPrompt("明日買い物に行く", CREATED_AT, "Asia/Tokyo", c.channelName);
    assert.deepEqual(
      runner.inputs,
      [
        { prompt, sessionId: "session-old", context: c.context, allowedUrls: [] },
        {
          prompt: c.seed === undefined ? prompt : `${c.seed}\n\n${prompt}`,
          sessionId: undefined,
          context: c.context,
          allowedUrls: [],
        },
      ],
      c.label,
    );
    assert.equal(seedAtRetry, c.seed, c.label);
    assert.equal(seeds.get(c.channelId), undefined, c.label);
    assert.equal(sessions.get(c.channelId), "session-new", c.label);
  }
});

test("seed: SDK セッションが無く seed があれば prompt の先頭に付け、成功したら消す。失敗なら残す", async (t) => {
  const { runner, sessions, seeds, topicSessions, handle } = setup(t, [
    { ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 0 },
    okResult("session-a", "了解"),
    okResult("session-a", "次"),
  ]);
  topicSessions.create(TOPIC);
  seeds.set("topic-1", "前日までの要約");
  const prompt = buildTurnPrompt("行き先を決めたい", CREATED_AT, "Asia/Tokyo", "旅行の計画");

  await handle(message({ channelId: "topic-1", content: "行き先を決めたい" }));
  assert.equal(seeds.get("topic-1"), "前日までの要約");

  await handle(message({ channelId: "topic-1", content: "行き先を決めたい" }));
  assert.equal(seeds.get("topic-1"), undefined);
  assert.equal(sessions.get("topic-1"), "session-a");

  // SDK セッションができた後は seed を付けない
  await handle(message({ channelId: "topic-1", content: "行き先を決めたい" }));
  assert.deepEqual(
    runner.inputs.map((input) => [input.prompt, input.sessionId]),
    [
      [`前日までの要約\n\n${prompt}`, undefined],
      [`前日までの要約\n\n${prompt}`, undefined],
      [prompt, "session-a"],
    ],
  );
});

test("seed: SDK セッションがあれば seed は付けずに resume する", async (t) => {
  const { runner, sessions, seeds, handle } = setup(t, [okResult("session-1", "はい")]);
  sessions.set("inbox-1", "session-1");
  seeds.set("inbox-1", "使わない");

  await handle(message());

  assert.equal(runner.inputs[0]!.prompt, buildTurnPrompt("明日買い物に行く", CREATED_AT, "Asia/Tokyo"));
  assert.equal(runner.inputs[0]!.sessionId, "session-1");
  assert.equal(seeds.get("inbox-1"), "使わない");
});

test("error_max_turns: SDK が記録した session_id を保存して専用の返信をし、次の発言はそこから resume する", async (t) => {
  const { gateway, runner, sessions, usage, handle } = setup(t, [
    { ok: false, errorMessage: "error_max_turns", sessionId: "session-x", sessionRecorded: true, toolCalls: 0 },
    okResult("session-x", "続きです"),
  ]);

  await handle(message({ id: "message-1" }));

  assert.equal(sessions.get("inbox-1"), "session-x");
  assert.deepEqual(gateway.sent, [{ channelId: "inbox-1", text: MAX_TURNS_REPLY, replyToId: "message-1" }]);
  assert.equal(usage.recent(10)[0]?.ok, false);

  await handle(message({ id: "message-2", content: "続けて" }));

  assert.equal(runner.inputs[1]!.sessionId, "session-x");
  assert.equal(gateway.sent[1]?.text, "続きです");
});

test("中断・打ち切り: やり直さず連続失敗にも数えない。受け取った session_id は、そのチャンネルにまだ SDK セッションが無いときだけ保存して seed も消し（その prompt は SDK の会話に記録済み）、次のターンはそこから resume する", async (t) => {
  const timeout = (sessionId?: string): RunResult => ({ ok: false, errorMessage: "timeout", sessionId, sessionRecorded: false, toolCalls: 0 });
  const aborted = (sessionId?: string): RunResult => ({ ok: false, errorMessage: "aborted", sessionId, sessionRecorded: false, toolCalls: 2 });
  const cases: Array<{
    label: string;
    channelId: string;
    stored?: string;
    result: RunResult;
    reply: string;
    session: string | undefined;
    seedKept: boolean;
  }> = [
    { label: "timeout・#inbox・session_id あり", channelId: "inbox-1", result: timeout("session-new"), reply: FAILURE_REPLY, session: "session-new", seedKept: false },
    { label: "aborted・セッション・session_id あり", channelId: "topic-1", result: aborted("session-new"), reply: ABORTED_REPLY, session: "session-new", seedKept: false },
    { label: "timeout・session_id なし", channelId: "inbox-1", result: timeout(), reply: FAILURE_REPLY, session: undefined, seedKept: true },
    { label: "aborted・session_id なし", channelId: "topic-1", result: aborted(), reply: ABORTED_REPLY, session: undefined, seedKept: true },
    { label: "timeout・既に SDK セッションあり", channelId: "topic-1", stored: "session-old", result: timeout("session-new"), reply: FAILURE_REPLY, session: "session-old", seedKept: true },
    { label: "aborted・既に SDK セッションあり", channelId: "topic-1", stored: "session-old", result: aborted("session-new"), reply: ABORTED_REPLY, session: "session-old", seedKept: true },
  ];
  for (const c of cases) {
    const { gateway, runner, sessions, seeds, topicSessions, handle } = setup(t, [
      c.result,
      okResult(c.session ?? "session-next", "続きです"),
    ]);
    topicSessions.create(TOPIC);
    if (c.stored !== undefined) sessions.set(c.channelId, c.stored);
    seeds.set(c.channelId, "前日までの要約");

    await handle(message({ id: "message-1", channelId: c.channelId }));

    assert.equal(runner.inputs.length, 1, c.label);
    assert.equal(sessions.get(c.channelId), c.session, c.label);
    assert.equal(sessions.failureCount(c.channelId), 0, c.label);
    assert.equal(seeds.get(c.channelId), c.seedKept ? "前日までの要約" : undefined, c.label);
    assert.deepEqual(gateway.sent.map((sent) => sent.text), [c.reply], c.label);

    // 次のターンは保存した SDK セッションから resume し、無ければ残した seed を付けて始める
    await handle(message({ id: "message-2", channelId: c.channelId }));
    assert.equal(runner.inputs[1]!.sessionId, c.session, c.label);
    assert.equal(runner.inputs[1]!.prompt.startsWith("前日までの要約\n\n"), c.session === undefined, c.label);
  }
});

test("連続失敗: 結果の届かない失敗が同じ SDK セッションで上限の回数続いたら捨てて seed を入れ、sessionId 無しで 1 回だけやり直す（seed はセッションなら題名、#inbox なら直近の #inbox の要約）", async (t) => {
  const cases = [
    { label: "セッション", channelId: "topic-1", channelName: "旅行の計画", seed: `${RESUME_SEED_HEADER}\n題名: 旅行の計画` },
    { label: "#inbox", channelId: "inbox-1", channelName: "inbox", seed: rotatedSeed("前回の要約") },
  ];
  for (const c of cases) {
    const crashes = Array.from({ length: RESUME_FAILURE_LIMIT }, () => CRASH);
    const { gateway, runner, sessions, seeds, topicSessions, inboxSummaries, logs, handle } = setup(t, [
      ...crashes,
      okResult("session-new", "続きをどうぞ"),
    ]);
    topicSessions.create(TOPIC);
    inboxSummaries.add("guild-1", "2026-10-02", "前回の要約");
    sessions.set(c.channelId, "session-old");

    // 上限の 1 回前までは捨てない
    for (let i = 1; i < RESUME_FAILURE_LIMIT; i++) await handle(message({ id: `message-${i}`, channelId: c.channelId }));
    assert.equal(runner.inputs.length, RESUME_FAILURE_LIMIT - 1, c.label);
    assert.equal(sessions.get(c.channelId), "session-old", c.label);
    assert.equal(sessions.failureCount(c.channelId), RESUME_FAILURE_LIMIT - 1, c.label);
    assert.ok(!logs.some((line) => line.includes("SDK セッションを捨てて")), c.label);

    await handle(message({ id: "message-last", channelId: c.channelId, content: "予算は" }));

    const prompt = buildTurnPrompt("予算は", CREATED_AT, "Asia/Tokyo", c.channelName);
    assert.deepEqual(
      runner.inputs.slice(-2).map((input) => [input.prompt, input.sessionId]),
      [
        [prompt, "session-old"],
        [`${c.seed}\n\n${prompt}`, undefined],
      ],
      c.label,
    );
    assert.equal(sessions.get(c.channelId), "session-new", c.label);
    assert.equal(sessions.failureCount(c.channelId), 0, c.label);
    assert.equal(seeds.get(c.channelId), undefined, c.label);
    assert.deepEqual(
      gateway.sent.map((sent) => sent.text),
      [...Array.from({ length: RESUME_FAILURE_LIMIT - 1 }, () => FAILURE_REPLY), "続きをどうぞ"],
      c.label,
    );
    // 捨てたことは log に出す。チャンネル ID は出さない
    assert.ok(logs.some((line) => line.includes("SDK セッションを捨てて")), c.label);
    assert.ok(logs.every((line) => !line.includes(c.channelId)), c.label);
  }
});

test("連続失敗: 結果の届かない失敗だけを数え、成功で 0 に戻す。timeout・中断・結果が届いた失敗（API エラー・手順の上限）は数えず、0 にも戻さない", async (t) => {
  const timeout: RunResult = { ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 0 };
  const aborted: RunResult = { ok: false, errorMessage: "aborted", sessionRecorded: false, toolCalls: 0 };
  const apiError: RunResult = {
    ok: false,
    errorMessage: "success (is_error)",
    sessionId: "session-old",
    sessionRecorded: true,
    toolCalls: 0,
  };
  const maxTurns: RunResult = {
    ok: false,
    errorMessage: "error_max_turns",
    sessionId: "session-old",
    sessionRecorded: true,
    toolCalls: 0,
  };
  const cases: Array<{ label: string; results: RunResult[]; count: number }> = [
    { label: "成功で 0 に戻す", results: [CRASH, CRASH, okResult("session-old", "はい")], count: 0 },
    { label: "timeout は数えず、0 にも戻さない", results: [CRASH, timeout, timeout, CRASH], count: 2 },
    { label: "中断は数えない", results: [aborted, aborted, aborted], count: 0 },
    { label: "結果が届いた失敗は数えない", results: [apiError, apiError, apiError, maxTurns, maxTurns, maxTurns], count: 0 },
    { label: "結果が届いた失敗は 0 に戻さない", results: [CRASH, apiError, CRASH, apiError], count: 2 },
  ];
  for (const c of cases) {
    // FakeRunner は渡した配列から取り出すので写しを渡す
    const { runner, sessions, seeds, topicSessions, logs, handle } = setup(t, [...c.results]);
    topicSessions.create(TOPIC);
    sessions.set("topic-1", "session-old");

    for (let i = 0; i < c.results.length; i++) await handle(message({ id: `message-${i + 1}`, channelId: "topic-1" }));

    assert.equal(sessions.failureCount("topic-1"), c.count, c.label);
    // やり直しは起きず、同じ SDK セッションのまま
    assert.equal(runner.inputs.length, c.results.length, c.label);
    assert.ok(runner.inputs.every((input) => input.sessionId === "session-old"), c.label);
    assert.equal(sessions.get("topic-1"), "session-old", c.label);
    assert.equal(seeds.get("topic-1"), undefined, c.label);
    assert.ok(!logs.some((line) => line.includes("SDK セッションを捨てて")), c.label);
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** ターンの番号は handler を作った時刻（NOW）のミリ秒から 1 ずつ増やす。そのテストで n 番目のセッションのターンの番号 */
function turnSeq(n: number): number {
  return NOW.getTime() + n;
}

/** 途中経過のメッセージの [中断]（そのテストで最初のセッションのターン） */
const ABORT_ROW = {
  kind: "buttons",
  buttons: [{ customId: `turn:abort:topic-1:${turnSeq(1)}`, label: "中断", style: "danger" }],
} as const;
const STALE = [{ method: "reply", message: { text: STALE_TURN_REPLY, ephemeral: true } }];

test("途中経過: セッションのチャンネルのターンが 20 秒未満で終われば途中経過を出さず、タイマーも残さない", async (t) => {
  const { gateway, runner, topicSessions, timers, handle } = setup(t, [okResult("session-a", "はい")]);
  topicSessions.create(TOPIC);
  const release = deferred();
  runner.beforeResult = async (input) => {
    input.onProgress?.({ label: "Web を検索しています" });
    await release.promise;
  };

  const turn = handle(message({ channelId: "topic-1" }));
  await timers.advance(PROGRESS_DELAY_MS - 1);
  release.resolve();
  await turn;

  assert.deepEqual(gateway.posts, []);
  assert.deepEqual(gateway.edits, []);
  assert.deepEqual(gateway.sent, [{ channelId: "topic-1", text: "はい", replyToId: "message-1" }]);
  assert.equal(timers.pending, 0);
  await timers.advance(60_000);
  assert.deepEqual(gateway.posts, []);
});

test("途中経過: 20 秒で [中断] 付きのメッセージを 1 つ送り、10 秒ごとに書き換え（ボタンは残す）、終わったら「完了」に書き換えてボタンを外し、返答は別のメッセージで送る", async (t) => {
  const { gateway, runner, topicSessions, timers, logs, handle } = setup(t, [okResult("session-a", "できました")]);
  topicSessions.create(TOPIC);
  const release = deferred();
  let current: RunInput | undefined;
  runner.beforeResult = async (input) => {
    current = input;
    await release.promise;
  };

  const turn = handle(message({ channelId: "topic-1" }));
  await timers.advance(5_000);
  current!.onProgress!({ label: "読んでいます: site/index.html" });
  await timers.advance(PROGRESS_DELAY_MS - 5_000 - 1);
  assert.deepEqual(gateway.posts, []);

  await timers.advance(1);
  assert.deepEqual(gateway.posts, [
    {
      channelId: "topic-1",
      messageId: "posted-1",
      message: { text: "作業中…（0 分 20 秒・ツール 1 回）\n読んでいます: site/index.html", components: [ABORT_ROW] },
    },
  ]);

  // 直近の手順とツールの回数・経過時間を 10 秒ごとに書き換える（components を送らないのでボタンは残る）
  current!.onProgress!({ label: "書いています: site/app.js" });
  current!.onProgress!({ label: "書いています: site/style.css" });
  await timers.advance(PROGRESS_INTERVAL_MS - 1);
  assert.equal(gateway.edits.length, 0);
  await timers.advance(1);
  assert.deepEqual(gateway.edits, [
    {
      channelId: "topic-1",
      messageId: "posted-1",
      message: { text: "作業中…（0 分 30 秒・ツール 3 回）\n書いています: site/style.css" },
    },
  ]);
  await timers.advance(4 * PROGRESS_INTERVAL_MS + 5_000);
  assert.deepEqual(
    gateway.edits.map((edit) => edit.message.text),
    ["0 分 30 秒", "0 分 40 秒", "0 分 50 秒", "1 分 0 秒", "1 分 10 秒"].map(
      (elapsed) => `作業中…（${elapsed}・ツール 3 回）\n書いています: site/style.css`,
    ),
  );
  assert.equal(gateway.posts.length, 1);

  release.resolve();
  await turn;

  assert.deepEqual(gateway.edits.at(-1), {
    channelId: "topic-1",
    messageId: "posted-1",
    message: { text: "完了（1 分 15 秒・ツール 3 回）", components: [] },
  });
  assert.deepEqual(gateway.sent, [{ channelId: "topic-1", text: "できました", replyToId: "message-1" }]);
  // 途中経過のタイマーはターンの終わりで止める
  assert.equal(timers.pending, 0);
  assert.deepEqual(logs, []);
});

test("途中経過: 送信に失敗したら log だけで、編集もせずにターンを続けて返答する", async (t) => {
  const { gateway, runner, topicSessions, timers, logs, handle } = setup(t, [okResult("session-a", "できました")]);
  topicSessions.create(TOPIC);
  const release = deferred();
  runner.beforeResult = () => release.promise;
  gateway.beforeSendMessage = () => {
    throw new Error("Missing Access");
  };

  const turn = handle(message({ channelId: "topic-1" }));
  await timers.advance(PROGRESS_DELAY_MS + 3 * PROGRESS_INTERVAL_MS);
  release.resolve();
  await turn;

  assert.deepEqual(gateway.posts, []);
  assert.deepEqual(gateway.edits, []);
  assert.deepEqual(gateway.sent.map((sent) => sent.text), ["できました"]);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0]!.includes("topic-1"), logs[0]);
  assert.equal(timers.pending, 0);
});

test("途中経過: 編集に失敗しても log だけで、次の間隔でまた書き換え、ターンを続けて返答する", async (t) => {
  const { gateway, runner, topicSessions, timers, logs, handle } = setup(t, [okResult("session-a", "できました")]);
  topicSessions.create(TOPIC);
  const release = deferred();
  runner.beforeResult = () => release.promise;
  let failing = true;
  gateway.beforeEdit = () => {
    if (failing) throw new Error("Unknown Message");
  };

  const turn = handle(message({ channelId: "topic-1" }));
  await timers.advance(PROGRESS_DELAY_MS + PROGRESS_INTERVAL_MS);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0]!.includes("topic-1"), logs[0]);
  failing = false;
  await timers.advance(PROGRESS_INTERVAL_MS);
  assert.deepEqual(gateway.edits.map((edit) => edit.message.text), ["作業中…（0 分 40 秒・ツール 0 回）"]);
  failing = true;
  release.resolve();
  await turn;

  assert.deepEqual(gateway.sent.map((sent) => sent.text), ["できました"]);
  assert.equal(logs.length, 2);
  assert.equal(timers.pending, 0);
});

test("#inbox・#tasks のターンには途中経過も [中断] も付けず、手順の上限で止まっても [続ける] を付けない（押されても古い操作として扱う）", async (t) => {
  for (const c of [
    { label: "#inbox", channelId: "inbox-1" },
    { label: "#tasks", channelId: "tasks-1" },
  ]) {
    const { db, gateway, runner, timers, handler, handle, press } = setup(t, [
      { ok: false, errorMessage: "error_max_turns", sessionId: "session-x", sessionRecorded: true, toolCalls: 8 },
    ]);
    setUpGuild(db);
    const release = deferred();
    runner.beforeResult = () => release.promise;

    const turn = handle(message({ channelId: c.channelId }));
    await timers.advance(PROGRESS_DELAY_MS + 3 * PROGRESS_INTERVAL_MS);

    assert.equal(runner.received[0]!.signal, undefined, c.label);
    assert.equal(runner.received[0]!.onProgress, undefined, c.label);
    assert.equal(handler.abortTurn(c.channelId, turnSeq(1)), false, c.label);
    assert.equal(timers.pending, 0, c.label);
    release.resolve();
    await turn;

    assert.deepEqual(gateway.posts, [], c.label);
    assert.deepEqual(gateway.edits, [], c.label);
    assert.deepEqual(gateway.sent, [{ channelId: c.channelId, text: MAX_TURNS_REPLY, replyToId: "message-1" }], c.label);
    assert.deepEqual(await press(`turn:continue:${c.channelId}`), STALE, c.label);
    assert.equal(runner.inputs.length, 1, c.label);
  }
});

test("[中断]: 実行中のセッションのターンを abort して deferUpdate し、途中経過を「中断しました」に書き換えて返答する。会話は捨てず連続失敗にも数えない", async (t) => {
  const { gateway, runner, sessions, topicSessions, timers, logs, handle, press } = setup(t, [
    { ok: false, errorMessage: "aborted", sessionId: "session-a", sessionRecorded: false, toolCalls: 1 },
  ]);
  topicSessions.create(TOPIC);
  sessions.set("topic-1", "session-a");
  runner.beforeResult = (input) => {
    input.onProgress?.({ label: "ツールを使っています: project_open" });
    return new Promise((resolve) => input.signal?.addEventListener("abort", () => resolve()));
  };

  const turn = handle(message({ channelId: "topic-1" }));
  await timers.advance(25_000);
  assert.deepEqual(gateway.posts.map((post) => post.message.components), [[ABORT_ROW]]);
  assert.equal(runner.received[0]!.signal?.aborted, false);

  // 表示の書き換えはターンの終わりに handler が行う
  assert.deepEqual(await press(`turn:abort:topic-1:${turnSeq(1)}`), [{ method: "deferUpdate" }]);
  await turn;

  assert.equal(runner.received[0]!.signal?.aborted, true);
  assert.deepEqual(gateway.edits.at(-1), {
    channelId: "topic-1",
    messageId: "posted-1",
    message: { text: "中断しました（0 分 25 秒・ツール 1 回）", components: [] },
  });
  assert.deepEqual(gateway.sent, [{ channelId: "topic-1", text: ABORTED_REPLY, replyToId: "message-1" }]);
  assert.equal(sessions.get("topic-1"), "session-a");
  assert.equal(sessions.failureCount("topic-1"), 0);
  assert.equal(runner.inputs.length, 1);
  // 中断したこととターンの失敗を log に出す。チャンネル ID は出さない
  assert.equal(logs.length, 2);
  assert.ok(logs.every((line) => !line.includes("topic-1")), logs.join("\n"));
  assert.equal(timers.pending, 0);

  // 終わったターンの [中断] は古い
  assert.deepEqual(await press(`turn:abort:topic-1:${turnSeq(1)}`), STALE);
});

test("[中断]: ボタンはターンごとの番号を持ち、前のターンのボタンでは次のターンを止めない", async (t) => {
  const { gateway, runner, topicSessions, timers, handle, press } = setup(t, [
    okResult("session-a", "できました"),
    { ok: false, errorMessage: "aborted", sessionId: "session-a", sessionRecorded: false, toolCalls: 0 },
  ]);
  topicSessions.create(TOPIC);
  let release = deferred();
  runner.beforeResult = (input) =>
    new Promise((resolve) => {
      void release.promise.then(resolve);
      input.signal?.addEventListener("abort", () => resolve());
    });

  // 1 ターン目: 途中経過の [中断] は 1 つ目の番号。押さずに終わる
  const first = handle(message({ id: "message-1", channelId: "topic-1" }));
  await timers.advance(PROGRESS_DELAY_MS);
  release.resolve();
  await first;
  release = deferred();

  // 2 ターン目: [中断] は次の番号。1 ターン目のボタンを押しても止まらない
  const second = handle(message({ id: "message-2", channelId: "topic-1" }));
  await timers.advance(PROGRESS_DELAY_MS);
  assert.deepEqual(
    gateway.posts.map((post) => post.message.components?.[0]),
    [
      ABORT_ROW,
      { kind: "buttons", buttons: [{ customId: `turn:abort:topic-1:${turnSeq(2)}`, label: "中断", style: "danger" }] },
    ],
  );
  assert.deepEqual(await press(`turn:abort:topic-1:${turnSeq(1)}`), STALE);
  assert.equal(runner.received[1]!.signal?.aborted, false);

  assert.deepEqual(await press(`turn:abort:topic-1:${turnSeq(2)}`), [{ method: "deferUpdate" }]);
  await second;
  assert.equal(runner.received[1]!.signal?.aborted, true);
  assert.deepEqual(gateway.sent.map((sent) => sent.text), ["できました", ABORTED_REPLY]);
});

test("[続ける]: セッションのチャンネルで手順の上限で止まったら返信に [続ける] を付け、押すとボタンを外して「続けてください」で 1 ターン走る（日時ヘッダは押した時刻・返信先なし・URL なし）", async (t) => {
  const { gateway, runner, topicSessions, clock, logs, handle, press } = setup(t, [
    { ok: false, errorMessage: "error_max_turns", sessionId: "session-x", sessionRecorded: true, toolCalls: 40 },
    okResult("session-x", "続きです"),
  ]);
  topicSessions.create(TOPIC);

  await handle(message({ channelId: "topic-1" }));

  assert.deepEqual(gateway.sent, []);
  assert.deepEqual(gateway.posts, [
    {
      channelId: "topic-1",
      messageId: "posted-1",
      message: {
        text: MAX_TURNS_REPLY,
        components: [{ kind: "buttons", buttons: [{ customId: "turn:continue:topic-1", label: "続ける" }] }],
      },
    },
  ]);

  // 押すまでに待ちに移っていても、発言と同じく進行中に戻す
  topicSessions.setWaiting("topic-1");
  clock.now = new Date("2026-10-02T01:31:00Z");
  const pressedAt = new Date("2026-10-02T01:30:00Z");
  const calls = await press("turn:continue:topic-1", pressedAt);

  assert.deepEqual(calls, [{ method: "update", message: { text: MAX_TURNS_REPLY, components: [] } }]);
  assert.deepEqual(runner.inputs[1], {
    prompt: buildTurnPrompt(CONTINUE_PROMPT, pressedAt, "Asia/Tokyo", "旅行の計画"),
    sessionId: "session-x",
    context: context("topic-1"),
    allowedUrls: [],
  });
  // 発言のターンと同じく中断できる
  assert.notEqual(runner.received[1]!.signal, undefined);
  assert.deepEqual(gateway.sent, [{ channelId: "topic-1", text: `${REVIVED_NOTE}\n続きです`, replyToId: undefined }]);
  assert.equal(topicSessions.get("topic-1")?.state, "active");
  assert.equal(topicSessions.get("topic-1")?.lastActivityAt, "2026-10-02T01:31:00.000Z");
  assert.ok(logs.some((line) => line.includes("[続ける]")), logs.join("\n"));
  assert.ok(logs.every((line) => !line.includes("topic-1")), logs.join("\n"));
});

test("途中経過: 最後の書き換えは終わり方で変えてボタンを外す（成功は完了・手順の上限・中断・timeout と結果の届かない失敗と例外は止まりました）", async (t) => {
  const cases: Array<{ label: string; result: RunResult | Error; text: string }> = [
    { label: "成功", result: okResult("session-a", "できました"), text: "完了" },
    {
      label: "手順の上限",
      result: { ok: false, errorMessage: "error_max_turns", sessionId: "session-x", sessionRecorded: true, toolCalls: 0 },
      text: "手順の上限で止まりました",
    },
    { label: "中断", result: { ok: false, errorMessage: "aborted", sessionRecorded: false, toolCalls: 0 }, text: "中断しました" },
    { label: "timeout", result: { ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 0 }, text: "止まりました" },
    { label: "結果の届かない失敗", result: CRASH, text: "止まりました" },
    { label: "例外", result: new Error("unexpected"), text: "止まりました" },
  ];
  for (const c of cases) {
    const { gateway, runner, topicSessions, timers, handle } = setup(t, [c.result]);
    topicSessions.create(TOPIC);
    const release = deferred();
    runner.beforeResult = () => release.promise;

    const turn = handle(message({ channelId: "topic-1" }));
    await timers.advance(PROGRESS_DELAY_MS + 1_000);
    release.resolve();
    await turn;

    // 手順がまだ無ければ途中経過は 1 行目だけ
    assert.equal(gateway.posts[0]?.message.text, "作業中…（0 分 20 秒・ツール 0 回）", c.label);
    assert.deepEqual(
      gateway.edits.map((edit) => edit.message),
      [{ text: `${c.text}（0 分 21 秒・ツール 0 回）`, components: [] }],
      c.label,
    );
    assert.equal(timers.pending, 0, c.label);
  }
});

/** history の行のうち、テストで見る項目（id・at・guildId・channelId は除く） */
function historyRows(history: ReturnType<typeof createStores>["history"], channelId: string) {
  return history
    .list(channelId, { limit: 200 })
    .map(({ kind, source, persona, text, outcome, steps, toolCalls, durationMs, messageId }) => ({
      kind,
      source,
      persona,
      text,
      outcome,
      steps,
      toolCalls,
      durationMs,
      messageId,
    }));
}

const OWNER_ROW = { source: "discord", persona: "default", outcome: null, steps: null, toolCalls: null, durationMs: null } as const;

test("history: #inbox の 1 ターンで owner（discord・発言の ID）→ agent（done・手順の label・ツール回数・時間）の順に書く。返信は変えない", async (t) => {
  const { gateway, runner, history, handle } = setup(t, [okResult("session-1", "登録しました")], { history: true });
  runner.beforeResult = async (input) => {
    // owner の行はキューに入れる前に書いてある
    assert.deepEqual(historyRows(history, "inbox-1").map((row) => row.kind), ["owner"]);
    input.onProgress?.({ label: "Web を検索しています" });
    input.onProgress?.({ label: "ページを読んでいます" });
  };

  await handle(message());

  assert.deepEqual(gateway.sent, [{ channelId: "inbox-1", text: "登録しました", replyToId: "message-1" }]);
  assert.deepEqual(historyRows(history, "inbox-1"), [
    { ...OWNER_ROW, kind: "owner", text: "明日買い物に行く", messageId: "message-1" },
    {
      kind: "agent",
      source: "discord",
      persona: "default",
      text: "登録しました",
      outcome: "done",
      steps: ["Web を検索しています", "ページを読んでいます"],
      toolCalls: 3,
      durationMs: 4200,
      messageId: null,
    },
  ]);
  assert.equal(history.list("inbox-1", { limit: 1 })[0]!.guildId, "guild-1");
});

test("history: 待ちのセッションの発言は owner → notice（REVIVED_NOTE）→ agent。agent の text には REVIVED_NOTE を付けず、COMPACTED_NOTE は含める", async (t) => {
  const { gateway, topicSessions, history, handle } = setup(
    t,
    [{ ...okResult("session-a", "おかえりなさい"), compacted: { trigger: "auto" } }],
    { history: true },
  );
  topicSessions.create(TOPIC);
  topicSessions.setWaiting("topic-1");

  await handle(message({ channelId: "topic-1" }));

  assert.deepEqual(gateway.sent.map((sent) => sent.text), [`${REVIVED_NOTE}\nおかえりなさい\n${COMPACTED_NOTE}`]);
  const rows = historyRows(history, "topic-1");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.text]),
    [
      ["owner", "明日買い物に行く"],
      ["notice", REVIVED_NOTE],
      ["agent", `おかえりなさい\n${COMPACTED_NOTE}`],
    ],
  );
  assert.equal(rows[1]!.source, "discord");
  assert.deepEqual(rows[2]!.steps, []);
});

test("history: 失敗・手順の上限・中断の返事も agent の行に書く（outcome と、時間は開始からの経過）", async (t) => {
  const { gateway, runner, timers, history, handle } = setup(
    t,
    [CRASH, { ok: false, errorMessage: "error_max_turns", sessionId: "session-x", sessionRecorded: true, toolCalls: 8 }],
    { history: true },
  );
  const release = deferred();
  runner.beforeResult = () => release.promise;
  const turn = handle(message());
  await timers.advance(1500);
  release.resolve();
  await turn;
  runner.beforeResult = undefined;
  await handle(message({ id: "message-2", content: "もう一度" }));

  assert.deepEqual(gateway.sent.map((sent) => sent.text), [FAILURE_REPLY, MAX_TURNS_REPLY]);
  assert.deepEqual(
    historyRows(history, "inbox-1")
      .filter((row) => row.kind === "agent")
      .map((row) => [row.text, row.outcome, row.toolCalls, row.durationMs]),
    [
      [FAILURE_REPLY, "failed", 0, 1500],
      [MAX_TURNS_REPLY, "max_turns", 8, 0],
    ],
  );
});

test("history: 画像だけの発言の owner は「（画像 1 枚）」、本文と画像なら本文の末尾に足す。読めない添付だけの発言は注記を notice に", async (t) => {
  const { history, handle } = setup(t, [okResult("session-1", "見ました")], { history: true });
  const image = {
    url: "https://cdn.discordapp.com/a.png",
    proxyUrl: "https://media.discordapp.net/a.png",
    contentType: "image/png",
    size: 100,
    width: 10,
    height: 10,
  } as const;

  // 画像を取る手段が無いので、画像だけの発言はターンにならない
  await handle(message({ id: "message-1", content: "", images: [image] }));
  await handle(message({ id: "message-2", content: "これを見て", images: [image, image] }));
  await handle(message({ id: "message-3", content: "", images: [], skippedAttachments: { unsupported: 1, overLimit: 0 } }));

  const rows = historyRows(history, "inbox-1");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.text, row.messageId]),
    [
      ["owner", "（画像 1 枚）", "message-1"],
      ["owner", "これを見て\n（画像 2 枚）", "message-2"],
      ["agent", "見ました", null],
      ["owner", "（添付 1 件）", "message-3"],
      ["notice", rows[4]!.text, null],
    ],
  );
  assert.notEqual(rows[4]!.text, "");
});

test("history: [続ける] の owner の text は「続けてください」（返信先が無いので message_id は null）", async (t) => {
  const { topicSessions, history, handle, press } = setup(
    t,
    [
      { ok: false, errorMessage: "error_max_turns", sessionId: "session-x", sessionRecorded: true, toolCalls: 40 },
      okResult("session-x", "続きです"),
    ],
    { history: true },
  );
  topicSessions.create(TOPIC);

  await handle(message({ channelId: "topic-1" }));
  await press("turn:continue:topic-1");

  assert.deepEqual(
    historyRows(history, "topic-1").map((row) => [row.kind, row.text, row.outcome, row.messageId]),
    [
      ["owner", "明日買い物に行く", null, "message-1"],
      ["agent", MAX_TURNS_REPLY, "max_turns", null],
      ["owner", CONTINUE_PROMPT, null, null],
      ["agent", "続きです", "done", null],
    ],
  );
});

test("history: 手順の label は 60 件まで集め、保存では 51 件目が「（ほか n 手順）」になる", async (t) => {
  const { history, runner, handle } = setup(t, [okResult("session-1", "できました")], { history: true });
  runner.beforeResult = async (input) => {
    for (let i = 1; i <= 70; i++) input.onProgress?.({ label: `手順 ${i}` });
  };

  await handle(message());

  const steps = historyRows(history, "inbox-1")[1]!.steps!;
  assert.equal(steps.length, 51);
  assert.equal(steps[49], "手順 50");
  assert.equal(steps[50], "（ほか 10 手順）");
});

test("history: 渡さなければ何も書かない", async (t) => {
  const { db, topicSessions, handle } = setup(t, [okResult("session-1", "1"), okResult("session-2", "2")]);
  topicSessions.create(TOPIC);
  topicSessions.setWaiting("topic-1");

  await handle(message());
  await handle(message({ channelId: "topic-1" }));

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM history").get()?.n, 0);
});

test("history: 書けなくても log だけでターンと返信は続け、log に本文は出さない", async (t) => {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const gateway = new FakeGateway({ allow: ["send", "startTyping"] });
  const logs: string[] = [];
  const handler = createHandler({
    cfg,
    resolveChannel: createChannelResolver(cfg, stores.guildSettings, stores.topicSessions),
    gateway,
    runner: new FakeRunner([okResult("session-1", "登録しました")]),
    ...stores,
    channelOps: new RecordingChannelOps(),
    queue: new KeyedSerialQueue(2),
    now: () => NOW,
    history: {
      add: () => {
        throw new Error("database is locked");
      },
    },
    log: (line) => logs.push(line),
  });

  await handler.handleMessage(message());

  assert.deepEqual(gateway.sent, [{ channelId: "inbox-1", text: "登録しました", replyToId: "message-1" }]);
  const failures = logs.filter((line) => line.startsWith("履歴の書き込みに失敗しました"));
  assert.equal(failures.length, 2);
  assert.ok(logs.every((line) => !line.includes("明日買い物に行く") && !line.includes("登録しました")), logs.join("\n"));
});
