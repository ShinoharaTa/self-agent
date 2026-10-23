import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { RunResult } from "../src/agent/runner.ts";
import type { CommandDef, GatewayHandlers, IncomingMessage } from "../src/discord/gateway.ts";
import { GUEST_SESSION_MAX_AGE_HOURS, guestSessionKey } from "../src/guest/constants.ts";
import {
  buildGuestPrompt,
  createGuestHandler,
  GUEST_BUSY_REPLY,
  GUEST_EMPTY_REPLY,
  GUEST_FAILURE_REPLY,
  GUEST_GUILD_LIMIT_REPLY,
  GUEST_TOO_LONG_REPLY,
  GUEST_USER_LIMIT_REPLY,
  headerDisplayName,
  stripBotMention,
} from "../src/guest/handler.ts";
import { startGuest, type GuestGateway } from "../src/guest/index.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { GuestStore } from "../src/store/guest.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { KnowledgeStore } from "../src/store/knowledge.ts";
import { MemoryStore } from "../src/store/memories.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";
import { tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { FakeRunner, type FakeRunStep, turnUsage } from "./helpers/runner.ts";

const GUILD = "g-guest";
const BOT = "bot-1";
// log に出てはいけないもの（チャンネル ID・ユーザー ID・本文・表示名）
const CHANNEL = "chan-secret-1";
const USER = "user-secret-1";
const BODY = "本文ひみつ";
const NAME = "表示名ひみつ";
/** 2026-10-23(金) 09:00 JST */
const NOW = new Date("2026-10-23T00:00:00.000Z");
const TODAY = "2026-10-23";

const CFG = {
  timeZone: "Asia/Tokyo",
  guestTurnsPerDay: 300,
  guestUserTurnsPerDay: 50,
  guestMaxConcurrent: 1,
  guestSessionMaxTurns: 30,
  guestSessionMaxInputTokens: 60000,
};

function ok(text: string, sessionId: string, contextTokens = 1000): RunResult {
  return { ok: true, text, sessionId, usage: turnUsage(10, 0, 990, 5), durationMs: 100, toolCalls: 0, contextTokens };
}

function failed(errorMessage: string, sessionRecorded = false): RunResult {
  return { ok: false, errorMessage, toolCalls: 0, sessionRecorded };
}

let nextMessageId = 1;

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: `m${nextMessageId++}`,
    channelId: CHANNEL,
    guildId: GUILD,
    authorId: USER,
    authorIsBot: false,
    isWebhook: false,
    content: `<@${BOT}> ${BODY}`,
    createdAt: NOW,
    persona: "guest",
    mentionsMe: true,
    authorDisplayName: NAME,
    ...overrides,
  };
}

type Setup = ReturnType<typeof setup>;

function setup(t: TestContext, steps: FakeRunStep[] = [], cfg: Partial<typeof CFG> = {}, db: DatabaseSync = tempDb(t)) {
  let clock = NOW;
  const now = () => clock;
  const guest = new GuestStore(db, now);
  const sessions = new SdkSessionStore(db, now);
  const usage = new UsageStore(db, now);
  const runner = new FakeRunner(steps);
  const gateway = new FakeGateway({ allow: ["send", "startTyping"] });
  const logs: string[] = [];
  const handler = createGuestHandler({
    cfg: { ...CFG, ...cfg },
    guest,
    sessions,
    usage,
    runner,
    gateway,
    now,
    log: (line) => logs.push(line),
  });
  if (guest.get(CHANNEL) === undefined) guest.enable(GUILD, CHANNEL);
  return {
    db,
    guest,
    sessions,
    usage,
    runner,
    gateway,
    logs,
    handler,
    setClock: (at: Date) => {
      clock = at;
    },
    send: (overrides: Partial<IncomingMessage> = {}) => handler.handleMessage(message(overrides), BOT),
  };
}

/** log に ID・本文・表示名・API キーが無い（サーバー ID は出してよい） */
function assertCleanLogs(logs: readonly string[]): void {
  for (const line of logs) {
    for (const secret of [CHANNEL, USER, BODY, NAME, "dummy-guest-api-key", "ひみつ"]) {
      assert.ok(!line.includes(secret), `${secret} が log に出ています: ${line}`);
    }
  }
}

