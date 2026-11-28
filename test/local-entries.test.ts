// 起動のときの場所の検査とローカルの入口作り（app/local-entries.ts。#530 の WP5 の 2 つ目）。一時 SQLite と、述語を作り物で true にした localPlaces で確かめる。
// 入口から先の一通り（GET /api/topics・発言・右腕の session_open）は、ローカルの Gateway に記録の包みを被せて「来た物の一覧」で見る
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createChannelResolver } from "../src/app/access.ts";
import type { Handler, SubmitTextResult } from "../src/app/handler.ts";
import { createHandler, WEB_ECHO_PREFIX } from "../src/app/handler.ts";
import { checkPersonaPlaces, ensureLocalEntries, type LocalEntriesDeps } from "../src/app/local-entries.ts";
import { discordPersonas, PersonaRouter, personaBot, webPersonaPredicate } from "../src/app/personas.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { createRightHand } from "../src/app/right-hand.ts";
import type { TopicsResult } from "../src/app/topics.ts";
import { loadConfig, type PersonaConfig } from "../src/config.ts";
import { LocalGateway } from "../src/discord/local-gateway.ts";
import { LocalIdStore } from "../src/store/local-places.ts";
import { PlaceSettingStore } from "../src/store/place-settings.ts";
import { topicRoutes } from "../src/web/routes/topics.ts";
import { turnRoutes } from "../src/web/routes/turns.ts";
import { createWebServer, type WebServer } from "../src/web/server.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

const NOW = new Date("2026-10-02T00:12:00Z");
const GUILD = "111";
const GUILD_2 = "222";
const GUILD_NOT_SET_UP = "333";
const LOGIN = "owner@example.com";
/** ローカルの番号（先頭が 1 の数字 21 桁） */
const LOCAL_ID = /^1\d{20}$/;

function persona(id: string, name: string): PersonaConfig {
  return {
    id,
    name,
    discordTokenEnv: `SELF_AGENT_PERSONA_${id.toUpperCase()}_DISCORD_TOKEN`,
    surface: "discord",
    promptFile: "/dev/null",
    model: undefined,
    engine: "claude",
    effort: undefined,
  };
}
/** Web だけの人格（述語が true） */
const SORA = persona("sora", "ソラ");
/** Discord の人格（述語が false） */
const MIKA = persona("mika", "ミカ");

const toLocalText = "SELF_AGENT_PERSONA_SORA_SURFACE: この人格の場所は Discord に在ります。人格の場所は後から変えられません（別の id で足してください）";
const toDiscordText = "SELF_AGENT_PERSONA_SORA_SURFACE: この人格の場所は Web に在ります。人格の場所は後から変えられません（別の id で足してください）";

/** 呼び出し（メソッドと引数） */
type Call = { method: string; args: unknown[] };

/** 呼び出しを全部記録する包み（ローカルの Gateway にも Discord の偽 Gateway にも被せる） */
function recording<T extends object>(target: T): { gateway: T; calls: Call[] } {
  const calls: Call[] = [];
  const gateway = new Proxy(target, {
    get(inner, property, receiver) {
      const value: unknown = Reflect.get(inner, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        return (value as (...a: unknown[]) => unknown).apply(inner, args);
      };
    },
  });
  return { gateway, calls };
}

/** 一時 SQLite と、述語を差し替えられる localPlaces（番号は本物の LocalIdStore）。setUp のサーバーは /setup 済みにする */
function setup(t: TestContext, options: { isLocal?: (id: string) => boolean; setUp?: string[]; allowed?: string[]; personas?: PersonaConfig[] } = {}) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  for (const [index, guildId] of (options.setUp ?? [GUILD]).entries()) stores.guildSettings.setChannel(guildId, "inboxChannelId", `10${index}`);
  const localIds = new LocalIdStore(db);
  const logs: string[] = [];
  const deps: LocalEntriesDeps = {
    cfg: { allowedGuildIds: options.allowed ?? [GUILD, GUILD_NOT_SET_UP], personas: options.personas ?? [SORA, MIKA] },
    guildSettings: stores.guildSettings,
    topicSessions: stores.topicSessions,
    localPlaces: { isLocalPersona: options.isLocal ?? ((id) => id === "sora"), ids: localIds },
    log: (line) => void logs.push(line),
  };
  return { db, stores, ...stores, localIds, logs, deps };
}

// ---- B1・B2: 入口を作る ----

