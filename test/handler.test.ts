import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, RunInput, RunResult } from "../src/agent/runner.ts";
import { createChannelResolver } from "../src/app/access.ts";
import type { MoveTarget } from "../src/app/channel-ops.ts";
import {
  COMPACTED_NOTE,
  createHandler,
  EMPTY_REPLY,
  FAILURE_REPLY,
  MAX_TURNS_REPLY,
  REVIVED_NOTE,
} from "../src/app/handler.ts";
import { rotatedSeed } from "../src/app/summary.ts";
import { buildTurnPrompt } from "../src/app/prompt.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { RESUME_FAILURE_LIMIT, RESUME_SEED_HEADER } from "../src/app/turn.ts";
import type { Gateway, IncomingMessage } from "../src/discord/gateway.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { InboxSummaryStore } from "../src/store/inbox-summaries.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";

const cfg = { allowedGuildIds: ["guild-1"], inboxChannelId: "inbox-1", ownerUserId: "owner-1", timeZone: "Asia/Tokyo" };
const NOW = new Date("2026-10-02T00:12:00Z");
// 発言の時刻（ストアの now とは別。prompt の日時ヘッダはこちらを使う）
const CREATED_AT = new Date("2026-10-01T23:59:00Z");

class FakeGateway implements Gateway {
  sent: Array<{ channelId: string; text: string; replyToId?: string }> = [];
  typingStarted = 0;
  typingStopped = 0;
  /** send の直前に呼ばれる。投げればその送信は失敗する */
  beforeSend: () => void = () => {};

  async start(): Promise<void> {}
  async send(channelId: string, text: string, replyToId?: string): Promise<void> {
    this.beforeSend();
    this.sent.push({ channelId, text, replyToId });
  }
  async sendMessage(): Promise<string> {
    throw new Error("想定外の呼び出し");
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
  inputs: RunInput[] = [];
  /** 入力を記録した後、結果を返す前に待つ */
  beforeResult: () => Promise<void> = async () => {};
  private readonly results: Array<RunResult | Error>;

  constructor(results: Array<RunResult | Error>) {
    this.results = results;
  }

  async run(input: RunInput): Promise<RunResult> {
    this.inputs.push(input);
    await this.beforeResult();
    const next = this.results.shift();
    if (next === undefined) throw new Error("想定外の呼び出し");
    if (next instanceof Error) throw next;
    return next;
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
  const channelOps = new RecordingChannelOps();
  const queue = new KeyedSerialQueue(2);
  const logs: string[] = [];
  const handle = createHandler({
    cfg,
    // guild_settings が空なので env の #inbox（inbox-1）を受け付ける
    resolveChannel: createChannelResolver(cfg, new GuildSettingsStore(db, () => NOW), topicSessions),
    gateway,
    runner,
    sessions,
    seeds,
    topicSessions,
    inboxSummaries,
    channelOps,
    usage,
    queue,
    log: (line) => logs.push(line),
  });
  return {
    db,
    gateway,
    runner,
    sessions,
    seeds,
    topicSessions,
    inboxSummaries,
    channelOps,
    queue,
    clock,
    usage,
    logs,
    handle,
  };
}

/** ツールのハンドラに渡す、このターンのチャンネル */
function context(channelId: string = "inbox-1") {
  return { guildId: "guild-1", channelId };
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
    { prompt: buildTurnPrompt("明日買い物に行く", CREATED_AT, "Asia/Tokyo"), sessionId: undefined, context: context() },
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
    { prompt, sessionId: "session-old", context: context("topic-1") },
    { prompt: `${seed}\n\n${prompt}`, sessionId: undefined, context: context("topic-1") },
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
    { prompt, sessionId: "session-old", context: context() },
    { prompt, sessionId: undefined, context: context() },
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
    { prompt, sessionId: "session-old", context: context() },
    { prompt: `${seed}\n\n${prompt}`, sessionId: undefined, context: context() },
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
  assert.deepEqual(gateway.sent, [{ channelId: "inbox-1", text: MAX_TURNS_REPLY, replyToId: "message-1" }]);
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
