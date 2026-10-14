import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { buildQueryOptions } from "../src/agent/query-options.ts";
import type { RunResult } from "../src/agent/runner.ts";
import { buildSystemPrompt, SYSTEM_PROMPT } from "../src/agent/system-prompt.ts";
import { acceptedChannel, createChannelResolver } from "../src/app/access.ts";
import { ChannelOpsQueue } from "../src/app/channel-ops.ts";
import { CLOSE_PROMPT, createCloseCommand } from "../src/app/commands/close.ts";
import { createDeleteComponent } from "../src/app/commands/delete.ts";
import { createRenewCommand, renewedText } from "../src/app/commands/renew.ts";
import { createHandler } from "../src/app/handler.ts";
import { InboxRotator } from "../src/app/inbox-rotate.ts";
import { type CommandHandler, registerCommands } from "../src/app/interactions.ts";
import {
  PersonaStatus,
  personaDisconnectedNotice,
  personaReconnectedNotice,
  startPersonaGateways,
} from "../src/app/persona-status.ts";
import { PersonaRouter, POSTED_BY_OWNER_REPLY } from "../src/app/personas.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { Scheduler } from "../src/app/scheduler.ts";
import { rotatedSeed } from "../src/app/summary.ts";
import { runChannelTurn } from "../src/app/turn.ts";
import { DiscordGateway } from "../src/discord/discord-gateway.ts";
import type { Gateway, IncomingMessage, Interaction } from "../src/discord/gateway.ts";
import type { DatabaseSync } from "node:sqlite";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway, type GatewayMethod } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { FakeResponder } from "./helpers/responder.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

const NOW = new Date("2026-10-14T00:12:00Z");
const cfg = {
  allowedGuildIds: ["guild-1"],
  inboxChannelId: "inbox-1",
  ownerUserId: "owner-1",
  timeZone: "Asia/Tokyo",
  deleteAfterDays: 30,
  inboxRotateAt: { hour: 4, minute: 0 },
  inboxMaxInputTokens: 150000,
};
/** 足した人格（持ち主の Bot の投稿だけを許す。管理の操作は呼ばれたら投げる） */
const OWNER_METHODS: GatewayMethod[] = ["send", "sendMessage", "editMessage", "startTyping"];

function ok(text: string, sessionId: string): RunResult {
  return { ok: true, text, sessionId, usage: turnUsage(10, 2000, 300), durationMs: 1000, toolCalls: 0, contextTokens: 2310 };
}

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: "message-1",
    channelId: "inbox-1",
    guildId: "guild-1",
    authorId: "owner-1",
    authorIsBot: false,
    isWebhook: false,
    content: "こんにちは",
    createdAt: NOW,
    ...overrides,
  };
}

/** 呼ばれたメソッドの名前を残す（足した人格の Bot に管理の操作が来ないことを確かめる） */
function tracked(gateway: FakeGateway): { gateway: Gateway; called: string[] } {
  const called: string[] = [];
  const proxy = new Proxy(gateway, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        called.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { gateway: proxy, called };
}

/** 既定の人格と、足した人格 mika。mika のセッション topic-m（進行中）と、既定の人格のセッション topic-d がある */
function setup(t: TestContext, steps: { default?: RunResult[]; mika?: RunResult[] } = {}) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { topicSessions, guildSettings, sessions, seeds, inboxSummaries, memories, usage } = stores;
  const defaultGateway = new FakeGateway({
    allow: [...OWNER_METHODS, "isInGuild", "registerGuildCommands", "deleteChannel"],
    record: ["createCategory", "moveChannel", "getParentId", "channelExists", "countChannelsIn"],
  });
  const mikaFake = new FakeGateway({ allow: OWNER_METHODS, messageIdPrefix: "mika-" });
  const mika = tracked(mikaFake);
  const defaultRunner = new FakeRunner(steps.default ?? []);
  const mikaRunner = new FakeRunner(steps.mika ?? []);
  const personas = new PersonaRouter({
    personas: [
      { id: "default", name: "default", engine: "claude", runner: defaultRunner, gateway: defaultGateway },
      { id: "mika", name: "ミカ", engine: "claude", runner: mikaRunner, gateway: mika.gateway },
    ],
    guildSettings,
    topicSessions,
  });
  topicSessions.create({ channelId: "topic-m", guildId: "guild-1", title: "ミカの相談", categoryId: "active-1", persona: "mika" });
  topicSessions.create({ channelId: "topic-d", guildId: "guild-1", title: "既定の相談", categoryId: "active-1" });
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const turn = { runner: defaultRunner, personas, sessions, seeds, topicSessions, inboxSummaries, memories, usage, log };
  return { db, ...stores, defaultGateway, mikaFake, mika, defaultRunner, mikaRunner, personas, turn, logs, log };
}

