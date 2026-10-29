import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AgentRunner } from "../src/agent/runner.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { PersonaRouter } from "../src/app/personas.ts";
import type { PersonaConfig } from "../src/config.ts";
import type { Gateway } from "../src/discord/gateway.ts";
import { channelRoutes } from "../src/web/routes/channels.ts";
import { createWebServer, type WebServer } from "../src/web/server.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";

const LOGIN = "owner@example.com";
const NOW = new Date("2026-10-02T00:12:00Z");
const GUILD = "111";
const GUILD_NOT_SET_UP = "222";

const MIKA: PersonaConfig = {
  id: "mika",
  name: "ミカ",
  discordTokenEnv: "SELF_AGENT_PERSONA_MIKA_DISCORD_TOKEN",
  promptFile: "/dev/null",
  model: undefined,
  engine: "claude",
  effort: undefined,
};

function getJson(server: WebServer, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: server.address()!.port, path, headers: { "tailscale-user-login": LOGIN } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function setup(t: TestContext, options: { publicBaseUrl?: string } = {}) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { guildSettings, topicSessions, projects, history } = stores;
  // /setup 済みのサーバー: #inbox・#tasks・ミカの #<NAME>・設定から外した人格の #<NAME>
  guildSettings.setChannel(GUILD, "inboxChannelId", "100");
  guildSettings.setChannel(GUILD, "tasksChannelId", "101");
  guildSettings.setPersonaInbox(GUILD, "mika", "102");
  guildSettings.setPersonaInbox(GUILD, "gone", "103");
  // セッション: 進行中（プロジェクトあり）・待ち（ミカ）・完了・削除済み
  topicSessions.create({ channelId: "200", guildId: GUILD, title: "家計簿アプリ", categoryId: "c" });
  topicSessions.create({ channelId: "201", guildId: GUILD, title: "ミカの相談", categoryId: "c", persona: "mika" });
  topicSessions.setWaiting("201");
  topicSessions.create({ channelId: "202", guildId: GUILD, title: "終わった話", categoryId: "c" });
  topicSessions.close("202", "要約");
  topicSessions.create({ channelId: "203", guildId: GUILD, title: "消した話", categoryId: "c" });
  topicSessions.markDeleted("203");
  projects.create({ guildId: GUILD, channelId: "200", name: "kakeibo", title: "家計簿" });

  const cfg = {
    allowedGuildIds: [GUILD, GUILD_NOT_SET_UP],
    personas: [MIKA],
    publicBaseUrl: options.publicBaseUrl,
    // /setup 前のサーバーの #inbox（Web では使わない）
    inboxChannelId: "900",
  };
  const personas = new PersonaRouter({
    personas: [
      { id: "default", name: "default", engine: "claude", runner: {} as AgentRunner, gateway: {} as Gateway, connected: () => true },
      { id: "mika", name: "ミカ", engine: "claude", runner: {} as AgentRunner, gateway: {} as Gateway, connected: () => false },
    ],
    guildSettings,
    topicSessions,
  });
  const routes = channelRoutes({
    cfg,
    guildSettings,
    topicSessions,
    projects,
    history,
    personas,
    resolveChannel: createChannelResolver(cfg, guildSettings, topicSessions),
  });
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
  return { server, ...stores };
}

test("/api/channels: /setup 済みのサーバーの入口（設定にある人格の #<NAME> を含む）とセッション。削除済み・外した人格・/setup 前のサーバーは無い", async (t) => {
  const { server, history } = await setup(t, { publicBaseUrl: "https://host.example" });
  history.add({ guildId: GUILD, channelId: "100", kind: "owner", source: "discord", text: "こんにちは", messageId: "5001" });
  const agentId = history.add({ guildId: GUILD, channelId: "100", kind: "agent", source: "discord", text: "はい", outcome: "done" });

  const { status, json } = await getJson(server, "/api/channels");
  assert.equal(status, 200);
  assert.deepEqual(json.guilds, [
    { id: GUILD, setUp: true },
    { id: GUILD_NOT_SET_UP, setUp: false },
  ]);
  assert.deepEqual(json.personas, [
    { id: "default", name: "既定の人格", isDefault: true, connected: true },
    { id: "mika", name: "ミカ", isDefault: false, connected: false },
  ]);
  const channels = json.channels as Array<Record<string, unknown>>;
  assert.deepEqual(
    channels.map((c) => [c.id, c.kind, c.name, c.title, c.persona, c.state]),
    [
      ["100", "inbox", "inbox", null, "default", null],
      ["101", "tasks", "tasks", null, "default", null],
      ["102", "inbox", "ミカ", null, "mika", null],
      ["200", "session", null, "家計簿アプリ", "default", "active"],
      ["201", "session", null, "ミカの相談", "mika", "waiting"],
      ["202", "session", null, "終わった話", "default", "done"],
    ],
  );
  const inbox = channels[0]!;
  assert.deepEqual(inbox.last, { id: agentId, at: NOW.toISOString(), kind: "agent" });
  assert.equal(inbox.link, `https://discord.com/channels/${GUILD}/100`);
  assert.equal(inbox.guildId, GUILD);
  assert.equal(inbox.project, null);
  const session = channels[3]!;
  assert.equal(session.last, null);
  assert.deepEqual(session.project, { slug: "kakeibo", url: "https://host.example/p/kakeibo/" });
  assert.equal(session.link, `https://discord.com/channels/${GUILD}/200`);
  // 一覧には closeDraft を入れない（/turns の channel だけ）
  assert.equal("closeDraft" in session, false);
});