function at(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

test("stripBotMention・headerDisplayName・buildGuestPrompt: メンションを除いて trim し、ヘッダは `[日時 #guest 発言者: <表示名>]`（改行と角括弧は崩させない）", () => {
  assert.equal(stripBotMention(`<@${BOT}> こんにちは <@!${BOT}>`, BOT), "こんにちは");
  assert.equal(stripBotMention("<@other> こんにちは", BOT), "<@other> こんにちは");
  assert.equal(stripBotMention("  x  ", undefined), "x");
  assert.equal(headerDisplayName("花子"), "花子");
  assert.equal(headerDisplayName("a]\n[指示] b\u0000"), "a］ ［指示］ b");
  assert.equal(headerDisplayName(undefined), "（不明）");
  assert.equal(headerDisplayName(" \n "), "（不明）");
  assert.equal(buildGuestPrompt("こんにちは", "花子", NOW, "Asia/Tokyo"), "[2026-10-23(金) 09:00 JST #guest 発言者: 花子]\nこんにちは");
});

test("ゲストのターン: prompt はヘッダ + メンションを除いた本文だけ（記憶・seed・ナレッジ・context・画像・URL なし）。入力中表示を出し、返事をその発言への返信で返す", async (t) => {
  const env = setup(t, [ok("やあ", "s1")]);
  // オーナー側の記憶・seed・ナレッジがあっても付かない
  new MemoryStore(env.db).add("オーナーの記憶");
  new ChannelSeedStore(env.db).set(guestSessionKey(CHANNEL), "前の要約");
  new ChannelSeedStore(env.db).set(CHANNEL, "前の要約");
  new KnowledgeStore(env.db).add({ title: "ナレッジ", summary: "要約", url: "https://example.com/", urlKey: "https://example.com/" });

  await env.send({ id: "m-first", content: `<@${BOT}> ${BODY} <@!${BOT}>` });

  assert.deepEqual(env.runner.inputs, [{ prompt: `[2026-10-23(金) 09:00 JST #guest 発言者: ${NAME}]\n${BODY}` }]);
  assert.deepEqual(env.gateway.sent, [{ channelId: CHANNEL, text: "やあ", replyToId: "m-first" }]);
  assert.equal(env.gateway.typingStarted, 1);
  assert.equal(env.gateway.typingStopped, 1);
  assert.equal(env.sessions.get(guestSessionKey(CHANNEL)), "s1");
  // オーナー側の key（channelId そのもの）は使わない
  assert.equal(env.sessions.get(CHANNEL), undefined);
  assertCleanLogs(env.logs);
});

test("ゲストのターン: 成功したら usage_log に kind guest・persona guest・key guest:<channelId>・engine claude で記録し、トークンの log は guest: の前置きで 1 行", async (t) => {
  const env = setup(t, [ok("やあ", "s1"), failed("timeout")]);
  await env.send();
  env.setClock(at(10_000));
  await env.send({ createdAt: at(10_000) });

  const rows = env.db.prepare("SELECT key, kind, persona, engine, ok, output_tokens FROM usage_log ORDER BY id").all();
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { key: `guest:${CHANNEL}`, kind: "guest", persona: "guest", engine: "claude", ok: 1, output_tokens: 5 },
      { key: `guest:${CHANNEL}`, kind: "guest", persona: "guest", engine: "claude", ok: 0, output_tokens: null },
    ],
  );
  assert.ok(env.logs.some((line) => line.startsWith("guest: トークン（guest・成功）: ステップ 1")));
  assert.ok(env.logs.some((line) => line.startsWith("guest: トークン（guest・失敗）")));
  assertCleanLogs(env.logs);
});

