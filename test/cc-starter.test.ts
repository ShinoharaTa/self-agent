import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { AgentEntry, AgentsResult } from "../src/cc/agents.ts";
import { CcPaneResolver } from "../src/cc/panes.ts";
import { CcRegistry } from "../src/cc/registry.ts";
import { CC_START_BIND_GRACE_MS, CcSender } from "../src/cc/sender.ts";
import {
  buildClaudeCommand,
  CC_MIN_MEM_AVAILABLE_BYTES,
  CC_START_CHECK_MS,
  CC_START_INTERVAL_MS,
  CC_TRUST_CHECK_DELAY_MS,
  CcStarter,
  chooseSessionName,
  isTrustDialog,
  listProjects,
  normalizeTitle,
  projectDir,
  quoteShellArg,
  slugify,
} from "../src/cc/starter.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { createTmux, NEW_SESSION_FORMAT, type RunCommand } from "../src/tmux/tmux.ts";
import { ccRoutes } from "../src/web/routes/cc.ts";
import { createWebServer, type Route, type WebServer } from "../src/web/server.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const LOGIN = "owner@example.com";
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const TMUX = "/usr/bin/tmux";
const CLAUDE = "/home/owner/.local/bin/claude";
const S1 = "11111111-1111-4111-8111-111111111111";
const NEW = "99999999-9999-4999-8999-999999999999";

// 画面（cc-sender.test.ts と同じ形。文字は置き換えたもの）
const RULE = "─".repeat(80);
const PROMPT = "❯ ";
function screen(input: string[], footer = ["  ⏵⏵ auto mode on (shift+tab to cycle)"]): string {
  return ["● 返答の本文（置き換え）", "", RULE, ...input, RULE, ...footer, "", ""].join("\n");
}
const EMPTY = screen([PROMPT]);
const BUSY = screen([PROMPT], ["  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt"]);
// trust のダイアログ（ccverify の §6 の形。パスは置き換えたもの）
const TRUST = [
  RULE,
  " Accessing workspace:",
  "",
  " /w/alpha",
  "",
  " Quick safety check: Is this a project you created or one you trust?",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
  "",
].join("\n");

test("buildClaudeCommand: 固定の形で、claude・題名・モードを単引用符で囲む。' を含む題名・知らないモードは投げる", () => {
  assert.equal(buildClaudeCommand({ claudePath: CLAUDE, title: "fix login" }), `'${CLAUDE}' -n 'fix login'; exec "$SHELL"`);
  assert.equal(
    buildClaudeCommand({ claudePath: CLAUDE, title: "ログイン修正_2.1-a", permissionMode: "acceptEdits" }),
    `'${CLAUDE}' -n 'ログイン修正_2.1-a' --permission-mode 'acceptEdits'; exec "$SHELL"`,
  );
  for (const title of ["it's", "a;b", "$(x)", "a`b", 'a"b', "a\nb", "", "a".repeat(41)]) {
    assert.throws(() => buildClaudeCommand({ claudePath: CLAUDE, title }), Error, title);
    assert.equal(normalizeTitle(title), undefined, title);
  }
  for (const mode of ["bypassPermissions", "dontAsk", "x' ; rm -rf ~ ; '"]) {
    assert.throws(() => buildClaudeCommand({ claudePath: CLAUDE, title: "a", permissionMode: mode }), Error, mode);
  }
  assert.throws(() => buildClaudeCommand({ claudePath: "claude", title: "a" }));
  assert.throws(() => buildClaudeCommand({ claudePath: "/a b/claude", title: "a" }));
  assert.throws(() => quoteShellArg("a'b"));
  assert.equal(normalizeTitle("  fix  "), "fix");
});

test("chooseSessionName: <slug(project)> → <slug>--<slug(題名)> → -2, -3", () => {
  assert.equal(slugify("My_Project"), "my-project");
  assert.equal(slugify("ログイン"), "");
  assert.equal(chooseSessionName("alpha", "Fix Login", new Set()), "alpha");
  assert.equal(chooseSessionName("alpha", "Fix Login", new Set(["alpha"])), "alpha--fix-login");
  assert.equal(chooseSessionName("alpha", "Fix Login", new Set(["alpha", "alpha--fix-login"])), "alpha--fix-login-2");
  assert.equal(chooseSessionName("alpha", "Fix Login", new Set(["alpha", "alpha--fix-login", "alpha--fix-login-2"])), "alpha--fix-login-3");
  // 題名から作れなければ <slug>-2
  assert.equal(chooseSessionName("alpha", "ログイン", new Set(["alpha"])), "alpha-2");
});