/** usage_log の人格とエンジン（古い順） */
function usageOwners(db: DatabaseSync): Array<[string, string, string]> {
  return db
    .prepare("SELECT key, persona, engine FROM usage_log ORDER BY id")
    .all()
    .map((row) => [String(row.key), String(row.persona), String(row.engine)]);
}

test("acceptedChannel: 受け取った Bot の人格がチャンネルの持ち主のときだけ受け付ける（省略は既定の人格）", () => {
  const resolve = () => "session" as const;
  const ownerOf = (channelId: string) => (channelId === "topic-m" ? "mika" : "default");
  const cases: Array<[Partial<IncomingMessage>, boolean]> = [
    [{ channelId: "topic-m", persona: "mika" }, true],
    [{ channelId: "topic-m", persona: "default" }, false],
    [{ channelId: "topic-m" }, false],
    [{ channelId: "topic-d", persona: "default" }, true],
    [{ channelId: "topic-d" }, true],
    [{ channelId: "topic-d", persona: "mika" }, false],
  ];
  for (const [overrides, accepted] of cases) {
    assert.equal(acceptedChannel(message(overrides), cfg, resolve, ownerOf) !== null, accepted, JSON.stringify(overrides));
  }
  // 振り分けが無ければすべて既定の人格のもの
  assert.equal(acceptedChannel(message({ persona: "default" }), cfg, resolve), "session");
  assert.equal(acceptedChannel(message({ persona: "mika" }), cfg, resolve), null);
  // Bot の発言は持ち主の Bot が受け取っても受け付けない
  assert.equal(acceptedChannel(message({ channelId: "topic-m", persona: "mika", authorIsBot: true }), cfg, resolve, ownerOf), null);
});

test("PersonaRouter: 持ち主は persona_channels → sessions.persona の順に引き、どちらにも無い・設定に無い人格なら既定の人格", (t) => {
  const env = setup(t);
  env.guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  env.db
    .prepare(
      "INSERT INTO persona_channels (guild_id, persona, kind, channel_id, created_at, updated_at) VALUES ('guild-1', 'mika', 'inbox', 'mika-entry', 'x', 'x')",
    )
    .run();
  env.topicSessions.create({ channelId: "topic-x", guildId: "guild-1", title: "外した人格", categoryId: "active-1", persona: "gone" });
  const owners = ["inbox-1", "mika-entry", "topic-m", "topic-d", "topic-x", "unknown"].map((id) => env.personas.ownerOf(id));
  assert.deepEqual(owners, ["default", "mika", "mika", "default", "default", "default"]);
  assert.equal(env.personas.gatewayFor("topic-m"), env.mika.gateway);
  assert.equal(env.personas.gatewayFor("inbox-1"), env.defaultGateway);
  assert.equal(env.personas.admin, env.defaultGateway);
  assert.equal(env.personas.turnPersona("topic-m").runner, env.mikaRunner);
  assert.equal(env.personas.turnPersona("unknown").runner, env.defaultRunner);
});