test("ensureLocalEntries: /setup 済みのサーバーに、述語が true の人格の入口を 1 行（place local・21 桁の番号）作る。もう一度呼ぶと 0 件で行は同じ。log に番号を出さない", (t) => {
  const env = setup(t);
  assert.equal(ensureLocalEntries(env.deps), 1);
  const inbox = env.guildSettings.personaInbox(GUILD, "sora");
  assert.equal(inbox?.place, "local");
  assert.match(inbox?.channelId ?? "", LOCAL_ID);
  // 述語が偽の人格・/setup していないサーバーには作らない（行も guild_settings も増えない）
  assert.equal(env.guildSettings.personaInbox(GUILD, "mika"), undefined);
  assert.equal(env.guildSettings.personaInbox(GUILD_NOT_SET_UP, "sora"), undefined);
  assert.equal(env.guildSettings.get(GUILD_NOT_SET_UP), undefined);
  assert.deepEqual(env.logs, [`ローカルの入口を作りました（persona=sora、guild=${GUILD}）`]);

  assert.equal(ensureLocalEntries(env.deps), 0);
  assert.deepEqual(env.guildSettings.personaInbox(GUILD, "sora"), inbox);
  assert.equal(env.logs.length, 1);
});

test("ensureLocalEntries: 許可サーバーが 2 つとも /setup 済みなら 1 つずつ、違う番号で作る", (t) => {
  const env = setup(t, { setUp: [GUILD, GUILD_2], allowed: [GUILD, GUILD_2] });
  assert.equal(ensureLocalEntries(env.deps), 2);
  const first = env.guildSettings.personaInbox(GUILD, "sora")?.channelId;
  const second = env.guildSettings.personaInbox(GUILD_2, "sora")?.channelId;
  assert.match(first ?? "", LOCAL_ID);
  assert.match(second ?? "", LOCAL_ID);
  assert.notEqual(first, second);
  assert.deepEqual(env.logs, [
    `ローカルの入口を作りました（persona=sora、guild=${GUILD}）`,
    `ローカルの入口を作りました（persona=sora、guild=${GUILD_2}）`,
  ]);
});

test("ensureLocalEntries: Web だけの人格が 2 体なら、2 体とも違う番号で入口を作る", (t) => {
  const HANA = persona("hana", "ハナ");
  const env = setup(t, { personas: [SORA, HANA], isLocal: () => true });
  assert.equal(ensureLocalEntries(env.deps), 2);
  const sora = env.guildSettings.personaInbox(GUILD, "sora");
  const hana = env.guildSettings.personaInbox(GUILD, "hana");
  assert.equal(sora?.place, "local");
  assert.equal(hana?.place, "local");
  assert.match(sora?.channelId ?? "", LOCAL_ID);
  assert.match(hana?.channelId ?? "", LOCAL_ID);
  assert.notEqual(sora?.channelId, hana?.channelId);
  assert.deepEqual(env.logs, [
    `ローカルの入口を作りました（persona=sora、guild=${GUILD}）`,
    `ローカルの入口を作りました（persona=hana、guild=${GUILD}）`,
  ]);
});

test("ensureLocalEntries: 番号の無い入口の行（切り替えの日だけ在る行）には、番号と local を書き、切り替えの日は残す", (t) => {
  const env = setup(t);
  env.guildSettings.setInboxRotated(GUILD, "2026-10-01", NOW, "sora");
  assert.equal(env.guildSettings.personaInbox(GUILD, "sora")?.channelId, null);
  assert.equal(ensureLocalEntries(env.deps), 1);
  const inbox = env.guildSettings.personaInbox(GUILD, "sora");
  assert.match(inbox?.channelId ?? "", LOCAL_ID);
  assert.equal(inbox?.place, "local");
  assert.equal(inbox?.rotatedDate, "2026-10-01");
});

test("ensureLocalEntries: 述語が常に false（今の main）なら何も作らず、番号も取らず、log も出さない", (t) => {
  const env = setup(t, { isLocal: () => false });
  let taken = 0;
  const deps = { ...env.deps, localPlaces: { isLocalPersona: () => false, ids: { next: () => `${++taken}` } } };
  assert.equal(ensureLocalEntries(deps), 0);
  assert.equal(taken, 0);
  assert.deepEqual(env.logs, []);
  assert.equal(env.guildSettings.personaInbox(GUILD, "sora"), undefined);
});