test("ゲストのターン: 次のターンは同じ SDK セッションを resume し、成功したターンだけ数える（失敗・例外は数えず、決まった文面を返す）", async (t) => {
  const env = setup(t, [ok("1", "s1"), failed("exception: API Error: 500"), new Error("boom"), ok("  ", "s1")]);
  await env.send();
  for (const [index, ms] of [10_000, 20_000, 30_000].entries()) {
    env.setClock(at(ms));
    await env.send({ createdAt: at(ms), id: `m-${index}` });
  }

  assert.deepEqual(
    env.runner.inputs.map((input) => input.sessionId),
    [undefined, "s1", "s1", "s1"],
  );
  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.text),
    ["1", GUEST_FAILURE_REPLY, GUEST_FAILURE_REPLY, GUEST_EMPTY_REPLY],
  );
  assert.equal(env.guest.countTurns(GUILD, TODAY), 2);
  assert.equal(env.guest.countUserTurns(GUILD, USER, TODAY), 2);
  assert.equal(env.guest.get(CHANNEL)?.sessionTurns, 2);
  assert.equal(env.guest.get(CHANNEL)?.sessionStartedAt, NOW.toISOString());
  assert.ok(env.logs.some((line) => line === "guest: ターンが失敗しました（guild=g-guest）: exception: API Error: 500"));
  assertCleanLogs(env.logs);
});

/** 1 ターン目で SDK セッション s1 を作り、change を加えてから 2 ターン目を送る。2 ターン目の sessionId と、その後の状態を返す */
async function secondTurn(
  t: TestContext,
  first: RunResult,
  change: (env: Setup) => Date,
): Promise<{ env: Setup; sessionId: string | undefined }> {
  const env = setup(t, [first, ok("2", "s2")]);
  await env.send();
  const when = change(env);
  env.setClock(when);
  await env.send({ createdAt: when });
  return { env, sessionId: env.runner.inputs[1]?.sessionId };
}

test("寿命: SDK セッションのターン数が上限（30）に達したら、次のターンは新しいセッションで（seed なし）始め、数え直す", async (t) => {
  const { env, sessionId } = await secondTurn(t, ok("1", "s1"), (current) => {
    for (let i = 1; i < 30; i++) current.guest.bumpSession(CHANNEL);
    return at(10_000);
  });
  assert.equal(sessionId, undefined);
  assert.equal(env.sessions.get(guestSessionKey(CHANNEL)), "s2");
  assert.equal(env.guest.get(CHANNEL)?.sessionTurns, 1);
  assert.equal(env.guest.get(CHANNEL)?.sessionStartedAt, at(10_000).toISOString());
  assert.match(env.runner.inputs[1]!.prompt, /^\[[^\]]+\]\n本文ひみつ$/);

  // 29 ターンなら続ける
  const kept = await secondTurn(t, ok("1", "s1"), (current) => {
    for (let i = 1; i < 29; i++) current.guest.bumpSession(CHANNEL);
    return at(10_000);
  });
  assert.equal(kept.sessionId, "s1");
});

test("寿命: 直近の成功したターンの会話の大きさ（contextTokens）が上限を超えたら、次のターンは新しいセッション", async (t) => {
  assert.equal((await secondTurn(t, ok("1", "s1", 60001), () => at(10_000))).sessionId, undefined);
  assert.equal((await secondTurn(t, ok("1", "s1", 60000), () => at(10_000))).sessionId, "s1");
});

test("寿命: SDK セッションを始めてから 24 時間経ったら、次のターンは新しいセッション", async (t) => {
  const hours = GUEST_SESSION_MAX_AGE_HOURS * 3_600_000;
  assert.equal((await secondTurn(t, ok("1", "s1"), () => at(hours))).sessionId, undefined);
  assert.equal((await secondTurn(t, ok("1", "s1"), () => at(hours - 1))).sessionId, "s1");
});

