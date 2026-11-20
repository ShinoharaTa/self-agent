// 取り込みの Web の入口（src/web/routes/cc-takeover.ts）。本体は作り物（check・propose・confirm・cancel を記録する）で、
// 行は一時 SQLite の本物の CcTakeoverStore。本物の本体を通す端から端は test/cc-takeover.test.ts
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { CC_TAKE_STALE_REPLY } from "../src/app/commands/cc-take.ts";
import type { CcTakeover, CcTakeoverCheck, CcTakeoverConfirmResult, CcTakeoverProposeResult } from "../src/cc/takeover.ts";
import { takeoverFailureText, takeoverReasonText } from "../src/cc/takeover-rules.ts";
import { CcTakeoverStore, type CcTakeoverPropose } from "../src/store/cc-takeovers.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { ccTakeoverRoutes, TAKEOVER_WEB_STALE_TEXT } from "../src/web/routes/cc-takeover.ts";
import { createWebServer, type Route, type WebServer } from "../src/web/server.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const BASE = Date.parse("2026-11-20T05:00:00.000Z");
const LOGIN = "owner@example.com";
const S1 = "11111111-1111-4111-8111-111111111111";

async function serve(t: TestContext, routes: Route[]): Promise<WebServer> {
  const server = createWebServer({
    host: "127.0.0.1",
    port: 0,
    allowedLogin: LOGIN,
    staticDir: tempDir(t),
    templateSiteDir: tempDir(t),
    routes,
    stopping: () => false,
    now: () => new Date(BASE),
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());
  return server;
}

function send(
  server: WebServer,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address()!.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

function getJson(server: WebServer, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return send(server, "GET", path, { "tailscale-user-login": LOGIN });
}

function postJson(server: WebServer, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return send(server, "POST", path, { "tailscale-user-login": LOGIN, "sec-fetch-site": "same-origin", "x-self-agent": "1", "content-type": "application/json" });
}

const IDLE: CcTakeoverCheck = {
  takeable: true,
  reason: undefined,
  state: "idle",
  title: "題<b>&",
  project: "alpha",
  at: BASE - 60_000,
  bridgeSessionId: undefined,
  last: undefined,
};

/** 作り物の本体（呼ばれた順を記録する）。cancel は本物のストアの確認待ちを取り消す */
class FakeTakeover implements Pick<CcTakeover, "check" | "propose" | "confirm" | "cancel"> {
  readonly calls: string[] = [];
  readonly proposed: Array<Parameters<CcTakeover["propose"]>[0]> = [];
  checkResult: CcTakeoverCheck = IDLE;
  proposeResult: CcTakeoverProposeResult = {
    ok: true,
    id: 0,
    message: { text: "「題\\<b>&」（alpha）を取り込みます。" },
    plainText: "「題<b>&」（alpha）を取り込みます。",
  };
  confirmResult: CcTakeoverConfirmResult = { ok: true, channelId: "dest-1", text: "取り込みました → <#dest-1>", plainText: "完了の文 <b>", edited: false };
  private readonly store: CcTakeoverStore;

  constructor(store: CcTakeoverStore) {
    this.store = store;
  }

  async check(sessionId: string): Promise<CcTakeoverCheck> {
    this.calls.push(`check:${sessionId}`);
    return this.checkResult;
  }

  async propose(input: Parameters<CcTakeover["propose"]>[0]): Promise<CcTakeoverProposeResult> {
    this.calls.push(`propose:${input.sessionId}`);
    this.proposed.push(input);
    return this.proposeResult;
  }

  async confirm(id: number): Promise<CcTakeoverConfirmResult> {
    this.calls.push(`confirm:${id}`);
    return this.confirmResult;
  }

  cancel(id: number): boolean {
    this.calls.push(`cancel:${id}`);
    return this.store.cancel(id);
  }
}

function setup(t: TestContext, options: { wired?: boolean; setUp?: boolean } = {}) {
  const db = tempDb(t);
  const now = (): Date => new Date(BASE);
  const takeovers = new CcTakeoverStore(db, now);
  const guildSettings = new GuildSettingsStore(db, now);
  if (options.setUp !== false) guildSettings.setChannel("guild-2", "homeCategoryId", "home-2");
  const fake = new FakeTakeover(takeovers);
  const routes = ccTakeoverRoutes({
    takeover: () => (options.wired === false ? undefined : fake),
    takeovers,
    // /setup 済みなのは 2 つ目だけ（最初の /setup 済みのサーバーを選ぶ）
    cfg: { allowedGuildIds: ["guild-1", "guild-2"] },
    guildSettings,
  });
  const row = (overrides: Partial<CcTakeoverPropose> = {}) =>
    takeovers.propose({
      sessionId: S1,
      source: "alive",
      project: "alpha",
      guildId: "guild-2",
      entry: "web",
      permissionMode: "default",
      terminalMode: null,
      ...overrides,
    })!;
  return { db, takeovers, fake, routes, row };
}

test("Web の取り込み: 配線が無ければ 4 つとも 404", async (t) => {
  const s = setup(t, { wired: false });
  const server = await serve(t, s.routes);
  const id = s.row().id;
  for (const response of [
    await getJson(server, `/api/cc/sessions/${S1}/takeover`),
    await postJson(server, `/api/cc/sessions/${S1}/takeover`),
    await postJson(server, `/api/cc/takeovers/${id}/confirm`),
    await postJson(server, `/api/cc/takeovers/${id}/cancel`),
  ]) {
    assert.equal(response.status, 404);
    assert.deepEqual(response.json, { error: "not_found" });
  }
  assert.equal(s.takeovers.get(id)?.state, "awaiting_confirm");
});

test("Web の取り込み: Tailscale-User-Login が無ければ 401、X-Self-Agent が無い POST は 403", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  const id = s.row().id;
  assert.equal((await send(server, "GET", `/api/cc/sessions/${S1}/takeover`, {})).status, 401);
  assert.equal((await send(server, "POST", `/api/cc/sessions/${S1}/takeover`, { "sec-fetch-site": "same-origin", "x-self-agent": "1", "content-type": "application/json" })).status, 401);
  for (const path of [`/api/cc/sessions/${S1}/takeover`, `/api/cc/takeovers/${id}/confirm`, `/api/cc/takeovers/${id}/cancel`]) {
    const response = await send(server, "POST", path, { "tailscale-user-login": LOGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" });
    assert.equal(response.status, 403, path);
    assert.deepEqual(response.json, { error: "csrf" }, path);
  }
  assert.deepEqual(s.fake.calls, []);
});

test("Web の取り込み: 形の違う session_id は GET も POST も 404 で、本体を呼ばない", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  for (const bad of ["not-a-uuid", "11111111-1111-4111-8111-11111111111", "..", "%2e%2e", "11111111-1111-4111-8111-111111111111x"]) {
    const read = await getJson(server, `/api/cc/sessions/${bad}/takeover`);
    assert.equal(read.status, 404, bad);
    assert.deepEqual(read.json, { error: "not_found" }, bad);
    const made = await postJson(server, `/api/cc/sessions/${bad}/takeover`);
    assert.equal(made.status, 404, bad);
    assert.deepEqual(made.json, { error: "not_found" }, bad);
  }
  assert.deepEqual(s.fake.calls, []);
});

test("Web の取り込み: GET は判定と事実を返す（取り込める・実行中・判断待ち・理由つき・終わった）", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  const read = await getJson(server, `/api/cc/sessions/${S1}/takeover`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, {
    takeable: true,
    state: "idle",
    reason: null,
    text: null,
    title: "題<b>&",
    project: "alpha",
    activityAt: new Date(BASE - 60_000).toISOString(),
    rcUrl: null,
    last: null,
  });
  for (const [state, reason] of [
    ["running", "busy"],
    ["waiting", "waiting"],
    ["idle", "not_in_tmux"],
  ] as const) {
    s.fake.checkResult = { ...IDLE, takeable: false, reason, state, project: undefined };
    const refused = await getJson(server, `/api/cc/sessions/${S1}/takeover`);
    assert.equal(refused.status, 200, reason);
    assert.equal(refused.json.takeable, false, reason);
    assert.equal(refused.json.state, state, reason);
    assert.equal(refused.json.reason, reason, reason);
    // 理由だけの文（頭の「取り込めませんでした: 」は付けない）
    assert.equal(refused.json.text, takeoverReasonText(reason), reason);
    assert.equal(refused.json.project, null, reason);
  }
  s.fake.checkResult = { ...IDLE, state: "ended", at: undefined };
  const ended = await getJson(server, `/api/cc/sessions/${S1}/takeover`);
  assert.equal(ended.json.state, "ended");
  assert.equal(ended.json.takeable, true);
  assert.equal(ended.json.activityAt, null);
  assert.deepEqual(s.fake.calls, Array.from({ length: 5 }, () => `check:${S1}`));
});

test("Web の取り込み: GET の rcUrl は bridgeSessionId が在るときだけ、last の id は done で行き先が在るときだけ", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  s.fake.checkResult = { ...IDLE, bridgeSessionId: "bridge-1", last: { id: 7, state: "done", targetChannelId: "dest-9" } };
  const done = await getJson(server, `/api/cc/sessions/${S1}/takeover`);
  assert.equal(done.json.rcUrl, "https://claude.ai/code/bridge-1");
  assert.deepEqual(done.json.last, { takeover: 7, state: "done", id: "ch:dest-9" });
  for (const last of [
    { id: 8, state: "failed", targetChannelId: "dest-9" },
    { id: 9, state: "running", targetChannelId: "dest-9" },
    { id: 10, state: "done", targetChannelId: null },
    { id: 11, state: "cancelled", targetChannelId: null },
  ] as const) {
    s.fake.checkResult = { ...IDLE, last };
    const read = await getJson(server, `/api/cc/sessions/${S1}/takeover`);
    assert.equal(read.json.rcUrl, null, String(last.id));
    assert.deepEqual(read.json.last, { takeover: last.id, state: last.state, id: null }, String(last.id));
  }
});