test("ensureLocalEntries の後: entryChannel はその人格・inbox・local を返し、createChannelResolver は #inbox と同じ種類にする", (t) => {
  const env = setup(t);
  ensureLocalEntries(env.deps);
  const channelId = env.guildSettings.personaInbox(GUILD, "sora")!.channelId!;
  assert.deepEqual(env.guildSettings.entryChannel(channelId), { guildId: GUILD, persona: "sora", kind: "inbox", place: "local" });
  const resolve = createChannelResolver({ inboxChannelId: undefined, personas: [SORA, MIKA] }, env.guildSettings, env.topicSessions);
  assert.equal(resolve(GUILD, channelId), "inbox");
  assert.equal(resolve(GUILD_2, channelId), null);
});

// ---- B3: 食い違いの検査 ----

test("checkPersonaPlaces: 述語が true なのに入口・話題が discord、述語が false なのに入口・話題が local なら、それぞれその人格の文を 1 つ返す（番号を出さない）", (t) => {
  const cases: Array<{ label: string; isLocal: boolean; prepare: (env: ReturnType<typeof setup>) => void; text: string }> = [
    { label: "true × 入口 discord", isLocal: true, prepare: (env) => env.guildSettings.setPersonaInbox(GUILD, "sora", "500"), text: toLocalText },
    {
      label: "true × 話題 discord",
      isLocal: true,
      prepare: (env) => env.topicSessions.create({ channelId: "600", guildId: GUILD, title: "旅行", categoryId: "c", persona: "sora" }),
      text: toLocalText,
    },
    {
      label: "false × 入口 local",
      isLocal: false,
      prepare: (env) => env.guildSettings.setPersonaInbox(GUILD, "sora", env.localIds.next(), "local"),
      text: toDiscordText,
    },
    {
      label: "false × 話題 local",
      isLocal: false,
      prepare: (env) =>
        env.topicSessions.create({ channelId: env.localIds.next(), guildId: GUILD, title: "旅行", categoryId: "local", persona: "sora", place: "local" }),
      text: toDiscordText,
    },
  ];
  for (const { label, isLocal, prepare, text } of cases) {
    const env = setup(t, { isLocal: (id) => id === "sora" && isLocal });
    prepare(env);
    const errors = checkPersonaPlaces(env.deps);
    assert.deepEqual(errors, [text], label);
    assert.ok(errors.every((error) => !/\d/.test(error)), label);
    assert.deepEqual(env.logs, [], label);
  }
});

test("checkPersonaPlaces: 2 つ目の人格の食い違いでも、2 つ目の許可サーバーの食い違いでも 1 文を返す", (t) => {
  // 2 つ目の人格（mika。述語は偽）の入口が local
  const second = setup(t);
  ensureLocalEntries(second.deps);
  second.guildSettings.setPersonaInbox(GUILD, "mika", second.localIds.next(), "local");
  assert.deepEqual(checkPersonaPlaces(second.deps), [
    "SELF_AGENT_PERSONA_MIKA_SURFACE: この人格の場所は Web に在ります。人格の場所は後から変えられません（別の id で足してください）",
  ]);
  // 2 つ目の許可サーバー（1 つ目は揃っている）の sora の入口が discord
  const guild2 = setup(t, { setUp: [GUILD, GUILD_2], allowed: [GUILD, GUILD_2] });
  guild2.guildSettings.setPersonaInbox(GUILD, "sora", guild2.localIds.next(), "local");
  guild2.guildSettings.setPersonaInbox(GUILD_2, "sora", "500");
  assert.deepEqual(checkPersonaPlaces(guild2.deps), [toLocalText]);
});

test("checkPersonaPlaces: 入口と話題の両方が違っても、人格ごとに文は 1 つ", (t) => {
  const env = setup(t);
  env.guildSettings.setPersonaInbox(GUILD, "sora", "500");
  env.topicSessions.create({ channelId: "600", guildId: GUILD, title: "旅行", categoryId: "c", persona: "sora" });
  assert.deepEqual(checkPersonaPlaces(env.deps), [toLocalText]);
});

test("checkPersonaPlaces: 揃っていれば空（local の人格の local の入口・話題、discord の人格の discord の入口・話題、行が無い）", (t) => {
  const env = setup(t);
  assert.deepEqual(checkPersonaPlaces(env.deps), []);
  ensureLocalEntries(env.deps);
  env.topicSessions.create({ channelId: env.localIds.next(), guildId: GUILD, title: "旅行", categoryId: "local", persona: "sora", place: "local" });
  env.guildSettings.setPersonaInbox(GUILD, "mika", "501");
  env.topicSessions.create({ channelId: "601", guildId: GUILD, title: "相談", categoryId: "c", persona: "mika" });
  env.topicSessions.create({ channelId: "602", guildId: GUILD, title: "既定", categoryId: "c" });
  assert.deepEqual(checkPersonaPlaces(env.deps), []);
  // 述語が常に false（今の main）で、今在る行が全部 discord なら空
  const today = setup(t, { isLocal: () => false });
  today.guildSettings.setPersonaInbox(GUILD, "sora", "500");
  today.topicSessions.create({ channelId: "600", guildId: GUILD, title: "旅行", categoryId: "c", persona: "sora" });
  assert.deepEqual(checkPersonaPlaces(today.deps), []);
});