test("寿命: resume が「会話の記録が無い」で失敗したら、SDK セッションを捨てて新しいセッションで 1 回だけやり直す（失敗は数えない）", async (t) => {
  const env = setup(t, [
    ok("1", "s1"),
    failed("error_during_execution: No conversation found with session ID: s1", true),
    ok("2", "s2"),
    failed("error_during_execution: No conversation found with session ID: s2", true),
    failed("error_during_execution: No conversation found with session ID: x", true),
  ]);
  await env.send();
  env.setClock(at(10_000));
  await env.send({ createdAt: at(10_000) });

  assert.deepEqual(env.runner.inputs.map((input) => input.sessionId), [undefined, "s1", undefined]);
  assert.equal(env.runner.inputs[2]!.prompt, env.runner.inputs[1]!.prompt);
  assert.deepEqual(env.gateway.sent.map((sent) => sent.text), ["1", "2"]);
  assert.equal(env.sessions.get(guestSessionKey(CHANNEL)), "s2");
  assert.equal(env.guest.get(CHANNEL)?.sessionTurns, 1);
  assert.equal(env.guest.countTurns(GUILD, TODAY), 2);
  assert.ok(env.logs.includes("guest: resume に失敗したため、SDK セッションを捨てて新しいセッションで 1 回だけやり直します（guild=g-guest）"));

  // やり直しも失敗したら、それ以上はやり直さない
  env.setClock(at(20_000));
  await env.send({ createdAt: at(20_000) });
  assert.equal(env.runner.inputs.length, 5);
  assert.equal(env.gateway.sent.at(-1)?.text, GUEST_FAILURE_REPLY);
  assertCleanLogs(env.logs);
});

test("寿命: resume が結果の届かない失敗で 3 回続いたら、次のターンは新しいセッションで始める（タイムアウト・中断は数えず、成功で数え直す）", async (t) => {
  const crash = failed("exception: Error: Claude Code process exited with code 1");
  const env = setup(t, [ok("1", "s1"), crash, crash, ok("2", "s1"), crash, crash, crash, ok("3", "s2")]);
  const times = [0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000];
  for (const [index, ms] of times.entries()) {
    env.setClock(at(ms));
    await env.send({ createdAt: at(ms), id: `r-${index}` });
  }
  assert.deepEqual(
    env.runner.inputs.map((input) => input.sessionId),
    [undefined, "s1", "s1", "s1", "s1", "s1", "s1", undefined],
  );
  assert.equal(env.sessions.get(guestSessionKey(CHANNEL)), "s2");
  assert.equal(env.guest.get(CHANNEL)?.sessionTurns, 1);
  assert.ok(env.logs.includes("guest: resume の失敗が 3 回続いたため、次のターンは新しいセッションで始めます（guild=g-guest）"));
  assertCleanLogs(env.logs);

  // タイムアウト・中断・結果の届いた失敗は数えない
  const other = setup(t, [ok("1", "s1"), failed("timeout"), failed("aborted"), failed("error_max_turns", true), ok("2", "s1")]);
  for (const [index, ms] of [0, 10_000, 20_000, 30_000, 40_000].entries()) {
    other.setClock(at(ms));
    await other.send({ createdAt: at(ms), id: `o-${index}` });
  }
  assert.equal(other.runner.inputs.at(-1)?.sessionId, "s1");
});

test("上限: guest_turns には上限の判定に使った日（発言の日）で数える", async (t) => {
  // 発言は 10/23 23:59:59 JST、ターンが終わるのは 10/24
  const sentAt = new Date("2026-10-23T14:59:59.000Z");
  const env = setup(t, [ok("1", "s1")]);
  env.setClock(new Date("2026-10-23T15:00:30.000Z"));
  await env.send({ createdAt: sentAt });
  assert.equal(env.guest.countTurns(GUILD, TODAY), 1);
  assert.equal(env.guest.countTurns(GUILD, "2026-10-24"), 0);
});