test("Web の取り込み: GET は propose・confirm・cancel を呼ばない", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  // Web の確認待ちが残っていても、読むだけでは取り消さない
  const row = s.row();
  await getJson(server, `/api/cc/sessions/${S1}/takeover`);
  await getJson(server, `/api/cc/sessions/${S1}/takeover`);
  assert.deepEqual(s.fake.calls, [`check:${S1}`, `check:${S1}`]);
  assert.equal(s.takeovers.get(row.id)?.state, "awaiting_confirm");
});

test("Web の取り込み: POST /takeover は entry web・confirmChannelId 無しで propose を呼び、201 と番号・エスケープ前の文", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  s.fake.proposeResult = { ...s.fake.proposeResult, id: 12 } as CcTakeoverProposeResult;
  const made = await postJson(server, `/api/cc/sessions/${S1}/takeover`);
  assert.equal(made.status, 201);
  assert.deepEqual(made.json, { id: 12, text: "「題<b>&」（alpha）を取り込みます。" });
  // 行き先は /setup 済みの最初のサーバー。Discord のボタン（message）は返さない
  assert.deepEqual(s.fake.proposed, [{ sessionId: S1, entry: "web", guildId: "guild-2" }]);
  assert.ok(!("confirmChannelId" in s.fake.proposed[0]!));
  assert.deepEqual(s.fake.calls, [`propose:${S1}`]);
});

