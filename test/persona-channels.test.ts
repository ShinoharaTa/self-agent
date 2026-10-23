// 足した人格のチャンネル（docs/plan/personas.md §7.2 PR-C）: /setup の #<NAME>、#<NAME> の発言・切り替え・/renew、
// /new の persona、#<NAME> の session_open、待ちの知らせ、/sessions・/usage の表示、表示名の検証、dev ログの印
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { RunContext, RunResult } from "../src/agent/runner.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { createNewSessionCommand, newCommandDef, welcomeText } from "../src/app/commands/new.ts";
import { createRenewCommand } from "../src/app/commands/renew.ts";
import { createSessionsCommand } from "../src/app/commands/sessions.ts";
import { createSetupCommand, HOME_PANEL_TEXT } from "../src/app/commands/setup.ts";
import { usageText } from "../src/app/commands/usage.ts";
import { createHandler } from "../src/app/handler.ts";
import { InboxRotator, ROTATE_PROMPT, ROTATED_NOTICE } from "../src/app/inbox-rotate.ts";
import { PersonaRouter, POSTED_BY_OWNER_REPLY } from "../src/app/personas.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { idleNotice, Scheduler } from "../src/app/scheduler.ts";
import { createOpenSession, inboxSeed, inboxWelcomeText } from "../src/app/session-open.ts";
import { rotatedSeed } from "../src/app/summary.ts";
import { loadConfig, type PersonaConfig } from "../src/config.ts";
import { formatDevLogRecord, selectDevLogRecords } from "../src/devlog/format.ts";
import type { DevLogRecord } from "../src/devlog/log.ts";
import { toCommandData } from "../src/discord/convert.ts";
import type { IncomingMessage, Interaction } from "../src/discord/gateway.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway, type GatewayMethod } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { FakeResponder } from "./helpers/responder.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

/** 2026-10-14(水) 09:12 JST */
const NOW = new Date("2026-10-14T00:12:00Z");
const HOUR_MS = 60 * 60 * 1000;
const MIKA: PersonaConfig = {
  id: "mika",
  name: "Mika",
  discordTokenEnv: "SELF_AGENT_PERSONA_MIKA_DISCORD_TOKEN",
  promptFile: "/home/tester/.config/self-agent/personas/mika.md",
  model: undefined,
  engine: "claude",
  effort: undefined,
};
const PERSONAS = [MIKA];
const cfg = {
  allowedGuildIds: ["guild-1"],
  inboxChannelId: undefined,
  ownerUserId: "owner-1",
  timeZone: "Asia/Tokyo",
  autoSessionPerDay: 3,
  idleHours: 12,
  deleteAfterDays: 30,
  inboxRotateAt: { hour: 4, minute: 0 },
  inboxMaxInputTokens: 150000,
  personas: PERSONAS,
};
/** 足した人格の Bot に許す呼び出し（持ち主の Bot の投稿だけ。管理の操作は呼ばれたら投げる） */
const OWNER_METHODS: GatewayMethod[] = ["send", "sendMessage", "editMessage", "startTyping"];

function ok(text: string, sessionId: string): RunResult {
  return { ok: true, text, sessionId, usage: turnUsage(10, 2000, 300), durationMs: 1000, toolCalls: 0, contextTokens: 2310 };
}

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: "message-1",
    channelId: "mika-in",
    guildId: "guild-1",
    authorId: "owner-1",
    authorIsBot: false,
    isWebhook: false,
    content: "こんにちは",
    createdAt: NOW,
    ...overrides,
  };
}

function command(name: string, options: Record<string, string> = {}, channelId = "channel-1"): Extract<Interaction, { kind: "command" }> {
  return { kind: "command", name, options, guildId: "guild-1", channelId, userId: "owner-1", createdAt: NOW };
}

const SETUP_COMMAND: Extract<Interaction, { kind: "command" }> = command("setup");

/**
 * 既定の人格と足した人格 mika（表示名 Mika）。/setup 済み: #inbox は inbox-1、#tasks は tasks-1、mika の #mika は mika-in、
 * 進行中カテゴリは active-1（Discord 上にある）。既定の人格の Bot は作成・投稿を、mika の Bot は投稿だけを許す
 */