test("上限: サーバーの 301 回目・ユーザーの 51 回目は決まった文面を返し、run は呼ばない。再起動（ストア・handler を作り直す）しても数は残る", async (t) => {
  const db = tempDb(t);
  const first = setup(t, [], {}, db);
  for (let i = 0; i < 300; i++) first.guest.recordTurn(GUILD, `other-${i}`, TODAY);
  await first.send();
  assert.deepEqual(first.gateway.sent.map((sent) => sent.text), [GUEST_GUILD_LIMIT_REPLY]);

  const restarted = setup(t, [], { guestTurnsPerDay: 1000 }, db);
  for (let i = 0; i < 50; i++) restarted.guest.recordTurn(GUILD, USER, TODAY);
  await restarted.send();
  assert.deepEqual(restarted.gateway.sent.map((sent) => sent.text), [GUEST_USER_LIMIT_REPLY]);

  // 別のユーザーはまだ使える
  const other = setup(t, [ok("はい", "s1")], { guestTurnsPerDay: 1000 }, db);
  await other.send({ authorId: "user-secret-2" });
  assert.deepEqual(other.gateway.sent.map((sent) => sent.text), ["はい"]);

  assert.equal(first.runner.inputs.length + restarted.runner.inputs.length, 0);
  assertCleanLogs([...first.logs, ...restarted.logs, ...other.logs]);
});

test("上限: 同じサーバー・同じユーザーの 5 秒以内の連投は run も返事も log も無い。5 秒経てば受け付ける", async (t) => {
  const env = setup(t, [ok("1", "s1"), ok("2", "s1")]);
  await env.send();
  const logs = env.logs.length;
  await env.send({ createdAt: at(4_999) });
  assert.equal(env.runner.inputs.length, 1);
  assert.equal(env.gateway.sent.length, 1);
  assert.equal(env.logs.length, logs);
  env.setClock(at(5_000));
  await env.send({ createdAt: at(5_000) });
  assert.equal(env.runner.inputs.length, 2);
});

test("上限: メンションを除いた本文が 2,000 字を超えたら断り、2,000 字なら受け付ける。添付だけ（本文が空）は無視する", async (t) => {
  const env = setup(t, [ok("はい", "s1")]);
  await env.send({ content: `<@${BOT}> ${"あ".repeat(2001)}`, authorId: "u-long" });
  await env.send({ content: `<@${BOT}> ${"あ".repeat(2000)}`, authorId: "u-ok" });
  await env.send({ content: `<@${BOT}>`, authorId: "u-empty" });
  await env.send({ content: "", authorId: "u-empty2" });
  assert.deepEqual(env.gateway.sent.map((sent) => sent.text), [GUEST_TOO_LONG_REPLY, "はい"]);
  assert.equal(env.runner.inputs.length, 1);
});

test("上限: キューの待ちが 5 件のとき、6 件目は「混み合っています」。待っていたものは順に答える", async (t) => {
  const steps = Array.from({ length: 6 }, (_, i) => ok(`答え${i}`, "s1"));
  const env = setup(t, steps);
  let release!: () => void;
  env.runner.gates[0] = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 1 件が実行中、5 件が待ち
  const pending = [env.send({ authorId: "u-0", id: "q-0" })];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.runner.inputs.length, 1);
  pending.push(...[1, 2, 3, 4, 5].map((i) => env.send({ authorId: `u-${i}`, id: `q-${i}` })));
  await env.send({ authorId: "u-6", id: "q-6" });
  assert.deepEqual(env.gateway.sent, [{ channelId: CHANNEL, text: GUEST_BUSY_REPLY, replyToId: "q-6" }]);
  release();
  await Promise.all(pending);
  await env.handler.idle();
  assert.equal(env.runner.inputs.length, 6);
  assert.deepEqual(env.gateway.sent.slice(1).map((sent) => sent.text), ["答え0", "答え1", "答え2", "答え3", "答え4", "答え5"]);
});

test("ゲストのターン: 待っている間に無効にされたチャンネルでは run しない", async (t) => {
  const env = setup(t, [ok("1", "s1")]);
  let release!: () => void;
  env.runner.gates[0] = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = env.send({ authorId: "u-a" });
  const second = env.send({ authorId: "u-b" });
  await new Promise((resolve) => setImmediate(resolve));
  env.guest.disable(CHANNEL, "command");
  release();
  await Promise.all([first, second]);
  assert.equal(env.runner.inputs.length, 1);
  assert.equal(env.gateway.sent.length, 1);
});