test("Web の取り込み: サーバーの設定が無ければ 409 not_set_up で propose を呼ばない", async (t) => {
  const s = setup(t, { setUp: false });
  const server = await serve(t, s.routes);
  const made = await postJson(server, `/api/cc/sessions/${S1}/takeover`);
  assert.equal(made.status, 409);
  assert.deepEqual(made.json, { error: "not_set_up" });
  assert.deepEqual(s.fake.calls, []);
});

test("Web の取り込み: 断られたら 409 と符号・断りの文", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  for (const reason of ["busy", "in_progress", "already_taken", "not_ready"] as const) {
    s.fake.proposeResult = { ok: false, reason, text: takeoverFailureText(reason, false) };
    const made = await postJson(server, `/api/cc/sessions/${S1}/takeover`);
    assert.equal(made.status, 409, reason);
    assert.deepEqual(made.json, { error: reason, text: takeoverFailureText(reason, false) }, reason);
  }
});

test("Web の取り込み: Web の確認待ちが残っていれば取り消してから新しい確認を作る", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  const old = s.row();
  const made = await postJson(server, `/api/cc/sessions/${S1}/takeover`);
  assert.equal(made.status, 201);
  assert.deepEqual(s.fake.calls, [`cancel:${old.id}`, `propose:${S1}`]);
  assert.equal(s.takeovers.get(old.id)?.state, "cancelled");
});