/** ~/workspace に見立てた一時ディレクトリ: alpha・beta（実際のディレクトリ）、link（alpha への symlink）、file.txt、"bad name"、selfdata（守る場所） */
function workspace(t: TestContext) {
  const root = tempDir(t);
  const ws = join(root, "workspace");
  mkdirSync(join(ws, "alpha"), { recursive: true });
  mkdirSync(join(ws, "beta"));
  mkdirSync(join(ws, "bad name"));
  mkdirSync(join(ws, "selfdata"));
  mkdirSync(join(ws, "alpha", "sub"));
  symlinkSync(join(ws, "alpha"), join(ws, "link"));
  writeFileSync(join(ws, "file.txt"), "x");
  const outside = join(root, "outside");
  mkdirSync(outside);
  return { ws, places: { workspaceDir: ws, protectedDirs: [join(ws, "selfdata"), join(root, "missing")] }, outside };
}

test("projectDir・listProjects: 直下の実際のディレクトリだけ。symlink・無い・ファイル・入れ子・形の違う名前・守る場所は通さない", (t) => {
  const { ws, places } = workspace(t);
  assert.equal(projectDir("alpha", places), join(ws, "alpha"));
  for (const name of ["link", "missing", "file.txt", "bad name", "alpha/sub", "../outside", ".", "..", "selfdata", "", 3, undefined]) {
    assert.equal(projectDir(name, places), undefined, String(name));
  }
  assert.deepEqual(listProjects(places), ["alpha", "beta"]);
  // workspace が無ければ空
  assert.deepEqual(listProjects({ workspaceDir: join(ws, "nope"), protectedDirs: [] }), []);
});

test("isTrustDialog: trust のダイアログだけ（ほかのダイアログ・入力待ちは違う）", () => {
  assert.equal(isTrustDialog(TRUST), true);
  assert.equal(isTrustDialog(EMPTY), false);
  assert.equal(isTrustDialog(screen([" Do you want to proceed?", " ❯ 1. Yes", " Esc to cancel"])), false);
});

function agent(sessionId: string, pid: number, overrides: Partial<AgentEntry> = {}): AgentEntry {
  return { pid, sessionId, cwd: "/w/a", name: "a", kind: "interactive", startedAt: BASE, status: "idle", waitingFor: undefined, ...overrides };
}

function paneLine(session: string, paneId: string, panePid: number, command = "claude"): string {
  return [session, "0", paneId.slice(1), paneId, "1", "1", "/w/a", command, "0", "0", String(panePid)].join("\t");
}

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

function call(server: WebServer, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "tailscale-user-login": LOGIN };
    if (method === "POST") Object.assign(headers, { "sec-fetch-site": "same-origin", "x-self-agent": "1", "content-type": "application/json" });
    const req = request({ host: "127.0.0.1", port: server.address()!.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(method === "POST" ? JSON.stringify(body ?? {}) : undefined);
  });
}

/**
 * 本物の CcRegistry（偽の claude agents --json）・CcPaneResolver・CcSender・CcStarter と偽の tmux（createTmux の実行を差し替え）・一時 SQLite。
 * 既存のセッション S1（pid 500 → pane_pid 400 の %1）。new-session は `$7 %9` を返し、%9（pane_pid 900）をセッション名 created で足す。
 * 起動した claude（pid 950 → 親 900）は agents の newAgent で一覧に出す
 */
