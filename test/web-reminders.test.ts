import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createChannelResolver } from "../src/app/access.ts";
import type { PersonaConfig } from "../src/config.ts";
import { webChannelNamer } from "../src/web/routes/channels.ts";
import { reminderRoutes } from "../src/web/routes/reminders.ts";
import { request } from "node:http";
import { createWebServer, type Route, type WebServer } from "../src/web/server.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";

const LOGIN = "owner@example.com";
const POST_HEADERS = {
  "tailscale-user-login": LOGIN,
  "sec-fetch-site": "same-origin",
  "x-self-agent": "1",
  "content-type": "application/json",
};

type Response = { status: number; json: Record<string, unknown> };

function call(server: WebServer, method: "GET" | "POST", path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.address()!.port,
        method,
        path,
        headers: method === "POST" ? POST_HEADERS : { "tailscale-user-login": LOGIN },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

async function serve(t: TestContext, routes: Route[], now: () => Date): Promise<WebServer> {
  const server = createWebServer({
    host: "127.0.0.1",
    port: 0,
    allowedLogin: LOGIN,
    staticDir: tempDir(t),
    templateSiteDir: tempDir(t),
    routes,
    stopping: () => false,
    now,
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());
  return server;
}

/** 2026-10-13(火) 9:25 JST */
const NOW = new Date("2026-10-13T00:25:00.000Z");
const GUILD = "111";

const MIKA: PersonaConfig = {
  id: "mika",
  name: "ミカ",
  discordTokenEnv: "SELF_AGENT_PERSONA_MIKA_DISCORD_TOKEN",
  promptFile: "/dev/null",
  model: undefined,
  engine: "claude",
  effort: undefined,
};

async function setup(t: TestContext) {
  const stores = createStores(tempDb(t), () => NOW);
  const { guildSettings, topicSessions, reminders } = stores;
  // #inbox 100・#tasks 101・ミカの #<NAME> 102・セッション 200・削除したセッション 203
  guildSettings.setChannel(GUILD, "inboxChannelId", "100");
  guildSettings.setChannel(GUILD, "tasksChannelId", "101");
  guildSettings.setPersonaInbox(GUILD, "mika", "102");
  topicSessions.create({ channelId: "200", guildId: GUILD, title: "引っ越しの手続き", categoryId: "c" });
  topicSessions.create({ channelId: "203", guildId: GUILD, title: "消した話", categoryId: "c" });
  topicSessions.markDeleted("203");
  const cfg = { allowedGuildIds: [GUILD], personas: [MIKA], publicBaseUrl: undefined, inboxChannelId: undefined, timeZone: "Asia/Tokyo" };
  const resolveChannel = createChannelResolver(cfg, guildSettings, topicSessions);
  const logs: string[] = [];
  const routes = reminderRoutes({
    cfg,
    reminders,
    channelName: webChannelNamer({ cfg, guildSettings, topicSessions, resolveChannel }),
    log: (line) => logs.push(line),
  });
  const server = await serve(t, routes, () => NOW);
  return { server, reminders, logs };
}

test("GET /api/reminders: active を次に知らせる順に。nextAt はスヌーズとの早い方、ruleText は日本語、channelName は #inbox・#tasks・#<NAME>・題名（開けなければ null）", async (t) => {
  const { server, reminders } = await setup(t);
  const daily = reminders.add({ guildId: GUILD, channelId: "100", kind: "notify", text: "薬を飲む", rule: "daily@21:00", nextAt: new Date("2026-10-13T12:00:00.000Z") });
  const once = reminders.add({ guildId: GUILD, channelId: "200", kind: "notify", text: "家賃の振込", taskId: 7, nextAt: new Date("2026-10-14T00:00:00.000Z") });
  reminders.snooze(once.id, new Date("2026-10-13T01:00:00.000Z"));
  const prompt = reminders.add({ guildId: GUILD, channelId: "101", kind: "prompt", text: "今週のタスク", rule: "weekly:mon@08:00", nextAt: new Date("2026-10-18T23:00:00.000Z") });
  const mika = reminders.add({ guildId: GUILD, channelId: "102", kind: "notify", text: "ミカ", nextAt: new Date("2026-10-20T00:00:00.000Z") });
  const deleted = reminders.add({ guildId: GUILD, channelId: "203", kind: "notify", text: "消した", nextAt: new Date("2026-10-21T00:00:00.000Z") });
  const stopped = reminders.add({ guildId: GUILD, channelId: "100", kind: "notify", text: "止めた", nextAt: new Date("2026-10-13T02:00:00.000Z") });
  reminders.cancel(stopped.id);

  const { status, json } = await call(server, "GET", "/api/reminders");
  assert.equal(status, 200);
  const link = (channelId: string) => `https://discord.com/channels/${GUILD}/${channelId}`;
  assert.deepEqual(json.reminders, [
    { id: once.id, kind: "notify", text: "家賃の振込", rule: null, ruleText: null, nextAt: "2026-10-13T01:00:00.000Z", channelId: "200", channelName: "引っ越しの手続き", taskId: 7, link: link("200") },
    { id: daily.id, kind: "notify", text: "薬を飲む", rule: "daily@21:00", ruleText: "毎日 21:00", nextAt: "2026-10-13T12:00:00.000Z", channelId: "100", channelName: "#inbox", taskId: null, link: link("100") },
    { id: prompt.id, kind: "prompt", text: "今週のタスク", rule: "weekly:mon@08:00", ruleText: "毎週 月 8:00", nextAt: "2026-10-18T23:00:00.000Z", channelId: "101", channelName: "#tasks", taskId: null, link: link("101") },
    { id: mika.id, kind: "notify", text: "ミカ", rule: null, ruleText: null, nextAt: "2026-10-20T00:00:00.000Z", channelId: "102", channelName: "#ミカ", taskId: null, link: link("102") },
    { id: deleted.id, kind: "notify", text: "消した", rule: null, ruleText: null, nextAt: "2026-10-21T00:00:00.000Z", channelId: "203", channelName: null, taskId: null, link: link("203") },
  ]);
});

test("POST /api/reminders/<id>/skip: 繰り返しの次の回を飛ばして { skipped, next }。1 回だけ・止めたものは 409、無い id は 404", async (t) => {
  const { server, reminders, logs } = await setup(t);
  // 毎週 水・金 8:00。次は 10/14(水)
  const weekly = reminders.add({ guildId: GUILD, channelId: "100", kind: "notify", text: "ゴミ出し", rule: "weekly:wed,fri@08:00", nextAt: new Date("2026-10-13T23:00:00.000Z") });
  const once = reminders.add({ guildId: GUILD, channelId: "100", kind: "notify", text: "歯医者", nextAt: new Date("2026-10-13T02:00:00.000Z") });

  assert.deepEqual(await call(server, "POST", `/api/reminders/${weekly.id}/skip`), {
    status: 200,
    json: { skipped: "2026-10-13T23:00:00.000Z", next: "2026-10-15T23:00:00.000Z" },
  });
  assert.equal(reminders.get(weekly.id)?.nextAt, "2026-10-15T23:00:00.000Z");
  assert.deepEqual(await call(server, "POST", `/api/reminders/${once.id}/skip`), { status: 409, json: { error: "stale" } });
  assert.deepEqual(await call(server, "POST", "/api/reminders/99/skip"), { status: 404, json: { error: "not_found" } });
  reminders.cancel(weekly.id);
  assert.deepEqual(await call(server, "POST", `/api/reminders/${weekly.id}/skip`), { status: 409, json: { error: "stale" } });
  assert.deepEqual(logs, [`Web でリマインドの次の回を飛ばしました（#${weekly.id}）`]);
});

test("POST /api/reminders/<id>/cancel: 止めて 200、2 回目は 409、無い id は 404", async (t) => {
  const { server, reminders, logs } = await setup(t);
  const once = reminders.add({ guildId: GUILD, channelId: "100", kind: "notify", text: "歯医者", nextAt: new Date("2026-10-13T02:00:00.000Z") });
  assert.deepEqual(await call(server, "POST", `/api/reminders/${once.id}/cancel`), { status: 200, json: { cancelled: true } });
  assert.equal(reminders.get(once.id)?.status, "cancelled");
  assert.deepEqual(await call(server, "POST", `/api/reminders/${once.id}/cancel`), { status: 409, json: { error: "stale" } });
  assert.deepEqual(await call(server, "POST", "/api/reminders/99/cancel"), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(logs, [`Web でリマインドを止めました（#${once.id}）`]);
});