function setup(t: TestContext, steps: { default?: RunResult[]; mika?: RunResult[] } = {}) {
  const db = tempDb(t);
  const clock = { now: NOW };
  const now = (): Date => clock.now;
  const stores = createStores(db, now);
  const { guildSettings, topicSessions, sessions, seeds, inboxSummaries, memories, usage } = stores;
  const admin = new FakeGateway({
    allow: [...OWNER_METHODS],
    record: ["createTextChannel", "channelExists", "countChannelsIn"],
  });
  admin.alive.add("active-1");
  const mika = new FakeGateway({ allow: OWNER_METHODS, messageIdPrefix: "mika-" });
  const defaultRunner = new FakeRunner(steps.default ?? []);
  const mikaRunner = new FakeRunner(steps.mika ?? []);
  const personas = new PersonaRouter({
    personas: [
      { id: "default", name: "default", engine: "claude", runner: defaultRunner, gateway: admin, connected: () => true },
      { id: "mika", name: "Mika", engine: "claude", runner: mikaRunner, gateway: mika, connected: () => true },
    ],
    guildSettings,
    topicSessions,
  });
  guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  guildSettings.setChannel("guild-1", "tasksChannelId", "tasks-1");
  guildSettings.setPersonaInbox("guild-1", "mika", "mika-in");
  guildSettings.setStateCategory("guild-1", "active", 1, "active-1");
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const turn = { runner: defaultRunner, personas, sessions, seeds, topicSessions, inboxSummaries, memories, usage, log };
  return { db, clock, now, ...stores, admin, mika, defaultRunner, mikaRunner, personas, turn, logs, log };
}

test("/setup: 足した人格の #<NAME> を #tasks の後に self-agent カテゴリへ作って記録し、ホームパネルは #inbox だけ。2 回目は作らず、消えたものだけ作り直す", async (t) => {
  const db = tempDb(t);
  const { guildSettings } = createStores(db, () => NOW);
  const gateway = new FakeGateway({
    record: ["createCategory", "createTextChannel", "channelExists", "moveChannel", "messageExists", "sendMessage", "pinMessage"],
  });
  const command = createSetupCommand({
    cfg: { personas: PERSONAS },
    gateway,
    guildSettings,
    queue: new KeyedSerialQueue(1),
    log: () => {},
  });
  const run = async (): Promise<string> => {
    const responder = new FakeResponder();
    await command.handle({ ...SETUP_COMMAND }, responder);
    return responder.replies[0]?.text ?? "";
  };
  const created = () =>
    gateway.callsOf("createTextChannel").map((call) => (call.method === "createTextChannel" ? call.options : undefined));

  await run();
  // self-agent カテゴリ（ch-1）の中に #inbox → #tasks → #mika → #system の順
  assert.deepEqual(
    created().map((options) => [options?.name, options?.parentId]),
    [
      ["inbox", "ch-1"],
      ["tasks", "ch-1"],
      ["mika", "ch-1"],
      ["system", "ch-1"],
    ],
  );
  assert.match(created()[2]?.topic ?? "", /Mika/);
  assert.equal(guildSettings.personaInbox("guild-1", "mika")?.channelId, "ch-4");
  assert.deepEqual(guildSettings.entryChannel("ch-4"), { guildId: "guild-1", persona: "mika", kind: "inbox" });
  // 既定の人格の #inbox・#tasks は今までどおり
  assert.equal(guildSettings.get("guild-1")?.inboxChannelId, "ch-2");
  assert.equal(guildSettings.get("guild-1")?.systemChannelId, "ch-5");
  // ホームパネルは #inbox だけ
  assert.deepEqual(
    gateway.callsOf("sendMessage").map((call) => (call.method === "sendMessage" ? [call.channelId, call.message.text] : [])),
    [["ch-2", HOME_PANEL_TEXT]],
  );

  gateway.reset();
  assert.match(await run(), /すべて揃っています/);
  assert.deepEqual(created(), []);

  // #mika だけ消えていれば、それだけ作り直す
  gateway.reset();
  gateway.alive.delete("ch-4");
  await run();
  assert.deepEqual(
    created().map((options) => options?.name),
    ["mika"],
  );
  const recreated = guildSettings.personaInbox("guild-1", "mika")?.channelId;
  assert.notEqual(recreated, "ch-4");
  assert.equal(guildSettings.entryChannel(recreated!)?.persona, "mika");
});

