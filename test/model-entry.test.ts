// 話題を始める入口のモデルの決め方（docs/plan/models.md §3。#451 の PR-2）: resolveTopicModel・最初の投稿の行・/new の model・
// startTopic（［対応］）と main.ts の配線。一時 SQLite・偽 Gateway。場所の既定は PlaceSettingStore.set で直に入れる。
// 右腕は test/right-hand.test.ts、Web は test/web-topics.test.ts・test/web-sessions.test.ts、ホームパネルは test/home.test.ts、取り込みは test/cc-takeover.test.ts
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { MODEL_CHOICES } from "../src/agent/models.ts";
import {
  createNewSessionCommand,
  MODEL_INVALID_REPLY,
  MODEL_OPTION,
  MODEL_PERSONA_REPLY,
  newCommandDef,
} from "../src/app/commands/new.ts";
import { ensureGuildLayout } from "../src/app/commands/setup.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import {
  openTopicSession,
  placeKeyOf,
  type ProjectSessionGate,
  resolveTopicModel,
  rightHandWelcomeText,
  startTopic,
  welcomeText,
} from "../src/app/session-ops.ts";
import { groupKeyOf } from "../src/app/topics.ts";
import { PlaceSettingStore } from "../src/store/place-settings.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";

const NOW = new Date("2026-11-20T00:00:00.000Z");
const GUILD = "guild-1";
const MIKA = {
  id: "mika",
  name: "ミカ",
  discordTokenEnv: "SELF_AGENT_PERSONA_MIKA_DISCORD_TOKEN",
  promptFile: "/dev/null",
  model: undefined,
  engine: "claude" as const,
  effort: undefined,
};

/** 場所の既定（place → key）を入れた PlaceSettingStore */
function placeStore(t: TestContext, rows: Record<string, string | null> = {}): PlaceSettingStore {
  const store = new PlaceSettingStore(tempDb(t), () => NOW);
  for (const [place, model] of Object.entries(rows)) store.set(place, { label: null, model });
  return store;
}

// ---- resolveTopicModel・placeKeyOf ----

test("resolveTopicModel: 明示が場所の既定に勝ち、明示が無ければ場所の既定、どちらも無ければ undefined", (t) => {
  const placeSettings = placeStore(t, { general: "haiku" });
  const base = { persona: false, projectDir: undefined, generalDir: undefined, placeSettings };
  assert.equal(resolveTopicModel({ ...base, key: "sonnet" })?.model, "claude-sonnet-5-5");
  assert.equal(resolveTopicModel(base)?.model, "claude-haiku-4-5");
  assert.equal(resolveTopicModel({ ...base, placeSettings: placeStore(t) }), undefined);
});

test("resolveTopicModel: projectDir が無い・generalDir と同じなら general の行、ほかは p:<名前> の行", (t) => {
  const placeSettings = placeStore(t, { general: "haiku", "p:alpha": "opus" });
  const pick = (projectDir: string | undefined) =>
    resolveTopicModel({ persona: false, projectDir, generalDir: "General", placeSettings })?.key;
  assert.equal(pick(undefined), "haiku");
  assert.equal(pick("General"), "haiku");
  assert.equal(pick("alpha"), "opus");
  assert.equal(pick("beta"), undefined);
  assert.equal(placeKeyOf(undefined, undefined), "general");
  assert.equal(placeKeyOf("General", "General"), "general");
  assert.equal(placeKeyOf("alpha", "General"), "p:alpha");
  assert.equal(placeKeyOf("General", undefined), "p:General");
});

test("placeKeyOf: Web の一覧の群の鍵（topics.ts の groupKeyOf）と同じ字（General・プロジェクト）", () => {
  for (const [dir, generalDir] of [
    ["General", "General"],
    [undefined, "General"],
    [undefined, undefined],
    ["alpha", "General"],
    ["alpha", undefined],
  ] as const) {
    assert.equal(placeKeyOf(dir, generalDir), groupKeyOf({ dir: dir ?? null, outside: false }, generalDir ?? null), `${dir}/${generalDir}`);
  }
});

