import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AgentEntry, AgentsResult } from "../src/cc/agents.ts";
import type { SessionFileInfo } from "../src/cc/claude-dirs.ts";
import { parseHookEvent } from "../src/cc/hook-server.ts";
import { CcPermissionHold } from "../src/cc/permission-hold.ts";
import { CcPaneResolver } from "../src/cc/panes.ts";
import { CcRegistry } from "../src/cc/registry.ts";
import { CC_SEND_MAX_CHARS, CcSender } from "../src/cc/sender.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { createTmux, PANE_FORMAT, type RunCommand, type RunResult } from "../src/tmux/tmux.ts";
import { cwdLabel } from "../src/cc/labels.ts";
import { CC_SCREEN_LINES, ccRoutes, ccStatus, screenText } from "../src/web/routes/cc.ts";
import { createWebServer, type Route, type WebServer } from "../src/web/server.ts";
import { tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { CcChannels } from "../src/cc/channels.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";

const LOGIN = "owner@example.com";
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const TMUX = "/usr/bin/tmux";
const HOME = "/home/owner";
const WORKSPACE = "/home/owner/workspace";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const S4 = "44444444-4444-4444-8444-444444444444";

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

function postJson(server: WebServer, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.address()!.port,
        method: "POST",
        path,
        headers: { "tailscale-user-login": LOGIN, "sec-fetch-site": "same-origin", "x-self-agent": "1", "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function agent(sessionId: string, overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    pid: 500,
    sessionId,
    cwd: `${WORKSPACE}/alpha`,
    name: "alpha",
    kind: "interactive",
    startedAt: BASE - 3_600_000,
    status: "idle",
    waitingFor: undefined,
    ...overrides,
  };
}

/** list-panes の 1 行（PANE_FORMAT の順） */
function paneLine(paneId: string, panePid: number, session = "work"): string {
  return [session, "0", paneId.slice(1), paneId, "1", "1", WORKSPACE, "claude", "0", "0", String(panePid)].join("\t");
}

const sgr = (params: string): string => `\u001b[${params}m`;

/**
 * 本物の CcRegistry（偽の claude agents --json・一時 SQLite）と、偽の tmux（list-panes・capture-pane）。
 * pid 500 → 400（%1 の pane_pid）、pid 600 → 410（%2）、pid 700 は tmux の外
 */
async function setup(
  t: TestContext,
  opts: { agents?: AgentEntry[]; files?: Record<string, SessionFileInfo>; parentTable?: Record<number, number> } = {},
) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const store = new CcSessionStore(db, now);
  let next: AgentsResult = {
    ok: true,
    agents: opts.agents ?? [
      agent(S1, { pid: 500, name: "alpha", status: "idle" }),
      agent(S2, { pid: 600, name: "beta", status: "busy", cwd: `${WORKSPACE}/beta/sub` }),
      agent(S3, { pid: 700, name: "gamma", status: "idle", cwd: "/home/owner/other" }),
      agent(S4, { pid: 800, name: undefined, status: "waiting", waitingFor: "permission prompt", cwd: "/srv/x" }),
    ],
    dropped: 0,
  };
  const files = new Map<string, SessionFileInfo>(Object.entries(opts.files ?? { [S1]: { bridgeSessionId: "session_abc123", tmux: "work:0.%1" } }));
  let touches = 0;
  const registry = new CcRegistry({
    cfg: { ccPollSec: 10 },
    agents: { list: async () => next },
    dirs: { sessionFile: (_pid, sessionId) => files.get(sessionId), transcriptLastAt: () => undefined },
    store,
    now,
    timers: { after: () => () => undefined },
    log: () => undefined,
  });
  const touch = registry.touch.bind(registry);
  registry.touch = () => {
    touches++;
    touch();
  };
  await registry.tick();

  const tmuxState: { panes: RunResult; capture: RunResult } = {
    panes: { code: 0, stdout: [paneLine("%1", 400), paneLine("%2", 410)].join("\n"), stderr: "" },
    capture: { code: 0, stdout: "", stderr: "" },
  };
  const calls: string[][] = [];
  const run: RunCommand = async (_file, args) => {
    calls.push([...args]);
    if (args[0] === "list-panes") return tmuxState.panes;
    if (args[0] === "capture-pane") return tmuxState.capture;
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const tmux = createTmux({ tmuxPath: TMUX, run });
  const parentTable: Record<number, number> = { 500: 400, 600: 410, 700: 1, 800: 1, ...opts.parentTable };
  const panes = new CcPaneResolver({ tmux, parentOf: (pid) => parentTable[pid] });
  // 送信（CC3）。capture-pane が空の画面（入力欄が無い = no_prompt）なので、積んだものは queued のまま
  const sends = new CcSendStore(db, now);
  const sender = new CcSender({
    cfg: { ccSendWaitMin: 120, allowedGuildIds: [] },
    registry,
    panes,
    tmux,
    sends,
    sessions: store,
    now,
    sleep: async () => undefined,
    timers: { after: () => () => undefined },
    log: () => undefined,
  });
  const server = await serve(t, ccRoutes({ registry, panes, tmux, workspaceDir: WORKSPACE, home: HOME, sender, sends, follows: store, now }));
  return {
    db,
    server,
    store,
    registry,
    panes,
    tmux,
    sender,
    sends,
    tmuxState,
    calls,
    clock,
    touches: () => touches,
    setAgents: (agents: AgentEntry[] | null) => {
      next = agents === null ? { ok: false, reason: "json" } : { ok: true, agents, dropped: 0 };
    },
  };
}

test("/api/cc/*: SELF_AGENT_CC が無効（registry が無い）なら一覧も 1 件も送信も 404", async (t) => {
  const server = await serve(t, ccRoutes({ registry: undefined, panes: undefined, tmux: undefined, workspaceDir: WORKSPACE, home: HOME }));
  for (const path of ["/api/cc/sessions", `/api/cc/sessions/${S1}`, "/api/cc/other", "/api/cc/permissions"]) {
    const { status, json } = await getJson(server, path);
    assert.equal(status, 404, path);
    assert.deepEqual(json, { error: "not_found" });
  }
  for (const path of [`/api/cc/sessions/${S1}/send`, "/api/cc/sends/1/cancel", "/api/cc/permissions/1/allow", "/api/cc/permissions/1/deny"]) {
    const { status, json } = await postJson(server, path, { text: "x" });
    assert.equal(status, 404, path);
    assert.deepEqual(json, { error: "not_found" });
  }
});

test("POST /api/cc/sessions/<id>/send: 本文の検証（CR・ESC・TAB は 400、4,001 字は 400、空は 400）・404・tmux の外は 409・サーバーが無ければ 503", async (t) => {
  const { server, sends, tmuxState } = await setup(t);
  const send = (id: string, body: unknown) => postJson(server, `/api/cc/sessions/${id}/send`, body);
  for (const text of ["a\rb", "a\x1b[2Jb", "a\tb"]) assert.deepEqual(await send(S1, { text }), { status: 400, json: { error: "invalid_text" } });
  assert.deepEqual(await send(S1, { text: "字".repeat(CC_SEND_MAX_CHARS + 1) }), { status: 400, json: { error: "too_long" } });
  for (const body of [{ text: "" }, { text: "\n\n" }, {}, { text: 1 }]) assert.deepEqual(await send(S1, body), { status: 400, json: { error: "empty" } });
  assert.deepEqual(await send("55555555-5555-4555-8555-555555555555", { text: "x" }), { status: 404, json: { error: "not_found" } });
  assert.equal((await send("not-a-uuid", { text: "x" })).status, 404);
  assert.deepEqual(await send(S3, { text: "x" }), { status: 409, json: { error: "not_in_tmux" } });
  tmuxState.panes = { code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/default\n" };
  assert.deepEqual(await send(S1, { text: "x" }), { status: 503, json: { error: "no_server" } });
  assert.equal(sends.countActive(), 0);
});

test("POST /api/cc/sessions/<id>/send: 202 で積み、一覧の pending に出る。同じ本文は 5 秒以内なら同じ sendId、別の本文は 409。/cancel で取り消す", async (t) => {
  const { server, sender, sends, clock } = await setup(t);
  const text = "1 行目\n2 行目\n\n4 行目";
  const first = await postJson(server, `/api/cc/sessions/${S1}/send`, { text: `${text}\n` });
  assert.equal(first.status, 202);
  const sendId = first.json.sendId as number;
  assert.deepEqual(first.json, { sendId, state: "queued" });
  await sender.idle();
  // 末尾の改行は落として DB に残す
  assert.equal(sends.get(sendId)?.text, text);
  assert.deepEqual(await postJson(server, `/api/cc/sessions/${S1}/send`, { text }), { status: 202, json: { sendId, state: "queued" } });
  assert.deepEqual(await postJson(server, `/api/cc/sessions/${S1}/send`, { text: "別" }), { status: 409, json: { error: "already_queued" } });
  const list = await getJson(server, "/api/cc/sessions");
  const s1 = (list.json.sessions as Array<Record<string, unknown>>).find((s) => s.sessionId === S1)!;
  // 最後に見たペインの状態（この偽の tmux は list-clients を知らないので failed のまま積んでいる）
  assert.deepEqual(s1.pending, { id: sendId, state: "queued", lastPaneState: "failed", replyState: null, updatedAt: new Date(clock.now).toISOString() });
  const one = await getJson(server, `/api/cc/sessions/${S1}`);
  assert.deepEqual((one.json.pending as Record<string, unknown>).id, sendId);

  assert.deepEqual(await postJson(server, `/api/cc/sends/${sendId}/cancel`, {}), { status: 200, json: { state: "cancelled" } });
  assert.deepEqual(await postJson(server, `/api/cc/sends/${sendId}/cancel`, {}), { status: 409, json: { error: "stale" } });
  assert.deepEqual(await postJson(server, "/api/cc/sends/999/cancel", {}), { status: 404, json: { error: "not_found" } });
  // 終わった送信は CC_SEND_RECENT_MS（10 分）の間だけ一覧に出す
  clock.now += 10 * 60_000 + 1;
  const later = await getJson(server, "/api/cc/sessions");
  assert.equal((later.json.sessions as Array<Record<string, unknown>>).find((s) => s.sessionId === S1)!.pending, null);
});

test("/api/cc/sessions: 判断待ち → 実行中 → 待機の順で、ペイン・RC のリンク（bridgeSessionId があるときだけ）・ディレクトリの表示を返し、touch する", async (t) => {
  const { server, touches, calls } = await setup(t);
  const { status, json } = await getJson(server, "/api/cc/sessions");
  assert.equal(status, 200);
  assert.equal(json.stale, false);
  assert.equal(json.unreadable, false);
  assert.equal(json.fetchedAt, new Date(BASE).toISOString());
  const sessions = json.sessions as Array<Record<string, unknown>>;
  assert.deepEqual(
    sessions.map((s) => [s.sessionId, s.state]),
    [
      [S4, "needs_input"],
      [S2, "running"],
      [S1, "idle"],
      [S3, "idle"],
    ],
  );
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  assert.deepEqual(byId.get(S1), {
    sessionId: S1,
    name: "alpha",
    cwdLabel: "alpha",
    permissionMode: null,
    state: "idle",
    waitingFor: null,
    since: new Date(BASE - 3_600_000).toISOString(),
    lastPromptAt: null,
    lastPromptText: null,
    inTmux: true,
    paneLabel: "work:0.1",
    rcUrl: "https://claude.ai/code/session_abc123",
    startedBy: "owner",
    trustPending: false,
    pending: null,
    permission: null,
    follow: null,
    channel: null,
  });
  assert.equal(byId.get(S2)!.paneLabel, "work:0.2");
  assert.equal(byId.get(S2)!.cwdLabel, "beta/sub");
  assert.equal(byId.get(S2)!.inTmux, true);
  // bridgeSessionId が無ければ RC のリンクは無い。tmux の外
  assert.equal(byId.get(S3)!.rcUrl, null);
  assert.equal(byId.get(S3)!.inTmux, false);
  assert.equal(byId.get(S3)!.paneLabel, null);
  assert.equal(byId.get(S3)!.cwdLabel, "~/other");
  assert.equal(byId.get(S4)!.name, null);
  // 判断待ちの理由（waitingFor）は waiting のときだけ
  assert.equal(byId.get(S4)!.state, "needs_input");
  assert.equal(byId.get(S4)!.waitingFor, "permission prompt");
  assert.equal(byId.get(S4)!.cwdLabel, "/srv/x");
  assert.equal(touches(), 1);
  // 一覧では画面を撮らない（list-panes を 1 回だけ）
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["list-panes"],
  );
  assert.deepEqual(calls[0], ["list-panes", "-a", "-F", PANE_FORMAT]);
});

test("/api/cc/sessions: 最後の指示（hook）と判断待ちの始まりで並び、読めなければ stale、5 回で unreadable の空", async (t) => {
  const { server, registry, clock, setAgents } = await setup(t);
  clock.now = BASE + 60_000;
  const event = parseHookEvent({ hook_event_name: "UserPromptSubmit", session_id: S3, prompt: "テストを直して", permission_mode: "auto" }, new Date(clock.now));
  assert.ok(event);
  registry.receive(event);
  const first = await getJson(server, "/api/cc/sessions");
  const sessions = first.json.sessions as Array<Record<string, unknown>>;
  // 待機の中では最後の指示の新しい順（S3 が S1 より先）
  assert.deepEqual(
    sessions.map((s) => s.sessionId),
    [S4, S2, S3, S1],
  );
  const s3 = sessions.find((s) => s.sessionId === S3)!;
  assert.equal(s3.lastPromptText, "テストを直して");
  assert.equal(s3.lastPromptAt, new Date(BASE + 60_000).toISOString());
  assert.equal(s3.since, new Date(BASE + 60_000).toISOString());
  assert.equal(s3.permissionMode, "auto");

  setAgents(null);
  await registry.tick();
  const stale = await getJson(server, "/api/cc/sessions");
  assert.equal(stale.json.stale, true);
  assert.equal(stale.json.unreadable, false);
  assert.equal((stale.json.sessions as unknown[]).length, 4);
  for (let i = 0; i < 4; i++) await registry.tick();
  const empty = await getJson(server, "/api/cc/sessions");
  assert.equal(empty.json.unreadable, true);
  assert.deepEqual(empty.json.sessions, []);
});

test("/api/cc/sessions: ほかのセッションの中で起動した claude（入れ子）は、外のセッションのペインに結びつけない", async (t) => {
  // S2（pid 600）の pane_pid は 410。S5 の claude（pid 650）は S2 の claude の子
  const S5 = "55555555-5555-4555-8555-555555555555";
  const { server } = await setup(t, {
    agents: [agent(S2, { pid: 600, status: "busy" }), agent(S5, { pid: 650, name: "inner" })],
    parentTable: { 650: 600 },
  });
  const sessions = (await getJson(server, "/api/cc/sessions")).json.sessions as Array<Record<string, unknown>>;
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  assert.equal(byId.get(S2)!.paneLabel, "work:0.2");
  assert.equal(byId.get(S5)!.inTmux, false);
});

test("/api/cc/sessions: tmux のサーバーが無ければ、どれも tmux の外（一覧は出る）", async (t) => {
  const { server, tmuxState } = await setup(t);
  tmuxState.panes = { code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/default\n" };
  const { status, json } = await getJson(server, "/api/cc/sessions");
  assert.equal(status, 200);
  const sessions = json.sessions as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 4);
  assert.ok(sessions.every((s) => s.inTmux === false && s.paneLabel === null));
});

test("/api/cc/sessions/<id>: 画面は capture-pane -S -200 を stripAnsi し、末尾の空行を除いた最後の 200 行", async (t) => {
  const { server, tmuxState, calls, touches } = await setup(t);
  const lines = Array.from({ length: 260 }, (_, i) => `${sgr("2")}line ${i}${sgr("")}\u001b]8;;https://example.invalid\u0007${i}\u001b]8;;\u0007`);
  tmuxState.capture = { code: 0, stdout: `${lines.join("\n")}\n\n   \n`, stderr: "" };
  const { status, json } = await getJson(server, `/api/cc/sessions/${S1}`);
  assert.equal(status, 200);
  assert.equal(json.sessionId, S1);
  assert.equal(json.inTmux, true);
  assert.equal(json.paneLabel, "work:0.1");
  assert.equal(json.rcUrl, "https://claude.ai/code/session_abc123");
  const screen = json.screen as string;
  const shown = screen.split("\n");
  assert.equal(shown.length, CC_SCREEN_LINES);
  assert.equal(shown[0], "line 6060");
  assert.equal(shown[shown.length - 1], "line 259259");
  assert.doesNotMatch(screen, /\u001b/);
  // 写しは SGR なし（-e を付けない）で履歴から撮る
  assert.deepEqual(calls[calls.length - 1], ["capture-pane", "-p", "-S", `-${CC_SCREEN_LINES}`, "-t", "%1"]);
  assert.equal(touches(), 1);
});

test("/api/cc/sessions/<id>: tmux の外は screen: null で capture-pane を呼ばない。撮れなければ null", async (t) => {
  const { server, tmuxState, calls } = await setup(t);
  const outside = await getJson(server, `/api/cc/sessions/${S3}`);
  assert.equal(outside.status, 200);
  assert.equal(outside.json.inTmux, false);
  assert.equal(outside.json.screen, null);
  assert.ok(!calls.some((args) => args[0] === "capture-pane"));

  tmuxState.capture = { code: 1, stdout: "", stderr: "can't find pane: %2\n" };
  const gone = await getJson(server, `/api/cc/sessions/${S2}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.json.screen, null);

  tmuxState.panes = { code: 1, stdout: "", stderr: "no server running\n" };
  const noServer = await getJson(server, `/api/cc/sessions/${S1}`);
  assert.equal(noServer.json.inTmux, false);
  assert.equal(noServer.json.screen, null);
});

test("/api/cc/sessions/<id>: UUID でない・一覧に無い id は 404", async (t) => {
  const { server } = await setup(t);
  for (const id of ["not-a-uuid", "55555555-5555-4555-8555-555555555555", encodeURIComponent("../sessions")]) {
    const { status, json } = await getJson(server, `/api/cc/sessions/${id}`);
    assert.equal(status, 404, id);
    assert.deepEqual(json, { error: "not_found" });
  }
});

test("cwdLabel: ~/workspace の中は相対、その外の ~ の中は ~/…、それ以外はそのまま", () => {
  assert.equal(cwdLabel(`${WORKSPACE}/alpha`, WORKSPACE, HOME), "alpha");
  assert.equal(cwdLabel(`${WORKSPACE}/alpha/b`, `${WORKSPACE}/`, HOME), "alpha/b");
  assert.equal(cwdLabel(WORKSPACE, WORKSPACE, HOME), "~/workspace");
  assert.equal(cwdLabel(`${WORKSPACE}-other/x`, WORKSPACE, HOME), "~/workspace-other/x");
  assert.equal(cwdLabel(HOME, WORKSPACE, HOME), "~");
  assert.equal(cwdLabel("/srv/x", WORKSPACE, HOME), "/srv/x");
  assert.equal(cwdLabel(undefined, WORKSPACE, HOME), null);
  assert.equal(cwdLabel("", WORKSPACE, HOME), null);
});

test("screenText: 制御シーケンスを落とし、末尾の空行を除く", () => {
  assert.equal(screenText(`${sgr("1")}a${sgr("")}\nb\n\n  \n`), "a\nb");
  assert.equal(screenText(""), "");
});

test("ccStatus: hook の受け口・tmux（直近の lookup の ok / no_server / failed。まだなら null）・複数行・保留中の許可（CC2 は 0）。list-panes は起動しない", async (t) => {
  const db = tempDb(t);
  const store = new CcSessionStore(db);
  const results: RunResult[] = [
    { code: 0, stdout: "", stderr: "" },
    { code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/default\n" },
    { code: 1, stdout: "", stderr: "something else\n" },
  ];
  let runs = 0;
  const tmux = createTmux({
    tmuxPath: TMUX,
    run: async () => {
      runs++;
      return results.shift()!;
    },
  });
  const panes = new CcPaneResolver({ tmux, parentOf: () => undefined });
  let listening = true;
  const deps = { panes, hookListening: () => listening, store };
  assert.deepEqual(ccStatus(deps), { enabled: true, hookPort: true, tmux: null, multilineOk: true, pendingPermissions: 0, unifyReady: false });
  assert.equal(runs, 0);
  await panes.lookup(new Set());
  assert.deepEqual(ccStatus(deps), { enabled: true, hookPort: true, tmux: "ok", multilineOk: true, pendingPermissions: 0, unifyReady: false });
  listening = false;
  db.exec("UPDATE cc_state SET multiline_ok = 0");
  await panes.lookup(new Set());
  assert.deepEqual(ccStatus(deps), { enabled: true, hookPort: false, tmux: "no_server", multilineOk: false, pendingPermissions: 0, unifyReady: false });
  // プロジェクトのセッションの共有の link（U1b）
  assert.equal(ccStatus({ ...deps, unifyReady: () => true }).unifyReady, true);
  await panes.lookup(new Set());
  assert.equal(ccStatus(deps).tmux, "failed");
  ccStatus(deps);
  assert.equal(runs, 3);
});

/**
 * 許可の要求（CC5a）: 本物の CcRegistry（偽の一覧）・CcPermissionHold（偽のタイマー）・一時 SQLite に、HTTP を通さず要求を保留させる
 */
async function permissionSetup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const sessions = new CcSessionStore(db, now);
  const store = new CcPermissionStore(db, now);
  const timers: Array<() => void> = [];
  let registry!: CcRegistry;
  const hold = new CcPermissionHold({
    cfg: { ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 },
    store,
    known: (id) => registry.knows(id),
    now,
    timers: {
      after: (fn) => {
        timers.push(fn);
        return () => undefined;
      },
    },
    log: () => undefined,
  });
  registry = new CcRegistry({
    cfg: { ccPollSec: 10 },
    agents: { list: async () => ({ ok: true, agents: [agent(S1, { pid: 700, status: "waiting" }), agent(S2, { pid: 800 })], dropped: 0 }) },
    dirs: { sessionFile: () => undefined, transcriptLastAt: () => undefined },
    store: sessions,
    now,
    timers: { after: () => () => undefined },
    permissions: hold,
    log: () => undefined,
  });
  await registry.tick();
  /** 答えた後の口（CC11。チャンネルを作る） */
  const answered: number[] = [];
  const server = await serve(
    t,
    ccRoutes({
      registry,
      panes: undefined,
      tmux: undefined,
      workspaceDir: WORKSPACE,
      home: HOME,
      permissions: { hold, store, holdSec: 300, questionHoldSec: 900, answered: (id) => void answered.push(id) },
      now,
    }),
  );
  const ask = (sessionId: string, command: string, suggestions: unknown[] = []) => {
    const event = parseHookEvent(
      {
        hook_event_name: "PermissionRequest",
        session_id: sessionId,
        cwd: `${WORKSPACE}/alpha`,
        permission_mode: "default",
        tool_name: "Bash",
        tool_input: { command },
        permission_suggestions: suggestions,
      },
      now(),
      { workspaceDir: WORKSPACE },
    )!;
    registry.receive(event);
    return hold.request(event, new AbortController().signal);
  };
  return { db, clock, store, hold, registry, server, ask, timers, sessions, answered };
}

test("GET /api/cc/permissions: 保留中の要求（id・sessionId・toolName・summary・alwaysRule: null・alwaysNote: null・requestHash・expiresAt）。一覧の permission と status", async (t) => {
  const s = await permissionSetup(t);
  const reply = s.ask(S1, "npm test");
  const pending = s.store.pendingFor(S1)!;
  const { status, json } = await getJson(s.server, "/api/cc/permissions");
  assert.equal(status, 200);
  assert.deepEqual(json, {
    permissions: [
      {
        id: pending.id,
        sessionId: S1,
        state: "pending",
        via: null,
        toolName: "Bash",
        summary: "npm test",
        alwaysRule: null,
        alwaysNote: null,
        requestHash: pending.requestHash,
        permissionMode: "default",
        createdAt: new Date(BASE).toISOString(),
        expiresAt: new Date(BASE + 300_000).toISOString(),
        resolvedAt: null,
        question: null,
      },
    ],
  });
  // 一覧と 1 件の permission。保留中のセッションは判断待ち
  const list = await getJson(s.server, "/api/cc/sessions");
  const sessions = list.json.sessions as Array<Record<string, unknown>>;
  const one = sessions.find((session) => session.sessionId === S1)!;
  assert.equal(one.state, "needs_input");
  assert.equal((one.permission as Record<string, unknown>).id, pending.id);
  assert.equal(sessions.find((session) => session.sessionId === S2)!.permission, null);
  const detail = await getJson(s.server, `/api/cc/sessions/${S1}`);
  assert.equal((detail.json.permission as Record<string, unknown>).state, "pending");
  // /api/status の pendingPermissions
  const panes = new CcPaneResolver({ tmux: createTmux({ tmuxPath: TMUX, run: async () => ({ code: 0, stdout: "", stderr: "" }) }), parentOf: () => undefined });
  assert.equal(ccStatus({ panes, hookListening: () => true, store: s.sessions, permissions: s.store }).pendingPermissions, 1);
  s.hold.answer(pending.id, "deny", "web");
  await reply;
  assert.equal(ccStatus({ panes, hookListening: () => true, store: s.sessions, permissions: s.store }).pendingPermissions, 0);
});

test("Q1: 質問の行の permission.question と expiresAt（質問の長さ）。POST /api/cc/permissions/<id>/answer は 400 / 404 / 409 / 200、質問の /allow は 409・/deny は「断りました」", async (t) => {
  const s = await permissionSetup(t);
  const input = {
    questions: [
      { question: "色は？", header: "Color", options: [{ label: "red", description: "赤" }, { label: "blue", description: "青" }], multiSelect: false },
      { question: "部品は？", header: "Parts", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: true },
    ],
  };
  const askQuestion = () => {
    const event = parseHookEvent(
      { hook_event_name: "PermissionRequest", session_id: S1, cwd: `${WORKSPACE}/alpha`, permission_mode: "default", tool_name: "AskUserQuestion", tool_input: input },
      new Date(s.clock.now),
    )!;
    s.registry.receive(event);
    return s.hold.request(event, new AbortController().signal);
  };
  const reply = askQuestion();
  const pending = s.store.pendingFor(S1)!;
  const listed = (await getJson(s.server, "/api/cc/permissions")).json.permissions as Array<Record<string, unknown>>;
  assert.equal(listed[0]!.summary, "質問 2 問: 色は？");
  assert.equal(listed[0]!.expiresAt, new Date(BASE + 900_000).toISOString());
  assert.deepEqual(listed[0]!.question, {
    questions: [
      { question: "色は？", header: "Color", options: [{ label: "red", description: "赤" }, { label: "blue", description: "青" }], multiSelect: false },
      { question: "部品は？", header: "Parts", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: true },
    ],
    answers: null,
  });
  const url = `/api/cc/permissions/${pending.id}/answer`;
  // 形の違い・問に合わない答えは 400
  for (const body of [
    { answers: [{ labels: ["red"] }, { labels: ["a"] }] },
    { requestHash: pending.requestHash },
    { requestHash: pending.requestHash, answers: "red" },
    { requestHash: pending.requestHash, answers: [{ labels: ["red"], other: "x" }, { labels: ["a"] }] },
    { requestHash: pending.requestHash, answers: [{ labels: ["red"] }] },
    { requestHash: pending.requestHash, answers: [{ labels: ["green"] }, { labels: ["a"] }] },
    { requestHash: pending.requestHash, answers: [{ labels: ["red", "blue"] }, { labels: ["a"] }] },
  ]) {
    const result = await postJson(s.server, url, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.deepEqual(result.json, { error: "bad_request" });
  }
  // 無い id は 404、hash 違いは 409、質問の /allow は 409
  const answers = [{ labels: ["blue"] }, { labels: ["b", "a"] }];
  assert.equal((await postJson(s.server, `/api/cc/permissions/${pending.id + 9}/answer`, { requestHash: pending.requestHash, answers })).status, 404);
  assert.deepEqual((await postJson(s.server, url, { requestHash: "0".repeat(64), answers })).json, { error: "stale" });
  assert.equal((await postJson(s.server, `/api/cc/permissions/${pending.id}/allow`, { requestHash: pending.requestHash })).status, 409);
  assert.equal(s.store.get(pending.id)?.state, "pending");
  assert.deepEqual(s.answered, []);
  const ok = await postJson(s.server, url, { requestHash: pending.requestHash, answers });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { state: "allowed" });
  assert.deepEqual(s.answered, [pending.id]);
  const decision = JSON.parse((await reply)!).hookSpecificOutput.decision;
  assert.deepEqual(decision, { behavior: "allow", updatedInput: { ...input, answers: { "色は？": "blue", "部品は？": "a, b" } } });
  // 終わった質問は answers を出し、期限は null。2 回目は 409
  const detail = (await getJson(s.server, `/api/cc/sessions/${S1}`)).json.permission as Record<string, unknown>;
  assert.deepEqual((detail.question as Record<string, unknown>).answers, { "色は？": "blue", "部品は？": "a, b" });
  assert.equal(detail.expiresAt, null);
  assert.equal((await postJson(s.server, url, { requestHash: pending.requestHash, answers })).status, 409);
  // 質問でない行の /answer は 409
  const bash = s.ask(S1, "npm test");
  const row = s.store.pendingFor(S1)!;
  assert.deepEqual((await postJson(s.server, `/api/cc/permissions/${row.id}/answer`, { requestHash: row.requestHash, answers })).json, { error: "stale" });
  s.hold.answer(row.id, "deny", "web");
  await bash;
  // 質問の [答えない] は /deny（message は「断りました」）
  const second = askQuestion();
  const next = s.store.pendingFor(S1)!;
  assert.deepEqual((await postJson(s.server, `/api/cc/permissions/${next.id}/deny`, { requestHash: next.requestHash })).json, { state: "denied" });
  assert.equal(JSON.parse((await second)!).hookSpecificOutput.decision.message, "self-agent（Discord / Web）から断りました");
});

test("POST /api/cc/permissions/<id>/allow|deny: 200 { state }・応答の本文。2 回目・時間切れ・request_hash が違えば 409 stale、無い id は 404", async (t) => {
  const s = await permissionSetup(t);
  const reply = s.ask(S1, "npm test");
  const pending = s.store.pendingFor(S1)!;
  // request_hash が違う
  const wrong = await postJson(s.server, `/api/cc/permissions/${pending.id}/allow`, { requestHash: "0".repeat(64) });
  assert.equal(wrong.status, 409);
  assert.deepEqual(wrong.json, { error: "stale" });
  // requestHash は必須（無い・文字列でなければ 400）
  assert.equal((await postJson(s.server, `/api/cc/permissions/${pending.id}/allow`, { requestHash: 1 })).status, 400);
  assert.equal((await postJson(s.server, `/api/cc/permissions/${pending.id}/allow`, {})).status, 400);
  assert.equal(s.store.get(pending.id)?.state, "pending");
  assert.equal((await postJson(s.server, `/api/cc/permissions/${pending.id + 9}/allow`, { requestHash: pending.requestHash })).status, 404);
  // 提案の無い要求の always は 409（常に許可のルールが無い）
  const always = await postJson(s.server, `/api/cc/permissions/${pending.id}/always`, { requestHash: pending.requestHash });
  assert.equal(always.status, 409);
  assert.deepEqual(always.json, { error: "stale" });
  assert.equal(s.store.get(pending.id)?.state, "pending");
  // 答えていない（断られた）うちはチャンネルを作る口を呼ばない（CC11）
  assert.deepEqual(s.answered, []);
  const ok = await postJson(s.server, `/api/cc/permissions/${pending.id}/allow`, { requestHash: pending.requestHash });
  assert.equal(ok.status, 200);
  assert.deepEqual(s.answered, [pending.id]);
  assert.deepEqual(ok.json, { state: "allowed" });
  assert.equal(JSON.parse((await reply)!).hookSpecificOutput.decision.behavior, "allow");
  const again = await postJson(s.server, `/api/cc/permissions/${pending.id}/deny`, { requestHash: pending.requestHash });
  assert.equal(again.status, 409);
  assert.deepEqual(s.answered, [pending.id]);
  // 終わった要求は一覧の permission に残る（カードの「許可しました（Web）」）
  const detail = await getJson(s.server, `/api/cc/sessions/${S1}`);
  assert.deepEqual(
    [(detail.json.permission as Record<string, unknown>).state, (detail.json.permission as Record<string, unknown>).via],
    ["allowed", "web"],
  );
  // 終わった要求の期限は null
  assert.equal((detail.json.permission as Record<string, unknown>).expiresAt, null);
  assert.deepEqual((await getJson(s.server, "/api/cc/permissions")).json, { permissions: [] });
  // 拒否
  const second = s.ask(S1, "touch x");
  const row = s.store.pendingFor(S1)!;
  const denied = await postJson(s.server, `/api/cc/permissions/${row.id}/deny`, { requestHash: row.requestHash });
  assert.deepEqual(denied.json, { state: "denied" });
  assert.equal(JSON.parse((await second)!).hookSpecificOutput.decision.behavior, "deny");
  // 時間切れの後
  const third = s.ask(S1, "touch y");
  const expired = s.store.pendingFor(S1)!;
  s.timers.at(-1)!();
  assert.equal(await third, undefined);
  assert.equal((await postJson(s.server, `/api/cc/permissions/${expired.id}/allow`, { requestHash: expired.requestHash })).status, 409);
});

test("POST /api/cc/permissions/<id>/always: 一覧に alwaysRule（Bash(npm test *)）と alwaysNote、200 { state: allowed_always } と session の updatedPermissions", async (t) => {
  const s = await permissionSetup(t);
  const reply = s.ask(S1, "npm test", [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test *" }], behavior: "allow", destination: "localSettings" },
  ]);
  const pending = s.store.pendingFor(S1)!;
  const listed = (await getJson(s.server, "/api/cc/permissions")).json.permissions as Array<Record<string, unknown>>;
  assert.equal(listed[0]!.alwaysRule, "Bash(npm test *)");
  assert.equal(listed[0]!.alwaysNote, "「npm test」で始まるコマンド");
  // request_hash が違えば 409
  assert.equal((await postJson(s.server, `/api/cc/permissions/${pending.id}/always`, { requestHash: "0".repeat(64) })).status, 409);
  const ok = await postJson(s.server, `/api/cc/permissions/${pending.id}/always`, { requestHash: pending.requestHash });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { state: "allowed_always" });
  const decision = JSON.parse((await reply)!).hookSpecificOutput.decision;
  assert.deepEqual(decision, {
    behavior: "allow",
    updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test *" }], behavior: "allow", destination: "session" }],
  });
  // 2 回目は 409。終わった要求の permission に常に許可したルールが残る
  assert.equal((await postJson(s.server, `/api/cc/permissions/${pending.id}/always`, { requestHash: pending.requestHash })).status, 409);
  const detail = (await getJson(s.server, `/api/cc/sessions/${S1}`)).json.permission as Record<string, unknown>;
  assert.deepEqual([detail.state, detail.via, detail.alwaysRule], ["allowed_always", "web", "Bash(npm test *)"]);
});

test("POST /api/cc/permissions/<id>/always: 危ないルールだけの提案は alwaysRule: null で 409", async (t) => {
  const s = await permissionSetup(t);
  const reply = s.ask(S1, "rm -rf build", [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm *" }], behavior: "allow", destination: "localSettings" },
  ]);
  const pending = s.store.pendingFor(S1)!;
  const listed = (await getJson(s.server, "/api/cc/permissions")).json.permissions as Array<Record<string, unknown>>;
  assert.equal(listed[0]!.alwaysRule, null);
  assert.equal(listed[0]!.alwaysNote, null);
  const always = await postJson(s.server, `/api/cc/permissions/${pending.id}/always`, { requestHash: pending.requestHash });
  assert.equal(always.status, 409);
  assert.deepEqual(always.json, { error: "stale" });
  // [許可] は押せる
  assert.equal((await postJson(s.server, `/api/cc/permissions/${pending.id}/allow`, { requestHash: pending.requestHash })).status, 200);
  assert.equal(JSON.parse((await reply)!).hookSpecificOutput.decision.updatedPermissions, undefined);
});

test("POST /api/cc/sessions/<id>/unfollow: 追いかけ中なら止めて 200、もう一度・追いかけていないなら 409、UUID でなければ 404。一覧の follow に出る（CC8）", async (t) => {
  const { server, store } = await setup(t);
  assert.ok(store.startFollow(S1, "channel-1"));
  const list = await getJson(server, "/api/cc/sessions");
  const byId = new Map((list.json.sessions as Array<Record<string, unknown>>).map((s) => [s.sessionId, s]));
  assert.deepEqual(byId.get(S1)!.follow, { since: new Date(BASE).toISOString() });
  assert.equal(byId.get(S2)!.follow, null);
  assert.deepEqual((await getJson(server, `/api/cc/sessions/${S1}`)).json.follow, { since: new Date(BASE).toISOString() });

  assert.deepEqual(await postJson(server, `/api/cc/sessions/${S1}/unfollow`, {}), { status: 200, json: { follow: null } });
  assert.equal(store.get(S1)?.follow, false);
  assert.deepEqual(await postJson(server, `/api/cc/sessions/${S1}/unfollow`, {}), { status: 409, json: { error: "stale" } });
  assert.deepEqual(await postJson(server, `/api/cc/sessions/${S2}/unfollow`, {}), { status: 409, json: { error: "stale" } });
  assert.equal((await postJson(server, "/api/cc/sessions/not-a-uuid/unfollow", {})).status, 404);
  assert.equal((await getJson(server, `/api/cc/sessions/${S1}`)).json.follow, null);
});

test("POST /api/cc/sessions/<id>/unfollow: 追いかけ（follows）を渡していなければ 404", async (t) => {
  const server = await serve(t, ccRoutes({ registry: undefined, panes: undefined, tmux: undefined, workspaceDir: WORKSPACE, home: HOME }));
  assert.equal((await postJson(server, `/api/cc/sessions/${S1}/unfollow`, {})).status, 404);
});

test("POST /api/cc/sessions/<id>/channel: 201 でチャンネルを作り一覧の channel に出る。2 回目は 409 exists、tmux の外は 409、50 は 409 full、カテゴリが無ければ 503、guildId が許可外は 400", async (t) => {
  const { db, registry, panes, tmux, clock } = await setup(t);
  const now = (): Date => new Date(clock.now);
  const guildSettings = new GuildSettingsStore(db, now);
  guildSettings.setChannel("guild-1", "homeCategoryId", "home-1");
  const gateway = new FakeGateway({ allow: ["createTextChannel", "channelExists", "countChannelsIn", "sendMessage"], channelIdPrefix: "chan-" });
  const channels = new CcChannels({
    cfg: { allowedGuildIds: ["guild-1", "guild-2"], workspaceDir: WORKSPACE, ownerUserId: "owner-1" },
    store: new CcChannelStore(db, now),
    sends: new CcSendStore(db, now),
    sender: () => undefined,
    guildSettings,
    registry,
    panes,
    gateway,
    queue: new KeyedSerialQueue(1),
    channelOps: new RecordingChannelOps(),
    home: HOME,
    now,
    log: () => undefined,
  });
  const server = await serve(
    t,
    ccRoutes({ registry, panes, tmux, workspaceDir: WORKSPACE, home: HOME, channels: { store: channels, allowedGuildIds: ["guild-1", "guild-2"] }, now }),
  );
  const open = (id: string, body: unknown = {}) => postJson(server, `/api/cc/sessions/${id}/channel`, body);
  // カテゴリ「Claude Code」がまだ無い
  assert.deepEqual(await open(S1), { status: 503, json: { error: "not_set_up" } });
  guildSettings.setCcCategory("guild-1", "cat-cc");
  gateway.alive.add("cat-cc");
  assert.deepEqual(await open(S1, { guildId: "guild-9" }), { status: 400, json: { error: "bad_request" } });
  assert.deepEqual(await open(S1, { guildId: 1 }), { status: 400, json: { error: "bad_request" } });
  assert.deepEqual(await open(S1, { guildId: "guild-2" }), { status: 503, json: { error: "not_set_up" } });
  assert.deepEqual(await open("55555555-5555-4555-8555-555555555555"), { status: 404, json: { error: "not_found" } });
  assert.equal((await open("not-a-uuid")).status, 404);
  assert.deepEqual(await open(S3), { status: 409, json: { error: "not_in_tmux" } });
  gateway.manual.set("cat-cc", 50);
  assert.deepEqual(await open(S1), { status: 409, json: { error: "full" } });
  gateway.manual.delete("cat-cc");
  const link = "https://discord.com/channels/guild-1/chan-1";
  assert.deepEqual(await open(S1, { guildId: "guild-1" }), { status: 201, json: { channelId: "chan-1", link } });
  assert.deepEqual(await open(S1), { status: 409, json: { error: "exists", channelId: "chan-1", link } });
  const list = await getJson(server, "/api/cc/sessions");
  const byId = new Map((list.json.sessions as Array<Record<string, unknown>>).map((s) => [s.sessionId, s]));
  assert.deepEqual(byId.get(S1)!.channel, { channelId: "chan-1", guildId: "guild-1", link, state: "open" });
  assert.equal(byId.get(S2)!.channel, null);
  assert.deepEqual((await getJson(server, `/api/cc/sessions/${S1}`)).json.channel, { channelId: "chan-1", guildId: "guild-1", link, state: "open" });
});

test("POST /api/cc/sessions/<id>/channel: channels が無ければ 404", async (t) => {
  const { registry, panes, tmux } = await setup(t);
  const server = await serve(t, ccRoutes({ registry, panes, tmux, workspaceDir: WORKSPACE, home: HOME }));
  assert.deepEqual(await postJson(server, `/api/cc/sessions/${S1}/channel`, {}), { status: 404, json: { error: "not_found" } });
});