test("#<NAME> の発言は足した人格の Bot の分だけがその人格のターンになり、日時ヘッダは #inbox（種類も inbox）", async (t) => {
  const env = setup(t, { mika: [ok("ミカの返事", "s-m")] });
  const handler = createHandler({
    cfg,
    resolveChannel: createChannelResolver(cfg, env.guildSettings, env.topicSessions),
    ...env.turn,
    gateway: env.personas.ownerPosts(),
    channelOps: new RecordingChannelOps(),
    queue: new KeyedSerialQueue(2),
    now: env.now,
    timers: { after: () => () => {}, every: () => () => {} },
  });

  await handler.handleMessage(message({ persona: "default" }));
  await handler.handleMessage(message({ persona: "mika" }));

  assert.equal(env.defaultRunner.inputs.length, 0);
  assert.equal(env.mikaRunner.inputs.length, 1);
  const input = env.mikaRunner.inputs[0]!;
  assert.deepEqual(input.context, { guildId: "guild-1", channelId: "mika-in", kind: "inbox" });
  assert.match(input.prompt, /^\[2026-10-14\(水\) 09:12 JST #inbox\]\nこんにちは$/m);
  assert.deepEqual(
    env.mika.sent.map(({ channelId, text }) => [channelId, text]),
    [["mika-in", "ミカの返事"]],
  );
  assert.deepEqual(env.admin.sent, []);
});

test("#<NAME> は、その人格が設定にあるときだけ受け付ける（人格が無い・外した・別のサーバーなら受け付けない）", (t) => {
  const env = setup(t);
  const withPersonas = createChannelResolver(cfg, env.guildSettings, env.topicSessions);
  assert.equal(withPersonas("guild-1", "mika-in"), "inbox");
  assert.equal(withPersonas("guild-2", "mika-in"), null);
  assert.equal(createChannelResolver({ inboxChannelId: undefined }, env.guildSettings, env.topicSessions)("guild-1", "mika-in"), null);
  assert.equal(
    createChannelResolver({ inboxChannelId: undefined, personas: [] }, env.guildSettings, env.topicSessions)("guild-1", "mika-in"),
    null,
  );
  // #inbox・#tasks は今までどおり
  assert.equal(withPersonas("guild-1", "inbox-1"), "inbox");
  assert.equal(withPersonas("guild-1", "tasks-1"), "tasks");
});

test("/new: 足した人格があるときだけ persona の引数（選択肢は表示名）を足す", () => {
  assert.deepEqual(
    newCommandDef([]).options?.map((option) => option.name),
    ["title"],
  );
  const options = newCommandDef(PERSONAS).options ?? [];
  assert.deepEqual(options[1], {
    type: "string",
    name: "persona",
    description: "話す相手（省略すると既定の人格）",
    choices: [{ name: "Mika", value: "mika" }],
  });
  assert.equal(options[1]?.required, undefined);
  // Discord に送る形にも選択肢が入る（無ければ入れない）
  const data = toCommandData(newCommandDef(PERSONAS));
  assert.deepEqual((data.options?.[1] as { choices?: unknown } | undefined)?.choices, [{ name: "Mika", value: "mika" }]);
  assert.equal("choices" in (toCommandData(newCommandDef([])).options?.[0] ?? {}), false);
});

test("/new persona: その人格のセッションを `<NAME>-<題名>` で作り（topic に表示名）、最初の投稿はその人格の Bot。省略は既定の人格で今までどおり", async (t) => {
  const env = setup(t);
  const handler = createNewSessionCommand({
    cfg: { personas: PERSONAS },
    gateway: env.admin,
    personas: env.personas,
    guildSettings: env.guildSettings,
    topicSessions: env.topicSessions,
    queue: new KeyedSerialQueue(1),
    log: env.log,
  });

  const responder = new FakeResponder();
  await handler.handle(command("new", { title: "旅行の計画", persona: "mika" }), responder);
  await handler.handle(command("new", { title: "家計簿" }), new FakeResponder());

  const created = env.admin.callsOf("createTextChannel").map((call) => (call.method === "createTextChannel" ? call.options : undefined));
  assert.deepEqual(created, [
    { name: "mika-旅行の計画", parentId: "active-1", topic: "旅行の計画（Mika）" },
    { name: "家計簿", parentId: "active-1", topic: "家計簿" },
  ]);
  assert.equal(env.topicSessions.personaOf("ch-1"), "mika");
  assert.equal(env.topicSessions.personaOf("ch-2"), "default");
  assert.equal(env.personas.ownerOf("ch-1"), "mika");
  assert.deepEqual(
    env.mika.sent.map(({ channelId, text }) => [channelId, text]),
    [["ch-1", welcomeText("旅行の計画")]],
  );
  assert.deepEqual(
    env.admin.sent.map(({ channelId, text }) => [channelId, text]),
    [["ch-2", welcomeText("家計簿")]],
  );
  assert.deepEqual(responder.replies.at(-1), { text: "<#ch-1> を作りました", ephemeral: true });
});

test("session_open: #<NAME> から呼ばれたらその人格のセッションを作り、最初の投稿はその人格の Bot。1 日の上限と間隔は全人格で合算、同じ題名は人格ごと", async (t) => {
  const env = setup(t);
  const openSession = createOpenSession({
    cfg: { ...cfg, autoSessionPerDay: 2 },
    resolveChannel: createChannelResolver(cfg, env.guildSettings, env.topicSessions),
    gateway: env.admin,
    personas: env.personas,
    guildSettings: env.guildSettings,
    topicSessions: env.topicSessions,
    seeds: env.seeds,
    queue: new KeyedSerialQueue(1),
    now: env.now,
    log: env.log,
  });
  const mikaContext: RunContext = { guildId: "guild-1", channelId: "mika-in", kind: "inbox" };
  const inboxContext: RunContext = { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" };
  const args = { title: "旅行の計画", context: "京都に 2 泊したい" };

  assert.deepEqual(await openSession(args, mikaContext), { result: "created", channelId: "ch-1" });
  assert.equal(env.topicSessions.personaOf("ch-1"), "mika");
  assert.equal(env.seeds.get("ch-1"), inboxSeed(args.context));
  assert.deepEqual(
    env.admin.callsOf("createTextChannel").map((call) => (call.method === "createTextChannel" ? call.options.name : "")),
    ["mika-旅行の計画"],
  );
  assert.deepEqual(
    env.mika.sent.map(({ channelId, text }) => [channelId, text]),
    [["ch-1", inboxWelcomeText("旅行の計画", "mika")]],
  );
  assert.deepEqual(env.admin.sent, []);

  // 間隔は全人格で合算（#inbox から 15 分以内）
  env.clock.now = new Date(NOW.getTime() + 5 * 60 * 1000);
  assert.equal((await openSession(args, inboxContext)).result, "cooldown");
  // 同じ題名でも、既定の人格には mika のセッションは「既にある」ではない
  env.clock.now = new Date(NOW.getTime() + 20 * 60 * 1000);
  assert.deepEqual(await openSession(args, inboxContext), { result: "created", channelId: "ch-2" });
  assert.equal(env.topicSessions.personaOf("ch-2"), "default");
  // mika の同じ題名は既にある
  env.clock.now = new Date(NOW.getTime() + 40 * 60 * 1000);
  assert.deepEqual(await openSession(args, mikaContext), { result: "existing", channelId: "ch-1" });
  // 1 日の上限は全人格で合算（mika 1 + 既定 1 = 2）
  assert.equal((await openSession({ ...args, title: "別の話" }, mikaContext)).result, "limit");
});

/** 前日の 05:00 JST に切り替えた記録を 3 つのチャンネルに入れ、mika の #mika にだけその後の会話（SDK セッション s-m とターン 1 つ）を作る */
function seedRotation(env: ReturnType<typeof setup>): void {
  const yesterday = new Date("2026-10-12T20:00:00Z");
  env.guildSettings.setInboxRotated("guild-1", "2026-10-13", yesterday);
  env.guildSettings.setTasksRotated("guild-1", yesterday);
  env.guildSettings.setInboxRotated("guild-1", "2026-10-13", yesterday, "mika");
  env.sessions.set("mika-in", "s-m");
  env.usage.record({ key: "mika-in", sessionId: "s-m", ok: true, kind: "inbox", persona: "mika" });
}

function rotator(env: ReturnType<typeof setup>, personas: readonly PersonaConfig[] = PERSONAS): InboxRotator {
  return new InboxRotator({
    cfg: { ...cfg, personas: [...personas] },
    guildSettings: env.guildSettings,
    inboxSummaries: env.inboxSummaries,
    turnQueue: new KeyedSerialQueue(2),
    turn: env.turn,
    gateway: env.personas.ownerPosts(),
    now: env.now,
    log: env.log,
  });
}

test("切り替え: #<NAME> もその人格の runner で要約し、要約・切り替えの日と時刻はその人格のもの、知らせはその人格の Bot", async (t) => {
  const env = setup(t, { mika: [ok("- 京都旅行の宿を探す", "s-m2")] });
  seedRotation(env);

  await rotator(env).rotateDue(() => false);

  assert.equal(env.defaultRunner.inputs.length, 0);
  assert.deepEqual(env.mikaRunner.inputs, [{ prompt: ROTATE_PROMPT, sessionId: "s-m", context: undefined, allowedUrls: [] }]);
  assert.equal(env.inboxSummaries.latest("guild-1", "inbox", "mika")?.summary, "- 京都旅行の宿を探す");
  assert.equal(env.inboxSummaries.latest("guild-1", "inbox"), undefined);
  assert.equal(env.sessions.get("mika-in"), undefined);
  assert.equal(env.seeds.get("mika-in"), rotatedSeed("- 京都旅行の宿を探す"));
  assert.equal(env.guildSettings.personaInbox("guild-1", "mika")?.rotatedDate, "2026-10-14");
  // 既定の人格の #inbox・#tasks は会話が無いので日付と時刻だけ
  assert.equal(env.guildSettings.get("guild-1")?.inboxRotatedDate, "2026-10-14");
  assert.deepEqual(
    env.mika.posts.map(({ channelId, message: posted }) => [channelId, posted.text]),
    [["mika-in", ROTATED_NOTICE]],
  );
  assert.deepEqual(env.admin.posts, []);
});

test("切り替え: 人格が設定に無ければ #<NAME> は切り替えない", async (t) => {
  const env = setup(t);
  seedRotation(env);
  await rotator(env, []).rotateDue(() => false);
  assert.equal(env.mikaRunner.inputs.length, 0);
  assert.equal(env.sessions.get("mika-in"), "s-m");
  assert.equal(env.guildSettings.personaInbox("guild-1", "mika")?.rotatedDate, "2026-10-13");
});

test("切り替え（サイズ）: #<NAME> はそのチャンネルの直近の成功したターンの最後のステップの入力で判定し、超えたらその人格で切り替える", async (t) => {
  const env = setup(t, { mika: [ok("- 京都旅行の宿を探す", "s-m2")] });
  // 3 つのチャンネルとも今日の 1 時間前に切り替え済み（日次の時期ではない）
  const earlier = new Date(NOW.getTime() - HOUR_MS);
  env.guildSettings.setInboxRotated("guild-1", "2026-10-14", earlier);
  env.guildSettings.setTasksRotated("guild-1", earlier);
  env.guildSettings.setInboxRotated("guild-1", "2026-10-14", earlier, "mika");
  env.sessions.set("mika-in", "s-m");
  // 既定の人格の #inbox の大きな入力は #mika の判定に使わない（#inbox は SDK セッションが無いので切り替えない）
  env.usage.record({ key: "inbox-1", ok: true, contextTokens: 200000, kind: "inbox" });
  // #mika の直近の成功したターンは上限以下
  env.usage.record({ key: "mika-in", ok: true, contextTokens: 200000, kind: "inbox", persona: "mika" });
  env.usage.record({ key: "mika-in", ok: true, contextTokens: 1000, kind: "inbox", persona: "mika" });
  const inboxRotator = rotator(env);

  await inboxRotator.rotateDue(() => false);
  assert.equal(env.mikaRunner.inputs.length, 0);
  assert.equal(env.sessions.get("mika-in"), "s-m");

  // 直近の成功したターンが上限を超えた（その後の失敗したターンは数えない）
  env.usage.record({ key: "mika-in", ok: true, contextTokens: 150001, kind: "inbox", persona: "mika" });
  env.usage.record({ key: "mika-in", ok: false, kind: "inbox", persona: "mika" });
  await inboxRotator.rotateDue(() => false);

  assert.deepEqual(env.mikaRunner.inputs, [{ prompt: ROTATE_PROMPT, sessionId: "s-m", context: undefined, allowedUrls: [] }]);
  assert.equal(env.defaultRunner.inputs.length, 0);
  assert.equal(env.inboxSummaries.latest("guild-1", "inbox", "mika")?.summary, "- 京都旅行の宿を探す");
  assert.equal(env.sessions.get("mika-in"), undefined);
  assert.ok(env.logs.some((line) => line.includes("#inbox（人格 mika）") && line.includes("直近の入力 150001 トークン")));
  assert.deepEqual(
    env.mika.posts.map(({ channelId, message: posted }) => [channelId, posted.text]),
    [["mika-in", ROTATED_NOTICE]],
  );
});

test("/renew: #<NAME> ではその人格の会話を切り替え、結果はその人格の Bot が投稿する（応答は本人にだけ）", async (t) => {
  const env = setup(t, { mika: [ok("- 京都旅行の宿を探す", "s-m2")] });
  seedRotation(env);
  const renew = createRenewCommand({
    guildSettings: env.guildSettings,
    topicSessions: env.topicSessions,
    turnQueue: new KeyedSerialQueue(2),
    turn: env.turn,
    inboxRotator: rotator(env),
    personas: env.personas,
    log: env.log,
  });
  const responder = new FakeResponder();

  await renew.handle(command("renew", {}, "mika-in"), responder);

  assert.equal(env.mikaRunner.inputs.length, 1);
  assert.equal(env.inboxSummaries.latest("guild-1", "inbox", "mika")?.summary, "- 京都旅行の宿を探す");
  assert.deepEqual(
    env.mika.posts.map(({ channelId, message: posted }) => [channelId, posted.text]),
    [["mika-in", ROTATED_NOTICE]],
  );
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: POSTED_BY_OWNER_REPLY } },
  ]);
});

