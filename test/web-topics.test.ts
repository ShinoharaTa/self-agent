// GET /api/topics（docs/plan/web-ui-v3.md §11 の M1）。一時 SQLite と偽の registry・handler で、話題・群・あなたの番・右腕を確かめる
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { AgentRunner } from "../src/agent/runner.ts";
import type { RunningTurn } from "../src/app/handler.ts";
import { PersonaRouter } from "../src/app/personas.ts";
import type { Topic, TopicsResult } from "../src/app/topics.ts";
import type { CcSessionView } from "../src/cc/registry.ts";
import type { PersonaConfig } from "../src/config.ts";
import type { Gateway } from "../src/discord/gateway.ts";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcStartStore } from "../src/store/cc-starts.ts";
import { CLOSE_CONFIRM_NOTICE } from "../src/web/routes/channels.ts";
import { topicRoutes } from "../src/web/routes/topics.ts";
import { createWebServer, type WebServer } from "../src/web/server.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";

const LOGIN = "owner@example.com";
const NOW = new Date("2026-11-14T00:30:00Z");
const EARLIER = new Date("2026-11-14T00:20:00Z");
const GUILD = "111";
const GUILD_NOT_SET_UP = "222";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const S4 = "44444444-4444-4444-8444-444444444444";
const SP = "55555555-5555-4555-8555-555555555555";
const SQ = "66666666-6666-4666-8666-666666666666";

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

async function topics(server: WebServer, path = "/api/topics"): Promise<TopicsResult> {
  const { status, json } = await getJson(server, path);
  assert.equal(status, 200);
  return json as unknown as TopicsResult;
}

function view(sessionId: string, cwd: string | undefined, overrides: Partial<CcSessionView> = {}): CcSessionView {
  return { sessionId, pid: 100, name: undefined, cwd, tmux: undefined, state: "idle", lastActivityAt: EARLIER.getTime(), ...overrides } as CcSessionView;
}

/**
 * /setup 済みのサーバー: #inbox 100・#tasks 101・ミカの #<NAME> 102。セッション: 200（進行中）・201（プロジェクト alpha・許可待ち）・
 * 202（完了）・203（待ち・ミカ・/close の確認が最後の行）・204（/close の確認の後に発言）・205（プロジェクト beta・質問）。
 * /setup 前のサーバーのセッション 400 とチャンネル 303。
 * Claude Code（cc を渡すとき）: チャンネル 300（S1・open・alpha・実行中）・301（S2・ended）。チャンネルの無い S3（ワークスペースの外・判断待ち）・
 * S4（alpha・判断待ちで hook の許可も pending）
 */