test("2 つの Bot が同じ発言を受け取ると、持ち主の Bot の分だけがターンになり、返信は持ち主の Bot から出る", async (t) => {
  const env = setup(t, { default: [ok("既定の返事", "s-d")], mika: [ok("ミカの返事", "s-m")] });
  const handler = createHandler({
    cfg,
    resolveChannel: createChannelResolver(cfg, env.guildSettings, env.topicSessions),
    ...env.turn,
    gateway: env.personas.ownerPosts(),
    channelOps: new RecordingChannelOps(),
    queue: new KeyedSerialQueue(2),
    now: () => NOW,
    timers: { after: () => () => {}, every: () => () => {} },
  });

  // mika のセッション: 両方の Bot が受け取る
  await handler.handleMessage(message({ channelId: "topic-m", persona: "default" }));
  await handler.handleMessage(message({ channelId: "topic-m", persona: "mika" }));
  // 既定の人格の #inbox（env）: 両方の Bot が受け取る
  await handler.handleMessage(message({ channelId: "inbox-1", persona: "mika" }));
  await handler.handleMessage(message({ channelId: "inbox-1", persona: "default" }));

  assert.equal(env.mikaRunner.inputs.length, 1);
  assert.equal(env.mikaRunner.inputs[0]?.context?.channelId, "topic-m");
  assert.equal(env.defaultRunner.inputs.length, 1);
  assert.equal(env.defaultRunner.inputs[0]?.context?.channelId, "inbox-1");
  assert.deepEqual(
    env.mikaFake.sent.map(({ channelId, text }) => [channelId, text]),
    [["topic-m", "ミカの返事"]],
  );
  assert.deepEqual(
    env.defaultGateway.sent.map(({ channelId, text }) => [channelId, text]),
    [["inbox-1", "既定の返事"]],
  );
  assert.equal(env.mikaFake.typingStarted, 1);
  assert.equal(env.defaultGateway.typingStarted, 1);
  // usage には動かした人格とエンジンを残す
  assert.deepEqual(usageOwners(env.db), [
    ["topic-m", "mika", "claude"],
    ["inbox-1", "default", "claude"],
  ]);
});

test("足した人格のチャンネルの /close は既定のアプリで受け、ターンはその人格の runner で動かし、結果はその人格の Bot が投稿する", async (t) => {
  const env = setup(t, { mika: [ok("要約です", "s-m2")] });
  env.sessions.set("topic-m", "s-m");
  const command = createCloseCommand({
    topicSessions: env.topicSessions,
    tasks: env.tasks,
    channelOps: new RecordingChannelOps(),
    turnQueue: new KeyedSerialQueue(2),
    turn: env.turn,
    personas: env.personas,
    projects: env.projects,
    projectsDir: "/nonexistent",
    log: env.log,
  });
  const responder = new FakeResponder();
  const close: Interaction = { kind: "command", name: "close", options: {}, guildId: "guild-1", channelId: "topic-m", userId: "owner-1", createdAt: NOW };
  assert.equal(close.kind, "command");
  if (close.kind === "command") await command.handle(close, responder);

  assert.deepEqual(env.mikaRunner.inputs.map((input) => input.prompt), [CLOSE_PROMPT]);
  assert.equal(env.defaultRunner.inputs.length, 0);
  // 受けたアプリの応答は本人にだけ、結果は mika の Bot がチャンネルに投稿する
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: POSTED_BY_OWNER_REPLY } },
  ]);
  assert.equal(env.mikaFake.posts.length, 1);
  assert.equal(env.mikaFake.posts[0]?.channelId, "topic-m");
  assert.match(env.mikaFake.posts[0]?.message.text ?? "", /要約です/);
  assert.equal(env.defaultGateway.posts.length, 0);
  assert.equal(env.topicSessions.get("topic-m")?.state, "done");
  assert.deepEqual(usageOwners(env.db), [["topic-m", "mika", "claude"]]);

  // 既定の人格のセッションの /close は今までどおり公開で保留して応答に出す
  const env2 = setup(t, { default: [ok("既定の要約", "s-d2")] });
  env2.sessions.set("topic-d", "s-d");
  const command2 = createCloseCommand({
    topicSessions: env2.topicSessions,
    tasks: env2.tasks,
    channelOps: new RecordingChannelOps(),
    turnQueue: new KeyedSerialQueue(2),
    turn: env2.turn,
    personas: env2.personas,
    projects: env2.projects,
    projectsDir: "/nonexistent",
    log: env2.log,
  });
  const responder2 = new FakeResponder();
  if (close.kind === "command") await command2.handle({ ...close, channelId: "topic-d" }, responder2);
  assert.deepEqual(responder2.calls[0], { method: "defer", ephemeral: false });
  assert.equal(responder2.calls[1]?.method, "reply");
  assert.equal(env2.mikaRunner.inputs.length, 0);
  assert.equal(env2.mikaFake.posts.length, 0);
});