test("待ちに移した知らせ（[続ける][閉じる]）は、セッションの持ち主の Bot が出す", async (t) => {
  const env = setup(t);
  env.topicSessions.create({ channelId: "topic-m", guildId: "guild-1", title: "ミカの相談", categoryId: "active-1", persona: "mika" });
  env.topicSessions.create({ channelId: "topic-d", guildId: "guild-1", title: "既定の相談", categoryId: "active-1" });
  env.clock.now = new Date(NOW.getTime() + 12 * HOUR_MS);
  const scheduler = new Scheduler({
    cfg,
    topicSessions: env.topicSessions,
    guildSettings: { get: () => undefined, listStateCategories: () => [], personaInbox: () => undefined, jobsChannelId: () => null },
    sessions: env.sessions,
    seeds: env.seeds,
    channelOps: new RecordingChannelOps(),
    gateway: env.admin,
    personas: env.personas,
    inboxRotator: { rotateDue: async () => {} },
    pruneDevLogs: () => {},
    pruneProjectTrash: async () => {},
    pruneWorkDir: async () => {},
    turnQueue: new KeyedSerialQueue(2),
    now: env.now,
    log: env.log,
  });

  await scheduler.tick();

  assert.deepEqual(
    env.mika.posts.map(({ channelId, message: posted }) => [channelId, posted]),
    [["topic-m", idleNotice(12, "topic-m")]],
  );
  assert.deepEqual(
    env.admin.posts.map(({ channelId, message: posted }) => [channelId, posted]),
    [["topic-d", idleNotice(12, "topic-d")]],
  );
});