async function setup(t: TestContext, opts: { sessions?: number; mem?: number } = {}) {
  const { ws, places } = workspace(t);
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const store = new CcSessionStore(db, now);
  const sends = new CcSendStore(db, now);
  const extra = Array.from({ length: (opts.sessions ?? 1) - 1 }, (_, i) =>
    agent(`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`, 2000 + i),
  );
  const agents: AgentEntry[] = [agent(S1, 500), ...extra];
  let listResult: AgentsResult | undefined;
  const registry = new CcRegistry({
    cfg: { ccPollSec: 10 },
    agents: { list: async () => listResult ?? { ok: true, agents: [...agents], dropped: 0 } },
    dirs: { sessionFile: () => undefined, transcriptMtime: () => undefined },
    store,
    now,
    timers: { after: () => () => undefined },
    log: () => undefined,
  });
  await registry.tick();

  const env = {
    noServer: false,
    newSessionFails: false,
    panes: [paneLine("work", "%1", 400)],
    /** ペインごとの画面 */
    screens: { "%1": EMPTY, "%9": EMPTY } as Record<string, string>,
    /** 新しいセッションの名前（オーナーの hook が変えたもの） */
    renamed: "created",
  };
  const commands: string[][] = [];
  const run: RunCommand = async (_file, args) => {
    commands.push([...args]);
    if (env.noServer) return { code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/default\n" };
    const target = args[args.indexOf("-t") + 1] ?? "";
    switch (args[0]) {
      case "list-panes":
        return { code: 0, stdout: env.panes.join("\n"), stderr: "" };
      case "list-clients":
        return { code: 0, stdout: "", stderr: "" };
      case "new-session":
        if (env.newSessionFails) return { code: 1, stdout: "", stderr: "failed" };
        env.panes.push(paneLine(env.renamed, "%9", 900));
        return { code: 0, stdout: "$7 %9\n", stderr: "" };
      case "capture-pane":
        return env.screens[target] === undefined
          ? { code: 1, stdout: "", stderr: `can't find pane: ${target}\n` }
          : { code: 0, stdout: env.screens[target]!, stderr: "" };
      case "paste-buffer":
        env.screens[target] = screen([`${PROMPT}最初の指示`]);
        return { code: 0, stdout: "", stderr: "" };
      case "send-keys":
        env.screens[target] = BUSY;
        return { code: 0, stdout: "", stderr: "" };
      default:
        return { code: 0, stdout: "", stderr: "" };
    }
  };
  const tmux = createTmux({ tmuxPath: TMUX, run });
  const parents: Record<number, number> = { 500: 400, 950: 900, 400: 1, 900: 1 };
  const panes = new CcPaneResolver({ tmux, parentOf: (pid) => parents[pid] });
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
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const logs: string[] = [];
  const mem = { value: opts.mem as number | undefined };
  const starter = new CcStarter({
    cfg: { workspaceDir: ws, ccMaxSessions: 30 },
    places,
    claudePath: CLAUDE,
    registry,
    panes,
    tmux,
    sends,
    sessions: store,
    sender,
    memAvailable: () => mem.value,
    now,
    timers: {
      after: (fn, ms) => {
        const entry = { fn, ms };
        pending.push(entry);
        return () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
        };
      },
    },
    log: (message) => logs.push(message),
  });
  const server = await serve(t, ccRoutes({ registry, panes, tmux, workspaceDir: ws, home: "/home/owner", sender, sends, starter, now }));
  /** ms の予約を全部走らせる */
  const fire = async (ms: number): Promise<void> => {
    for (const entry of pending.filter((e) => e.ms === ms)) {
      pending.splice(pending.indexOf(entry), 1);
      entry.fn();
    }
    await new Promise((resolve) => setImmediate(resolve));
    await starter.tick();
  };
  /** 起動した claude を一覧に出す */
  const showNew = async (): Promise<void> => {
    agents.push(agent(NEW, 950, { name: "fix login", cwd: join(ws, "alpha") }));
    await registry.tick();
  };
  return { ws, db, clock, store, sends, registry, sender, starter, server, env, commands, pending, logs, mem, fire, showNew, setList: (r: AgentsResult) => (listResult = r) };
}

const actions = (commands: string[][]) => commands.filter((args) => ["load-buffer", "paste-buffer", "send-keys"].includes(args[0]!)).map((a) => a[0]);