test("足した人格のセッションの /renew はその人格の runner で要約し、結果はその人格の Bot が投稿する", async (t) => {
  const env = setup(t, { mika: [ok("- 要約", "s-m")] });
  env.sessions.set("topic-m", "s-m");
  const command = createRenewCommand({
    topicSessions: env.topicSessions,
    turnQueue: new KeyedSerialQueue(2),
    turn: env.turn,
    log: env.log,
    guildSettings: env.guildSettings,
    inboxRotator: { rotateNow: async () => "failed" },
    personas: env.personas,
  });
  const responder = new FakeResponder();
  await command.handle(
    { kind: "command", name: "renew", options: {}, guildId: "guild-1", channelId: "topic-m", userId: "owner-1", createdAt: NOW },
    responder,
  );
  assert.equal(env.mikaRunner.inputs.length, 1);
  assert.equal(env.defaultRunner.inputs.length, 0);
  assert.deepEqual(
    env.mikaFake.posts.map(({ channelId, message: posted }) => [channelId, posted.text]),
    [["topic-m", renewedText("- 要約")]],
  );
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: POSTED_BY_OWNER_REPLY } },
  ]);
  assert.deepEqual(usageOwners(env.db), [["topic-m", "mika", "claude"]]);
});

test("足した人格の Bot は createCategory・moveChannel・deleteChannel・registerGuildCommands を呼ばれない（管理の操作は既定の人格の Bot）", async (t) => {
  const env = setup(t, { mika: [ok("おかえり", "s-m")] });
  // mika のセッションは待ちで、状態カテゴリはまだ無い（戻すときに進行中カテゴリを作る）
  env.topicSessions.setWaiting("topic-m");
  env.defaultGateway.alive.add("topic-m");
  const channelOps = new ChannelOpsQueue({
    gateway: env.personas.admin,
    guildSettings: env.guildSettings,
    topicSessions: env.topicSessions,
    gapMs: 1,
    timers: { sleep: async () => {} },
    log: env.log,
  });
  const commands: CommandHandler[] = [{ def: { name: "help", description: "使い方" }, handle: async () => {} }];
  await registerCommands({ cfg, gateway: env.personas.admin, commands, log: env.log });

  const handler = createHandler({
    cfg,
    resolveChannel: createChannelResolver(cfg, env.guildSettings, env.topicSessions),
    ...env.turn,
    gateway: env.personas.ownerPosts(),
    channelOps,
    queue: new KeyedSerialQueue(2),
    now: () => NOW,
    timers: { after: () => () => {}, every: () => () => {} },
  });
  await handler.handleMessage(message({ channelId: "topic-m", persona: "mika" }));
  await channelOps.idle();

  // 完了にして削除の確認の [削除する] を押す
  env.topicSessions.close("topic-m", "要約");
  env.topicSessions.setDeletePrompt("topic-m", "prompt-1");
  const del = createDeleteComponent({
    cfg,
    topicSessions: env.topicSessions,
    sessions: env.sessions,
    seeds: env.seeds,
    gateway: env.personas.admin,
    channelOps,
    log: env.log,
  });
  await del.handle(
    { kind: "button", customId: "del:yes:topic-m", messageId: "prompt-1", guildId: "guild-1", channelId: "system-1", userId: "owner-1", createdAt: NOW },
    new FakeResponder(),
  );

  assert.equal(env.mikaRunner.inputs.length, 1);
  assert.equal(env.mikaFake.sent.length, 1);
  assert.deepEqual(env.defaultGateway.registered.map((entry) => entry.guildId), ["guild-1"]);
  assert.deepEqual(env.defaultGateway.callsOf("createCategory", "moveChannel").map((call) => call.method), ["createCategory", "moveChannel"]);
  assert.deepEqual(env.defaultGateway.deleted, ["topic-m"]);
  for (const forbidden of ["createCategory", "createTextChannel", "moveChannel", "deleteChannel", "registerGuildCommands", "pinMessage"]) {
    assert.equal(env.mika.called.includes(forbidden), false, forbidden);
  }
  assert.deepEqual([...new Set(env.mika.called)].sort(), ["send", "startTyping"]);
});

