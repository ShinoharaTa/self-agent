import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createChannelResolver } from "../src/app/access.ts";
import { createHandler, type Handler, type RunningTurn, type SubmitTextResult, WEB_ECHO_PREFIX } from "../src/app/handler.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { turnRoutes, WEB_DUPLICATE_WINDOW_MS, WEB_MESSAGE_MAX_LENGTH } from "../src/web/routes/turns.ts";
import { createWebServer, type WebServer } from "../src/web/server.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

const LOGIN = "owner@example.com";
const NOW = new Date("2026-10-02T00:12:00Z");
const GUILD = "111";
const POST_HEADERS = {
  "tailscale-user-login": LOGIN,
  "sec-fetch-site": "same-origin",
  "x-self-agent": "1",
  "content-type": "application/json",
};

type Response = { status: number; json: Record<string, unknown> };

function call(server: WebServer, method: "GET" | "POST", path: string, body?: unknown, headers?: Record<string, string>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.address()!.port,
        method,
        path,
        headers: headers ?? (method === "POST" ? POST_HEADERS : { "tailscale-user-login": LOGIN }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** 偽の handler（submitText の結果は next の順、無ければ受け付けて turnId を 1 から振る） */
class FakeTurns implements Pick<Handler, "submitText" | "runningTurns" | "abortTurn" | "continueTurn"> {
  submits: Array<{ guildId: string; channelId: string; content: string; at: string }> = [];
  next: SubmitTextResult[] = [];
  running: RunningTurn[] = [];
  aborts: Array<[string, number]> = [];
  abortResult = true;
  continues: Array<{ guildId: string; channelId: string; at: string }> = [];
  /** あれば submitText はこれを待ってから返す（同時に来た 2 回目を見る） */
  gate: Promise<void> | undefined;

  async submitText(input: { guildId: string; channelId: string; content: string; at: Date; source: "web" }): Promise<SubmitTextResult> {
    this.submits.push({ guildId: input.guildId, channelId: input.channelId, content: input.content, at: input.at.toISOString() });
    await this.gate;
    return this.next.shift() ?? { result: "accepted", turnId: this.submits.length, messageId: `9000${this.submits.length}` };
  }
  runningTurns(): RunningTurn[] {
    return this.running;
  }
  abortTurn(channelId: string, turnSeq: number): boolean {
    this.aborts.push([channelId, turnSeq]);
    return this.abortResult;
  }
  async continueTurn(guildId: string, channelId: string, at: Date): Promise<void> {
    this.continues.push({ guildId, channelId, at: at.toISOString() });
  }
}

/** /setup 済みのサーバー: #inbox 100・#tasks 101、セッション 200（進行中）・203（削除済み） */
function prepare(t: TestContext) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  stores.guildSettings.setChannel(GUILD, "inboxChannelId", "100");
  stores.guildSettings.setChannel(GUILD, "tasksChannelId", "101");
  stores.topicSessions.create({ channelId: "200", guildId: GUILD, title: "家計簿アプリ", categoryId: "c" });
  stores.topicSessions.create({ channelId: "203", guildId: GUILD, title: "消した話", categoryId: "c" });
  stores.topicSessions.markDeleted("203");
  const cfg = { allowedGuildIds: [GUILD], personas: [], publicBaseUrl: undefined, inboxChannelId: undefined };
  const resolveChannel = createChannelResolver(cfg, stores.guildSettings, stores.topicSessions);
  return { db, stores, cfg, resolveChannel };
}

async function serve(t: TestContext, routes: ReturnType<typeof turnRoutes>, now: () => Date): Promise<WebServer> {
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

async function setup(t: TestContext) {
  const { stores, cfg, resolveChannel } = prepare(t);
  const clock = { now: NOW };
  const handler = new FakeTurns();
  const logs: string[] = [];
  const now = () => clock.now;
  const routes = turnRoutes({
    cfg,
    guildSettings: stores.guildSettings,
    topicSessions: stores.topicSessions,
    resolveChannel,
    handler,
    now,
    log: (line) => logs.push(line),
  });
  const server = await serve(t, routes, now);
  return { server, handler, clock, logs };
}

test("POST /messages: 本文が文字列でない・空白だけは 400 empty、1,901 字は 400 too_long（1,900 字は送る）。前後の空白は除いて送る", async (t) => {
  const { server, handler } = await setup(t);
  for (const body of [{}, { text: 1 }, { text: null }, { text: "  \n " }]) {
    assert.deepEqual(await call(server, "POST", "/api/channels/100/messages", body), { status: 400, json: { error: "empty" } }, JSON.stringify(body));
  }
  assert.deepEqual(await call(server, "POST", "/api/channels/100/messages", { text: "あ".repeat(WEB_MESSAGE_MAX_LENGTH + 1) }), {
    status: 400,
    json: { error: "too_long" },
  });
  assert.equal(handler.submits.length, 0);

  const ok = await call(server, "POST", "/api/channels/100/messages", { text: ` ${"あ".repeat(WEB_MESSAGE_MAX_LENGTH)}\n` });
  assert.equal(ok.status, 202);
  assert.deepEqual(handler.submits, [{ guildId: GUILD, channelId: "100", content: "あ".repeat(WEB_MESSAGE_MAX_LENGTH), at: NOW.toISOString() }]);
});

test("POST /messages: 受け付けるチャンネル（#inbox・#tasks・セッション）は 202 と turnId・投稿へのリンク。知らない・削除済みは 404 で submitText を呼ばない", async (t) => {
  const { server, handler, logs } = await setup(t);
  const results: Array<[string, Response]> = [];
  for (const id of ["100", "101", "200"]) results.push([id, await call(server, "POST", `/api/channels/${id}/messages`, { text: `本文 ${id}` })]);
  assert.deepEqual(results, [
    ["100", { status: 202, json: { turnId: 1, link: `https://discord.com/channels/${GUILD}/100/90001` } }],
    ["101", { status: 202, json: { turnId: 2, link: `https://discord.com/channels/${GUILD}/101/90002` } }],
    ["200", { status: 202, json: { turnId: 3, link: `https://discord.com/channels/${GUILD}/200/90003` } }],
  ]);
  for (const id of ["203", "999"]) {
    assert.deepEqual(await call(server, "POST", `/api/channels/${id}/messages`, { text: "本文" }), { status: 404, json: { error: "not_found" } }, id);
  }
  assert.equal(handler.submits.length, 3);
  // log は種類とサーバーだけ（本文・チャンネル ID は出さない）
  assert.deepEqual(logs, [
    `Web から inbox に送りました（guild=${GUILD}）`,
    `Web から tasks に送りました（guild=${GUILD}）`,
    `Web から session に送りました（guild=${GUILD}）`,
  ]);
});

test("POST /messages: submitText の結果で not_accepted 404・bot_disconnected 503・echo_failed 502。失敗した本文はすぐ送り直せる", async (t) => {
  const { server, handler, logs } = await setup(t);
  handler.next = [{ result: "not_accepted" }, { result: "bot_disconnected" }, { result: "echo_failed" }];
  assert.deepEqual(await call(server, "POST", "/api/channels/100/messages", { text: "a" }), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await call(server, "POST", "/api/channels/100/messages", { text: "a" }), { status: 503, json: { error: "bot_disconnected" } });
  assert.deepEqual(await call(server, "POST", "/api/channels/100/messages", { text: "a" }), { status: 502, json: { error: "echo_failed" } });
  assert.equal((await call(server, "POST", "/api/channels/100/messages", { text: "a" })).status, 202);
  assert.equal(handler.submits.length, 4);
  assert.equal(logs.length, 1);
});

test("POST /messages: 同じチャンネル・同じ本文が 5 秒以内なら送らずに前回の turnId・link で 202。5 秒後・別の本文・別のチャンネルは送る", async (t) => {
  const { server, handler, clock } = await setup(t);
  const first = await call(server, "POST", "/api/channels/100/messages", { text: "はい" });
  clock.now = new Date(NOW.getTime() + WEB_DUPLICATE_WINDOW_MS - 1);
  const second = await call(server, "POST", "/api/channels/100/messages", { text: " はい " });
  assert.equal(first.status, 202);
  assert.deepEqual(second, first);
  assert.equal(handler.submits.length, 1);

  assert.equal((await call(server, "POST", "/api/channels/101/messages", { text: "はい" })).json.turnId, 2);
  assert.equal((await call(server, "POST", "/api/channels/100/messages", { text: "いいえ" })).json.turnId, 3);
  clock.now = new Date(NOW.getTime() + 2 * WEB_DUPLICATE_WINDOW_MS);
  assert.equal((await call(server, "POST", "/api/channels/100/messages", { text: "いいえ" })).json.turnId, 4);
  assert.equal(handler.submits.length, 4);
});

test("POST /messages: 1 回目の処理中に同じ本文が来たら、送らずに 1 回目の結果を待って同じものを返す", async (t) => {
  const { server, handler } = await setup(t);
  let release!: () => void;
  handler.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = call(server, "POST", "/api/channels/100/messages", { text: "はい" });
  const second = call(server, "POST", "/api/channels/100/messages", { text: "はい" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 202);
  assert.deepEqual(b, a);
  assert.equal(handler.submits.length, 1);
});

test("POST /messages: CSRF の 3 条件を通らなければ 403 で送らない", async (t) => {
  const { server, handler } = await setup(t);
  const { "x-self-agent": _marker, ...withoutMarker } = POST_HEADERS;
  assert.equal((await call(server, "POST", "/api/channels/100/messages", { text: "a" }, withoutMarker)).status, 403);
  assert.equal((await call(server, "POST", "/api/channels/100/messages", { text: "a" }, { ...POST_HEADERS, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal(handler.submits.length, 0);
});

test("GET /api/running: runningTurns に経過時間（elapsedMs）を足して返す", async (t) => {
  const { server, handler } = await setup(t);
  assert.deepEqual(await call(server, "GET", "/api/running"), { status: 200, json: { turns: [] } });
  handler.running = [
    {
      guildId: GUILD,
      channelId: "200",
      turnSeq: 7,
      startedAt: new Date(NOW.getTime() - 65_000).toISOString(),
      toolCalls: 2,
      label: "読んでいます",
      steps: ["書いています", "読んでいます"],
      source: "web",
      abortable: true,
    },
  ];
  const { status, json } = await call(server, "GET", "/api/running");
  assert.equal(status, 200);
  assert.deepEqual(json.turns, [{ ...handler.running[0], elapsedMs: 65_000 }]);
});

test("POST /turns/<seq>/abort: abortTurn が true なら 200、false なら 409 stale", async (t) => {
  const { server, handler } = await setup(t);
  assert.deepEqual(await call(server, "POST", "/api/channels/200/turns/1759363920001/abort", {}), { status: 200, json: { aborted: true } });
  handler.abortResult = false;
  assert.deepEqual(await call(server, "POST", "/api/channels/200/turns/5/abort", {}), { status: 409, json: { error: "stale" } });
  assert.deepEqual(handler.aborts, [
    ["200", 1759363920001],
    ["200", 5],
  ]);
});

test("POST /continue: セッションだけ 202 で continueTurn を呼ぶ。実行中なら 409 running、入口・削除済み・知らないチャンネルは 404", async (t) => {
  const { server, handler } = await setup(t);
  for (const id of ["100", "101", "203", "999"]) {
    assert.deepEqual(await call(server, "POST", `/api/channels/${id}/continue`, {}), { status: 404, json: { error: "not_found" } }, id);
  }
  handler.running = [
    { guildId: GUILD, channelId: "200", turnSeq: 1, startedAt: NOW.toISOString(), toolCalls: 0, label: undefined, steps: [], source: "discord", abortable: true },
  ];
  assert.deepEqual(await call(server, "POST", "/api/channels/200/continue", {}), { status: 409, json: { error: "running" } });
  handler.running = [];
  assert.deepEqual(await call(server, "POST", "/api/channels/200/continue", {}), { status: 202, json: { accepted: true } });
  assert.deepEqual(handler.continues, [{ guildId: GUILD, channelId: "200", at: NOW.toISOString() }]);
});

test("POST /messages（本物の handler）: 持ち主の Bot で echo を投稿し、owner の行の message_id と返事の返信先がその ID。5 秒以内の同じ本文は echo 1 回で同じ turnId", async (t) => {
  const { stores, cfg, resolveChannel } = prepare(t);
  const gateway = new FakeGateway({ allow: ["send", "sendMessage", "editMessage", "startTyping"], messageIdPrefix: "5000" });
  const runner = new FakeRunner([
    { ok: true, text: "登録しました", sessionId: "session-1", usage: turnUsage(10, 0, 0), durationMs: 1000, toolCalls: 0, contextTokens: 10 },
  ]);
  const logs: string[] = [];
  const handler = createHandler({
    cfg: { ...cfg, ownerUserId: "owner-1", timeZone: "Asia/Tokyo" },
    resolveChannel,
    gateway,
    runner,
    ...stores,
    channelOps: new RecordingChannelOps(),
    queue: new KeyedSerialQueue(2),
    now: () => NOW,
    history: stores.history,
    ownerConnected: () => true,
    log: (line) => logs.push(line),
  });
  const routes = turnRoutes({ cfg, guildSettings: stores.guildSettings, topicSessions: stores.topicSessions, resolveChannel, handler, now: () => NOW, log: (line) => logs.push(line) });
  const server = await serve(t, routes, () => NOW);

  const first = await call(server, "POST", "/api/channels/100/messages", { text: "牛乳を買う" });
  const second = await call(server, "POST", "/api/channels/100/messages", { text: "牛乳を買う" });
  for (let i = 0; i < 50 && gateway.sent.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));

  const owner = stores.history.list("100", { limit: 10 })[0]!;
  assert.deepEqual(first, { status: 202, json: { turnId: owner.id, link: `https://discord.com/channels/${GUILD}/100/50001` } });
  assert.deepEqual(second, first);
  assert.deepEqual(
    gateway.posts.map((post) => post.message),
    [{ text: `${WEB_ECHO_PREFIX}\n牛乳を買う` }],
  );
  assert.equal(owner.messageId, "50001");
  assert.equal(owner.source, "web");
  assert.deepEqual(gateway.sent, [{ channelId: "100", text: "登録しました", replyToId: "50001" }]);
  assert.equal(runner.inputs.length, 1);
  assert.ok(logs.every((line) => !line.includes("牛乳を買う") && !line.includes("100")), logs.join("\n"));
});