/** startGuest の Gateway の偽物 */
class FakeGuestGateway implements GuestGateway {
  handlers: GatewayHandlers | undefined;
  sent: Array<{ channelId: string; text: string; replyToId?: string }> = [];
  stopped = 0;
  async start(handlers: GatewayHandlers): Promise<void> {
    this.handlers = handlers;
  }
  async stop(): Promise<void> {
    this.stopped++;
  }
  isInGuild(): boolean {
    return true;
  }
  async registerGuildCommands(_guildId: string, _defs: readonly CommandDef[]): Promise<void> {}
  async send(channelId: string, text: string, replyToId?: string): Promise<void> {
    this.sent.push({ channelId, text, ...(replyToId === undefined ? {} : { replyToId }) });
  }
  startTyping(): () => void {
    return () => {};
  }
  selfUserId(): string | undefined {
    return BOT;
  }
}

function startWith(t: TestContext, steps: FakeRunStep[]) {
  const db = tempDb(t);
  const now = () => NOW;
  const guest = new GuestStore(db, now);
  guest.enable(GUILD, CHANNEL);
  const runner = new FakeRunner(steps);
  const gateway = new FakeGuestGateway();
  const logs: string[] = [];
  let stopping = false;
  const layer = startGuest({
    cfg: {
      ...CFG,
      allowedGuildIds: ["g-owner"],
      ownerUserId: "owner-1",
      guestGuildIds: [GUILD],
      guestTokenEnv: "SELF_AGENT_GUEST_DISCORD_TOKEN",
    },
    guest,
    sessions: new SdkSessionStore(db, now),
    runner,
    usage: new UsageStore(db, now),
    guildSettings: new GuildSettingsStore(db, now),
    adminGateway: new FakeGateway({ allow: ["sendMessage"] }),
    stopping: () => stopping,
    now,
    log: (line) => logs.push(line),
    createGateway: () => gateway,
  });
  return {
    layer,
    runner,
    gateway,
    logs,
    setStopping: () => {
      stopping = true;
    },
  };
}

test("startGuest: 受付判定（5 条件）を通った発言だけターンにする。メンションでなくても Bot への返信なら答え、他の人への返信・既定の Bot の発言・停止を始めた後の発言は捨てる", async (t) => {
  const { layer, runner, gateway, setStopping } = startWith(t, [ok("1", "s1"), ok("2", "s1")]);
  await layer.ready;
  const onMessage = gateway.handlers!.onMessage;
  onMessage(message({ id: "a", authorId: "u-a" }));
  onMessage(message({ id: "b", authorId: "u-b", content: BODY, mentionsMe: false, replyToAuthorId: BOT }));
  onMessage(message({ id: "c", authorId: "u-c", content: BODY, mentionsMe: false, replyToAuthorId: "someone" }));
  onMessage(message({ id: "d", authorId: "u-d", persona: "default" }));
  onMessage(message({ id: "e", authorId: "u-e", authorIsBot: true }));
  onMessage(message({ id: "f", authorId: "u-f", channelId: "chan-other" }));
  await layer.idle();
  setStopping();
  onMessage(message({ id: "g", authorId: "u-g" }));
  await layer.idle();
  assert.equal(runner.inputs.length, 2);
  assert.deepEqual(gateway.sent.map((sent) => sent.replyToId), ["a", "b"]);
});

test("停止: idle はゲストのキューの実行中のターンの返信まで待つ", async (t) => {
  const { layer, runner, gateway, logs } = startWith(t, [ok("やあ", "s1")]);
  await layer.ready;
  let release!: () => void;
  runner.gates[0] = new Promise<void>((resolve) => {
    release = resolve;
  });
  gateway.handlers!.onMessage(message({ id: "m-stop" }));
  let idle = false;
  const waiting = layer.idle().then(() => {
    idle = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  release();
  await waiting;
  assert.deepEqual(gateway.sent, [{ channelId: CHANNEL, text: "やあ", replyToId: "m-stop" }]);
  await layer.stop();
  assert.equal(gateway.stopped, 1);
  assertCleanLogs(logs);
});