test("resolveTopicModel: 場所の既定の key が一覧に無い → undefined で投げない。人格は明示も場所も無し。placeSettings が無ければ明示だけ。一覧に無い明示は場所の既定へ", (t) => {
  const stale = placeStore(t, { general: "gpt" });
  assert.equal(resolveTopicModel({ persona: false, projectDir: undefined, generalDir: undefined, placeSettings: stale }), undefined);
  const placeSettings = placeStore(t, { general: "haiku" });
  assert.equal(resolveTopicModel({ key: "sonnet", persona: true, projectDir: undefined, generalDir: undefined, placeSettings }), undefined);
  assert.equal(resolveTopicModel({ persona: true, projectDir: undefined, generalDir: undefined, placeSettings }), undefined);
  assert.equal(resolveTopicModel({ key: "opus", persona: false, projectDir: undefined, generalDir: undefined, placeSettings: undefined })?.key, "opus");
  assert.equal(resolveTopicModel({ persona: false, projectDir: undefined, generalDir: undefined, placeSettings: undefined }), undefined);
  assert.equal(resolveTopicModel({ key: "xxx", persona: false, projectDir: undefined, generalDir: undefined, placeSettings })?.key, "haiku");
});

// ---- 最初の投稿 ----

test("welcomeText・rightHandWelcomeText: model があれば「モデル: <label>」の行（右腕は「話の続き」の前）、無ければ今と同じ、一覧に無い ID は ID のまま", () => {
  const head = "セッション「X」を始めました。ここで話しかけてください。";
  assert.equal(welcomeText("X"), head);
  assert.equal(welcomeText("X", undefined, "claude-sonnet-5-5"), `${head}\nモデル: Sonnet 5.5`);
  assert.equal(welcomeText("X", "alpha", "claude-sonnet-5-5"), `${welcomeText("X", "alpha")}\nモデル: Sonnet 5.5`);
  assert.equal(welcomeText("X", undefined, "x-unknown"), `${head}\nモデル: x-unknown`);
  assert.equal(rightHandWelcomeText("X", "inbox", "alpha"), `${welcomeText("X", "alpha")}\n#inbox の話の続きです。`);
  assert.equal(
    rightHandWelcomeText("X", "inbox", "alpha", "claude-sonnet-5-5"),
    `${welcomeText("X", "alpha")}\nモデル: Sonnet 5.5\n#inbox の話の続きです。`,
  );
});

// ---- /new ----

test("newCommandDef: 最後の引数が model（choices は一覧の label と key・必須でない）。人格・プロジェクトが無くても在る", () => {
  for (const def of [newCommandDef(), newCommandDef([MIKA], ["alpha"])]) {
    const last = def.options?.at(-1);
    assert.deepEqual(last, {
      type: "string",
      name: MODEL_OPTION,
      description: "使うモデル（省略すると場所の既定。無ければ全体の既定）",
      choices: MODEL_CHOICES.map((choice) => ({ name: choice.label, value: choice.key })),
    });
    assert.equal(last?.required, undefined);
  }
  assert.deepEqual(newCommandDef().options?.map((option) => option.name), ["title", "model"]);
});