test("Web の取り込み: Discord の確認待ち・実行中の行は取り消さない", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  const discord = s.row({ entry: "discord", confirmChannelId: "confirm-1" });
  s.fake.proposeResult = { ok: false, reason: "in_progress", text: takeoverFailureText("in_progress", false) };
  const first = await postJson(server, `/api/cc/sessions/${S1}/takeover`);
  assert.equal(first.status, 409);
  assert.equal(first.json.error, "in_progress");
  assert.equal(s.takeovers.get(discord.id)?.state, "awaiting_confirm");
  assert.ok(s.takeovers.cancel(discord.id));
  // Web の行でも実行中なら取り消さない
  const running = s.row();
  assert.ok(s.takeovers.start(running.id));
  const second = await postJson(server, `/api/cc/sessions/${S1}/takeover`);
  assert.equal(second.status, 409);
  assert.equal(s.takeovers.get(running.id)?.state, "running");
  assert.deepEqual(s.fake.calls, [`propose:${S1}`, `propose:${S1}`]);
});

test("Web の取り込み: /confirm の成功は 200 と id が ch:<channelId>・完了の文", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  const row = s.row();
  const confirmed = await postJson(server, `/api/cc/takeovers/${row.id}/confirm`);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmed.json, { ok: true, id: "ch:dest-1", text: "完了の文 <b>" });
  assert.deepEqual(s.fake.calls, [`confirm:${row.id}`]);
});

test("Web の取り込み: /confirm の期限切れ・失敗は 409 と reason・文", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  const row = s.row();
  const results: Array<[CcTakeoverConfirmResult, Record<string, unknown>]> = [
    [
      { ok: false, reason: "expired", text: "期限切れ", plainText: "期限切れ（Web）", edited: false },
      { error: "expired", text: "期限切れ（Web）" },
    ],
    [
      { ok: false, reason: "busy", text: "断り", plainText: takeoverFailureText("busy", false), edited: false },
      { error: "busy", text: takeoverFailureText("busy", false) },
    ],
    [
      { ok: false, reason: "copy_failed", text: "断り", plainText: takeoverFailureText("copy_failed", true), edited: false },
      { error: "copy_failed", text: takeoverFailureText("copy_failed", true) },
    ],
    [{ ok: false, reason: "stale" }, { error: "stale", text: TAKEOVER_WEB_STALE_TEXT }],
  ];
  for (const [result, json] of results) {
    s.fake.confirmResult = result;
    const confirmed = await postJson(server, `/api/cc/takeovers/${row.id}/confirm`);
    assert.equal(confirmed.status, 409, String(json.error));
    assert.deepEqual(confirmed.json, json, String(json.error));
  }
});