test("要約は人格ごと: 書くときも引くときもチャンネルの持ち主の人格のもの", async (t) => {
  const env = setup(t, {
    default: [{ ok: false, errorMessage: "No conversation found with session ID: s-d", toolCalls: 0, sessionRecorded: false }],
    mika: [
      { ok: false, errorMessage: "No conversation found with session ID: s-x", toolCalls: 0, sessionRecorded: false },
      ok("返事", "s-x2"),
    ],
  });
  // ストアの add・latest は人格で分ける（省略は既定の人格）
  env.inboxSummaries.add("guild-1", "2026-10-13", "既定の要約");
  env.inboxSummaries.add("guild-1", "2026-10-13", "ミカの要約", "inbox", "mika");
  assert.equal(env.inboxSummaries.latest("guild-1")?.summary, "既定の要約");
  assert.equal(env.inboxSummaries.latest("guild-1", "inbox", "mika")?.summary, "ミカの要約");
  assert.equal(env.inboxSummaries.latest("guild-1", "tasks", "mika"), undefined);

  // mika の入口のチャンネル（kind inbox）の resume 失敗の復旧は、mika の要約を seed にする
  env.db
    .prepare(
      "INSERT INTO persona_channels (guild_id, persona, kind, channel_id, created_at, updated_at) VALUES ('guild-1', 'mika', 'inbox', 'mika-entry', 'x', 'x')",
    )
    .run();
  env.sessions.set("mika-entry", "s-x");
  const result = await runChannelTurn(env.turn, {
    guildId: "guild-1",
    channelId: "mika-entry",
    kind: "inbox",
    prompt: "[ヘッダ]\nこんにちは",
    allowedUrls: [],
  });
  assert.equal(result.ok, true);
  assert.equal(env.mikaRunner.inputs[1]?.prompt, `${rotatedSeed("ミカの要約", "inbox")}\n\n[ヘッダ]\nこんにちは`);
  assert.equal(env.defaultRunner.inputs.length, 0);

  // 既定の人格の #inbox の切り替えは、記録が切れていれば既定の人格の要約だけを引き継ぐ（mika の要約は使わない）
  env.db.prepare("DELETE FROM inbox_summaries WHERE persona = 'default'").run();
  env.guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  env.sessions.set("inbox-1", "s-d");
  const rotator = new InboxRotator({
    cfg,
    guildSettings: env.guildSettings,
    inboxSummaries: env.inboxSummaries,
    turnQueue: new KeyedSerialQueue(2),
    turn: env.turn,
    gateway: env.personas.ownerPosts(),
    now: () => NOW,
    log: env.log,
  });
  assert.equal(await rotator.rotateNow("guild-1", "inbox"), "rotated_fresh");
  assert.equal(env.seeds.get("inbox-1"), undefined);
  assert.equal(env.defaultRunner.inputs.length, 1);
  assert.deepEqual(usageOwners(env.db), [
    ["mika-entry", "mika", "claude"],
    ["mika-entry", "mika", "claude"],
    ["inbox-1", "default", "claude"],
  ]);
});