test("/api/channels: 公開 URL が無ければ project.url は null。/setup 前のサーバーのチャンネルは出ない", async (t) => {
  const { server, guildSettings } = await setup(t);
  const { json } = await getJson(server, "/api/channels");
  const session = (json.channels as Array<Record<string, unknown>>).find((c) => c.id === "200")!;
  assert.deepEqual(session.project, { slug: "kakeibo", url: null });
  assert.ok(guildSettings.get(GUILD_NOT_SET_UP) === undefined);
  assert.equal((json.channels as Array<Record<string, unknown>>).some((c) => c.guildId === GUILD_NOT_SET_UP), false);
});

test("/api/channels: /setup 前のサーバー（env の #inbox だけ）はチャンネルが 0 件で setUp: false", async (t) => {
  const db = tempDb(t);
  const { guildSettings, topicSessions, projects, history } = createStores(db, () => NOW);
  const cfg = { allowedGuildIds: [GUILD_NOT_SET_UP], personas: [], publicBaseUrl: undefined, inboxChannelId: "900" };
  history.add({ guildId: GUILD_NOT_SET_UP, channelId: "900", kind: "owner", source: "discord", text: "x" });
  const personas = new PersonaRouter({
    personas: [{ id: "default", name: "default", engine: "claude", runner: {} as AgentRunner, gateway: {} as Gateway, connected: () => true }],
    guildSettings,
    topicSessions,
  });
  const server = createWebServer({
    host: "127.0.0.1",
    port: 0,
    allowedLogin: LOGIN,
    staticDir: tempDir(t),
    templateSiteDir: tempDir(t),
    routes: channelRoutes({
      cfg,
      guildSettings,
      topicSessions,
      projects,
      history,
      personas,
      resolveChannel: createChannelResolver(cfg, guildSettings, topicSessions),
    }),
    stopping: () => false,
    now: () => NOW,
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());
  const { json } = await getJson(server, "/api/channels");
  assert.deepEqual(json, {
    guilds: [{ id: GUILD_NOT_SET_UP, setUp: false }],
    personas: [{ id: "default", name: "既定の人格", isDefault: true, connected: true }],
    channels: [],
  });
  // env の #inbox の会話も読めない
  assert.equal((await getJson(server, "/api/channels/900/turns")).status, 404);
});

test("/api/channels/<id>/turns: 最新・before・after・limit、行の link と channel（closeDraft: null）", async (t) => {
  const { server, history } = await setup(t);
  const ids: number[] = [];
  for (let i = 1; i <= 5; i++) {
    ids.push(history.add({ guildId: GUILD, channelId: "200", kind: "owner", source: "discord", text: `発言 ${i}`, messageId: `70${i}` }));
  }
  const agent = history.add({
    guildId: GUILD,
    channelId: "200",
    kind: "agent",
    source: "web",
    text: "返事",
    outcome: "max_turns",
    steps: ["読んでいます site/index.html"],
    toolCalls: 3,
    durationMs: 65_000,
  });
  // ほかのチャンネルの行は混ざらない
  history.add({ guildId: GUILD, channelId: "100", kind: "owner", source: "discord", text: "別" });

  const latest = await getJson(server, "/api/channels/200/turns?limit=3");
  assert.equal(latest.status, 200);
  const channel = latest.json.channel as Record<string, unknown>;
  assert.equal(channel.id, "200");
  assert.equal(channel.kind, "session");
  assert.equal(channel.title, "家計簿アプリ");
  assert.equal(channel.state, "active");
  assert.equal(channel.closeDraft, null);
  assert.deepEqual(channel.last, { id: agent, at: NOW.toISOString(), kind: "agent" });
  const turns = latest.json.turns as Array<Record<string, unknown>>;
  assert.deepEqual(turns.map((turn) => turn.id), [ids[3], ids[4], agent]);
  assert.deepEqual(turns[0], {
    id: ids[3],
    at: NOW.toISOString(),
    kind: "owner",
    source: "discord",
    persona: "default",
    text: "発言 4",
    outcome: null,
    steps: null,
    toolCalls: null,
    durationMs: null,
    messageId: "704",
    link: `https://discord.com/channels/${GUILD}/200/704`,
  });
  assert.deepEqual(turns[2], {
    id: agent,
    at: NOW.toISOString(),
    kind: "agent",
    source: "web",
    persona: "default",
    text: "返事",
    outcome: "max_turns",
    steps: ["読んでいます site/index.html"],
    toolCalls: 3,
    durationMs: 65_000,
    messageId: null,
    link: `https://discord.com/channels/${GUILD}/200`,
  });
  // 最新の取得では hasMore は返さない（before のときだけ）
  assert.equal(latest.json.hasMore, false);

  const older = await getJson(server, `/api/channels/200/turns?before=${ids[3]}&limit=2`);
  assert.deepEqual((older.json.turns as Array<Record<string, unknown>>).map((turn) => turn.id), [ids[1], ids[2]]);
  assert.equal(older.json.hasMore, true);
  const oldest = await getJson(server, `/api/channels/200/turns?before=${ids[1]}&limit=2`);
  assert.deepEqual((oldest.json.turns as Array<Record<string, unknown>>).map((turn) => turn.id), [ids[0]]);
  assert.equal(oldest.json.hasMore, false);

  const newer = await getJson(server, `/api/channels/200/turns?after=${ids[2]}`);
  assert.deepEqual((newer.json.turns as Array<Record<string, unknown>>).map((turn) => turn.id), [ids[3], ids[4], agent]);
  assert.equal(newer.json.hasMore, false);

  // 既定の limit は 50
  const all = await getJson(server, "/api/channels/200/turns");
  assert.equal((all.json.turns as unknown[]).length, 6);
});

test("/api/channels/<id>/turns: limit・before・after の形が違えば 400", async (t) => {
  const { server } = await setup(t);
  for (const query of ["limit=201", "limit=0", "limit=abc", "limit=", "before=0", "before=x", "after=-1", "before=1&after=2"]) {
    const { status, json } = await getJson(server, `/api/channels/200/turns?${query}`);
    assert.equal(status, 400, query);
    assert.deepEqual(json, { error: "bad_request" });
  }
  assert.equal((await getJson(server, "/api/channels/200/turns?limit=200")).status, 200);
});

test("/api/channels/<id>/turns: 入口・完了・人格の #<NAME> は 200、削除済み・知らない・外した人格・/setup 前は 404", async (t) => {
  const { server, guildSettings } = await setup(t);
  for (const id of ["100", "101", "102", "202"]) {
    assert.equal((await getJson(server, `/api/channels/${id}/turns`)).status, 200, id);
  }
  const tasks = await getJson(server, "/api/channels/101/turns");
  assert.equal((tasks.json.channel as Record<string, unknown>).kind, "tasks");
  const mika = await getJson(server, "/api/channels/102/turns");
  assert.equal((mika.json.channel as Record<string, unknown>).name, "ミカ");
  assert.equal((mika.json.channel as Record<string, unknown>).persona, "mika");
  // 削除済みのセッション・外した人格の #<NAME>・知らないチャンネル・env の #inbox
  for (const id of ["203", "103", "999", "900"]) {
    const { status, json } = await getJson(server, `/api/channels/${id}/turns`);
    assert.equal(status, 404, id);
    assert.deepEqual(json, { error: "not_found" });
  }
  // 許可していないサーバーの #inbox
  guildSettings.setChannel("333", "inboxChannelId", "300");
  assert.equal((await getJson(server, "/api/channels/300/turns")).status, 404);
  // 数字でない ID はルートに当たらない
  assert.equal((await getJson(server, "/api/channels/abc/turns")).status, 404);
});
