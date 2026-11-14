// GET /api/topics（docs/plan/web-ui-v3.md §11 の M1）。一時 SQLite と偽の registry・handler で、話題・群・あなたの番・右腕を確かめる
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { AgentRunner } from "../src/agent/runner.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { createHandler, type RunningTurn, type SubmitTextResult, WEB_ECHO_PREFIX } from "../src/app/handler.ts";
import { PersonaRouter } from "../src/app/personas.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { welcomeText } from "../src/app/session-ops.ts";
import { MOVE_FAILED_TEXT, moveRefusalText, movedPostText } from "../src/app/topic-move.ts";
import type { Topic, TopicsResult } from "../src/app/topics.ts";
import { buildTopics } from "../src/app/topics.ts";
import type { CcSessionView } from "../src/cc/registry.ts";
import type { PersonaConfig } from "../src/config.ts";
import type { Gateway } from "../src/discord/gateway.ts";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcStartStore } from "../src/store/cc-starts.ts";
import { TopicMoveStore } from "../src/store/topic-moves.ts";
import { CLOSE_CONFIRM_NOTICE } from "../src/web/routes/channels.ts";
import { TOPIC_START_DUPLICATE_MS, topicRoutes } from "../src/web/routes/topics.ts";
import { createTopicCollector, type TopicRouteDeps } from "../src/web/routes/topics.ts";
import { WEB_DUPLICATE_WINDOW_MS } from "../src/web/routes/turns.ts";
import { createWebServer, type WebServer } from "../src/web/server.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { FakeRunner, type FakeRunStep, turnUsage } from "./helpers/runner.ts";

const LOGIN = "owner@example.com";
// 許可（300 秒）・確認（10 分）が時間切れにならない時刻
const NOW = new Date("2026-11-14T00:22:00Z");
const EARLIER = new Date("2026-11-14T00:20:00Z");
const GUILD = "111";
const GUILD_NOT_SET_UP = "222";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const S4 = "44444444-4444-4444-8444-444444444444";
const SP = "55555555-5555-4555-8555-555555555555";
const SQ = "66666666-6666-4666-8666-666666666666";
const S7 = "77777777-7777-4777-8777-777777777777";

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
 * 202（完了）・203（待ち・ミカ・/close の確認が最後の行で下書きあり）・204（/close の確認の後に発言）・205（プロジェクト beta・質問）。
 * /setup 前のサーバーのセッション 400 とチャンネル 303。
 * Claude Code（cc を渡すとき）: チャンネル 300（S1・open・alpha・実行中）・301（S2・ended）。チャンネルの無い S3（ワークスペースの外・判断待ち）・
 * S4（alpha・判断待ちで hook の許可も pending）。/setup 前のサーバーのチャンネル 303 は S7。
 * allowed で cfg.allowedGuildIds を、at でルートの今の時刻を差し替える。registry.unreadable と snapshotSessions は後から変えられる。
 * move で場所の付け替えの配線を渡す（"cc" は連携あり、"noCc" は連携なし）。要点のターンは moveSteps の順に偽の runner が返し、結果の投稿は posts に入る。
 * postFails を true にすると結果の投稿は投げる。waitLog で log の行を待てる
 */