test("要約のターンが成功したら、要約はチャンネルの持ち主の人格の行として残す", async (t) => {
  const env = setup(t, { default: [ok("- #inbox の要約", "s-d2")] });
  env.guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  env.sessions.set("inbox-1", "s-d");
  const rotator = new InboxRotator({
    cfg,
    guildSettings: env.guildSettings,
    inboxSummaries: env.inboxSummaries,
    turnQueue: new KeyedSerialQueue(2),
    turn: env.turn,
    gateway: env.personas.ownerPosts(),
    now: () => NOW,
    log: env.log,
  });
  assert.equal(await rotator.rotateNow("guild-1", "inbox"), "rotated");
  const rows = env.db.prepare("SELECT persona, summary FROM inbox_summaries").all();
  assert.deepEqual(rows.map((row) => [String(row.persona), String(row.summary)]), [["default", "- #inbox の要約"]]);
  assert.equal(env.inboxSummaries.latest("guild-1", "inbox", "mika"), undefined);
});

test("新しいセッションは作った人格を記録する（省略は既定の人格）", (t) => {
  const env = setup(t);
  assert.equal(env.topicSessions.personaOf("topic-m"), "mika");
  assert.equal(env.topicSessions.personaOf("topic-d"), "default");
  assert.equal(env.topicSessions.personaOf("unknown"), undefined);
});

/** guild-1 は /setup 済み（#system あり）、guild-2 は #system なし */
function statusSetup(t: TestContext) {
  const db = tempDb(t);
  const { guildSettings } = createStores(db, () => NOW);
  guildSettings.setChannel("guild-1", "systemChannelId", "system-1");
  guildSettings.setChannel("guild-2", "inboxChannelId", "inbox-2");
  const gateway = new FakeGateway({ allow: ["sendMessage"] });
  const logs: string[] = [];
  const connected = { mika: true, nana: true };
  const status = new PersonaStatus({
    cfg: { allowedGuildIds: ["guild-1", "guild-2"] },
    personas: [
      { id: "mika", name: "ミカ", connected: () => connected.mika },
      { id: "nana", name: "ナナ", connected: () => connected.nana },
    ],
    guildSettings,
    gateway,
    log: (line) => logs.push(line),
  });
  const posts = (): Array<[string, string]> => gateway.posts.map(({ channelId, message: posted }) => [channelId, posted.text]);
  return { gateway, logs, connected, status, posts };
}

test("PersonaStatus: 接続できない・戻ったが変わったときだけ #system に知らせる（最初は接続できないときだけ）", async (t) => {
  const env = statusSetup(t);
  env.connected.nana = false;
  await env.status.refresh();
  assert.deepEqual(env.posts(), [["system-1", personaDisconnectedNotice("ナナ")]]);
  assert.deepEqual(env.logs, ["人格の Bot に接続できません（persona=nana）"]);

  // 変わらなければ知らせない
  await env.status.refresh();
  assert.equal(env.posts().length, 1);

  env.connected.mika = false;
  env.connected.nana = true;
  await env.status.refresh();
  assert.deepEqual(env.posts().slice(1), [
    ["system-1", personaDisconnectedNotice("ミカ")],
    ["system-1", personaReconnectedNotice("ナナ")],
  ]);
  await env.status.refresh();
  assert.equal(env.posts().length, 3);
  assert.deepEqual(env.logs.slice(1), ["人格の Bot に接続できません（persona=mika）", "人格の Bot に接続しました（persona=nana）"]);
});

test("PersonaStatus: 投稿に失敗したサーバーには、状態が変わらなければ次の refresh でやり直す", async (t) => {
  const env = statusSetup(t);
  env.connected.mika = false;
  let fail = true;
  env.gateway.beforeSendMessage = () => {
    if (fail) throw new Error("通信エラー");
  };
  await env.status.refresh();
  assert.deepEqual(env.posts(), []);
  assert.match(env.logs.at(-1) ?? "", /^人格の Bot の接続の知らせの投稿に失敗しました（guild=guild-1、persona=mika）/);
  fail = false;
  await env.status.refresh();
  assert.deepEqual(env.posts(), [["system-1", personaDisconnectedNotice("ミカ")]]);
  await env.status.refresh();
  assert.equal(env.posts().length, 1);
});