test("checkPersonaPlaces: 削除済みの話題・番号の無い入口の行・設定に無い人格の行は数えない", (t) => {
  const env = setup(t, { personas: [SORA] });
  // 削除済みの話題（場所が違う）
  env.topicSessions.create({ channelId: "600", guildId: GUILD, title: "旅行", categoryId: "c", persona: "sora" });
  env.topicSessions.markDeleted("600");
  // 番号の無い入口の行（切り替えの日だけを書いた行。場所は discord）
  env.guildSettings.setInboxRotated(GUILD, "2026-10-01", NOW, "sora");
  assert.equal(env.guildSettings.personaInbox(GUILD, "sora")?.channelId, null);
  // 設定に無い人格（mika）の、述語と違う場所の行
  env.guildSettings.setPersonaInbox(GUILD, "mika", env.localIds.next(), "local");
  env.topicSessions.create({ channelId: env.localIds.next(), guildId: GUILD, title: "外した", categoryId: "local", persona: "mika", place: "local" });
  assert.deepEqual(checkPersonaPlaces(env.deps), []);
});

test("hasPlaceOtherThan: その人格の削除済みでない話題に、場所が違う物が在るときだけ true", (t) => {
  const env = setup(t);
  assert.equal(env.topicSessions.hasPlaceOtherThan("sora", "local"), false);
  env.topicSessions.create({ channelId: "600", guildId: GUILD, title: "旅行", categoryId: "c", persona: "sora" });
  assert.equal(env.topicSessions.hasPlaceOtherThan("sora", "local"), true);
  assert.equal(env.topicSessions.hasPlaceOtherThan("sora", "discord"), false);
  assert.equal(env.topicSessions.hasPlaceOtherThan("mika", "local"), false);
  env.topicSessions.markDeleted("600");
  assert.equal(env.topicSessions.hasPlaceOtherThan("sora", "local"), false);
  // 削除済みでなければ、進行中でなくても数える（done だけの人格・waiting だけの人格）
  env.topicSessions.create({ channelId: "601", guildId: GUILD, title: "終わった", categoryId: "c", persona: "sora" });
  env.topicSessions.close("601", "要約");
  assert.equal(env.topicSessions.hasPlaceOtherThan("sora", "local"), true);
  env.topicSessions.create({ channelId: "602", guildId: GUILD, title: "待ち", categoryId: "c", persona: "mika" });
  env.topicSessions.setWaiting("602");
  assert.equal(env.topicSessions.hasPlaceOtherThan("mika", "local"), true);
});

// ---- B4・B5: 入口から先の一通り ----

type Response = { status: number; json: Record<string, unknown> };