async function setup(
  t: TestContext,
  options: {
    cc?: boolean;
    running?: string[];
    allowed?: string[];
    at?: Date;
    general?: boolean;
    move?: "cc" | "noCc";
    moveSteps?: FakeRunStep[];
  } = {},
) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { guildSettings, topicSessions, history, sessions } = stores;
  const workspace = realpathSync(tempDir(t));
  for (const name of ["alpha", "beta", "empty"]) mkdirSync(join(workspace, name));
  // general なら General のディレクトリを作り、places に入れる
  if (options.general === true) mkdirSync(join(workspace, "General"));

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
  topicSessions.saveCloseDraft("203", { summary: "要約", tasks: [] });
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
  ccStore.create({ channelId: "303", guildId: GUILD_NOT_SET_UP, sessionId: S7, name: "cc-x", cwd: null, origin: "web" });
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
    unreadable: false,
    snapshot() {
      return { sessions: snapshotSessions, stale: true, unreadable: this.unreadable, fetchedAt: NOW.getTime() };
    },
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
  // プロジェクトのセッションの許可を探したチャンネル
  const sdkLookups: string[] = [];
  const sdkStore = {
    latestSdkFor: (...args: Parameters<CcPermissionStore["latestSdkFor"]>) => {
      sdkLookups.push(args[0]);
      return permissions.latestSdkFor(...args);
    },
  };
  const places = { workspaceDir: workspace, protectedDirs: [], ...(options.general === true ? { generalDir: "General" } : {}) };
  // 場所の付け替えの配線（move のときだけ）
  const moves = new TopicMoveStore(db, () => NOW);
  const moveRunner = new FakeRunner(options.moveSteps ?? []);
  const ready = { value: true };
  const posts: Array<{ channelId: string; text: string }> = [];
  const postWaiters: Array<{ count: number; resolve: () => void }> = [];
  const logs: string[] = [];
  const logWaiters: Array<{ match: (line: string) => boolean; resolve: () => void }> = [];
  const topicCalls: Array<{ channelId: string; topic: string }> = [];
  const log = (line: string): void => {
    logs.push(line);
    for (const waiter of logWaiters.filter((w) => w.match(line))) {
      logWaiters.splice(logWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  const postFails = { value: false };
  const turnQueue = new KeyedSerialQueue(2);
  const move =
    options.move === undefined
      ? undefined
      : {
          topicSessions,
          moves,
          turnQueue,
          turn: { runner: moveRunner, projectRunner: moveRunner, sessions, seeds: stores.seeds, usage: stores.usage, log },
          runningTurns: () => handler.runningTurns(),
          ...(options.move === "cc" ? { projectSessions: { places, ready: () => ready.value } } : {}),
          history,
          setChannelTopic: async (channelId: string, topic: string) => void topicCalls.push({ channelId, topic }),
          ownerPosts: {
            send: async (channelId: string, text: string) => {
              if (postFails.value) throw new TypeError("post failed");
              posts.push({ channelId, text });
              for (const waiter of postWaiters.filter((w) => posts.length >= w.count)) {
                postWaiters.splice(postWaiters.indexOf(waiter), 1);
                waiter.resolve();
              }
            },
          },
          log,
        };
  /** 結果の投稿が count 通になるまで待つ */
  const waitPosts = (count: number): Promise<void> =>
    posts.length >= count ? Promise.resolve() : new Promise((resolve) => postWaiters.push({ count, resolve }));
  /** match に合う log の行が出るまで待つ（もう出ていればすぐ） */
  const waitLog = (match: (line: string) => boolean): Promise<void> =>
    logs.some(match) ? Promise.resolve() : new Promise((resolve) => logWaiters.push({ match, resolve }));
  const routes = topicRoutes({
    cfg: { allowedGuildIds: options.allowed ?? [GUILD, GUILD_NOT_SET_UP], personas: [MIKA], workspaceDir: workspace },
    guildSettings,
    topicSessions,
    history,
    personas,
    handler,
    places,
    home: "/home/owner",
    projectPermissions: { store: sdkStore, sessions, holdSec: 300, questionHoldSec: 900 },
    ...(move === undefined ? {} : { move }),
    ...(options.cc === true
      ? { cc: { registry, channels: ccStore, permissions, sends, starts, holdSec: 300, questionHoldSec: 900 } }
      : {}),
    now: () => options.at ?? NOW,
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
  return {
    server,
    registry,
    workspace,
    snapshotSessions,
    permissions,
    guildSettings,
    topicSessions,
    sdkLookups,
    sessions,
    history,
    moves,
    moveRunner,
    ready,
    posts,
    postFails,
    waitPosts,
    waitLog,
    logs,
    topicCalls,
    turnQueue,
  };
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
  // 履歴の無い入口は null
  assert.equal(tasks.activityAt, null);
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

test("web topics: ended の行でもセッションが一覧に居れば active で、pending の許可が turn になる", async (t) => {
  const { server, snapshotSessions, permissions, workspace } = await setup(t, { cc: true });
  const before = await topics(server);
  snapshotSessions.push(view(S2, join(workspace, "beta", "sub")));
  permissions.add({ sessionId: S2, requestHash: "h4", toolName: "Bash", summary: "ls", permissionMode: "default", state: "pending" });
  const result = await topics(server);
  const reopened = byId(result, "ch:301")!;
  assert.deepEqual([reopened.state, reopened.sessionId, reopened.mark, reopened.turn?.kind], ["active", S2, "turn", "permission"]);
  assert.equal(result.turns, before.turns + 1);
  assert.ok(result.turnIds.includes("ch:301"));
  // チャンネルのあるセッションは cc: にしない
  assert.equal(byId(result, `cc:${S2}`), undefined);
});

test("web topics: open の行でもセッションが一覧に無ければ done。一覧が読めないときは open の行が active", async (t) => {
  const { server, snapshotSessions, registry } = await setup(t, { cc: true });
  snapshotSessions.splice(0, 1); // S1 を一覧から外す
  const gone = await topics(server, "/api/topics?done=p:alpha");
  assert.equal(byId(gone, "ch:300")!.state, "done");
  snapshotSessions.splice(0, snapshotSessions.length);
  registry.unreadable = true;
  const unreadable = await topics(server, "/api/topics?done=p:beta");
  assert.equal(byId(unreadable, "ch:300")!.state, "active");
  // ended の行は done のまま
  assert.equal(byId(unreadable, "ch:301")!.state, "done");
  assert.equal(unreadable.cc.unreadable, true);
});

test("web topics: setUp 済みのサーバーが 0 でも、チャンネルの無い Claude Code のセッションが出る", async (t) => {
  const { server, snapshotSessions } = await setup(t, { cc: true, allowed: [GUILD_NOT_SET_UP] });
  snapshotSessions.splice(0, snapshotSessions.length, view(S3, "/somewhere/else", { state: "needs_input" }));
  const result = await topics(server);
  assert.deepEqual(
    result.topics.map((topic) => topic.id),
    [`cc:${S3}`],
  );
  assert.equal(result.turns, 1);
  assert.equal(byId(result, `cc:${S3}`)!.turn?.summary, "判断待ち");
});

test("web topics: setUp 済みのサーバーが 2 つなら、2 つ目のサーバーのチャンネルのあるセッションは ch: の 1 行だけ", async (t) => {
  const { server, snapshotSessions, guildSettings } = await setup(t, { cc: true });
  guildSettings.setChannel(GUILD_NOT_SET_UP, "inboxChannelId", "500");
  snapshotSessions.push(view(S7, undefined));
  const result = await topics(server);
  assert.equal(result.topics.filter((topic) => topic.id === "ch:303" || topic.id === `cc:${S7}`).length, 1);
  assert.equal(byId(result, "ch:303")!.state, "active");
  assert.equal(byId(result, "ch:303")!.link, `https://discord.com/channels/${GUILD_NOT_SET_UP}/303`);
});

test("web topics: 完了のセッションではプロジェクトの許可を探さない", async (t) => {
  const { server, sdkLookups } = await setup(t);
  await topics(server, "/api/topics?done=general");
  assert.ok(sdkLookups.includes("200"));
  assert.equal(sdkLookups.includes("202"), false);
});

test("web topics: 時間切れの turn は数えない", async (t) => {
  // 201 の許可（00:20 + 300 秒）は切れ、205 の質問（00:20 + 900 秒）は残る
  const { server } = await setup(t, { at: new Date("2026-11-14T00:26:00Z") });
  const result = await topics(server);
  const expired = byId(result, "ch:201")!;
  assert.deepEqual([expired.turn, expired.mark], [null, null]);
  assert.equal(result.turnIds.includes("ch:201"), false);
  assert.equal(byId(result, "ch:205")!.turn?.kind, "question");
  assert.deepEqual(result.turnIds, ["ch:205", "ch:203"]);
});

test("web topics: /close の確認は下書きが無ければ数えない", async (t) => {
  const { server, topicSessions } = await setup(t);
  topicSessions.clearCloseDraft("203");
  const result = await topics(server);
  assert.equal(byId(result, "ch:203")!.turn, null);
  assert.equal(result.turnIds.includes("ch:203"), false);
});

test("web topics: General のセッションは群 general（place.dir は General の名前）、軽いセッションは place.dir が null。General は群 p: に出ない", async (t) => {
  const { server, topicSessions } = await setup(t, { general: true });
  topicSessions.create({ channelId: "206", guildId: GUILD, title: "場所を決めない用事", categoryId: "c" });
  topicSessions.setProject("206", "General", "default");
  const result = await topics(server);
  const general = byId(result, "ch:206")!;
  assert.deepEqual([general.origin, general.group, general.place.dir], ["project", "general", "General"]);
  assert.deepEqual([byId(result, "ch:200")!.group, byId(result, "ch:200")!.place.dir], ["general", null]);
  assert.deepEqual(
    result.groups.map((group) => [group.key, group.open]),
    [
      ["p:alpha", 1],
      ["p:beta", 1],
      ["p:empty", 0],
      ["general", 6],
    ],
  );
});

test("web topics: 端末で General を cwd に動いている Claude Code は群 general", async (t) => {
  const { server, snapshotSessions, workspace } = await setup(t, { cc: true, general: true });
  const S8 = "88888888-8888-4888-8888-888888888888";
  snapshotSessions.push(view(S8, join(workspace, "General")));
  const result = await topics(server);
  const terminal = byId(result, `cc:${S8}`)!;
  assert.deepEqual([terminal.group, terminal.place.dir], ["general", "General"]);
  assert.equal(
    result.groups.some((group) => group.key === "p:General"),
    false,
  );
});

// ---- POST /api/topics（M4a） ----

const POST_HEADERS = {
  "tailscale-user-login": LOGIN,
  "sec-fetch-site": "same-origin",
  "x-self-agent": "1",
  "content-type": "application/json",
};

function postJson(server: WebServer, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address()!.port, method: "POST", path, headers: POST_HEADERS }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/**
 * POST /api/topics の配線: /setup 済みのサーバー 111（進行中カテゴリ 500）と許可しているが /setup 前の 222。ワークスペースは alpha・link（symlink）。
 * cc（既定 true）で連携を付け、ready で共有の link の済みを変える。real なら本物の handler（FakeRunner）の submitText、ほかは偽物（next の順の結果）。
 * start を false にすると POST の配線を渡さない。clock でルートの今の時刻を進める
 */
async function startServer(
  t: TestContext,
  options: { cc?: boolean; real?: boolean; start?: boolean; allowed?: string[]; setUp?: boolean } = {},
) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { guildSettings, topicSessions, history } = stores;
  if (options.setUp !== false) {
    guildSettings.setChannel(GUILD, "inboxChannelId", "100");
    guildSettings.setChannel(GUILD, "tasksChannelId", "101");
    guildSettings.setStateCategory(GUILD, "active", 1, "500");
  }
  const workspace = realpathSync(tempDir(t));
  mkdirSync(join(workspace, "alpha"));
  symlinkSync(join(workspace, "alpha"), join(workspace, "link"));
  const places = { workspaceDir: workspace, protectedDirs: [], generalDir: "General" };
  const ready = { value: true };
  const gateway = new FakeGateway({
    allow: ["send", "sendMessage", "editMessage", "channelExists", "countChannelsIn", "startTyping"],
    record: ["createTextChannel"],
    channelIdPrefix: "900",
    messageIdPrefix: "5000",
  });
  gateway.alive.add("500");
  const connected = { value: true };
  const personas = new PersonaRouter({
    personas: [{ id: "default", name: "default", engine: "claude", runner: {} as AgentRunner, gateway, connected: () => connected.value }],
    guildSettings,
    topicSessions,
  });
  const allowed = options.allowed ?? [GUILD, GUILD_NOT_SET_UP];
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const submits: Array<{ channelId: string; content: string }> = [];
  const next: SubmitTextResult[] = [];
  const runner = new FakeRunner([
    { ok: true, text: "はい", sessionId: "session-1", usage: turnUsage(10, 0, 0), durationMs: 1000, toolCalls: 0, contextTokens: 10 },
  ]);
  const cfg = { allowedGuildIds: allowed, personas: [], publicBaseUrl: undefined, inboxChannelId: undefined };
  const real = createHandler({
    cfg: { ...cfg, ownerUserId: "owner-1", timeZone: "Asia/Tokyo" },
    resolveChannel: createChannelResolver(cfg, guildSettings, topicSessions),
    gateway: personas.ownerPosts(),
    runner,
    projectRunner: runner,
    ...stores,
    channelOps: new RecordingChannelOps(),
    queue: new KeyedSerialQueue(2),
    now: () => NOW,
    history,
    ownerConnected: () => true,
    log: () => undefined,
  });
  const clock = { now: NOW.getTime() };
  const routes = topicRoutes({
    cfg: { allowedGuildIds: allowed, personas: [], workspaceDir: workspace },
    guildSettings,
    topicSessions,
    history,
    personas,
    handler: { runningTurns: () => [] },
    places,
    home: "/home/owner",
    ...(options.start === false
      ? {}
      : {
          start: {
            gateway,
            personas,
            guildSettings,
            topicSessions,
            queue: new KeyedSerialQueue(1),
            history,
            submitText:
              options.real === true
                ? (input) => real.submitText(input)
                : async (input) => {
                    submits.push({ channelId: input.channelId, content: input.content });
                    return next.shift() ?? { result: "accepted", turnId: 1, messageId: "m-1" };
                  },
            defaultConnected: () => connected.value,
            ...(options.cc === false ? {} : { projectSessions: { places, ready: () => ready.value } }),
            log,
          },
        }),
    now: () => new Date(clock.now),
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
  return { server, gateway, topicSessions, history, ready, connected, submits, next, logs, clock, runner };
}

/** 作ったチャンネル（createTextChannel の呼び出し）の数 */
const createdCount = (gateway: FakeGateway): number => gateway.calls.filter((call) => call.method === "createTextChannel").length;

test("POST /api/topics: general は 201 で id・channelId・link・title・place・mode project・turn started。Discord にチャンネル・最初の投稿・（Web から）の写し", async (t) => {
  const s = await startServer(t, { real: true });
  const res = await postJson(s.server, "/api/topics", { place: "general", text: "京都の宿を探して" });
  assert.equal(res.status, 201);
  const channelId = res.json.channelId as string;
  assert.deepEqual(res.json, {
    id: `ch:${channelId}`,
    channelId,
    link: `https://discord.com/channels/${GUILD}/${channelId}`,
    title: "京都の宿を探して",
    place: { dir: "General" },
    mode: "project",
    turn: "started",
  });
  assert.equal(s.topicSessions.projectDirOf(channelId)?.projectDir, "General");
  assert.equal(createdCount(s.gateway), 1);
  assert.deepEqual(
    s.gateway.posts.map((post) => [post.channelId, post.message]),
    [[channelId, { text: `${WEB_ECHO_PREFIX}\n京都の宿を探して` }]],
  );
  assert.equal(s.gateway.sent[0]?.text, welcomeText("京都の宿を探して", "General"));
  // 履歴は仕切り → owner の行（その後に返事が続きうる）
  const rows = s.history.list(channelId, { limit: 10 });
  assert.deepEqual(
    rows.slice(0, 2).map((row) => [row.kind, row.source]),
    [
      ["divider", "system"],
      ["owner", "web"],
    ],
  );
  assert.ok(s.logs.includes(`Web から話題を始めました（guild=${GUILD}、プロジェクトのセッション）`));
  // 次の GET /api/topics で群 general の open の話題として出る
  const listed = await topics(s.server);
  const topic = byId(listed, `ch:${channelId}`)!;
  assert.deepEqual([topic.group, topic.state, topic.place.dir], ["general", "active", "General"]);
  // 返事のターンが済むまで待つ（後片付けの前に）
  for (let i = 0; i < 2000 && s.gateway.sent.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(s.gateway.sent.length >= 2);
  assert.equal(s.runner.inputs.length, 1);
});

test("POST /api/topics: p:<名前> はそのプロジェクトのセッション。p:<General の名前> は general と同じ", async (t) => {
  const s = await startServer(t);
  const project = await postJson(s.server, "/api/topics", { place: "p:alpha", title: "直す", text: "テストを直す" });
  assert.equal(project.status, 201);
  assert.deepEqual([project.json.mode, project.json.place, project.json.turn], ["project", { dir: "alpha" }, "started"]);
  assert.equal(s.topicSessions.projectDirOf(project.json.channelId as string)?.projectDir, "alpha");
  const listed = await topics(s.server);
  assert.equal(byId(listed, project.json.id as string)?.group, "p:alpha");

  const general = await postJson(s.server, "/api/topics", { place: "p:General", title: "雑用" });
  assert.equal(general.status, 201);
  assert.deepEqual([general.json.mode, general.json.place, general.json.turn], ["project", { dir: "General" }, "none"]);
  assert.deepEqual(
    s.history.list(general.json.channelId as string, { limit: 10 }).map((row) => row.text),
    ["General で始めました"],
  );
});

test("POST /api/topics: 連携が無ければ general は 201 で mode light・place.dir null、p: は 409 cc_disabled", async (t) => {
  const s = await startServer(t, { cc: false });
  const light = await postJson(s.server, "/api/topics", { place: "general", title: "雑談" });
  assert.equal(light.status, 201);
  assert.deepEqual([light.json.mode, light.json.place], ["light", { dir: null }]);
  assert.ok(s.logs.includes(`Web から話題を始めました（guild=${GUILD}、軽いセッション）`));
  assert.deepEqual(await postJson(s.server, "/api/topics", { place: "p:alpha", title: "x" }), { status: 409, json: { error: "cc_disabled" } });
  // 共有の link が無ければ p: は 503、general は軽いセッション
  const t2 = await startServer(t);
  t2.ready.value = false;
  assert.deepEqual(await postJson(t2.server, "/api/topics", { place: "p:alpha", title: "x" }), { status: 503, json: { error: "unify_not_ready" } });
  const fallback = await postJson(t2.server, "/api/topics", { place: "general", title: "x" });
  assert.deepEqual([fallback.status, fallback.json.mode], [201, "light"]);
});

test("POST /api/topics: place の形が違う・other・型が違う・許可していない guildId は 400 bad_request。空は 400 empty、長すぎは 400 too_long と field", async (t) => {
  const s = await startServer(t);
  const bad = [
    {},
    { place: "other", title: "x" },
    { place: "p:../x", title: "x" },
    { place: "p:a/b", title: "x" },
    { place: "/", title: "x" },
    { place: "alpha", title: "x" },
    { place: 1, title: "x" },
    { place: "general", title: 1 },
    { place: "general", text: ["x"] },
    { place: "general", title: "x", guildId: 111 },
    { place: "general", title: "x", guildId: "999" },
  ];
  for (const body of bad) {
    assert.deepEqual(await postJson(s.server, "/api/topics", body), { status: 400, json: { error: "bad_request" } }, JSON.stringify(body));
  }
  assert.deepEqual(await postJson(s.server, "/api/topics", { place: "general", title: " ", text: "\n" }), { status: 400, json: { error: "empty" } });
  assert.deepEqual(await postJson(s.server, "/api/topics", { place: "general", title: "a".repeat(101) }), {
    status: 400,
    json: { error: "too_long", field: "title" },
  });
  assert.deepEqual(await postJson(s.server, "/api/topics", { place: "general", text: "a".repeat(1901) }), {
    status: 400,
    json: { error: "too_long", field: "text" },
  });
  assert.deepEqual(await postJson(s.server, "/api/topics", { place: "p:link", title: "x" }), { status: 400, json: { error: "invalid_project" } });
  assert.deepEqual(await postJson(s.server, "/api/topics", { place: "p:missing", title: "x" }), { status: 400, json: { error: "invalid_project" } });
  assert.equal(createdCount(s.gateway), 0);
  assert.equal(s.submits.length, 0);
});

test("POST /api/topics: Bot が未接続は 503 bot_disconnected、/setup 済みのサーバーが無ければ 409 not_set_up で、どちらも作らない", async (t) => {
  const s = await startServer(t);
  s.connected.value = false;
  assert.deepEqual(await postJson(s.server, "/api/topics", { place: "general", title: "x" }), { status: 503, json: { error: "bot_disconnected" } });
  s.connected.value = true;
  // /setup 前のサーバーを名指し
  assert.deepEqual(await postJson(s.server, "/api/topics", { place: "general", title: "x", guildId: GUILD_NOT_SET_UP }), {
    status: 409,
    json: { error: "not_set_up" },
  });
  const none = await startServer(t, { setUp: false });
  assert.deepEqual(await postJson(none.server, "/api/topics", { place: "general", title: "x" }), { status: 409, json: { error: "not_set_up" } });
  assert.equal(createdCount(s.gateway) + createdCount(none.gateway), 0);
});

test("POST /api/topics: 同じ内容を 5 秒以内に 2 回送っても作るのは 1 つで、同じ応答。5 秒を過ぎれば 2 つ目を作る", async (t) => {
  assert.equal(TOPIC_START_DUPLICATE_MS, WEB_DUPLICATE_WINDOW_MS);
  const s = await startServer(t);
  const body = { place: "general", title: "旅行", text: "宿を探す" };
  const [first, second] = await Promise.all([postJson(s.server, "/api/topics", body), postJson(s.server, "/api/topics", body)]);
  assert.equal(first.status, 201);
  assert.deepEqual(second, first);
  // 正規化して同じなら同じ内容
  s.clock.now += TOPIC_START_DUPLICATE_MS - 1;
  assert.deepEqual(await postJson(s.server, "/api/topics", { place: "p:General", title: " 旅行 ", text: "宿を探す\n" }), first);
  assert.equal(createdCount(s.gateway), 1);
  assert.equal(s.submits.length, 1);
  s.clock.now += 1;
  const third = await postJson(s.server, "/api/topics", body);
  assert.equal(third.status, 201);
  assert.notEqual(third.json.channelId, first.json.channelId);
  assert.equal(createdCount(s.gateway), 2);
  // Bot が切れているときは 503（二重の判定より前で返る）
  s.connected.value = false;
  const other = { place: "general", title: "別" };
  assert.equal((await postJson(s.server, "/api/topics", other)).status, 503);
  s.connected.value = true;
  assert.equal((await postJson(s.server, "/api/topics", other)).status, 201);
  // 201 でなかった応答は覚えない（すぐやり直せる）
  s.ready.value = false;
  const retry = { place: "p:alpha", title: "x" };
  assert.deepEqual(await postJson(s.server, "/api/topics", retry), { status: 503, json: { error: "unify_not_ready" } });
  s.ready.value = true;
  assert.equal((await postJson(s.server, "/api/topics", retry)).status, 201);
});

test("POST /api/topics: 最初の一言が受け付けられなければ 201 で turn failed", async (t) => {
  const s = await startServer(t);
  s.next.push({ result: "echo_failed" });
  const res = await postJson(s.server, "/api/topics", { place: "general", text: "本文" });
  assert.deepEqual([res.status, res.json.turn], [201, "failed"]);
  assert.equal(s.topicSessions.get(res.json.channelId as string)?.state, "active");
});

test("POST /api/topics: start の配線が無ければ受けない（405 で、何も作らない）", async (t) => {
  const s = await startServer(t, { start: false });
  const res = await postJson(s.server, "/api/topics", { place: "general", title: "x" });
  assert.deepEqual(res, { status: 405, json: { error: "method_not_allowed" } });
  assert.equal(createdCount(s.gateway), 0);
});

// ---- 場所の付け替え（M5b） ----

const MOVE_NOTE = "- 目的: alpha の作業の続き\n- 触ったファイル: notes.md";

function moveOk(text: string): FakeRunStep {
  return { ok: true, text, sessionId: SP, usage: turnUsage(10, 0, 0), durationMs: 1000, toolCalls: 0, contextTokens: 10 };
}

/** 付け替えの途中（running の行）なら ["running"] */
const moveStates = (env: { moves: TopicMoveStore }, channelId: string): string[] => (env.moves.runningChannels().has(channelId) ? ["running"] : []);

test("POST /api/topics/ch:<id>/place: 受け付けると 202 { accepted: true }。終わると場所が変わり、チャンネルに結果を 1 通投稿する", async (t) => {
  const s = await setup(t, { move: "cc", general: true, moveSteps: [moveOk(MOVE_NOTE)] });
  const res = await postJson(s.server, "/api/topics/ch:201/place", { place: "general" });
  assert.deepEqual(res, { status: 202, json: { accepted: true } });
  await s.waitPosts(1);
  assert.deepEqual(s.posts, [{ channelId: "201", text: movedPostText({ from: "alpha", to: "General", note: MOVE_NOTE }, "General") }]);
  assert.deepEqual(s.topicSessions.projectDirOf("201"), { projectDir: "General", permissionMode: "default" });
  assert.equal(s.sessions.get("201"), undefined);
  assert.equal(s.moveRunner.inputs.length, 1);
  assert.deepEqual(moveStates(s, "201"), []);
  // 履歴の仕切りと知らせは moveTopic が書く
  const rows = s.history.list("201", { limit: 10 });
  assert.ok(rows.some((row) => row.kind === "divider" && row.text === "場所を alpha から General に変えました"));
  // 一覧の place も新しい場所になる
  assert.equal(byId(await topics(s.server), "ch:201")!.place.dir, "General");
});

test("POST /api/topics/ch:<id>/place: place が無い・文字列でない・other・形が違えば 400 bad_request で、何も変えない", async (t) => {
  const s = await setup(t, { move: "cc", general: true });
  for (const body of [{}, { place: 1 }, { place: "other" }, { place: "p:../x" }, { place: "p:" }, { place: "alpha" }, { place: null }]) {
    assert.deepEqual(await postJson(s.server, "/api/topics/ch:200/place", body), { status: 400, json: { error: "bad_request" } }, JSON.stringify(body));
  }
  assert.equal(s.topicSessions.projectDirOf("200"), undefined);
  assert.equal(s.moves.runningChannels().size, 0);
  assert.deepEqual(s.posts, []);
});

test("POST /api/topics/ch:<id>/place: 知らないチャンネル・許可していないサーバーの話題は 404 not_found", async (t) => {
  const s = await setup(t, { move: "cc", general: true, allowed: [GUILD] });
  for (const id of ["999", "400"]) {
    assert.deepEqual(await postJson(s.server, `/api/topics/ch:${id}/place`, { place: "p:beta" }), { status: 404, json: { error: "not_found" } }, id);
  }
  assert.equal(s.topicSessions.projectDirOf("400"), undefined);
  // cc:<sessionId> の話題はパスが当たらない
  assert.equal((await postJson(s.server, `/api/topics/cc:${S3}/place`, { place: "p:beta" })).status, 404);
});

test("POST /api/topics/ch:<id>/place: 断りの status と error（closed・persona・closing・busy・same_place・cc_disabled は 409、unify_not_ready は 503、invalid_project は 400）。どれも投稿しない・場所を変えない", async (t) => {
  const s = await setup(t, { move: "cc", general: true, running: ["205"] });
  s.topicSessions.saveCloseDraft("204", { summary: "要約", tasks: [] });
  const cases: Array<[string, string, number, string]> = [
    ["202", "p:beta", 409, "closed"],
    ["203", "p:beta", 409, "persona"],
    ["204", "p:beta", 409, "closing"],
    ["205", "p:alpha", 409, "busy"],
    ["201", "p:alpha", 409, "same_place"],
    ["200", "p:nope", 400, "invalid_project"],
  ];
  for (const [id, place, status, error] of cases) {
    assert.deepEqual(await postJson(s.server, `/api/topics/ch:${id}/place`, { place }), { status, json: { error } }, id);
  }
  s.ready.value = false;
  assert.deepEqual(await postJson(s.server, "/api/topics/ch:200/place", { place: "p:beta" }), { status: 503, json: { error: "unify_not_ready" } });
  const noCc = await setup(t, { move: "noCc", general: true });
  assert.deepEqual(await postJson(noCc.server, "/api/topics/ch:200/place", { place: "p:beta" }), { status: 409, json: { error: "cc_disabled" } });

  for (const env of [s, noCc]) {
    assert.deepEqual(env.posts, []);
    assert.equal(env.moveRunner.inputs.length, 0);
    assert.equal(env.topicSessions.projectDirOf("200"), undefined);
    assert.deepEqual(env.topicSessions.projectDirOf("201"), { projectDir: "alpha", permissionMode: "default" });
    assert.equal(env.moves.runningChannels().size, 0);
  }
});

test("POST /api/topics/ch:<id>/place: 続けて 2 回送ると 2 つ目は 409 moving で、要点のターンは 1 回", async (t) => {
  const s = await setup(t, { move: "cc", general: true, moveSteps: [moveOk(MOVE_NOTE)] });
  let release!: () => void;
  s.moveRunner.gates[0] = new Promise<void>((resolve) => {
    release = resolve;
  });
  assert.deepEqual(await postJson(s.server, "/api/topics/ch:201/place", { place: "p:beta" }), { status: 202, json: { accepted: true } });
  assert.deepEqual(await postJson(s.server, "/api/topics/ch:201/place", { place: "general" }), { status: 409, json: { error: "moving" } });
  // 途中は一覧で「場所を変えています」
  assert.deepEqual(byId(await topics(s.server), "ch:201")!.movable, { reason: "場所を変えています" });
  release();
  await s.waitPosts(1);
  assert.equal(s.moveRunner.inputs.length, 1);
  assert.deepEqual(s.topicSessions.projectDirOf("201"), { projectDir: "beta", permissionMode: "default" });
  assert.equal(s.posts.length, 1);
});

test("POST /api/topics/ch:<id>/place: 要点のターンが失敗したら、202 の後でチャンネルに失敗の文を投稿し、場所は変わらない", async (t) => {
  const s = await setup(t, {
    move: "cc",
    general: true,
    moveSteps: [{ ok: false, errorMessage: "error_during_execution: boom", sessionId: SP, sessionRecorded: true, toolCalls: 0 }],
  });
  assert.deepEqual(await postJson(s.server, "/api/topics/ch:201/place", { place: "p:beta" }), { status: 202, json: { accepted: true } });
  await s.waitPosts(1);
  assert.deepEqual(s.posts, [{ channelId: "201", text: MOVE_FAILED_TEXT }]);
  assert.deepEqual(s.topicSessions.projectDirOf("201"), { projectDir: "alpha", permissionMode: "default" });
  assert.equal(s.sessions.get("201"), SP);
  assert.equal(s.moves.runningChannels().size, 0);
});

test("POST /api/topics/ch:<id>/place: 結果の投稿が投げても 202 のまま。log だけ（種類だけ）で、場所は変わる", async (t) => {
  const s = await setup(t, { move: "cc", general: true });
  s.postFails.value = true;
  assert.deepEqual(await postJson(s.server, "/api/topics/ch:200/place", { place: "general" }), { status: 202, json: { accepted: true } });
  await s.waitLog((line) => line.includes("投稿できませんでした"));
  assert.ok(s.logs.includes("場所の付け替えの結果を Discord に投稿できませんでした（TypeError）"), s.logs.join("\n"));
  assert.deepEqual(s.topicSessions.projectDirOf("200"), { projectDir: "General", permissionMode: "default" });
  assert.deepEqual(s.posts, []);
});

test("POST /api/topics/ch:<id>/place: 受け付けた後に moveTopic が投げたら、202 の後でチャンネルに失敗の文・履歴に知らせ。running の行は残らない", async (t) => {
  const s = await setup(t, { move: "cc", general: true });
  s.sessions.get = () => {
    throw new TypeError("boom");
  };
  assert.deepEqual(await postJson(s.server, "/api/topics/ch:201/place", { place: "p:beta" }), { status: 202, json: { accepted: true } });
  await s.waitPosts(1);
  assert.deepEqual(s.posts, [{ channelId: "201", text: MOVE_FAILED_TEXT }]);
  assert.ok(s.history.list("201", { limit: 10 }).some((row) => row.kind === "notice" && row.text === MOVE_FAILED_TEXT));
  assert.equal(s.moves.runningChannels().size, 0);
  assert.deepEqual(s.topicSessions.projectDirOf("201"), { projectDir: "alpha", permissionMode: "default" });
  assert.ok(s.logs.includes("Web からの場所の付け替えに失敗しました（TypeError）"), s.logs.join("\n"));
});

test("POST /api/topics/ch:<id>/place: 受け付けた後（枠待ちの間）に閉じられたら、チャンネルに「場所を変えられませんでした: …」1 通と履歴の知らせ", async (t) => {
  const s = await setup(t, { move: "cc", general: true });
  // セッションの枠（1）を別のジョブでふさぐ
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = s.turnQueue.run(
    "other",
    () => {
      started();
      return gate;
    },
    { session: true },
  );
  await running;
  assert.deepEqual(await postJson(s.server, "/api/topics/ch:200/place", { place: "p:beta" }), { status: 202, json: { accepted: true } });
  s.topicSessions.close("200", "要約");
  release();
  await blocker;
  await s.waitPosts(1);
  const refused = "場所を変えられませんでした: 完了した話題は場所を変えられません";
  assert.deepEqual(s.posts, [{ channelId: "200", text: refused }]);
  assert.equal(s.history.list("200", { limit: 10 }).filter((row) => row.kind === "notice" && row.text === refused).length, 1);
  assert.equal(s.topicSessions.projectDirOf("200"), undefined);
  assert.equal(s.moves.runningChannels().size, 0);
});

test("POST /api/topics/ch:<id>/place: パスの ch%3A<id> は当たらず 404", async (t) => {
  const s = await setup(t, { move: "cc", general: true });
  assert.equal((await postJson(s.server, "/api/topics/ch%3A200/place", { place: "p:beta" })).status, 404);
  assert.equal(s.topicSessions.projectDirOf("200"), undefined);
  assert.equal(s.moves.runningChannels().size, 0);
});

test("POST /api/topics/ch:<id>/place: p:<General の名前> は general と同じ", async (t) => {
  const s = await setup(t, { move: "cc", general: true });
  // 会話の無い話題（200）はターンを使わずに場所だけ変える
  assert.deepEqual(await postJson(s.server, "/api/topics/ch:200/place", { place: "p:General" }), { status: 202, json: { accepted: true } });
  await s.waitPosts(1);
  assert.deepEqual(s.topicSessions.projectDirOf("200"), { projectDir: "General", permissionMode: "default" });
  assert.deepEqual(s.posts, [{ channelId: "200", text: movedPostText({ from: null, to: "General", note: null }, "General") }]);
  assert.equal(s.moveRunner.inputs.length, 0);
  assert.deepEqual(s.topicCalls, [{ channelId: "200", topic: "家計簿（General）" }]);
});

test("POST /api/topics/ch:<id>/place: log に題名・チャンネル ID・プロジェクトの名前・要点が出ない", async (t) => {
  const s = await setup(t, { move: "cc", general: true, moveSteps: [moveOk(MOVE_NOTE)] });
  assert.equal((await postJson(s.server, "/api/topics/ch:201/place", { place: "general" })).status, 202);
  assert.equal((await postJson(s.server, "/api/topics/ch:200/place", { place: "p:beta" })).status, 202);
  await s.waitPosts(2);
  assert.ok(s.logs.some((line) => line.includes("Web から場所の付け替えを受け付けました（guild=111）")), s.logs.join("\n"));
  for (const line of s.logs) {
    for (const secret of ["alpha", "beta", "General", "家計簿", "200", "201", "notes.md", "目的"]) assert.ok(!line.includes(secret), `${secret}: ${line}`);
  }
});

test("GET /api/topics: move があるとき、足した人格の話題・完了した話題・付け替えの途中の話題・連携が無いときの話題は movable に理由。既定の人格の進行中・待ちの話題は true。入口と Claude Code のセッションは今までどおり", async (t) => {
  const s = await setup(t, { move: "cc", general: true, cc: true });
  s.topicSessions.create({ channelId: "206", guildId: GUILD, title: "待ちの話", categoryId: "c" });
  s.topicSessions.setWaiting("206");
  s.moves.start({ channelId: "205", fromDir: "beta", toDir: "alpha", by: "discord" });
  const result = await topics(s.server, "/api/topics?done=general");
  assert.deepEqual(byId(result, "ch:203")!.movable, { reason: "足した人格の話題は場所を変えられません" });
  assert.deepEqual(byId(result, "ch:202")!.movable, { reason: "完了した話題は場所を変えられません" });
  assert.deepEqual(byId(result, "ch:205")!.movable, { reason: "場所を変えています" });
  for (const id of ["ch:200", "ch:201", "ch:204", "ch:206"]) assert.equal(byId(result, id)!.movable, true, id);
  assert.deepEqual(byId(result, "ch:101")!.movable, { reason: "入口は場所を変えられません" });
  assert.deepEqual(byId(result, "ch:300")!.movable, { reason: "端末のセッションは場所を変えられません" });

  const noCc = await setup(t, { move: "noCc", general: true });
  const without = await topics(noCc.server);
  assert.deepEqual(byId(without, "ch:200")!.movable, { reason: "場所を変えるには Claude Code の連携が要ります" });
  // 人格の理由が先
  assert.deepEqual(byId(without, "ch:203")!.movable, { reason: "足した人格の話題は場所を変えられません" });
});

test("GET /api/topics: movable の理由の順は POST と同じ（完了 → 足した人格）。連携の設定が済んでいなければ unify_not_ready の文", async (t) => {
  const s = await setup(t, { move: "cc", general: true });
  // 完了 + 足した人格は「完了」
  s.topicSessions.close("203", "要約");
  s.ready.value = false;
  const result = await topics(s.server, "/api/topics?done=general");
  assert.deepEqual(byId(result, "ch:203")!.movable, { reason: "完了した話題は場所を変えられません" });
  for (const id of ["ch:200", "ch:201"]) assert.deepEqual(byId(result, id)!.movable, { reason: moveRefusalText("unify_not_ready") }, id);
  assert.deepEqual(byId(result, "ch:202")!.movable, { reason: "完了した話題は場所を変えられません" });
});

test("GET /api/topics: move を渡さなければ movable は今までどおり", async (t) => {
  const s = await setup(t);
  s.moves.start({ channelId: "200", fromDir: null, toDir: "alpha", by: "web" });
  const result = await topics(s.server, "/api/topics?done=general");
  for (const id of ["ch:200", "ch:201", "ch:202", "ch:203"]) assert.equal(byId(result, id)!.movable, true, id);
  // 付け替えのルートも無い
  assert.equal((await postJson(s.server, "/api/topics/ch:200/place", { place: "p:beta" })).status, 404);
});

// ---- createTopicCollector（M6b。右腕の topic_list と同じ元） ----

test("createTopicCollector: 同じ依存で集めて buildTopics した物が GET /api/topics の中身と同じ", async (t) => {
  const db = tempDb(t);
  const { guildSettings, topicSessions, history } = createStores(db, () => NOW);
  const workspace = realpathSync(tempDir(t));
  mkdirSync(join(workspace, "alpha"));
  guildSettings.setChannel(GUILD, "inboxChannelId", "100");
  guildSettings.setChannel(GUILD, "tasksChannelId", "101");
  topicSessions.create({ channelId: "200", guildId: GUILD, title: "家計簿", categoryId: "c" });
  topicSessions.create({ channelId: "201", guildId: GUILD, title: "alpha の作業", categoryId: "c" });
  topicSessions.setProject("201", "alpha", "default");
  history.add({ guildId: GUILD, channelId: "200", kind: "owner", source: "web", text: "一言" });
  const ccStore = new CcChannelStore(db, () => EARLIER);
  ccStore.create({ channelId: "300", guildId: GUILD, sessionId: S1, name: "cc-alpha", cwd: join(workspace, "alpha"), origin: "web" });
  const snapshotSessions = [view(S1, join(workspace, "alpha"), { state: "running" }), view(S3, "/somewhere/else", { state: "needs_input" })];
  const personas = new PersonaRouter({
    personas: [{ id: "default", name: "default", engine: "claude", runner: {} as AgentRunner, gateway: {} as Gateway, connected: () => true }],
    guildSettings,
    topicSessions,
  });
  const deps: TopicRouteDeps = {
    cfg: { allowedGuildIds: [GUILD], personas: [], workspaceDir: workspace },
    guildSettings,
    topicSessions,
    history,
    personas,
    handler: { runningTurns: (): RunningTurn[] => [{ guildId: GUILD, channelId: "200" } as RunningTurn] },
    places: { workspaceDir: workspace, protectedDirs: [] },
    home: "/home/owner",
    cc: {
      registry: { snapshot: () => ({ sessions: snapshotSessions, stale: false, unreadable: false, fetchedAt: NOW.getTime() }), touch: () => undefined },
      channels: ccStore,
      permissions: new CcPermissionStore(db, () => EARLIER),
      sends: new CcSendStore(db, () => EARLIER),
      starts: new CcStartStore(db, () => EARLIER),
      holdSec: 300,
      questionHoldSec: 900,
    },
    now: () => NOW,
  };
  const server = createWebServer({
    host: "127.0.0.1",
    port: 0,
    allowedLogin: LOGIN,
    staticDir: tempDir(t),
    templateSiteDir: tempDir(t),
    routes: topicRoutes(deps),
    stopping: () => false,
    now: () => NOW,
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());
  const fromRoute = await topics(server);
  const fromCollector = JSON.parse(JSON.stringify(buildTopics(createTopicCollector(deps)(NOW.getTime(), null)))) as TopicsResult;
  assert.deepEqual(fromCollector, fromRoute);
  assert.ok(fromRoute.topics.length >= 4);
});
