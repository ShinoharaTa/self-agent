import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AgentEntry, AgentsResult } from "../src/cc/agents.ts";
import type { SessionFileInfo } from "../src/cc/claude-dirs.ts";
import { parseHookEvent } from "../src/cc/hook-server.ts";
import { CcPaneResolver } from "../src/cc/panes.ts";
import { CcRegistry } from "../src/cc/registry.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { createTmux, PANE_FORMAT, type RunCommand, type RunResult } from "../src/tmux/tmux.ts";
import { CC_SCREEN_LINES, ccRoutes, ccStatus, cwdLabel, screenText } from "../src/web/routes/cc.ts";
import { createWebServer, type Route, type WebServer } from "../src/web/server.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

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
      agent(S4, { pid: 800, name: undefined, status: "waiting", cwd: "/srv/x" }),
    ],
    dropped: 0,
  };
  const files = new Map<string, SessionFileInfo>(Object.entries(opts.files ?? { [S1]: { bridgeSessionId: "session_abc123", tmux: "work:0.%1" } }));
  let touches = 0;
  const registry = new CcRegistry({
    cfg: { ccPollSec: 10 },
    agents: { list: async () => next },
    dirs: { sessionFile: (_pid, sessionId) => files.get(sessionId), transcriptMtime: () => undefined },
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
  const server = await serve(t, ccRoutes({ registry, panes, tmux, workspaceDir: WORKSPACE, home: HOME }));
  return {
    server,
    registry,
    tmuxState,
    calls,
    clock,
    touches: () => touches,
    setAgents: (agents: AgentEntry[] | null) => {
      next = agents === null ? { ok: false, reason: "json" } : { ok: true, agents, dropped: 0 };
    },
  };
}

test("/api/cc/*: SELF_AGENT_CC が無効（registry が無い）なら一覧も 1 件も 404", async (t) => {
  const server = await serve(t, ccRoutes({ registry: undefined, panes: undefined, tmux: undefined, workspaceDir: WORKSPACE, home: HOME }));
  for (const path of ["/api/cc/sessions", `/api/cc/sessions/${S1}`, "/api/cc/other"]) {
    const { status, json } = await getJson(server, path);
    assert.equal(status, 404, path);
    assert.deepEqual(json, { error: "not_found" });
  }
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
    since: new Date(BASE - 3_600_000).toISOString(),
    lastPromptAt: null,
    lastPromptText: null,
    inTmux: true,
    paneLabel: "work:0.1",
    rcUrl: "https://claude.ai/code/session_abc123",
    startedBy: "owner",
    pending: null,
    permission: null,
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
  assert.deepEqual(ccStatus(deps), { enabled: true, hookPort: true, tmux: null, multilineOk: true, pendingPermissions: 0 });
  assert.equal(runs, 0);
  await panes.lookup(new Set());
  assert.deepEqual(ccStatus(deps), { enabled: true, hookPort: true, tmux: "ok", multilineOk: true, pendingPermissions: 0 });
  listening = false;
  db.exec("UPDATE cc_state SET multiline_ok = 0");
  await panes.lookup(new Set());
  assert.deepEqual(ccStatus(deps), { enabled: true, hookPort: false, tmux: "no_server", multilineOk: false, pendingPermissions: 0 });
  await panes.lookup(new Set());
  assert.equal(ccStatus(deps).tmux, "failed");
  ccStatus(deps);
  assert.equal(runs, 3);
});