test("Web の取り込み: 番号が数字でなければ 400、無い番号は 404", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  for (const action of ["confirm", "cancel"]) {
    for (const bad of ["abc", "-1", "1.5", "1e3", "0x1", "1234567890123456"]) {
      const response = await postJson(server, `/api/cc/takeovers/${bad}/${action}`);
      assert.equal(response.status, 400, `${action} ${bad}`);
      assert.deepEqual(response.json, { error: "bad_request" }, `${action} ${bad}`);
    }
    const missing = await postJson(server, `/api/cc/takeovers/999/${action}`);
    assert.equal(missing.status, 404, action);
    assert.deepEqual(missing.json, { error: "not_found" }, action);
  }
  assert.deepEqual(s.fake.calls, []);
});

test("Web の取り込み: Discord の行の /confirm・/cancel は 409 stale で本体を呼ばない", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  const discord = s.row({ entry: "discord", confirmChannelId: "confirm-1" });
  for (const action of ["confirm", "cancel"]) {
    const response = await postJson(server, `/api/cc/takeovers/${discord.id}/${action}`);
    assert.equal(response.status, 409, action);
    assert.deepEqual(response.json, { error: "stale", text: TAKEOVER_WEB_STALE_TEXT }, action);
  }
  assert.deepEqual(s.fake.calls, []);
  assert.equal(s.takeovers.get(discord.id)?.state, "awaiting_confirm");
});

test("Web の取り込み: /cancel は 200、もう確認待ちでなければ 409 stale", async (t) => {
  const s = setup(t);
  const server = await serve(t, s.routes);
  const row = s.row();
  const first = await postJson(server, `/api/cc/takeovers/${row.id}/cancel`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { ok: true });
  assert.equal(s.takeovers.get(row.id)?.state, "cancelled");
  const second = await postJson(server, `/api/cc/takeovers/${row.id}/cancel`);
  assert.equal(second.status, 409);
  assert.deepEqual(second.json, { error: "stale", text: TAKEOVER_WEB_STALE_TEXT });
  assert.deepEqual(s.fake.calls, [`cancel:${row.id}`, `cancel:${row.id}`]);
});

test("Web の取り込み: 使えない確認の文は Discord の入口の文と同じ", () => {
  assert.equal(TAKEOVER_WEB_STALE_TEXT, CC_TAKE_STALE_REPLY);
});

test("見張り: web/routes/cc-takeover.ts は cc/channels.ts・sender.ts・replies.ts・starter.ts・web/routes/cc.ts・app/commands/ を import しない", () => {
  const source = readFileSync(new URL("../src/web/routes/cc-takeover.ts", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]!);
  assert.ok(specifiers.includes("../../cc/takeover-rules.ts"));
  for (const forbidden of ["../../cc/channels.ts", "../../cc/sender.ts", "../../cc/replies.ts", "../../cc/starter.ts", "./cc.ts"]) {
    assert.ok(!specifiers.includes(forbidden), forbidden);
  }
  for (const name of ["channels.ts", "sender.ts", "replies.ts", "starter.ts"]) {
    assert.ok(!specifiers.some((specifier) => specifier.endsWith(`/cc/${name}`)), name);
  }
  assert.ok(!specifiers.some((specifier) => specifier.endsWith("/routes/cc.ts") || specifier === "./cc.ts"));
  assert.ok(!specifiers.some((specifier) => specifier.includes("/app/commands/")));
});

test("見張り: main.ts は ccTakeoverRoutes を Web のルートに入れている", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(source, /\nimport \{ ccTakeoverRoutes \} from "\.\/web\/routes\/cc-takeover\.ts";\n/);
  // createWebServer({ … routes: [ … ] }) の中（本体は遅く読む getter で渡す）
  const start = source.indexOf("webServer = createWebServer({");
  const routes = source.indexOf("routes: [", start);
  const end = source.indexOf("\n    ],\n", routes);
  assert.ok(start >= 0 && routes > start && end > routes);
  const list = source.slice(routes, end);
  assert.match(list, /\n {6}\.\.\.ccTakeoverRoutes\(\{ takeover: \(\) => ccTakeover, takeovers: ccTakeovers, cfg: config, guildSettings \}\),\n/);
});