test("POST /api/cc/sessions: 引数は固定の形で単引用符に入る。201 でセッション名・%N・最初の指示の番号", async (t) => {
  const { server, commands, ws, logs } = await setup(t);
  const res = await call(server, "POST", "/api/cc/sessions", { project: "alpha", title: "fix login", text: "最初の指示", permissionMode: "plan" });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json, { tmuxSession: "alpha", paneId: "%9", sendId: 1 });
  const created = commands.find((args) => args[0] === "new-session")!;
  assert.deepEqual(created, [
    "new-session",
    "-d",
    "-P",
    "-F",
    NEW_SESSION_FORMAT,
    "-s",
    "alpha",
    "-c",
    join(ws, "alpha"),
    "--",
    `'${CLAUDE}' -n 'fix login' --permission-mode 'plan'; exec "$SHELL"`,
  ]);
  // サーバーがあるかを先に list-panes で確かめてから
  assert.equal(commands[0]![0], "list-panes");
  // log に名前・パス・ペイン id を出さない
  assert.deepEqual(logs, ["Claude Code: 起動しました（web、最初の指示 #1）"]);
  assert.ok(!logs.join("\n").includes("alpha") && !logs.join("\n").includes("%9"));
});

test("POST /api/cc/sessions: ' を含む題名・知らないモード・直下でない・symlink・無いディレクトリは 400 で tmux を呼ばない", async (t) => {
  const { server, commands } = await setup(t);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ project: "alpha", title: "it's" }, "invalid_title"],
    [{ project: "alpha", title: "a; rm -rf ~" }, "invalid_title"],
    [{ project: "alpha" }, "invalid_title"],
    [{ project: "alpha", title: "a", permissionMode: "bypassPermissions" }, "invalid_mode"],
    [{ project: "alpha", title: "a", permissionMode: "dontAsk" }, "invalid_mode"],
    [{ project: "link", title: "a" }, "invalid_project"],
    [{ project: "missing", title: "a" }, "invalid_project"],
    [{ project: "alpha/sub", title: "a" }, "invalid_project"],
    [{ project: "../outside", title: "a" }, "invalid_project"],
    [{ project: "selfdata", title: "a" }, "invalid_project"],
    [{ project: "alpha", title: "a", text: "a\tb" }, "invalid_text"],
    [{ project: "alpha", title: "a", text: "a".repeat(4001) }, "too_long"],
  ];
  for (const [body, error] of cases) {
    assert.deepEqual(await call(server, "POST", "/api/cc/sessions", body), { status: 400, json: { error } }, JSON.stringify(body));
  }
  assert.deepEqual(commands, []);
});

test("POST /api/cc/sessions: tmux のサーバーが無ければ 503 no_server で new-session を呼ばない（サーバーを起こさない）", async (t) => {
  const { server, commands, env } = await setup(t);
  env.noServer = true;
  assert.deepEqual(await call(server, "POST", "/api/cc/sessions", { project: "alpha", title: "a" }), { status: 503, json: { error: "no_server" } });
  assert.deepEqual(
    commands.map((args) => args[0]),
    ["list-panes"],
  );
  env.noServer = false;
  env.newSessionFails = true;
  assert.deepEqual(await call(server, "POST", "/api/cc/sessions", { project: "alpha", title: "a" }), { status: 503, json: { error: "tmux_failed" } });
});

test("POST /api/cc/sessions: 生きている claude が 30 本なら 31 本目は 409 limit。29 本なら起動する", async (t) => {
  const full = await setup(t, { sessions: 30 });
  assert.deepEqual(await call(full.server, "POST", "/api/cc/sessions", { project: "alpha", title: "a" }), { status: 409, json: { error: "limit" } });
  assert.equal(full.commands.length, 0);
  const room = await setup(t, { sessions: 29 });
  assert.equal((await call(room.server, "POST", "/api/cc/sessions", { project: "alpha", title: "a" })).status, 201);
  // 起動したものがまだ一覧に出ていなくても数える（30 本目として）
  room.clock.now += CC_START_INTERVAL_MS;
  assert.deepEqual(await call(room.server, "POST", "/api/cc/sessions", { project: "beta", title: "b" }), { status: 409, json: { error: "limit" } });
});

