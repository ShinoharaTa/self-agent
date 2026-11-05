// CC14: Claude Code のチャンネルを Web の会話のタブで見る（docs/plan/claude-code-channels.md §5.2）。
// /api/channels の kind cc・/turns・POST /messages（submitWeb）・/abort・/continue の 404・POST /api/cc/channels/<id>/close・webChannelNamer
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AgentRunner } from "../src/agent/runner.ts";
import { createChannelResolver } from "../src/app/access.ts";
import type { Handler, RunningTurn } from "../src/app/handler.ts";
import { PersonaRouter } from "../src/app/personas.ts";
import type { CcCloseResult, CcSubmitWebResult } from "../src/cc/channels.ts";
import type { CcSessionView } from "../src/cc/registry.ts";
import type { Gateway } from "../src/discord/gateway.ts";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { ccChannelDescriber, ccRoutes } from "../src/web/routes/cc.ts";
import { channelRoutes, webChannelLookup, webChannelNamer } from "../src/web/routes/channels.ts";
import { turnRoutes } from "../src/web/routes/turns.ts";
import { createWebServer, type WebServer } from "../src/web/server.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";

const LOGIN = "owner@example.com";
const NOW = new Date("2026-11-05T00:12:00Z");
const GUILD = "111";
const GUILD_NOT_SET_UP = "222";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const POST_HEADERS = {
  "tailscale-user-login": LOGIN,
  "sec-fetch-site": "same-origin",
  "x-self-agent": "1",
  "content-type": "application/json",
};

type Response = { status: number; json: Record<string, unknown> };

