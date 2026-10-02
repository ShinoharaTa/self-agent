import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, RunInput, RunResult } from "../src/agent/runner.ts";
import { createHandler, EMPTY_REPLY, FAILURE_REPLY } from "../src/app/handler.ts";
import { buildTurnPrompt } from "../src/app/prompt.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import type { Gateway, IncomingMessage } from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { SessionStore } from "../src/store/sessions.ts";
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
  async stop(): Promise<void> {}
}

class FakeRunner implements AgentRunner {
  inputs: RunInput[] = [];
  private readonly results: Array<RunResult | Error>;

  constructor(results: Array<RunResult | Error>) {
    this.results = results;
  }

  async run(input: RunInput): Promise<RunResult> {
    this.inputs.push(input);
    const next = this.results.shift();
    if (next === undefined) throw new Error("想定外の呼び出し");
    if (next instanceof Error) throw next;
    return next;
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

function okResult(sessionId: string, text: string): RunResult {
  return {
    ok: true,
    text,
    sessionId,
    usage: { inputTokens: 10, cacheReadInputTokens: 2000, cacheCreationInputTokens: 300 },
    durationMs: 4200,
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
  const sessions = new SessionStore(db, () => NOW);
  const usage = new UsageStore(db, () => NOW);
  const logs: string[] = [];
  const handle = createHandler({
    cfg,
    gateway,
    runner,
    sessions,
    usage,
    queue: new KeyedSerialQueue(2),
    log: (line) => logs.push(line),
  });
  return { gateway, runner, sessions, usage, logs, handle };
}

test("受け付けた発言で runner を呼び、usage 記録・session 保存・返信をする", async (t) => {
  const { gateway, runner, sessions, usage, logs, handle } = setup(t, [okResult("session-1", "登録しました")]);
  // 返信の時点で usage と session は記録済み
  gateway.beforeSend = () => {
    assert.equal(usage.recent(10).length, 1);
    assert.equal(sessions.get("inbox-1"), "session-1");
  };

  await handle(message());

  assert.deepEqual(runner.inputs, [
    { prompt: buildTurnPrompt("明日買い物に行く", CREATED_AT, "Asia/Tokyo"), sessionId: undefined },
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

test("ok:false なら usage に ok=0 で記録して失敗の返信をし、session は保存しない", async (t) => {
  const { gateway, sessions, usage, logs, handle } = setup(t, [
    { ok: false, errorMessage: "error_max_turns", sessionId: "session-x" },
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
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /error_max_turns/);
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