test("POST /api/cc/sessions: 1 分に 1 回・空きメモリ 1 GB 未満・一覧をまだ読めていないなら断る", async (t) => {
  const s = await setup(t, { mem: CC_MIN_MEM_AVAILABLE_BYTES - 1 });
  assert.deepEqual(await call(s.server, "POST", "/api/cc/sessions", { project: "alpha", title: "a" }), { status: 409, json: { error: "low_memory" } });
  s.mem.value = CC_MIN_MEM_AVAILABLE_BYTES;
  assert.equal((await call(s.server, "POST", "/api/cc/sessions", { project: "alpha", title: "a" })).status, 201);
  s.clock.now += CC_START_INTERVAL_MS - 1;
  assert.deepEqual(await call(s.server, "POST", "/api/cc/sessions", { project: "beta", title: "b" }), { status: 409, json: { error: "too_soon" } });
  s.clock.now += 1;
  // 一覧を 5 回続けて読めなければ（unreadable）数を確かめられないので起動しない
  s.setList({ ok: false, reason: "json" });
  for (let i = 0; i < 5; i++) await s.registry.tick();
  assert.deepEqual(await call(s.server, "POST", "/api/cc/sessions", { project: "beta", title: "b" }), { status: 503, json: { error: "not_ready" } });
});

test("GET /api/cc/projects: 直下の実際のディレクトリの名前。起動が無ければ 404", async (t) => {
  const { server } = await setup(t);
  assert.deepEqual(await call(server, "GET", "/api/cc/projects"), { status: 200, json: { projects: [{ name: "alpha" }, { name: "beta" }] } });
  const off = await serve(t, ccRoutes({ registry: undefined, panes: undefined, tmux: undefined, workspaceDir: "/w", home: "/h" }));
  assert.deepEqual(await call(off, "GET", "/api/cc/projects"), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await call(off, "POST", "/api/cc/sessions", { project: "alpha", title: "a" }), { status: 404, json: { error: "not_found" } });
});

test("起動: 最初の指示はペイン宛てに積まれ、sessionId が現れたら行に結びつく。セッション名が変わっても %N で追える", async (t) => {
  const s = await setup(t);
  s.env.renamed = "renamed-by-hook";
  const res = await call(s.server, "POST", "/api/cc/sessions", { project: "alpha", title: "fix login", text: "最初の指示" });
  assert.equal(res.status, 201);
  const row = s.sends.get(1)!;
  assert.deepEqual([row.sessionId, row.paneId, row.origin, row.state, row.text], [null, "%9", "start", "queued", "最初の指示"]);
  assert.equal(s.starter.busy(), true);
  // まだ一覧に無い: 積んだまま（何も貼らない）
  await s.sender.kick();
  assert.equal(s.sends.get(1)!.state, "queued");
  assert.equal(s.sends.get(1)!.lastPaneState, "starting");
  assert.deepEqual(actions(s.commands), []);
  // 一覧に現れた（tmux のセッション名は hook で変わっている）→ 起動の記録と最初の指示を結びつけ、入力待ちなので届ける
  await s.showNew();
  await s.fire(CC_START_CHECK_MS);
  assert.equal(s.starter.busy(), false);
  const saved = s.store.get(NEW)!;
  assert.deepEqual([saved.startedBy, saved.tmuxSession, saved.tmuxSessionId, saved.startPaneId], ["web", "alpha", "$7", "%9"]);
  assert.equal(s.sends.get(1)!.sessionId, NEW);
  await s.sender.idle();
  await s.sender.kick();
  assert.equal(s.sends.get(1)!.state, "delivered");
  assert.deepEqual(actions(s.commands), ["load-buffer", "paste-buffer", "send-keys"]);
  // 貼った先は %9（名前では指さない）
  assert.ok(s.commands.filter((args) => args[0] === "paste-buffer" || args[0] === "send-keys").every((args) => args.includes("%9")));
  // 一覧の API に起動したものが出る
  const list = await call(s.server, "GET", "/api/cc/sessions");
  const view = (list.json.sessions as Array<Record<string, unknown>>).find((v) => v.sessionId === NEW)!;
  assert.equal(view.startedBy, "web");
  assert.equal(view.trustPending, false);
  assert.equal(view.paneLabel, "renamed-by-hook:0.9");
});

test("起動: 送信の経路でも、一覧に現れたペインの sessionId を結びつけて送る（起動の記録の前でも）", async (t) => {
  const s = await setup(t);
  await call(s.server, "POST", "/api/cc/sessions", { project: "alpha", title: "a", text: "最初の指示" });
  await s.showNew();
  await s.sender.kick();
  assert.equal(s.sends.get(1)!.sessionId, NEW);
  assert.equal(s.sends.get(1)!.state, "delivered");
});

