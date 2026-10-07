import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, RunContext, RunInput, RunResult } from "../src/agent/runner.ts";
import { createChannelResolver } from "../src/app/access.ts";
import type { MoveTarget } from "../src/app/channel-ops.ts";
import { createTurnControlsComponent, STALE_TURN_REPLY } from "../src/app/commands/turn-controls.ts";
import {
  ABORTED_REPLY,
  COMPACTED_NOTE,
  CONTINUE_PROMPT,
  createHandler,
  EMPTY_REPLY,
  FAILURE_REPLY,
  formatElapsed,
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
import type {
  Gateway,
  IncomingMessage,
  Interaction,
  InteractionResponder,
  ModalDef,
  OutgoingMessage,
} from "../src/discord/gateway.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { InboxSummaryStore } from "../src/store/inbox-summaries.ts";
import { MemoryStore } from "../src/store/memories.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";

const cfg = { allowedGuildIds: ["guild-1"], inboxChannelId: "inbox-1", ownerUserId: "owner-1", timeZone: "Asia/Tokyo" };
const NOW = new Date("2026-10-02T00:12:00Z");
// 発言の時刻（ストアの now とは別。prompt の日時ヘッダはこちらを使う）
const CREATED_AT = new Date("2026-10-01T23:59:00Z");

class FakeGateway implements Gateway {
  sent: Array<{ channelId: string; text: string; replyToId?: string }> = [];
  /** sendMessage で送ったもの（ID は posted-<n>） */
  posts: Array<{ channelId: string; messageId: string; message: OutgoingMessage }> = [];
  edits: Array<{ channelId: string; messageId: string; message: OutgoingMessage }> = [];
  /** send・sendMessage・editMessage を呼んだ順 */
  order: string[] = [];
  typingStarted = 0;
  typingStopped = 0;
  /** send の直前に呼ばれる。投げればその送信は失敗する */
  beforeSend: () => void = () => {};
  /** sendMessage・editMessage の直前に呼ばれる。投げればその送信・編集は失敗する */
  beforeSendMessage: () => void = () => {};
  beforeEdit: () => void = () => {};

  async start(): Promise<void> {}
  async send(channelId: string, text: string, replyToId?: string): Promise<void> {
    this.beforeSend();
    this.order.push("send");
    this.sent.push({ channelId, text, replyToId });
  }
  async sendMessage(channelId: string, message: OutgoingMessage): Promise<string> {
    this.beforeSendMessage();
    const messageId = `posted-${this.posts.length + 1}`;
    this.order.push("sendMessage");
    this.posts.push({ channelId, messageId, message });
    return messageId;
  }
  async editMessage(channelId: string, messageId: string, message: OutgoingMessage): Promise<void> {
    this.beforeEdit();
    this.order.push("editMessage");
    this.edits.push({ channelId, messageId, message });
  }
  async pinMessage(): Promise<void> {
    throw new Error("想定外の呼び出し");
  }
  async messageExists(): Promise<boolean> {
    throw new Error("想定外の呼び出し");
  }
  startTyping(): () => void {
    this.typingStarted++;
    return () => {
      this.typingStopped++;
    };
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

class FakeRunner implements AgentRunner {
  /** 受け取った入力のうち、中断（signal）と途中経過（onProgress）を除いたもの */
  inputs: Array<Omit<RunInput, "signal" | "onProgress">> = [];
  /** 受け取った入力そのもの */
  received: RunInput[] = [];
  /** 入力を記録した後、結果を返す前に待つ。input の onProgress を呼べ、signal で止まれる */
  beforeResult: (input: RunInput) => Promise<void> = async () => {};
  private readonly results: Array<RunResult | Error>;

  constructor(results: Array<RunResult | Error>) {
    this.results = results;
  }

  async run(input: RunInput): Promise<RunResult> {
    const { signal: _signal, onProgress: _onProgress, ...rest } = input;
    this.inputs.push(rest);
    this.received.push(input);
    await this.beforeResult(input);
    const next = this.results.shift();
    if (next === undefined) throw new Error("想定外の呼び出し");
    if (next instanceof Error) throw next;
    return next;
  }
}

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

type ResponderCall = { method: "deferUpdate" } | { method: "reply" | "update"; message: OutgoingMessage };

class FakeResponder implements InteractionResponder {
  calls: ResponderCall[] = [];

  async defer(): Promise<void> {
    throw new Error("想定外の呼び出し");
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
  async showModal(_modal: ModalDef): Promise<void> {
    throw new Error("想定外の呼び出し");
  }
}

class RecordingChannelOps {
  moves: Array<{ channelId: string; target: MoveTarget }> = [];

  enqueueMove(channelId: string, target: MoveTarget): void {
    this.moves.push({ channelId, target });
  }
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
    usage: { inputTokens: 10, cacheReadInputTokens: 2000, cacheCreationInputTokens: 300 },
    durationMs: 4200,
    toolCalls: 3,
    // 3 回ツールを呼んだターンの最後のステップの入力（合算の usage より小さい）
    contextTokens: 900,
  };
}

function setup(t: TestContext, results: Array<RunResult | Error>) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const gateway = new FakeGateway();
  const runner = new FakeRunner(results);
  const sessions = new SdkSessionStore(db, () => NOW);
  const usage = new UsageStore(db, () => NOW);
  // last_activity_at の更新を見るため、sessions の時計だけ進められるようにする
  const clock = { now: NOW };
  const topicSessions = new TopicSessionStore(db, () => clock.now);
  const seeds = new ChannelSeedStore(db, () => NOW);
  const inboxSummaries = new InboxSummaryStore(db, () => NOW);
  const memories = new MemoryStore(db, () => NOW);
  const channelOps = new RecordingChannelOps();
  const queue = new KeyedSerialQueue(2);
  const logs: string[] = [];
  // 途中経過の経過時間は偽のタイマーの時刻で測る
  const timers = new FakeTimers();
  // guild_settings が空なので env の #inbox（inbox-1）を受け付ける
  const resolveChannel = createChannelResolver(cfg, new GuildSettingsStore(db, () => NOW), topicSessions);
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
    log: (line) => logs.push(line),
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
    timers,
    handler,
    handle,
    press,
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

test("受け付けた発言で runner を呼び、usage 記録・session 保存・返信をする", async (t) => {
  const { gateway, runner, sessions, usage, logs, handle } = setup(t, [okResult("session-1", "登録しました")]);
  // 返信の時点で usage と session は記録済み
  gateway.beforeSend = () => {
    assert.equal(usage.recent(10).length, 1);
    assert.equal(sessions.get("inbox-1"), "session-1");
  };

  await handle(message());

  assert.deepEqual(runner.inputs, [
    { prompt: buildTurnPrompt("明日買い物に行く", CREATED_AT, "Asia/Tokyo"), sessionId: undefined, context: context(), allowedUrls: [] },
  ]);
  assert.match(runner.inputs[0]!.prompt, /^\[2026-10-02\(金\) 08:59 JST #inbox\]\n/);
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
    },
  ]);
  assert.equal(gateway.typingStarted, 1);
  assert.equal(gateway.typingStopped, 1);
  assert.deepEqual(logs, []);
});

test("2 ターン目は保存した sessionId で resume する", async (t) => {
  const { runner, sessions, handle } = setup(t, [okResult("session-1", "1"), okResult("session-1", "2")]);

  await handle(message({ id: "message-1" }));
  await handle(message({ id: "message-2", content: "一覧を見せて" }));

  assert.equal(runner.inputs.length, 2);
  assert.equal(runner.inputs[0]!.sessionId, undefined);
  assert.equal(runner.inputs[1]!.sessionId, "session-1");
  assert.equal(sessions.get("inbox-1"), "session-1");
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

  assert.equal(COMPACTED_NOTE, "（会話が長くなったため、古い部分を要約しました）");
  assert.deepEqual(
    gateway.sent.map((sent) => sent.text),
    [`登録しました\n${COMPACTED_NOTE}`, `${EMPTY_REPLY}\n${COMPACTED_NOTE}`, "次"],
  );
  assert.deepEqual(
    usage.recent(10).map((entry) => entry.compacted),
    [false, true, true],
  );
  assert.deepEqual(logs, [
    "会話が長くなったため SDK が古い部分を要約しました（trigger=auto、要約前 150000 トークン）",
    "会話が長くなったため SDK が古い部分を要約しました（trigger=manual、要約前 ? トークン）",
  ]);
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

test("弾くべき発言では runner を呼ばず、何も送らない", async (t) => {
  const { gateway, runner, usage, handle } = setup(t, []);

  await handle(message({ authorId: "someone-else" }));
  await handle(message({ guildId: null }));
  await handle(message({ channelId: "other-1" }));
  await handle(message({ authorIsBot: true }));
  await handle(message({ isWebhook: true }));
  await handle(message({ content: "  " }));

  assert.equal(runner.inputs.length, 0);
  assert.deepEqual(gateway.sent, []);
  assert.equal(gateway.typingStarted, 0);
  assert.deepEqual(usage.recent(10), []);
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
  assert.equal(runner.inputs[0]!.prompt, "[2026-10-02(金) 08:59 JST #旅行の計画]\n行き先を決めたい");
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

test("同時実行: セッションのチャンネルのターンは枠を 1 つ #inbox 用に残す（maxConcurrent 2 ならセッションは 1 つずつ、その間も #inbox は動く）", async (t) => {
  const { runner, topicSessions, handle } = setup(t, [
    okResult("session-a", "1"),
    okResult("session-i", "2"),
    okResult("session-b", "3"),
  ]);
  topicSessions.create(TOPIC);
  topicSessions.create({ ...TOPIC, channelId: "topic-2", title: "引っ越し" });
  const releases: Array<() => void> = [];
  runner.beforeResult = () => new Promise<void>((resolve) => releases.push(resolve));
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const topicA = handle(message({ id: "message-1", channelId: "topic-1" }));
  await flush();
  const topicB = handle(message({ id: "message-2", channelId: "topic-2" }));
  const inbox = handle(message({ id: "message-3", channelId: "inbox-1" }));
  await flush();

  // topic-2 は枠が空いていても待ち、後から来た #inbox が動く
  assert.deepEqual(
    runner.inputs.map((input) => input.context),
    [context("topic-1"), context("inbox-1")],
  );

  // topic-1 が終わると topic-2 が動く
  releases[0]!();
  await topicA;
  await flush();
  assert.deepEqual(
    runner.inputs.map((input) => input.context?.channelId),
    ["topic-1", "inbox-1", "topic-2"],
  );
  for (const release of releases.slice(1)) release();
  await Promise.all([topicB, inbox]);
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
  assert.equal(REVIVED_NOTE, "（進行中に戻しました）");
  assert.deepEqual(
    gateway.sent.map((sent) => [sent.channelId, sent.text]),
    [
      ["topic-1", `${REVIVED_NOTE}\nおかえりなさい`],
      ["topic-2", `${REVIVED_NOTE}\n再開します`],
    ],
  );
  assert.equal(runner.inputs.length, 2);
  assert.deepEqual(logs, [
    "発言があったためセッションを進行中に戻しました（guild=guild-1）",
    "発言があったためセッションを進行中に戻しました（guild=guild-1）",
  ]);
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
  assert.deepEqual(logs, ["発言があったためセッションを進行中に戻しました（guild=guild-1）"]);
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

test("削除済みのセッション・別サーバーのセッションのチャンネルでは受け付けず、last_activity_at も更新しない", async (t) => {
  const { db, gateway, runner, topicSessions, clock, handle } = setup(t, []);
  topicSessions.create(TOPIC);
  db.prepare("UPDATE sessions SET state = 'deleted' WHERE channel_id = 'topic-1'").run();
  topicSessions.create({ ...TOPIC, channelId: "topic-9", guildId: "guild-9" });
  clock.now = new Date("2026-10-02T03:00:00Z");

  await handle(message({ channelId: "topic-1" }));
  await handle(message({ channelId: "topic-9" }));

  assert.equal(runner.inputs.length, 0);
  assert.deepEqual(gateway.sent, []);
  assert.equal(topicSessions.get("topic-1")?.lastActivityAt, NOW.toISOString());
  assert.equal(topicSessions.get("topic-9")?.lastActivityAt, NOW.toISOString());
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
  assert.equal(RESUME_SEED_HEADER, "前の会話の記録が切れたため、要約から再開します。");
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
  assert.ok(runner.inputs[1]!.prompt.startsWith(`${seed}\n\n[2026-10-02(金) 08:59 JST #旅行の計画]\n`));
  assert.equal(seeds.get("topic-1"), seed);
  assert.equal(sessions.get("topic-1"), undefined);
  assert.deepEqual(gateway.sent.map((sent) => sent.text), [FAILURE_REPLY]);

  // 次の発言は seed を付けて新しいセッションで始める（resume しない）
  runner.inputs.length = 0;
  await handle(message({ id: "message-2", channelId: "topic-1", content: "続き" }));
  assert.equal(runner.inputs[0]?.sessionId, undefined);
  assert.ok(runner.inputs[0]?.prompt.startsWith(`${seed}\n\n`));
});

test("resume 失敗: #inbox はそのサーバーの #inbox の要約がまだ無ければ seed を入れずに sessionId 無しで 1 回だけやり直す", async (t) => {
  const { runner, sessions, seeds, inboxSummaries, handle } = setup(t, [RESUME_FAILURE, okResult("session-new", "はい")]);
  sessions.set("inbox-1", "session-old");
  // 別のサーバーの要約は使わない
  inboxSummaries.add("guild-9", "2026-10-01", "別のサーバーの要約");

  await handle(message());

  const prompt = buildTurnPrompt("明日買い物に行く", CREATED_AT, "Asia/Tokyo");
  assert.deepEqual(runner.inputs, [
    { prompt, sessionId: "session-old", context: context(), allowedUrls: [] },
    { prompt, sessionId: undefined, context: context(), allowedUrls: [] },
  ]);
  assert.equal(seeds.get("inbox-1"), undefined);
  assert.equal(sessions.get("inbox-1"), "session-new");
});

test("resume 失敗: #inbox はそのサーバーの直近の #inbox の要約を seed にして sessionId 無しで 1 回だけやり直し、成功したら seed を消す", async (t) => {
  const { runner, sessions, seeds, inboxSummaries, handle } = setup(t, [RESUME_FAILURE, okResult("session-new", "はい")]);
  sessions.set("inbox-1", "session-old");
  inboxSummaries.add("guild-1", "2026-10-01", "古い要約");
  inboxSummaries.add("guild-1", "2026-10-02", "- 金曜までに見積もりを送る");
  const seed = rotatedSeed("- 金曜までに見積もりを送る");
  runner.beforeResult = async () => {
    if (runner.inputs.length === 2) assert.equal(seeds.get("inbox-1"), seed);
  };

  await handle(message());

  const prompt = buildTurnPrompt("明日買い物に行く", CREATED_AT, "Asia/Tokyo");
  assert.equal(seed, "これまでの #inbox の要約:\n- 金曜までに見積もりを送る");
  assert.deepEqual(runner.inputs, [
    { prompt, sessionId: "session-old", context: context(), allowedUrls: [] },
    { prompt: `${seed}\n\n${prompt}`, sessionId: undefined, context: context(), allowedUrls: [] },
  ]);
  assert.equal(seeds.get("inbox-1"), undefined);
  assert.equal(sessions.get("inbox-1"), "session-new");
});

test("連続失敗: #inbox でも結果の届かない失敗が 3 回続いたら捨て、直近の #inbox の要約を seed にしてやり直す", async (t) => {
  const { runner, sessions, seeds, inboxSummaries, handle } = setup(t, [CRASH, CRASH, CRASH, CRASH]);
  sessions.set("inbox-1", "session-old");
  inboxSummaries.add("guild-1", "2026-10-02", "前回の要約");

  for (let i = 0; i < 3; i++) await handle(message());

  assert.deepEqual(
    runner.inputs.map((input) => input.sessionId),
    ["session-old", "session-old", "session-old", undefined],
  );
  assert.ok(runner.inputs[3]!.prompt.startsWith(`${rotatedSeed("前回の要約")}\n\n`));
  // やり直しも失敗したので seed は残し、次の発言で使う
  assert.equal(sessions.get("inbox-1"), undefined);
  assert.equal(seeds.get("inbox-1"), rotatedSeed("前回の要約"));
});

test("resume 以外の失敗ではやり直さず、SDK セッションも seed もそのまま", async (t) => {
  const { gateway, runner, sessions, seeds, topicSessions, handle } = setup(t, [
    { ok: false, errorMessage: "timeout", sessionId: "session-old", sessionRecorded: false, toolCalls: 0 },
  ]);
  topicSessions.create(TOPIC);
  sessions.set("topic-1", "session-old");

  await handle(message({ channelId: "topic-1" }));

  assert.equal(runner.inputs.length, 1);
  assert.equal(sessions.get("topic-1"), "session-old");
  // タイムアウトは連続失敗に数えない
  assert.equal(sessions.failureCount("topic-1"), 0);
  assert.equal(seeds.get("topic-1"), undefined);
  assert.deepEqual(gateway.sent.map((sent) => sent.text), [FAILURE_REPLY]);
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
  // #inbox では [続ける] を付けない（ボタン付きのメッセージは送らない）
  assert.deepEqual(gateway.sent, [{ channelId: "inbox-1", text: MAX_TURNS_REPLY, replyToId: "message-1" }]);
  assert.deepEqual(gateway.posts, []);
  assert.equal(MAX_TURNS_REPLY, "途中までで止めました（手順が多すぎました）。続ける場合はもう一度送ってください。");
  assert.equal(usage.recent(10)[0]?.ok, false);

  await handle(message({ id: "message-2", content: "続けて" }));

  assert.equal(runner.inputs[1]!.sessionId, "session-x");
  assert.equal(gateway.sent[1]?.text, "続きです");
});

test("result が届かなかった失敗（例外・タイムアウト）では、途中で受け取った session_id があっても保存しない", async (t) => {
  const { gateway, sessions, handle } = setup(t, [
    { ok: false, errorMessage: "timeout", sessionId: "session-x", sessionRecorded: false, toolCalls: 0 },
    { ok: false, errorMessage: "exception: Error: boom", sessionId: "session-y", sessionRecorded: false, toolCalls: 0 },
  ]);

  await handle(message({ id: "message-1" }));
  await handle(message({ id: "message-2" }));

  assert.equal(sessions.get("inbox-1"), undefined);
  assert.deepEqual(gateway.sent.map((sent) => sent.text), [FAILURE_REPLY, FAILURE_REPLY]);
});

test("連続失敗: 同じ SDK セッションで 2 回までは捨てず、3 回目で捨てて seed を入れ、sessionId 無しで 1 回だけやり直す", async (t) => {
  const { gateway, runner, sessions, seeds, topicSessions, logs, handle } = setup(t, [
    CRASH,
    CRASH,
    CRASH,
    okResult("session-new", "続きをどうぞ"),
  ]);
  assert.equal(RESUME_FAILURE_LIMIT, 3);
  topicSessions.create(TOPIC);
  sessions.set("topic-1", "session-old");

  await handle(message({ id: "message-1", channelId: "topic-1" }));
  await handle(message({ id: "message-2", channelId: "topic-1" }));

  assert.equal(runner.inputs.length, 2);
  assert.equal(sessions.get("topic-1"), "session-old");
  assert.equal(sessions.failureCount("topic-1"), 2);
  assert.deepEqual(gateway.sent.map((sent) => sent.text), [FAILURE_REPLY, FAILURE_REPLY]);
  assert.equal(logs.filter((line) => line.includes("SDK セッションを捨てて")).length, 0);

  await handle(message({ id: "message-3", channelId: "topic-1", content: "予算は" }));

  const prompt = buildTurnPrompt("予算は", CREATED_AT, "Asia/Tokyo", "旅行の計画");
  const seed = `${RESUME_SEED_HEADER}\n題名: 旅行の計画`;
  assert.deepEqual(
    runner.inputs.slice(2).map((input) => [input.prompt, input.sessionId]),
    [
      [prompt, "session-old"],
      [`${seed}\n\n${prompt}`, undefined],
    ],
  );
  assert.equal(sessions.get("topic-1"), "session-new");
  assert.equal(sessions.failureCount("topic-1"), 0);
  assert.equal(seeds.get("topic-1"), undefined);
  assert.equal(gateway.sent[2]?.text, "続きをどうぞ");
  assert.ok(
    logs.includes(
      "連続失敗のため（3 回）、SDK セッションを捨てて新しいセッションで 1 回だけやり直します: " +
        "exception: Error: Claude Code process exited with code 1",
    ),
    logs.join("\n"),
  );
});

test("連続失敗: 成功したら回数を 0 に戻す。タイムアウトは数えない", async (t) => {
  const timeout: RunResult = { ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 0 };
  const { runner, sessions, handle } = setup(t, [
    CRASH,
    CRASH,
    okResult("session-old", "はい"),
    CRASH,
    timeout,
    timeout,
    CRASH,
  ]);
  sessions.set("inbox-1", "session-old");

  await handle(message());
  await handle(message());
  assert.equal(sessions.failureCount("inbox-1"), 2);
  await handle(message());
  assert.equal(sessions.failureCount("inbox-1"), 0);

  for (let i = 0; i < 4; i++) await handle(message());

  // CRASH・timeout・timeout・CRASH で 2 回。やり直しは起きていない
  assert.equal(sessions.failureCount("inbox-1"), 2);
  assert.equal(runner.inputs.length, 7);
  assert.ok(runner.inputs.every((input) => input.sessionId === "session-old"));
  assert.equal(sessions.get("inbox-1"), "session-old");
});

test("連続失敗: 結果が届いた失敗（API エラー・手順数の上限）は数えず、5 回続いても会話を捨てない", async (t) => {
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
  const { gateway, runner, sessions, seeds, logs, handle } = setup(t, [
    apiError,
    apiError,
    apiError,
    apiError,
    apiError,
    maxTurns,
    maxTurns,
    maxTurns,
  ]);
  sessions.set("inbox-1", "session-old");

  for (let i = 0; i < 8; i++) await handle(message());

  assert.equal(runner.inputs.length, 8);
  assert.ok(runner.inputs.every((input) => input.sessionId === "session-old"));
  assert.equal(sessions.failureCount("inbox-1"), 0);
  assert.equal(sessions.get("inbox-1"), "session-old");
  assert.equal(seeds.get("inbox-1"), undefined);
  assert.equal(logs.filter((line) => line.includes("SDK セッションを捨てて")).length, 0);
  assert.deepEqual(
    gateway.sent.map((sent) => sent.text),
    [...Array.from({ length: 5 }, () => FAILURE_REPLY), MAX_TURNS_REPLY, MAX_TURNS_REPLY, MAX_TURNS_REPLY],
  );
});

test("連続失敗: 結果が届いた失敗は、結果の届かない失敗の数を 0 に戻さない（同じ SDK セッションのまま）", async (t) => {
  const apiError: RunResult = {
    ok: false,
    errorMessage: "success (is_error)",
    sessionId: "session-old",
    sessionRecorded: true,
    toolCalls: 0,
  };
  const { runner, sessions, handle } = setup(t, [CRASH, apiError, CRASH, apiError, CRASH, okResult("session-new", "はい")]);
  sessions.set("inbox-1", "session-old");

  for (let i = 0; i < 4; i++) await handle(message());
  assert.equal(sessions.failureCount("inbox-1"), 2);
  assert.equal(sessions.get("inbox-1"), "session-old");

  await handle(message());
  assert.deepEqual(
    runner.inputs.map((input) => input.sessionId),
    ["session-old", "session-old", "session-old", "session-old", "session-old", undefined],
  );
  assert.equal(sessions.get("inbox-1"), "session-new");
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 途中経過のメッセージの [中断] */
const ABORT_ROW = {
  kind: "buttons",
  buttons: [{ customId: "turn:abort:topic-1", label: "中断", style: "danger" }],
} as const;
const STALE = [{ method: "reply", message: { text: STALE_TURN_REPLY, ephemeral: true } }];

test("途中経過: 経過時間は `<m> 分 <s> 秒`（秒未満は切り捨て）、間隔は 20 秒と 10 秒", () => {
  assert.equal(formatElapsed(20_999), "0 分 20 秒");
  assert.equal(formatElapsed(250_000), "4 分 10 秒");
  assert.equal(PROGRESS_DELAY_MS, 20_000);
  assert.equal(PROGRESS_INTERVAL_MS, 10_000);
});

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
  // 「完了」に書き換えてから返答を送る
  assert.deepEqual(gateway.order.slice(-2), ["editMessage", "send"]);
  // 途中経過のタイマーはターンの終わりで止める
  assert.equal(timers.pending, 0);
  assert.deepEqual(logs, []);
});

test("途中経過: 手順がまだ無ければ 1 行目だけ。結果の届かない失敗で終わったら「止まりました」に書き換える", async (t) => {
  const { gateway, runner, topicSessions, timers, handle } = setup(t, [CRASH]);
  topicSessions.create(TOPIC);
  const release = deferred();
  runner.beforeResult = () => release.promise;

  const turn = handle(message({ channelId: "topic-1" }));
  await timers.advance(PROGRESS_DELAY_MS);
  assert.deepEqual(gateway.posts.map((post) => post.message.text), ["作業中…（0 分 20 秒・ツール 0 回）"]);
  release.resolve();
  await turn;

  assert.deepEqual(gateway.edits.map((edit) => edit.message), [{ text: "止まりました（0 分 20 秒・ツール 0 回）", components: [] }]);
  assert.deepEqual(gateway.sent.map((sent) => sent.text), [FAILURE_REPLY]);
  assert.equal(timers.pending, 0);
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
  assert.deepEqual(logs, ["途中経過の送信に失敗しました: Missing Access"]);
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
  assert.deepEqual(logs, ["途中経過の更新に失敗しました: Unknown Message"]);
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

test("途中経過: #inbox のターンには途中経過も中断も付けない", async (t) => {
  const { gateway, runner, timers, handler, handle } = setup(t, [okResult("session-1", "はい")]);
  const release = deferred();
  runner.beforeResult = () => release.promise;

  const turn = handle(message());
  await timers.advance(PROGRESS_DELAY_MS + 3 * PROGRESS_INTERVAL_MS);

  assert.equal(runner.received[0]!.signal, undefined);
  assert.equal(runner.received[0]!.onProgress, undefined);
  assert.equal(handler.abortTurn("inbox-1"), false);
  assert.equal(timers.pending, 0);
  release.resolve();
  await turn;
  assert.deepEqual(gateway.posts, []);
  assert.deepEqual(gateway.edits, []);
  assert.deepEqual(gateway.sent.map((sent) => sent.text), ["はい"]);
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
  assert.deepEqual(await press("turn:abort:topic-1"), [{ method: "deferUpdate" }]);
  await turn;

  assert.equal(runner.received[0]!.signal?.aborted, true);
  assert.deepEqual(gateway.edits.at(-1), {
    channelId: "topic-1",
    messageId: "posted-1",
    message: { text: "中断しました（0 分 25 秒・ツール 1 回）", components: [] },
  });
  assert.equal(ABORTED_REPLY, "中断しました。続けるときは発言してください");
  assert.deepEqual(gateway.sent, [{ channelId: "topic-1", text: ABORTED_REPLY, replyToId: "message-1" }]);
  assert.equal(sessions.get("topic-1"), "session-a");
  assert.equal(sessions.failureCount("topic-1"), 0);
  assert.equal(runner.inputs.length, 1);
  assert.deepEqual(logs, ["[中断] でターンを中断しました（guild=guild-1）", "ターンが失敗しました: aborted"]);
  assert.equal(timers.pending, 0);

  // 終わったターンの [中断] は古い
  assert.deepEqual(await press("turn:abort:topic-1"), STALE);
});

test("[中断]: 実行中のターンが無いチャンネルでは本人にだけ「この操作は古くなっています」", async (t) => {
  const { topicSessions, press } = setup(t, []);
  topicSessions.create(TOPIC);

  assert.equal(STALE_TURN_REPLY, "この操作は古くなっています");
  assert.deepEqual(await press("turn:abort:topic-1"), STALE);
  assert.deepEqual(await press("turn:abort:inbox-1"), STALE);
});

test("連続失敗: 中断（aborted）は数えず、3 回続いても会話を捨てない", async (t) => {
  const aborted: RunResult = { ok: false, errorMessage: "aborted", sessionRecorded: false, toolCalls: 0 };
  const { runner, sessions, topicSessions, handle } = setup(t, [aborted, aborted, aborted]);
  topicSessions.create(TOPIC);
  sessions.set("topic-1", "session-old");

  for (let i = 0; i < 3; i++) await handle(message({ channelId: "topic-1" }));

  assert.equal(sessions.failureCount("topic-1"), 0);
  assert.equal(runner.inputs.length, 3);
  assert.ok(runner.inputs.every((input) => input.sessionId === "session-old"));
  assert.equal(sessions.get("topic-1"), "session-old");
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
  assert.equal(CONTINUE_PROMPT, "続けてください");
  assert.deepEqual(runner.inputs[1], {
    prompt: buildTurnPrompt(CONTINUE_PROMPT, pressedAt, "Asia/Tokyo", "旅行の計画"),
    sessionId: "session-x",
    context: context("topic-1"),
    allowedUrls: [],
  });
  assert.equal(runner.inputs[1]!.prompt, "[2026-10-02(金) 10:30 JST #旅行の計画]\n続けてください");
  // 発言のターンと同じく中断できる
  assert.notEqual(runner.received[1]!.signal, undefined);
  assert.deepEqual(gateway.sent, [{ channelId: "topic-1", text: `${REVIVED_NOTE}\n続きです`, replyToId: undefined }]);
  assert.equal(topicSessions.get("topic-1")?.state, "active");
  assert.equal(topicSessions.get("topic-1")?.lastActivityAt, "2026-10-02T01:31:00.000Z");
  assert.ok(logs.includes("[続ける] でターンを続けます（guild=guild-1）"));
});

test("[続ける]: 受け付けるセッションでなくなったチャンネル（削除済み・#inbox・知らない）では、ターンを入れずに本人にだけ「この操作は古くなっています」", async (t) => {
  const { db, runner, gateway, topicSessions, press } = setup(t, []);
  topicSessions.create(TOPIC);
  db.prepare("UPDATE sessions SET state = 'deleted' WHERE channel_id = 'topic-1'").run();

  assert.deepEqual(await press("turn:continue:topic-1"), STALE);
  assert.deepEqual(await press("turn:continue:inbox-1"), STALE);
  assert.deepEqual(await press("turn:continue:unknown-1"), STALE);
  assert.equal(runner.inputs.length, 0);
  assert.deepEqual(gateway.sent, []);
});

test("途中経過: 最後の書き換えは終わり方で変える（成功は完了・手順の上限・中断・timeout と例外は止まりました）", async (t) => {
  const timeout: RunResult = { ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 0 };
  const maxTurns: RunResult = {
    ok: false,
    errorMessage: "error_max_turns",
    sessionId: "session-x",
    sessionRecorded: true,
    toolCalls: 0,
  };
  const aborted: RunResult = { ok: false, errorMessage: "aborted", sessionRecorded: false, toolCalls: 0 };
  const { gateway, runner, topicSessions, timers, handle } = setup(t, [
    okResult("session-a", "できました"),
    maxTurns,
    aborted,
    timeout,
    new Error("unexpected"),
  ]);
  topicSessions.create(TOPIC);
  let release = deferred();
  runner.beforeResult = () => release.promise;

  for (let i = 0; i < 5; i++) {
    const turn = handle(message({ id: `message-${i + 1}`, channelId: "topic-1" }));
    await timers.advance(PROGRESS_DELAY_MS + 1_000);
    release.resolve();
    await turn;
    release = deferred();
  }

  assert.deepEqual(
    gateway.edits.map((edit) => edit.message),
    ["完了", "手順の上限で止まりました", "中断しました", "止まりました", "止まりました"].map((label) => ({
      text: `${label}（0 分 21 秒・ツール 0 回）`,
      components: [],
    })),
  );
  assert.equal(gateway.posts.length, 6);
  assert.equal(timers.pending, 0);
});