test("再同期: self-agent カテゴリの外にある設定中の人格の #<NAME> は戻し、設定から外した人格の #<NAME> は触らない", async (t) => {
  const env = setup(t);
  env.guildSettings.setChannel("guild-1", "homeCategoryId", "home-1");
  env.guildSettings.setChannel("guild-1", "systemChannelId", "system-1");
  env.guildSettings.setPersonaInbox("guild-1", "gone", "gone-in");
  const gateway = new FakeGateway({ allow: ["sendMessage", "listChannelParents", "isInGuild"] });
  gateway.parents = new Map<string, string | null>([
    ["home-1", null],
    ["active-1", null],
    ["inbox-1", "home-1"],
    ["tasks-1", "home-1"],
    ["system-1", "home-1"],
    // 手で動かされた #mika と、外した人格の #gone
    ["mika-in", "active-1"],
    ["gone-in", null],
  ]);
  const channelOps = new RecordingChannelOps();
  const scheduler = new Scheduler({
    cfg,
    topicSessions: env.topicSessions,
    guildSettings: env.guildSettings,
    sessions: env.sessions,
    seeds: env.seeds,
    channelOps,
    gateway,
    personas: env.personas,
    inboxRotator: { rotateDue: async () => {} },
    pruneDevLogs: () => {},
    pruneProjectTrash: async () => {},
    pruneWorkDir: async () => {},
    turnQueue: new KeyedSerialQueue(2),
    now: env.now,
    log: env.log,
  });

  await scheduler.tick();

  assert.deepEqual(channelOps.moves, [{ channelId: "mika-in", target: { kind: "category", categoryId: "home-1" } }]);
});