test("起動: trust のダイアログ（dialog）の間は Enter もキーも送らず積んだまま。10 秒で dialog なら trustPending、消えたら外れて届く", async (t) => {
  const s = await setup(t);
  s.env.screens["%9"] = TRUST;
  await call(s.server, "POST", "/api/cc/sessions", { project: "alpha", title: "a", text: "最初の指示" });
  // 10 秒の確かめ（キーは送らない）
  assert.ok(s.pending.some((entry) => entry.ms === CC_TRUST_CHECK_DELAY_MS));
  await s.fire(CC_TRUST_CHECK_DELAY_MS);
  assert.ok(s.logs.includes("Claude Code: 起動したセッションが trust の確認を待っています"));
  // trust の前でも claude agents --json には出る
  await s.showNew();
  await s.fire(CC_START_CHECK_MS);
  assert.notEqual(s.store.get(NEW)!.trustPendingAt, null);
  const list = await call(s.server, "GET", "/api/cc/sessions");
  assert.equal((list.json.sessions as Array<Record<string, unknown>>).find((v) => v.sessionId === NEW)!.trustPending, true);
  await s.sender.kick();
  assert.equal(s.sends.get(1)!.state, "queued");
  assert.equal(s.sends.get(1)!.lastPaneState, "dialog");
  assert.deepEqual(actions(s.commands), []);
  assert.ok(!s.commands.some((args) => args[0] === "send-keys"));
  // オーナーが端末で承認した → 入力待ち。確かめ直しで外れ、最初の指示が届く
  s.env.screens["%9"] = EMPTY;
  await s.fire(CC_START_CHECK_MS);
  assert.equal(s.store.get(NEW)!.trustPendingAt, null);
  await s.sender.kick();
  assert.equal(s.sends.get(1)!.state, "delivered");
});

test("起動: trust のダイアログが出ないディレクトリでは trustPending にならない。最初の指示が無ければ積まない", async (t) => {
  const s = await setup(t);
  const res = await call(s.server, "POST", "/api/cc/sessions", { project: "beta", title: "b", text: "  " });
  assert.deepEqual(res, { status: 201, json: { tmuxSession: "beta", paneId: "%9" } });
  await s.fire(CC_TRUST_CHECK_DELAY_MS);
  await s.showNew();
  await s.fire(CC_START_CHECK_MS);
  assert.equal(s.store.get(NEW)!.trustPendingAt, null);
  assert.equal(s.store.get(NEW)!.startedBy, "web");
  assert.equal(s.sends.get(1), undefined);
});

test("起動: ペイン宛ての送信は、ペインが無くなれば gone、しばらく claude でなければ not_claude（送らない）", async (t) => {
  const s = await setup(t);
  await call(s.server, "POST", "/api/cc/sessions", { project: "alpha", title: "a", text: "最初の指示" });
  // trust で No, exit を選ぶと claude が終わり、ペインはシェルになる
  s.env.panes[1] = paneLine("created", "%9", 900, "bash");
  await s.sender.kick();
  assert.equal(s.sends.get(1)!.state, "queued");
  s.clock.now += CC_START_BIND_GRACE_MS;
  await s.sender.kick();
  assert.equal(s.sends.get(1)!.state, "failed");
  assert.equal(s.sends.get(1)!.lastPaneState, "not_claude");

  const g = await setup(t);
  await call(g.server, "POST", "/api/cc/sessions", { project: "alpha", title: "a", text: "最初の指示" });
  g.env.panes.pop();
  await g.sender.kick();
  assert.equal(g.sends.get(1)!.state, "failed");
  assert.equal(g.sends.get(1)!.lastPaneState, "gone");
  assert.deepEqual(actions(g.commands), []);
});

test("起動: stop の後は起動しない（503 stopping）", async (t) => {
  const s = await setup(t);
  s.starter.stop();
  assert.deepEqual(await call(s.server, "POST", "/api/cc/sessions", { project: "alpha", title: "a" }), { status: 503, json: { error: "stopping" } });
  assert.deepEqual(s.commands, []);
});