function call(server: WebServer, method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
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
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function view(sessionId: string, overrides: Partial<CcSessionView> = {}): CcSessionView {
  return { sessionId, pid: 100, name: "alpha", cwd: "/home/owner/workspace/alpha", tmux: "/tmp/tmux-1000/default,1,0", state: "running", ...overrides } as CcSessionView;
}

/**
 * /setup 済みのサーバー: #inbox 100。Claude Code のチャンネル: 300（S1・open）・301（S2・ended）・302（S3・deleted）・303（/setup 前のサーバー）。
 * 一覧には S1 と S2 が居る（S2 のチャンネルは閉じている）
 */
async function setup(t: TestContext) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { guildSettings, topicSessions, projects, history } = stores;
  guildSettings.setChannel(GUILD, "inboxChannelId", "100");
  const ccStore = new CcChannelStore(db, () => NOW);
  const sends = new CcSendStore(db, () => NOW);
  const permissions = new CcPermissionStore(db, () => NOW);
  ccStore.create({ channelId: "300", guildId: GUILD, sessionId: S1, name: "cc-alpha", cwd: "/home/owner/workspace/alpha", origin: "web" });
  ccStore.create({ channelId: "301", guildId: GUILD, sessionId: S2, name: "cc-beta", cwd: "/home/owner/workspace/beta", origin: "web_send" });
  ccStore.setState("301", "ended");
  ccStore.create({ channelId: "302", guildId: GUILD, sessionId: S3, name: "cc-gone", cwd: null, origin: "web" });
  ccStore.markDeleted("302");
  ccStore.create({ channelId: "303", guildId: GUILD_NOT_SET_UP, sessionId: "44444444-4444-4444-8444-444444444444", name: "cc-other", cwd: null, origin: "web" });
  const sessions = [view(S1), view(S2, { name: "beta", state: "idle" })];
  const registry = { snapshot: () => ({ sessions, stale: false, unreadable: false, fetchedAt: NOW.getTime() }), touch: () => undefined };
  const cfg = { allowedGuildIds: [GUILD, GUILD_NOT_SET_UP], personas: [], publicBaseUrl: undefined, inboxChannelId: undefined };
  const resolveChannel = createChannelResolver(cfg, guildSettings, topicSessions);
  const personas = new PersonaRouter({
    personas: [{ id: "default", name: "default", engine: "claude", runner: {} as AgentRunner, gateway: {} as Gateway, connected: () => true }],
    guildSettings,
    topicSessions,
  });
  const describe = ccChannelDescriber({
    registry,
    workspaceDir: "/home/owner/workspace",
    home: "/home/owner",
    sends,
    permissions: { store: permissions, holdSec: 300 },
    now: () => NOW,
  });
  // Web の会話の入力欄からの送信（submitWeb）と閉じる（close）は偽物
  const submits: Array<{ channelId: string; text: string }> = [];
  const nextSubmit: CcSubmitWebResult[] = [];
  const closes: string[] = [];
  const closedPosts: Array<{ channelId: string; text: string }> = [];
  const nextClose: CcCloseResult[] = [];
  const handlerCalls = { submits: [] as string[], aborts: [] as string[], continues: [] as string[] };
  const handler: Pick<Handler, "submitText" | "runningTurns" | "abortTurn" | "continueTurn"> = {
    submitText: async (input) => {
      handlerCalls.submits.push(input.channelId);
      return { result: "accepted", turnId: 1, messageId: "m" };
    },
    runningTurns: (): RunningTurn[] => [],
    abortTurn: (channelId) => {
      handlerCalls.aborts.push(channelId);
      return true;
    },
    continueTurn: async (_guildId, channelId) => {
      handlerCalls.continues.push(channelId);
    },
  };
  const logs: string[] = [];
  const channels = {
    async submitWeb(channelId: string, text: string): Promise<CcSubmitWebResult> {
      submits.push({ channelId, text });
      return nextSubmit.shift() ?? { ok: true, sendId: submits.length, channelId, messageId: `mirror-${submits.length}` };
    },
  };
  const ccChannelsFake = {
    openChannel: async () => ({ ok: false as const, reason: "not_found" as const }),
    channelOf: () => undefined,
    defaultGuild: () => GUILD,
    close: (channelId: string): CcCloseResult => {
      closes.push(channelId);
      return nextClose.shift() ?? { result: "closed", cancelled: 0 };
    },
    postClosed: (channelId: string, text: string) => {
      closedPosts.push({ channelId, text });
    },
  };
  const routes = [
    ...channelRoutes({ cfg, guildSettings, topicSessions, projects, history, personas, resolveChannel, cc: { store: ccStore, describe } }),
    ...turnRoutes({
      cfg,
      guildSettings,
      topicSessions,
      resolveChannel,
      handler,
      cc: { store: ccStore, channels },
      now: () => NOW,
      log: (line) => logs.push(line),
    }),
    ...ccRoutes({
      registry,
      panes: undefined,
      tmux: undefined,
      workspaceDir: "/home/owner/workspace",
      home: "/home/owner",
      channels: { store: ccChannelsFake, allowedGuildIds: cfg.allowedGuildIds },
    }),
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
  return { server, cfg, resolveChannel, ccStore, sends, history, guildSettings, topicSessions, handler: handlerCalls, submits, nextSubmit, closes, closedPosts, nextClose, logs };
}

test("/api/channels: 削除されていない Claude Code のチャンネル（/setup 済みのサーバー）を kind cc で、名前はセッション名・cc の今を付ける", async (t) => {
  const env = await setup(t);
  const agentId = env.history.add({ guildId: GUILD, channelId: "300", kind: "agent", source: "system", text: "返事", outcome: "done" });
  const send = env.sends.add({ sessionId: S1, text: "本文", origin: "web", state: "queued", channelId: "300" });
  const { status, json } = await call(env.server, "GET", "/api/channels");
  assert.equal(status, 200);
  const channels = json.channels as Array<Record<string, unknown>>;
  assert.deepEqual(
    channels.map((c) => [c.id, c.kind, c.name, c.title, c.persona, c.state]),
    [
      ["100", "inbox", "inbox", null, "default", null],
      ["300", "cc", "alpha", null, "default", null],
      ["301", "cc", "cc-beta", null, "default", null],
    ],
  );
  const open = channels[1]!;
  assert.deepEqual(open.last, { id: agentId, at: NOW.toISOString(), kind: "agent" });
  assert.equal(open.link, `https://discord.com/channels/${GUILD}/300`);
  assert.deepEqual(open.cc, {
    sessionId: S1,
    state: "running",
    cwdLabel: "alpha",
    inTmux: true,
    permission: null,
    pending: { id: send.id, state: "queued", lastPaneState: null, replyState: null, updatedAt: NOW.toISOString() },
  });
  // 閉じたチャンネルは、セッションが一覧に居ても ended（名前はチャンネル名）
  assert.equal((channels[2]!.cc as Record<string, unknown>).state, "ended");
  // 入口・セッションの行には cc が無い
  assert.equal("cc" in channels[0]!, false);
});

test("/api/channels/<id>/turns: Claude Code のチャンネルは owner → agent の順。削除済み・/setup 前のサーバーは 404", async (t) => {
  const env = await setup(t);
  env.history.add({ guildId: GUILD, channelId: "300", kind: "owner", source: "web", text: "Web から", messageId: "mirror-1" });
  env.history.add({ guildId: GUILD, channelId: "300", kind: "agent", source: "system", text: "返事", outcome: "done" });
  env.history.add({ guildId: GUILD, channelId: "300", kind: "notice", source: "system", text: "セッションが終わりました" });
  const { status, json } = await call(env.server, "GET", "/api/channels/300/turns");
  assert.equal(status, 200);
  assert.deepEqual(
    (json.turns as Array<Record<string, unknown>>).map((row) => [row.kind, row.source, row.text, row.link]),
    [
      ["owner", "web", "Web から", `https://discord.com/channels/${GUILD}/300/mirror-1`],
      ["agent", "system", "返事", `https://discord.com/channels/${GUILD}/300`],
      ["notice", "system", "セッションが終わりました", `https://discord.com/channels/${GUILD}/300`],
    ],
  );
  const channel = json.channel as Record<string, unknown>;
  assert.equal(channel.kind, "cc");
  assert.equal(channel.closeDraft, null);
  assert.equal((await call(env.server, "GET", "/api/channels/302/turns")).status, 404);
  assert.equal((await call(env.server, "GET", "/api/channels/303/turns")).status, 404);
});

test("POST /messages（cc）: submitWeb で積んで 202 と sendId・写しへのリンク。ターンにはしない。終わった・起動中は 409、積めなければ /send と同じ状態", async (t) => {
  const env = await setup(t);
  const res = await call(env.server, "POST", "/api/channels/300/messages", { text: "  届けて  " });
  assert.deepEqual(res, { status: 202, json: { sendId: 1, link: `https://discord.com/channels/${GUILD}/300/mirror-1` } });
  assert.deepEqual(env.submits, [{ channelId: "300", text: "届けて" }]);
  assert.deepEqual(env.handler.submits, []);
  assert.deepEqual(env.logs, [`Web から Claude Code のチャンネルに送りました（guild=${GUILD}、#1）`]);
  // 写しを出せなければリンクはチャンネル
  env.nextSubmit.push({ ok: true, sendId: 7, channelId: "300", messageId: null });
  assert.deepEqual(await call(env.server, "POST", "/api/channels/300/messages", { text: "2" }), {
    status: 202,
    json: { sendId: 7, link: `https://discord.com/channels/${GUILD}/300` },
  });
  for (const [reason, status, error] of [
    ["ended", 409, "ended"],
    ["resuming", 409, "resuming"],
    ["already_queued", 409, "already_queued"],
    ["not_in_tmux", 409, "not_in_tmux"],
    ["invalid_text", 400, "invalid_text"],
    ["stopped", 503, "stopping"],
    ["not_channel", 404, "not_found"],
  ] as const) {
    env.nextSubmit.push({ ok: false, reason });
    assert.deepEqual(await call(env.server, "POST", "/api/channels/300/messages", { text: `本文 ${reason}` }), { status, json: { error } }, reason);
  }
  // 削除済み・/setup 前のサーバーは submitWeb を呼ばない
  const before = env.submits.length;
  assert.equal((await call(env.server, "POST", "/api/channels/302/messages", { text: "x" })).status, 404);
  assert.equal((await call(env.server, "POST", "/api/channels/303/messages", { text: "x" })).status, 404);
  assert.equal(env.submits.length, before);
  // log に本文・チャンネル ID は出さない
  for (const line of env.logs) assert.doesNotMatch(line, /300|届けて|本文/);
});

test("POST /turns/<seq>/abort・/continue: Claude Code のチャンネルは SDK のターンが無いので 404 で handler を呼ばない", async (t) => {
  const env = await setup(t);
  assert.deepEqual(await call(env.server, "POST", "/api/channels/300/turns/1/abort", {}), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await call(env.server, "POST", "/api/channels/300/continue", {}), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(env.handler.aborts, []);
  assert.deepEqual(env.handler.continues, []);
});

test("POST /api/cc/channels/<id>/close: /cc close と同じ close で 200、結果の文をチャンネルに投稿する。cc でなければ 404、閉じている・起動中は 409", async (t) => {
  const env = await setup(t);
  env.nextClose.push({ result: "closed", cancelled: 2 });
  assert.deepEqual(await call(env.server, "POST", "/api/cc/channels/300/close", {}), { status: 200, json: { state: "ended", cancelled: 2 } });
  assert.equal(env.closedPosts.length, 1);
  assert.equal(env.closedPosts[0]!.channelId, "300");
  assert.match(env.closedPosts[0]!.text, /^閉じました。ここに書くと起動して続けられます\n/);
  env.nextClose.push({ result: "not_channel" }, { result: "ended" }, { result: "resuming" });
  assert.deepEqual(await call(env.server, "POST", "/api/cc/channels/999/close", {}), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await call(env.server, "POST", "/api/cc/channels/301/close", {}), { status: 409, json: { error: "ended" } });
  assert.deepEqual(await call(env.server, "POST", "/api/cc/channels/300/close", {}), { status: 409, json: { error: "resuming" } });
  assert.equal(env.closedPosts.length, 1);
  assert.deepEqual(env.closes, ["300", "999", "301", "300"]);
});

test("webChannelLookup・webChannelNamer: ccChannels を渡したときだけ cc（/setup 済みのサーバーの削除されていない行）。名前は #<チャンネル名>", async (t) => {
  const env = await setup(t);
  const base = { cfg: env.cfg, resolveChannel: env.resolveChannel, guildSettings: env.guildSettings, topicSessions: env.topicSessions };
  const lookup = webChannelLookup({ ...base, ccChannels: env.ccStore });
  assert.deepEqual(lookup("300"), { guildId: GUILD, kind: "cc" });
  assert.deepEqual(lookup("301"), { guildId: GUILD, kind: "cc" });
  assert.equal(lookup("302"), undefined);
  assert.equal(lookup("303"), undefined);
  assert.equal(webChannelLookup(base)("300"), undefined);
  const namer = webChannelNamer({ ...base, ccChannels: env.ccStore });
  assert.equal(namer("300"), "#cc-alpha");
  assert.equal(namer("100"), "#inbox");
  assert.equal(namer("302"), null);
});