test("/sessions: 足した人格があれば、その人格のセッションに表示名を添える（無ければ今までどおり）", async (t) => {
  const env = setup(t);
  env.topicSessions.create({ channelId: "topic-m", guildId: "guild-1", title: "ミカの相談", categoryId: "active-1", persona: "mika" });
  env.topicSessions.create({ channelId: "topic-d", guildId: "guild-1", title: "既定の相談", categoryId: "active-1" });
  const run = async (personas?: PersonaConfig[]): Promise<string> => {
    const responder = new FakeResponder();
    await createSessionsCommand({
      topicSessions: env.topicSessions,
      ...(personas === undefined ? {} : { cfg: { personas } }),
    }).handle(command("sessions"), responder);
    return responder.replies[0]?.text ?? "";
  };

  const withPersonas = await run(PERSONAS);
  assert.match(withPersonas, /^<#topic-m> ミカの相談（Mika・最終 1 時間以内）$/m);
  assert.match(withPersonas, /^<#topic-d> 既定の相談（最終 1 時間以内）$/m);
  const without = await run();
  assert.match(without, /^<#topic-m> ミカの相談（最終 1 時間以内）$/m);
  assert.equal(await run([]), without);
});

test("/usage: 足した人格があれば人格ごと（既定の人格 → 足した人格）に分けて出す。無ければ既定の人格の分だけ（ほかの persona の行は含めない）", (t) => {
  const env = setup(t);
  env.usage.record({ key: "inbox-1", ok: true, inputTokens: 10, kind: "inbox" });
  env.usage.record({ key: "mika-in", ok: true, inputTokens: 20, kind: "inbox", persona: "mika" });
  env.usage.record({ key: "mika-in", ok: false, kind: "inbox", persona: "mika" });

  const plain = usageText(env.usage, NOW, "Asia/Tokyo");
  assert.equal(usageText(env.usage, NOW, "Asia/Tokyo", []), plain);
  assert.doesNotMatch(plain, /__\*\*/);
  assert.match(plain, /ターン 1（成功 1 \/ 失敗 0）/);

  const split = usageText(env.usage, NOW, "Asia/Tokyo", PERSONAS);
  const [defaultPart, mikaPart] = split.split("__**Mika**__");
  assert.match(defaultPart ?? "", /^__\*\*既定の人格\*\*__\n\*\*今日\*\*/);
  assert.match(defaultPart ?? "", /ターン 1（成功 1 \/ 失敗 0）\n入力トークン 10\n/);
  assert.match(mikaPart ?? "", /ターン 2（成功 1 \/ 失敗 1）\n入力トークン 20\n/);
});

test("設定: 表示名から作るチャンネル名が空・inbox/tasks/system・人格どうしで重なるなら、NAME の変数名を出してエラー", () => {
  const base = {
    HOME: "/home/tester",
    DISCORD_TOKEN: "dummy-default",
    SELF_AGENT_PERSONA_MIKA_DISCORD_TOKEN: "dummy-mika",
    SELF_AGENT_PERSONA_AOI_DISCORD_TOKEN: "dummy-aoi",
    SELF_AGENT_PERSONA_TASKS_DISCORD_TOKEN: "dummy-tasks",
    SELF_AGENT_PERSONA_GITHUB_DISCORD_TOKEN: "dummy-github",
  };
  const cases: Array<{ label: string; env: Record<string, string>; error: RegExp }> = [
    {
      label: "記号だけ",
      env: { SELF_AGENT_PERSONAS: "mika", SELF_AGENT_PERSONA_MIKA_NAME: "!!!" },
      error: /SELF_AGENT_PERSONA_MIKA_NAME からチャンネル名を作れません/,
    },
    {
      label: "inbox と同じ（大文字・空白も正規化）",
      env: { SELF_AGENT_PERSONAS: "mika", SELF_AGENT_PERSONA_MIKA_NAME: " Inbox " },
      error: /SELF_AGENT_PERSONA_MIKA_NAME は inbox・tasks・system・github と同じ/,
    },
    {
      label: "NAME 未設定で id が tasks",
      env: { SELF_AGENT_PERSONAS: "tasks" },
      error: /SELF_AGENT_PERSONA_TASKS_NAME は inbox・tasks・system・github と同じ/,
    },
    {
      label: "github と同じ（#github と重なる。SELF_AGENT_GITHUB が無効でも使えない）",
      env: { SELF_AGENT_PERSONAS: "github" },
      error: /SELF_AGENT_PERSONA_GITHUB_NAME は inbox・tasks・system・github と同じ/,
    },
    {
      label: "人格どうしで重なる",
      env: { SELF_AGENT_PERSONAS: "mika,aoi", SELF_AGENT_PERSONA_MIKA_NAME: "Sora", SELF_AGENT_PERSONA_AOI_NAME: "sora" },
      error: /SELF_AGENT_PERSONA_AOI_NAME と SELF_AGENT_PERSONA_MIKA_NAME が同じチャンネル名/,
    },
  ];
  for (const { label, env, error } of cases) {
    assert.throws(() => loadConfig({ ...base, ...env }), error, label);
  }
  // 足せる人格は 10 まで（/new の選択肢を Discord の 25 個以内に、/usage を 2,000 字以内に）
  const ids = Array.from({ length: 11 }, (_, index) => `p${index}`);
  const tokens = Object.fromEntries(ids.map((id) => [`SELF_AGENT_PERSONA_${id.toUpperCase()}_DISCORD_TOKEN`, `dummy-${id}`]));
  assert.throws(
    () => loadConfig({ ...base, ...tokens, SELF_AGENT_PERSONAS: ids.join(",") }),
    /SELF_AGENT_PERSONAS に足せる人格は 10 までです/,
  );
  assert.equal(loadConfig({ ...base, ...tokens, SELF_AGENT_PERSONAS: ids.slice(0, 10).join(",") }).personas.length, 10);
  assert.equal(loadConfig({ ...base, SELF_AGENT_PERSONAS: "mika", SELF_AGENT_PERSONA_MIKA_NAME: "Mika" }).personas[0]?.name, "Mika");
});

function devLogRecord(fields: Partial<DevLogRecord> = {}): DevLogRecord {
  return {
    at: "2026-10-07T15:30:05.000Z",
    durationMs: 1000,
    guildId: "guild-1",
    channelId: "mika-in",
    kind: "inbox",
    model: "claude-opus-5",
    effort: null,
    maxTurns: 8,
    resume: null,
    prompt: "[2026-10-08 00:30 #inbox]\nこんにちは",
    steps: [],
    result: { ok: true, text: "はい", sessionId: "s", usage: turnUsage(1, 2, 3, 4), toolCalls: 0, contextTokens: 6 },
    ...fields,
  };
}

test("dev ログ: 人格の印があれば見出しに出し、--persona で絞れる（印の無い以前の記録は既定の人格）", () => {
  const heading = (record: DevLogRecord): string => formatDevLogRecord(record, "Asia/Tokyo").split("\n")[0]!;
  assert.equal(heading(devLogRecord({ persona: "mika" })), "=== 00:30:05 inbox channel=mika-in persona=mika ===");
  assert.equal(heading(devLogRecord()), "=== 00:30:05 inbox channel=mika-in ===");

  const old = devLogRecord({ prompt: "old" });
  const byDefault = devLogRecord({ persona: "default", prompt: "default" });
  const byMika = devLogRecord({ persona: "mika", prompt: "mika" });
  const records = [old, byDefault, byMika];
  assert.deepEqual(selectDevLogRecords(records, { persona: "mika" }), [byMika]);
  assert.deepEqual(selectDevLogRecords(records, { persona: "default" }), [old, byDefault]);
  assert.deepEqual(selectDevLogRecords(records, {}), records);
});