/** /setup 済みのサーバーと /new（足した人格 mika・プロジェクト alpha・General）。placeSettings は place → key */
async function setupNew(t: TestContext, rows: Record<string, string | null> = {}) {
  const db = tempDb(t);
  const workspaceDir = realpathSync(tempDir(t));
  mkdirSync(join(workspaceDir, "alpha"));
  mkdirSync(join(workspaceDir, "General"));
  const gateway = new FakeGateway({
    allow: ["getParentId", "sendMessage", "pinMessage", "messageExists"],
    record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn", "moveChannel", "send"],
  });
  const { guildSettings, topicSessions } = createStores(db, () => NOW);
  const placeSettings = new PlaceSettingStore(db, () => NOW);
  for (const [place, model] of Object.entries(rows)) placeSettings.set(place, { label: null, model });
  const gate: ProjectSessionGate = { places: { workspaceDir, protectedDirs: [], generalDir: "General" }, ready: () => true };
  const deps = {
    cfg: { personas: [MIKA] },
    gateway,
    guildSettings,
    topicSessions,
    queue: new KeyedSerialQueue(1),
    channelOps: { enqueueMove: () => assert.fail("想定外の移動") },
    projectSessions: gate,
    placeSettings,
    log: () => undefined,
  };
  const result = await ensureGuildLayout(GUILD, deps);
  assert.equal(result.failure, null);
  gateway.reset();
  const command = createNewSessionCommand(deps);
  /** /new を実行し、作ったチャンネル（無ければ undefined）と応答 */
  const runNew = async (options: Record<string, string>): Promise<{ calls: ResponderCall[]; channelId: string | undefined }> => {
    const responder = new FakeResponder();
    await command.handle({ guildId: GUILD, channelId: "c", userId: "owner-1", createdAt: NOW, kind: "command", name: "new", options }, responder);
    const last = responder.calls.at(-1) as { message?: { text?: string } } | undefined;
    return { calls: responder.calls, channelId: last?.message?.text?.match(/<#(.+)>/)?.[1] };
  };
  const welcome = (channelId: string): string | undefined =>
    (gateway.calls.find((call) => call.method === "send" && call.channelId === channelId) as { text: string } | undefined)?.text;
  const created = (): number => gateway.calls.filter((call) => call.method === "createTextChannel").length;
  return { gateway, topicSessions, placeSettings, runNew, welcome, created };
}

test("/new model:sonnet: sessions.model が完全な ID で、最初の投稿にモデルの行", async (t) => {
  const s = await setupNew(t);
  const { channelId } = await s.runNew({ title: "作業", model: "sonnet" });
  assert.ok(channelId !== undefined);
  assert.equal(s.topicSessions.modelOf(channelId), "claude-sonnet-5-5");
  assert.equal(s.welcome(channelId), welcomeText("作業", undefined, "claude-sonnet-5-5"));
});

test("/new の model を省くと general の既定が付き、無ければ NULL で最初の投稿は今と同じ", async (t) => {
  const none = await setupNew(t);
  const plain = await none.runNew({ title: "雑談" });
  assert.equal(none.topicSessions.modelOf(plain.channelId!), undefined);
  assert.equal(none.welcome(plain.channelId!), welcomeText("雑談"));
  const s = await setupNew(t, { general: "haiku" });
  const placed = await s.runNew({ title: "雑談" });
  assert.equal(s.topicSessions.modelOf(placed.channelId!), "claude-haiku-4-5");
  assert.equal(s.welcome(placed.channelId!), welcomeText("雑談", undefined, "claude-haiku-4-5"));
});

test("/new project:alpha: p:alpha の既定が付き、model:opus を足すと opus（明示 > 場所）", async (t) => {
  const s = await setupNew(t, { general: "sonnet", "p:alpha": "haiku" });
  const placed = await s.runNew({ title: "直す", project: "alpha" });
  assert.equal(s.topicSessions.modelOf(placed.channelId!), "claude-haiku-4-5");
  assert.equal(s.welcome(placed.channelId!), welcomeText("直す", "alpha", "claude-haiku-4-5"));
  const explicit = await s.runNew({ title: "直す 2", project: "alpha", model: "opus" });
  assert.equal(s.topicSessions.modelOf(explicit.channelId!), "claude-opus-5-5");
});

test("/new persona と model の併用は MODEL_PERSONA_REPLY で作らない。persona だけなら general に既定があっても NULL", async (t) => {
  const s = await setupNew(t, { general: "haiku" });
  const refused = await s.runNew({ title: "相談", persona: "mika", model: "sonnet" });
  assert.deepEqual(refused.calls, [{ method: "reply", message: { text: MODEL_PERSONA_REPLY, ephemeral: true } }]);
  // project との併用の断りより先
  const both = await s.runNew({ title: "相談", persona: "mika", project: "alpha", model: "sonnet" });
  assert.deepEqual(both.calls, [{ method: "reply", message: { text: MODEL_PERSONA_REPLY, ephemeral: true } }]);
  assert.equal(s.created(), 0);
  const persona = await s.runNew({ title: "相談", persona: "mika" });
  assert.ok(persona.channelId !== undefined);
  assert.equal(s.topicSessions.modelOf(persona.channelId), undefined);
});

test("/new の一覧に無い model は MODEL_INVALID_REPLY で作らない", async (t) => {
  const s = await setupNew(t);
  for (const model of ["gpt", "claude-sonnet-5-5", ""]) {
    const { calls } = await s.runNew({ title: "作業", model });
    assert.deepEqual(calls, [{ method: "reply", message: { text: MODEL_INVALID_REPLY, ephemeral: true } }], model);
  }
  assert.equal(s.created(), 0);
});

test("openTopicSession: モデルの解決（placeSettings.get）が投げたら、チャンネルも sessions の行も作らずに投げる", async (t) => {
  const db = tempDb(t);
  const { guildSettings, topicSessions } = createStores(db, () => NOW);
  guildSettings.setChannel(GUILD, "inboxChannelId", "inbox-1");
  guildSettings.setStateCategory(GUILD, "active", 1, "active-1");
  const gateway = new FakeGateway({ record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn", "send"] });
  gateway.alive.add("active-1");
  const deps = {
    gateway,
    guildSettings,
    topicSessions,
    queue: new KeyedSerialQueue(1),
    placeSettings: {
      get: () => {
        throw new Error("読めない");
      },
    },
    log: () => undefined,
  };
  await assert.rejects(openTopicSession(GUILD, "作業", undefined, deps, "/new で"), /読めない/);
  assert.deepEqual(gateway.calls, []);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.n), 0);
});

// ---- startTopic（［対応］は model を渡さない） ----

test("startTopic（by github・place project）: 場所の既定が付き、結果に model（完全な ID）", async (t) => {
  const db = tempDb(t);
  const workspaceDir = realpathSync(tempDir(t));
  mkdirSync(join(workspaceDir, "alpha"));
  const { guildSettings, topicSessions } = createStores(db, () => NOW);
  guildSettings.setChannel(GUILD, "inboxChannelId", "inbox-1");
  guildSettings.setStateCategory(GUILD, "active", 1, "active-1");
  const placeSettings = new PlaceSettingStore(db, () => NOW);
  placeSettings.set("p:alpha", { label: null, model: "sonnet" });
  const gateway = new FakeGateway({ record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn", "send"] });
  gateway.alive.add("active-1");
  const deps = {
    gateway,
    guildSettings,
    topicSessions,
    queue: new KeyedSerialQueue(1),
    history: undefined,
    submitText: async () => ({ result: "accepted" as const, turnId: 1, messageId: "m-1" }),
    projectSessions: { places: { workspaceDir, protectedDirs: [], generalDir: "General" }, ready: () => true },
    placeSettings,
    log: () => undefined,
  };
  const result = await startTopic({ guildId: GUILD, title: "GitHub PR 12", place: { kind: "project", name: "alpha" }, by: "github", at: NOW }, deps);
  assert.ok(result.result === "created");
  assert.equal(result.model, "claude-sonnet-5-5");
  assert.equal(topicSessions.modelOf(result.channelId), "claude-sonnet-5-5");
  // 既定の無い場所なら結果に model の欄は無い
  placeSettings.set("p:alpha", { label: null, model: null });
  const plain = await startTopic({ guildId: GUILD, title: "GitHub PR 13", place: { kind: "project", name: "alpha" }, by: "github", at: NOW }, deps);
  assert.ok(plain.result === "created");
  assert.equal("model" in plain, false);
});

// ---- 配線の見張り（main.ts） ----

test("見張り: main.ts は placeSettings を topicStart・コマンドの deps・sessionRoutes に渡し、取り込みに placeModel を渡す", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(source, /const placeSettings = new PlaceSettingStore\(db, now\);/);
  const topicStart = source.match(/const topicStart = \{[\s\S]*?\n\};/)?.[0];
  assert.ok(topicStart !== undefined);
  assert.match(topicStart, /\n {2}placeSettings,\n/);
  const commands = source.match(/createCommands\(\{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(commands !== undefined);
  assert.match(commands, /\n {2}placeSettings,\n/);
  const sessions = source.match(/\.\.\.sessionRoutes\(\{[\s\S]*?\n {6}\}\),/)?.[0];
  assert.ok(sessions !== undefined);
  assert.match(sessions, /\n {8}placeSettings,\n/);
  const takeover = source.match(/new CcTakeover\(\{[\s\S]*?\n {2}\}\);/)?.[0];
  assert.ok(takeover !== undefined);
  assert.match(
    takeover,
    /placeModel: \(project\) => resolveTopicModel\(\{ persona: false, projectDir: project, generalDir: config\.generalDir, placeSettings \}\)\?\.model,/,
  );
});