function call(server: WebServer, method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> =
    method === "POST"
      ? { "tailscale-user-login": LOGIN, "sec-fetch-site": "same-origin", "x-self-agent": "1", "content-type": "application/json" }
      : { "tailscale-user-login": LOGIN };
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address()!.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** 入口を作った後の配線（main.ts と同じ: 人格 sora の runtime は gateway = ローカルの Gateway・connected = true）。既定の Bot の接続は defaultConnected */
function wire(t: TestContext, defaultConnected: boolean) {
  const env = setup(t);
  env.guildSettings.setChannel(GUILD, "tasksChannelId", "101");
  env.guildSettings.setStateCategory(GUILD, "active", 1, "active-1");
  assert.deepEqual(checkPersonaPlaces(env.deps), []);
  assert.equal(ensureLocalEntries(env.deps), 1);
  const entryId = env.guildSettings.personaInbox(GUILD, "sora")!.channelId!;

  const allow = ["send", "sendMessage", "editMessage", "startTyping"] as const;
  const defaultBot = recording(
    new FakeGateway({ allow, record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn"], messageIdPrefix: "5000" }),
  );
  const mikaBot = recording(new FakeGateway({ allow, messageIdPrefix: "6000" }));
  const local = recording(new LocalGateway(env.localIds));
  const defaultRunner = new FakeRunner([]);
  const mikaRunner = new FakeRunner([]);
  const soraRunner = new FakeRunner([
    { ok: true, text: "ソラです", sessionId: "session-1", usage: turnUsage(10, 0, 0), durationMs: 1000, toolCalls: 0, contextTokens: 10 },
  ]);
  const personas = new PersonaRouter({
    personas: [
      { id: "default", name: "default", engine: "claude", runner: defaultRunner, gateway: defaultBot.gateway, connected: () => defaultConnected },
      { id: "mika", name: "ミカ", engine: "claude", runner: mikaRunner, gateway: mikaBot.gateway, connected: () => true },
      { id: "sora", name: "ソラ", engine: "claude", runner: soraRunner, gateway: local.gateway, connected: () => true },
    ],
    guildSettings: env.guildSettings,
    topicSessions: env.topicSessions,
    localGateway: local.gateway,
  });
  const resolveChannel = createChannelResolver({ inboxChannelId: undefined, personas: [SORA, MIKA] }, env.guildSettings, env.topicSessions);
  /** Discord の偽 Gateway（既定・mika）に来た物 */
  const discordCalls = () => ({ default: defaultBot.calls, mika: mikaBot.calls });
  return { ...env, entryId, defaultBot, mikaBot, local, defaultRunner, mikaRunner, soraRunner, personas, resolveChannel, discordCalls };
}

test("一通り: 入口を作ると GET /api/topics に #<表示名> で出て、発言は 202。履歴は owner 1 行 + agent 1 行（その人格）で、Discord の偽 Gateway は 0 回", async (t) => {
  const env = wire(t, true);
  const cfg = { allowedGuildIds: [GUILD], personas: [SORA, MIKA], publicBaseUrl: undefined, inboxChannelId: undefined, workspaceDir: tempDir(t) };
  const handler = createHandler({
    cfg: { ...cfg, ownerUserId: "owner-1", timeZone: "Asia/Tokyo" },
    resolveChannel: env.resolveChannel,
    gateway: env.personas.ownerPosts(),
    runner: env.defaultRunner,
    personas: env.personas,
    ...env.stores,
    channelOps: new RecordingChannelOps(),
    queue: new KeyedSerialQueue(2),
    now: () => NOW,
    history: env.history,
    ownerConnected: (channelId) => env.personas.ownerConnected(channelId),
    log: () => undefined,
  });
  const routes = [
    ...topicRoutes({
      cfg,
      guildSettings: env.guildSettings,
      topicSessions: env.topicSessions,
      history: env.history,
      personas: env.personas,
      handler,
      places: { workspaceDir: cfg.workspaceDir, protectedDirs: [] },
      home: "/home/owner",
      now: () => NOW,
    }),
    ...turnRoutes({ cfg, guildSettings: env.guildSettings, topicSessions: env.topicSessions, resolveChannel: env.resolveChannel, handler, now: () => NOW, log: () => undefined }),
  ];
  const server = createWebServer({
    host: "127.0.0.1",
    port: 0,
    allowedLogin: LOGIN,
    staticDir: tempDir(t),
    templateSiteDir: tempDir(t),
    routes,
    stopping: () => false,
    now: () => NOW,
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());

  const listed = await call(server, "GET", "/api/topics");
  assert.equal(listed.status, 200);
  const entry = (listed.json as unknown as TopicsResult).topics.find((topic) => topic.id === `ch:${env.entryId}`);
  assert.equal(entry?.title, "#ソラ");
  assert.equal(entry?.persona, "ソラ");

  const posted = await call(server, "POST", `/api/channels/${env.entryId}/messages`, { text: "こんにちは" });
  assert.equal(posted.status, 202);
  for (let i = 0; i < 100 && env.history.list(env.entryId, { limit: 10 }).length < 2; i++) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    env.history.list(env.entryId, { limit: 10 }).map((row) => [row.kind, row.text, row.persona]),
    [
      ["owner", "こんにちは", "sora"],
      ["agent", "ソラです", "sora"],
    ],
  );
  assert.equal(env.soraRunner.inputs.length, 1);
  assert.equal(env.defaultRunner.inputs.length, 0);
  assert.equal(env.mikaRunner.inputs.length, 0);
  // Discord の偽 Gateway は 0 回。ローカルの Gateway に来たのは echo・入力中（何もしない）・返事だけ
  assert.deepEqual(env.discordCalls(), { default: [], mika: [] });
  assert.deepEqual(
    env.local.calls.map((entry) => [entry.method, entry.args[0]]),
    [
      ["sendMessage", env.entryId],
      ["startTyping", env.entryId],
      ["send", env.entryId],
    ],
  );
  assert.deepEqual(env.local.calls[0]?.args[1], { text: `${WEB_ECHO_PREFIX}\nこんにちは` });
  assert.equal(env.local.calls[2]?.args[1], "ソラです");
});

test("一通り（右腕の session_open）: ローカルの入口から始めた話題は place local・その人格の行で、区切り 1 行・submitText 1 回。Discord は 0 回", async (t) => {
  const env = wire(t, false);
  const submits: Array<Parameters<Handler["submitText"]>[0]> = [];
  const submitText = async (input: Parameters<Handler["submitText"]>[0]): Promise<SubmitTextResult> => {
    submits.push(input);
    return { result: "accepted", turnId: 1, messageId: "m-1" };
  };
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const rightHand = createRightHand({
    cfg: { timeZone: "Asia/Tokyo", autoSessionPerDay: 3, personas: [SORA, MIKA] },
    resolveChannel: env.resolveChannel,
    personas: env.personas,
    topicSessions: env.topicSessions,
    start: {
      gateway: env.defaultBot.gateway,
      personas: env.personas,
      guildSettings: env.guildSettings,
      topicSessions: env.topicSessions,
      queue: new KeyedSerialQueue(2),
      log,
      history: env.history,
      submitText,
      seeds: env.seeds,
      placeSettings: new PlaceSettingStore(env.db, () => NOW),
      localPlaces: env.deps.localPlaces,
    },
    now: () => NOW,
    log,
  });

  const opened = await rightHand.open(
    { title: "旅行の計画", text: "京都の宿を比べて", context: "京都に 2 泊したい" },
    { guildId: GUILD, channelId: env.entryId, kind: "inbox" },
  );
  assert.equal(opened.result, "created");
  const channelId = opened.result === "created" ? opened.channelId : "";
  assert.match(channelId, LOCAL_ID);
  assert.notEqual(channelId, env.entryId);
  const row = env.topicSessions.get(channelId);
  assert.equal(row?.place, "local");
  assert.equal(row?.title, "旅行の計画");
  assert.equal(env.topicSessions.personaOf(channelId), "sora");
  assert.deepEqual(
    env.history.list(channelId, { limit: 10 }).map((entry) => [entry.kind, entry.persona]),
    [["divider", "sora"]],
  );
  assert.deepEqual(
    submits.map((input) => [input.channelId, input.content]),
    [[channelId, "京都の宿を比べて"]],
  );
  // Discord の偽 Gateway（チャンネル作り・投稿とも）は 0 回。ローカルの Gateway にも来ない（ローカルの話題には最初の投稿をしない）
  assert.deepEqual(env.discordCalls(), { default: [], mika: [] });
  assert.deepEqual(env.defaultBot.gateway.calls, []);
  assert.deepEqual(env.local.calls, []);
  assert.ok(logs.every((line) => !line.includes(channelId) && !line.includes(env.entryId)), logs.join("\n"));
});

test("一通り（設定から。#530 の WP5 の門）: _SURFACE=web の env で loadConfig → 述語 → 入口 → 発言。Bot は Discord の人格だけに作り、ローカルの Gateway に来たのは入口の番号への echo・入力中・返事だけ", async (t) => {
  const workspaceDir = tempDir(t);
  const config = loadConfig({
    HOME: "/home/tester",
    DISCORD_TOKEN: "dummy-default",
    SELF_AGENT_OWNER_ID: "123456789012345678",
    SELF_AGENT_ALLOWED_GUILD_IDS: GUILD,
    SELF_AGENT_WORKSPACE_DIR: workspaceDir,
    SELF_AGENT_WEB_PORT: "8791",
    SELF_AGENT_WEB_ALLOWED_LOGIN: LOGIN,
    SELF_AGENT_PERSONAS: "mika,sora",
    SELF_AGENT_PERSONA_MIKA_DISCORD_TOKEN: "dummy-mika",
    SELF_AGENT_PERSONA_MIKA_NAME: "ミカ",
    SELF_AGENT_PERSONA_SORA_SURFACE: "web",
    SELF_AGENT_PERSONA_SORA_NAME: "ソラ",
  });
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  stores.guildSettings.setChannel(GUILD, "inboxChannelId", "100");
  stores.guildSettings.setChannel(GUILD, "tasksChannelId", "101");
  stores.guildSettings.setStateCategory(GUILD, "active", 1, "active-1");
  // main.ts と同じ: 述語は設定の surface から、入口は起動の検査の後に作る
  const localIds = new LocalIdStore(db);
  const logs: string[] = [];
  const localEntriesDeps = {
    cfg: config,
    guildSettings: stores.guildSettings,
    topicSessions: stores.topicSessions,
    localPlaces: { isLocalPersona: webPersonaPredicate(config.personas), ids: localIds },
    log: (line: string) => void logs.push(line),
  };
  assert.deepEqual(checkPersonaPlaces(localEntriesDeps), []);
  assert.equal(ensureLocalEntries(localEntriesDeps), 1);
  assert.deepEqual(logs, [`ローカルの入口を作りました（persona=sora、guild=${GUILD}）`]);
  const entryId = stores.guildSettings.personaInbox(GUILD, "sora")!.channelId!;
  assert.match(entryId, LOCAL_ID);
  assert.equal(stores.guildSettings.personaInbox(GUILD, "mika"), undefined);

  // main.ts と同じ: Bot は surface が discord の人格だけ。runtime は設定の全部の人格から、Bot の側は personaBot
  const allow = ["send", "sendMessage", "editMessage", "startTyping"] as const;
  const defaultBot = recording(
    new FakeGateway({ allow, record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn"], messageIdPrefix: "5000" }),
  );
  const bots = discordPersonas(config.personas).map((persona) => ({
    persona,
    bot: recording(Object.assign(new FakeGateway({ allow, messageIdPrefix: "6000" }), { connected: () => true })),
  }));
  assert.deepEqual(
    bots.map(({ persona }) => persona.id),
    ["mika"],
  );
  const local = recording(new LocalGateway(localIds));
  const runners = new Map([
    ["default", new FakeRunner([])],
    ["mika", new FakeRunner([])],
    [
      "sora",
      new FakeRunner([
        { ok: true, text: "ソラです", sessionId: "session-1", usage: turnUsage(10, 0, 0), durationMs: 1000, toolCalls: 0, contextTokens: 10 },
      ]),
    ],
  ]);
  const personas = new PersonaRouter({
    personas: [
      { id: "default", name: "default", engine: "claude", runner: runners.get("default")!, gateway: defaultBot.gateway, connected: () => true },
      ...config.personas.map((persona) => ({
        id: persona.id,
        name: persona.name,
        engine: "claude" as const,
        runner: runners.get(persona.id)!,
        ...personaBot(persona, bots.find((bot) => bot.persona.id === persona.id)?.bot.gateway, local.gateway),
      })),
    ],
    guildSettings: stores.guildSettings,
    topicSessions: stores.topicSessions,
    localGateway: local.gateway,
  });
  assert.equal(personas.ownerConnected(entryId), true);
  const resolveChannel = createChannelResolver(config, stores.guildSettings, stores.topicSessions);
  const handler = createHandler({
    cfg: config,
    resolveChannel,
    gateway: personas.ownerPosts(),
    runner: runners.get("default")!,
    personas,
    ...stores,
    channelOps: new RecordingChannelOps(),
    queue: new KeyedSerialQueue(2),
    now: () => NOW,
    history: stores.history,
    ownerConnected: (channelId) => personas.ownerConnected(channelId),
    log: () => undefined,
  });
  const server = createWebServer({
    host: "127.0.0.1",
    port: 0,
    allowedLogin: LOGIN,
    staticDir: tempDir(t),
    templateSiteDir: tempDir(t),
    routes: [
      ...topicRoutes({
        cfg: config,
        guildSettings: stores.guildSettings,
        topicSessions: stores.topicSessions,
        history: stores.history,
        personas,
        handler,
        places: { workspaceDir, protectedDirs: [] },
        home: "/home/owner",
        now: () => NOW,
      }),
      ...turnRoutes({ cfg: config, guildSettings: stores.guildSettings, topicSessions: stores.topicSessions, resolveChannel, handler, now: () => NOW, log: () => undefined }),
    ],
    stopping: () => false,
    now: () => NOW,
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());

  const listed = await call(server, "GET", "/api/topics");
  assert.equal(listed.status, 200);
  const entry = (listed.json as unknown as TopicsResult).topics.find((topic) => topic.id === `ch:${entryId}`);
  assert.equal(entry?.title, "#ソラ");
  assert.equal(entry?.persona, "ソラ");

  const posted = await call(server, "POST", `/api/channels/${entryId}/messages`, { text: "こんにちは" });
  assert.equal(posted.status, 202);
  for (let i = 0; i < 100 && stores.history.list(entryId, { limit: 10 }).length < 2; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    stores.history.list(entryId, { limit: 10 }).map((row) => [row.kind, row.text, row.persona]),
    [
      ["owner", "こんにちは", "sora"],
      ["agent", "ソラです", "sora"],
    ],
  );
  assert.deepEqual(
    [...runners].map(([id, runner]) => [id, runner.inputs.length]),
    [
      ["default", 0],
      ["mika", 0],
      ["sora", 1],
    ],
  );
  // ローカルの Gateway に来た物の一覧（どの番号に何が来たか）。宛先はどれも入口の番号で、返事は echo（ローカルの番号）への返信
  const replyTo = local.calls[2]?.args[2];
  assert.match(String(replyTo), LOCAL_ID);
  assert.notEqual(replyTo, entryId);
  assert.deepEqual(
    local.calls.map((entry) => [entry.method, ...entry.args]),
    [
      ["sendMessage", entryId, { text: `${WEB_ECHO_PREFIX}\nこんにちは` }],
      ["startTyping", entryId],
      ["send", entryId, "ソラです", replyTo, undefined],
    ],
  );
  // Discord の偽 Gateway（既定・mika）には何も来ない
  assert.deepEqual(defaultBot.calls, []);
  assert.deepEqual(defaultBot.gateway.calls, []);
  assert.deepEqual(
    bots.map(({ persona, bot }) => [persona.id, bot.calls]),
    [["mika", []]],
  );
});

// ---- 配線の見張り ----

test("見張り: main.ts は store の直後に、checkPersonaPlaces → 断るなら exit 1 → ensureLocalEntries の順で、同じ localPlaces（localIds）を使い、Discord・Web の待ち受けより前", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(source.match(/checkPersonaPlaces\(/g)?.length, 1);
  assert.equal(source.match(/ensureLocalEntries\(/g)?.length, 1);
  assert.match(source, /\nconst localPlaces: LocalPersonaPlaces = \{[^\n]*ids: localIds[^\n]*\};\n/);
  assert.match(source, /\nconst localEntriesDeps = \{ cfg: config, guildSettings, topicSessions, localPlaces, log \};\n/);
  const order = [
    "\nconst localIds = new LocalIdStore(db);\n",
    "\nconst localPlaces: LocalPersonaPlaces = {",
    "\nconst placeErrors = checkPersonaPlaces(localEntriesDeps);\nif (placeErrors.length > 0) {\n  for (const error of placeErrors) console.error(error);\n  process.exit(1);\n}\nensureLocalEntries(localEntriesDeps);\n",
  ].map((text) => {
    const at = source.indexOf(text);
    assert.ok(at >= 0, text);
    return at;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // 入口を作るのは、Discord の待ち受けと、main.ts の最初の .start()（配信・Web・hook の受け口など）より前
  const ensured = source.indexOf("ensureLocalEntries(");
  const gatewayStart = source.indexOf("await gateway.start(");
  const firstStart = source.search(/\.start\(/);
  assert.ok(gatewayStart >= 0 && firstStart >= 0);
  assert.ok(ensured < gatewayStart);
  assert.ok(ensured < firstStart);
});

/** source の start の字の後の最初の `{` から、括弧の釣り合う `}` までの塊 */
function braceBlock(source: string, start: string): string {
  const at = source.indexOf(start);
  assert.ok(at >= 0, start);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(open, i + 1);
  }
  assert.fail(`閉じていない: ${start}`);
}

test("見張り（#530 の WP5 の門）: main.ts は Bot を surface が discord の人格だけから作り、述語は設定の surface から答え、4 つの塊に同じ localPlaces を渡す", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  // (1) 人格の Bot（Client・接続の知らせ・止める一覧の元）は、surface で絞ってから作る
  assert.equal(source.match(/\nconst personaGateways = /g)?.length, 1);
  assert.match(source, /\nconst personaGateways = discordPersonas\(config\.personas\)\.map\(/);
  assert.doesNotMatch(source, /personaGateways = config\.personas\.map\(/);
  // (2) 述語は常に false ではなく、設定の surface から答える
  assert.doesNotMatch(source, /isLocalPersona: \(\) => false/);
  assert.match(source, /\nconst localPlaces: LocalPersonaPlaces = \{ isLocalPersona: webPersonaPredicate\(config\.personas\), ids: localIds \};\n/);
  // (3) /new・/setup（createCommands）・ホームパネル（createComponents）・話題を始める口（topicStart）・Web（createWebServer）が同じ localPlaces を見る
  for (const start of ["\nconst commands = createCommands(", "  components: createComponents(", "\nconst topicStart = ", "  webServer = createWebServer("]) {
    assert.match(braceBlock(source, start), /\n\s+localPlaces,\n/, start);
  }
});