test("startPersonaGateways: ログインの失敗・時間切れは log だけで reject しない", async () => {
  const logs: string[] = [];
  const started: string[] = [];
  const handlers = { onMessage: () => {}, onInteraction: () => {} };
  await startPersonaGateways(
    [
      { id: "mika", gateway: { start: async () => void started.push("mika") } },
      { id: "nana", gateway: { start: async () => Promise.reject(new Error("An invalid token was provided.")) } },
      { id: "kai", gateway: { start: () => new Promise<void>(() => {}) } },
    ],
    handlers,
    (line) => logs.push(line),
    20,
  );
  assert.deepEqual(started, ["mika"]);
  assert.deepEqual(logs.sort(), [
    "人格の Bot に接続できませんでした（persona=kai）: 20 ms で終わりませんでした",
    "人格の Bot に接続できませんでした（persona=nana）: An invalid token was provided.",
  ]);
});

test("DiscordGateway: 足した人格はその人格のトークンの変数を読み、無ければ変数名を出して start を失敗する。start 前は接続していない", async (t) => {
  const name = "SELF_AGENT_PERSONA_ZZTEST_DISCORD_TOKEN";
  delete process.env[name];
  const gateway = new DiscordGateway(["guild-1"], { persona: "zztest", tokenEnv: name });
  t.after(() => gateway.stop());
  assert.equal(gateway.connected(), false);
  await assert.rejects(gateway.start({ onMessage: () => {}, onInteraction: () => {} }), new Error(`${name} が設定されていません`));
  assert.equal(gateway.connected(), false);
});

test("buildQueryOptions: 人格のシステムプロンプトを渡せば使い、省略すれば既定の人格の SYSTEM_PROMPT のまま", () => {
  const base = { model: "claude-opus-5", workDir: "/srv/work", claudeConfigDir: "/srv/claude", effort: undefined };
  const mcpServer = createSdkMcpServer({ name: "selfagent", version: "0.1.0", tools: [] });
  const persona = buildSystemPrompt("あなたはミカ。");
  assert.deepEqual(buildQueryOptions(base, mcpServer).systemPrompt, { type: "custom", prompt: SYSTEM_PROMPT, snapshot: false });
  assert.deepEqual(buildQueryOptions({ ...base, systemPrompt: persona }, mcpServer).systemPrompt, {
    type: "custom",
    prompt: persona,
    snapshot: false,
  });
  // ツールなどプロンプト以外は同じ
  const { systemPrompt: _a, ...rest } = buildQueryOptions(base, mcpServer);
  const { systemPrompt: _b, ...personaRest } = buildQueryOptions({ ...base, systemPrompt: persona }, mcpServer);
  assert.deepEqual(personaRest, rest);
});

test("tick: 足した人格があれば Bot の接続を確かめ、投げても log に出して残りを続ける", async (t) => {
  const stores = createStores(tempDb(t), () => NOW);
  const logs: string[] = [];
  let refreshed = 0;
  let rotated = 0;
  const scheduler = new Scheduler({
    cfg: { allowedGuildIds: [], idleHours: 12, deleteAfterDays: 30 },
    topicSessions: stores.topicSessions,
    guildSettings: stores.guildSettings,
    sessions: stores.sessions,
    seeds: stores.seeds,
    channelOps: new RecordingChannelOps(),
    gateway: new FakeGateway({ allow: ["sendMessage", "listChannelParents", "isInGuild"] }),
    inboxRotator: { rotateDue: async () => void rotated++ },
    pruneDevLogs: () => {},
    pruneProjectTrash: async () => {},
    refreshPersonas: async () => {
      refreshed++;
      if (refreshed === 2) throw new Error("壊れた");
    },
    pruneWorkDir: async () => {},
    turnQueue: new KeyedSerialQueue(2),
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(refreshed, 2);
  assert.equal(rotated, 2);
  assert.deepEqual(logs, ["人格の Bot の接続の確認に失敗しました: 壊れた"]);
});