async function setup(t: TestContext, options: { cc?: boolean; running?: string[] } = {}) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { guildSettings, topicSessions, history, sessions } = stores;
  const workspace = realpathSync(tempDir(t));
  for (const name of ["alpha", "beta", "empty"]) mkdirSync(join(workspace, name));

  guildSettings.setChannel(GUILD, "inboxChannelId", "100");
  guildSettings.setChannel(GUILD, "tasksChannelId", "101");
  guildSettings.setPersonaInbox(GUILD, "mika", "102");
  topicSessions.create({ channelId: "200", guildId: GUILD, title: "家計簿", categoryId: "c" });
  topicSessions.create({ channelId: "201", guildId: GUILD, title: "alpha の作業", categoryId: "c" });
  topicSessions.setProject("201", "alpha", "default");
  sessions.set("201", SP);
  topicSessions.create({ channelId: "202", guildId: GUILD, title: "終わった話", categoryId: "c" });
  topicSessions.close("202", "要約");
  topicSessions.create({ channelId: "203", guildId: GUILD, title: "ミカの相談", categoryId: "c", persona: "mika" });
  topicSessions.setWaiting("203");
  history.add({ guildId: GUILD, channelId: "203", kind: "notice", source: "system", text: CLOSE_CONFIRM_NOTICE });
  topicSessions.create({ channelId: "204", guildId: GUILD, title: "確認の後に発言", categoryId: "c" });
  history.add({ guildId: GUILD, channelId: "204", kind: "notice", source: "system", text: CLOSE_CONFIRM_NOTICE });
  history.add({ guildId: GUILD, channelId: "204", kind: "owner", source: "discord", text: "やっぱり続ける" });
  topicSessions.create({ channelId: "205", guildId: GUILD, title: "beta の作業", categoryId: "c" });
  topicSessions.setProject("205", "beta", "default");
  sessions.set("205", SQ);
  topicSessions.create({ channelId: "400", guildId: GUILD_NOT_SET_UP, title: "別のサーバー", categoryId: "c" });

  const permissions = new CcPermissionStore(db, () => EARLIER);
  permissions.add({ sessionId: SP, requestHash: "h1", toolName: "Bash", summary: "npm   test\nnow", permissionMode: "default", state: "pending", origin: "sdk" });
  permissions.add({
    sessionId: SQ,
    requestHash: "h2",
    toolName: "AskUserQuestion",
    summary: "質問 1 問: 色は？",
    permissionMode: "default",
    state: "pending",
    origin: "sdk",
    questionInput: JSON.stringify({ questions: [{ question: "色は？", header: "Color", options: [{ label: "red" }, { label: "blue" }], multiSelect: false }] }),
  });

  const ccStore = new CcChannelStore(db, () => EARLIER);
  const sends = new CcSendStore(db, () => EARLIER);
  const starts = new CcStartStore(db, () => EARLIER);
  ccStore.create({ channelId: "300", guildId: GUILD, sessionId: S1, name: "cc-alpha", cwd: join(workspace, "alpha"), origin: "web" });
  ccStore.create({ channelId: "301", guildId: GUILD, sessionId: S2, name: "cc-beta", cwd: join(workspace, "beta", "sub"), origin: "web" });
  ccStore.setState("301", "ended");
  ccStore.create({ channelId: "303", guildId: GUILD_NOT_SET_UP, sessionId: "77777777-7777-4777-8777-777777777777", name: "cc-x", cwd: null, origin: "web" });
  permissions.add({ sessionId: S4, requestHash: "h3", toolName: "Edit", summary: "src/a.ts", permissionMode: "default", state: "pending" });
  // 確認待ち: #inbox からの起動・200 からの送信・合わないチャンネル・ツール以外の送信
  starts.add({ project: "alpha", title: "t", channelId: "100" });
  sends.add({ sessionId: S1, text: "x", origin: "tool", state: "awaiting_confirm", channelId: "200" });
  sends.add({ sessionId: S1, text: "x", origin: "tool", state: "awaiting_confirm", channelId: "999" });
  sends.add({ sessionId: S1, text: "x", origin: "web", state: "queued" });

  const snapshotSessions = [
    view(S1, join(workspace, "alpha"), { name: "alpha の端末", state: "running" }),
    view(S3, "/somewhere/else", { state: "needs_input", waitingFor: "approve\n  the plan", waitingSince: EARLIER.getTime() }),
    view(S4, join(workspace, "alpha", "src"), { state: "needs_input" }),
  ];
  const registry = {
    touches: 0,
    snapshot: () => ({ sessions: snapshotSessions, stale: true, unreadable: false, fetchedAt: NOW.getTime() }),
    touch() {
      this.touches++;
    },
  };
  const personas = new PersonaRouter({
    personas: [
      { id: "default", name: "default", engine: "claude", runner: {} as AgentRunner, gateway: {} as Gateway, connected: () => true },
      { id: "mika", name: "ミカ", engine: "claude", runner: {} as AgentRunner, gateway: {} as Gateway, connected: () => false },
    ],
    guildSettings,
    topicSessions,
  });
  const running = options.running ?? [];
  const handler = {
    runningTurns: (): RunningTurn[] => running.map((channelId) => ({ guildId: GUILD, channelId }) as RunningTurn),
  };
  const routes = topicRoutes({
    cfg: { allowedGuildIds: [GUILD, GUILD_NOT_SET_UP], personas: [MIKA], workspaceDir: workspace },
    guildSettings,
    topicSessions,
    history,
    personas,
    handler,
    places: { workspaceDir: workspace, protectedDirs: [] },
    home: "/home/owner",
    projectPermissions: { store: permissions, sessions, holdSec: 300, questionHoldSec: 900 },
    ...(options.cc === true
      ? { cc: { registry, channels: ccStore, permissions, sends, starts, holdSec: 300, questionHoldSec: 900 } }
      : {}),
    now: () => NOW,
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
  return { server, registry, workspace };
}

const byId = (result: TopicsResult, id: string): Topic | undefined => result.topics.find((topic) => topic.id === id);

test("web topics: セッション・プロジェクトのセッション・#tasks・人格の入口が話題になり、#inbox は rightHands に出る", async (t) => {
  const { server } = await setup(t);
  const result = await topics(server);
  assert.deepEqual(
    result.topics.map((topic) => [topic.id, topic.origin, topic.group, topic.pinned, topic.persona, topic.state]),
    [
      ["ch:201", "project", "p:alpha", false, null, "active"],
      ["ch:205", "project", "p:beta", false, null, "active"],
      ["ch:203", "session", "general", false, "ミカ", "waiting"],
      ["ch:200", "session", "general", false, null, "active"],
      ["ch:204", "session", "general", false, null, "active"],
      ["ch:101", "session", "general", true, null, "active"],
      ["ch:102", "session", "general", true, "ミカ", "active"],
    ],
  );
  const tasks = byId(result, "ch:101")!;
  assert.equal(tasks.title, "#tasks");
  assert.deepEqual(tasks.movable, { reason: "入口は場所を変えられません" });
  assert.equal(tasks.activityAt, new Date(0).toISOString());
  assert.equal(byId(result, "ch:102")!.title, "#ミカ");
  const session = byId(result, "ch:200")!;
  assert.equal(session.movable, true);
  assert.equal(session.link, `https://discord.com/channels/${GUILD}/200`);
  assert.deepEqual(session.place, { dir: null });
  assert.equal(byId(result, "ch:201")!.place.dir, "alpha");
  assert.deepEqual(result.rightHands, [
    { id: "ch:100", guildId: GUILD, title: "右腕", turn: null, last: null, link: `https://discord.com/channels/${GUILD}/100` },
  ]);
  // 完了は数だけ（done が無ければ topics に入らない）
  const general = result.groups.find((group) => group.key === "general")!;
  assert.equal(general.done, 1);
  assert.equal(byId(result, "ch:202"), undefined);
  // 話題の無いプロジェクトも群になる
  assert.deepEqual(
    result.groups.map((group) => [group.key, group.open]),
    [
      ["p:alpha", 1],
      ["p:beta", 1],
      ["p:empty", 0],
      ["general", 5],
    ],
  );
});

test("web topics: プロジェクトのセッションの pending の許可が turn（permission）になり、expiresAt が入る。質問は question", async (t) => {
  const { server } = await setup(t);
  const result = await topics(server);
  const project = byId(result, "ch:201")!;
  assert.equal(project.mark, "turn");
  assert.deepEqual(project.turn, {
    kind: "permission",
    summary: "Bash: npm test now",
    since: EARLIER.toISOString(),
    expiresAt: new Date(EARLIER.getTime() + 300_000).toISOString(),
  });
  const question = byId(result, "ch:205")!;
  assert.deepEqual(question.turn, {
    kind: "question",
    summary: "色は？",
    since: EARLIER.toISOString(),
    expiresAt: new Date(EARLIER.getTime() + 900_000).toISOString(),
  });
  assert.ok(result.turnIds.includes("ch:201") && result.turnIds.includes("ch:205"));
  assert.deepEqual(result.cc, { enabled: false, stale: false, unreadable: false });
});

test("web topics: /close の確認が最後の行のときだけ confirm になる", async (t) => {
  const { server } = await setup(t);
  const result = await topics(server);
  const waiting = byId(result, "ch:203")!;
  assert.equal(waiting.mark, "turn");
  assert.deepEqual(waiting.turn, { kind: "confirm", summary: "閉じる前の確認", since: NOW.toISOString(), expiresAt: null });
  assert.equal(byId(result, "ch:204")!.turn, null);
  assert.equal(byId(result, "ch:204")!.mark, null);
  assert.equal(result.turns, 3);
  // 時間切れの近い順（201 の許可 → 205 の質問 → 期限の無い 203 の確認）
  assert.deepEqual(result.turnIds, ["ch:201", "ch:205", "ch:203"]);
});

test("web topics: Claude Code のセッション（チャンネルあり・なし）の id と sessionId、ワークスペースの外の cwd は other、needs_input は waiting、pending の許可があれば permission が勝つ", async (t) => {
  const { server, registry } = await setup(t, { cc: true });
  const result = await topics(server);
  assert.equal(registry.touches, 1);
  assert.deepEqual(result.cc, { enabled: true, stale: true, unreadable: false });
  const withChannel = byId(result, "ch:300")!;
  assert.deepEqual(
    [withChannel.origin, withChannel.sessionId, withChannel.group, withChannel.title, withChannel.cwdLabel, withChannel.mark, withChannel.state],
    ["cc", S1, "p:alpha", "alpha の端末", "alpha", "running", "active"],
  );
  assert.equal(withChannel.link, `https://discord.com/channels/${GUILD}/300`);
  assert.deepEqual(withChannel.movable, { reason: "端末のセッションは場所を変えられません" });
  const outside = byId(result, `cc:${S3}`)!;
  assert.deepEqual([outside.sessionId, outside.group, outside.place.dir, outside.link, outside.last], [S3, "other", null, null, null]);
  assert.equal(outside.title, "/somewhere/else");
  assert.deepEqual(outside.turn, { kind: "waiting", summary: "approve the plan", since: EARLIER.toISOString(), expiresAt: null });
  const permitted = byId(result, `cc:${S4}`)!;
  assert.equal(permitted.group, "p:alpha");
  assert.equal(permitted.cwdLabel, "alpha/src");
  assert.equal(permitted.turn?.kind, "permission");
  assert.equal(permitted.turn?.summary, "Edit: src/a.ts");
  assert.equal(permitted.turn?.expiresAt, new Date(EARLIER.getTime() + 300_000).toISOString());
  // 終わったチャンネルと /setup 前のサーバーのチャンネルは出ない
  assert.equal(byId(result, "ch:301"), undefined);
  assert.equal(byId(result, "ch:303"), undefined);
  const groups = result.groups.map((group) => group.key);
  assert.deepEqual(groups, ["p:alpha", "p:beta", "p:empty", "general", "other"]);
});

test("web topics: 終わった Claude Code のチャンネルは done で、?done=<群> のときだけ返る", async (t) => {
  const { server } = await setup(t, { cc: true });
  const plain = await topics(server);
  assert.equal(byId(plain, "ch:301"), undefined);
  assert.equal(plain.groups.find((group) => group.key === "p:beta")!.done, 1);
  const withDone = await topics(server, "/api/topics?done=p:beta");
  const ended = byId(withDone, "ch:301")!;
  assert.deepEqual([ended.state, ended.sessionId, ended.mark, ended.turn, ended.title, ended.cwdLabel], ["done", null, null, null, "cc-beta", "beta/sub"]);
  assert.equal(ended.activityAt, EARLIER.toISOString());
  // 群の中では done でないものの後ろ
  const ids = withDone.topics.map((topic) => topic.id);
  assert.ok(ids.indexOf("ch:205") < ids.indexOf("ch:301"));
  // general の完了は足さない
  assert.equal(byId(withDone, "ch:202"), undefined);
  assert.ok(byId(await topics(server, "/api/topics?done=general"), "ch:202") !== undefined);
});

test("web topics: cc_starts・cc_sends（origin tool）の確認待ちが、頼んだチャンネルの話題（#inbox なら rightHands）の confirm になる", async (t) => {
  const { server } = await setup(t, { cc: true });
  const result = await topics(server);
  const expiresAt = new Date(EARLIER.getTime() + 10 * 60_000).toISOString();
  assert.deepEqual(result.rightHands[0]!.turn, { kind: "confirm", summary: "Claude Code を起動する確認", since: EARLIER.toISOString(), expiresAt });
  assert.deepEqual(byId(result, "ch:200")!.turn, { kind: "confirm", summary: "Claude Code に送る確認", since: EARLIER.toISOString(), expiresAt });
  assert.ok(result.turnIds.includes("ch:100"));
  assert.ok(result.turnIds.includes("ch:200"));
  // 201・205・203・200・S3・S4 と右腕
  assert.equal(result.turns, 7);
});

test("web topics: ?done= が形に合わなければ 400、知らない群は 200 で完了 0 件", async (t) => {
  const { server } = await setup(t);
  for (const bad of ["../x", "p:", "p:a/b", "GENERAL", "", "p:a%20b"]) {
    const res = await getJson(server, `/api/topics?done=${encodeURIComponent(bad)}`);
    assert.deepEqual([res.status, res.json], [400, { error: "bad_request" }], bad);
  }
  const unknown = await topics(server, "/api/topics?done=p:nothing");
  assert.equal(unknown.topics.some((topic) => topic.state === "done"), false);
  // done 以外の query は見ない
  assert.equal((await getJson(server, "/api/topics?other=1")).status, 200);
});

test("web topics: cc が無ければ enabled false で、Claude Code の行と other の群が無い", async (t) => {
  const { server, registry } = await setup(t);
  const result = await topics(server);
  assert.equal(registry.touches, 0);
  assert.equal(result.cc.enabled, false);
  assert.equal(result.topics.some((topic) => topic.origin === "cc"), false);
  assert.equal(result.groups.some((group) => group.key === "other"), false);
  // 確認の札も数えない（右腕は turn なし・200 は confirm なし）
  assert.equal(result.rightHands[0]!.turn, null);
  assert.equal(byId(result, "ch:200")!.turn, null);
});

test("web topics: 実行中のターンのあるチャンネルは mark が running、許可待ちなら turn が勝つ", async (t) => {
  const { server } = await setup(t, { running: ["200", "201"] });
  const result = await topics(server);
  assert.equal(byId(result, "ch:200")!.mark, "running");
  assert.equal(byId(result, "ch:201")!.mark, "turn");
  const general = result.groups.find((group) => group.key === "general")!;
  assert.equal(general.running, 1);
});

test("web topics: setUp していないサーバーの行は出ない", async (t) => {
  const { server } = await setup(t, { cc: true });
  const result = await topics(server, "/api/topics?done=general");
  assert.equal(byId(result, "ch:400"), undefined);
  assert.equal(byId(result, "ch:303"), undefined);
  assert.equal(result.rightHands.every((hand) => hand.guildId === GUILD), true);
});
