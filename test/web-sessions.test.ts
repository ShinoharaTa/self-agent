import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AgentRunner, RunInput, RunResult } from "../src/agent/runner.ts";
import { createSessionToolHandlers, type SessionReportArgs } from "../src/agent/tools.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { CLOSE_PROMPT, closedText, confirmButtons, confirmText, SUMMARY_FAILURE_REPLY } from "../src/app/commands/close.ts";
import type { RotateNowResult } from "../src/app/inbox-rotate.ts";
import { PersonaRouter } from "../src/app/personas.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { confirmClose, NO_CONVERSATION_REPLY, WAITED_REPLY, CONTINUED_TEXT, welcomeText } from "../src/app/session-ops.ts";
import { renewedText } from "../src/app/session-renew.ts";
import type { PersonaConfig } from "../src/config.ts";
import type { CloseDraft, TopicSessionStore } from "../src/store/topic-sessions.ts";
import { channelRoutes } from "../src/web/routes/channels.ts";
import { CLOSE_CONFIRM_NOTICE, sessionRoutes } from "../src/web/routes/sessions.ts";
import { createWebServer, type WebServer } from "../src/web/server.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

const LOGIN = "owner@example.com";
const NOW = new Date("2026-10-02T00:12:00Z");
const GUILD = "111";
const GUILD_NOT_SET_UP = "222";
const POST_HEADERS = {
  "tailscale-user-login": LOGIN,
  "sec-fetch-site": "same-origin",
  "x-self-agent": "1",
  "content-type": "application/json",
};

const MIKA: PersonaConfig = {
  id: "mika",
  name: "ミカ",
  discordTokenEnv: "SELF_AGENT_PERSONA_MIKA_DISCORD_TOKEN",
  promptFile: "/dev/null",
  model: undefined,
  engine: "claude",
  effort: undefined,
};

const DRAFT: CloseDraft = {
  summary: "京都に 2 泊する。宿は候補を 2 つに絞った。",
  tasks: [{ title: "宿を予約する", due: "2026-10-05" }, { title: "新幹線の時刻を調べる" }, { title: "休みの申請" }],
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
    // POST の本文は JSON のオブジェクトが要る（画面は {} を送る）
    req.end(method === "GET" ? undefined : JSON.stringify(body ?? {}));
  });
}

function ok(text: string): RunResult {
  return { ok: true, text, sessionId: "session-1", usage: turnUsage(10, 2000, 300), durationMs: 4200, toolCalls: 1, contextTokens: 2310 };
}

/** session_report を呼んでから返答するターン（ツールのハンドラは run に渡された context で動く） */
function reports(args: SessionReportArgs, topicSessions: TopicSessionStore): (input: RunInput) => RunResult {
  return (input) => {
    createSessionToolHandlers(topicSessions, input.context).sessionReport(args);
    return ok("閉じる準備ができました");
  };
}

/** 背景の処理（.then の投稿まで）が済むまで待つ */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("待っている状態になりませんでした");
}

/**
 * /setup 済みのサーバー 111（#inbox 100・#tasks 101・進行中カテゴリ 500）と、許可しているが /setup 前の 222。
 * セッション 200（進行中）・201（完了）・202（削除済み）・203（許可していないサーバー）。会話のターンは steps の順
 */
async function setup(t: TestContext, steps: (topicSessions: TopicSessionStore) => Array<RunResult | Error | ((input: RunInput) => RunResult)> = () => []) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { guildSettings, topicSessions, sessions, seeds, inboxSummaries, memories, usage, projects, tasks, history } = stores;
  guildSettings.setChannel(GUILD, "inboxChannelId", "100");
  guildSettings.setChannel(GUILD, "tasksChannelId", "101");
  guildSettings.setStateCategory(GUILD, "active", 1, "500");
  topicSessions.create({ channelId: "200", guildId: GUILD, title: "旅行の計画", categoryId: "500" });
  sessions.set("200", "session-1");
  topicSessions.create({ channelId: "201", guildId: GUILD, title: "終わった話", categoryId: "500" });
  topicSessions.close("201", "要約");
  topicSessions.create({ channelId: "202", guildId: GUILD, title: "消した話", categoryId: "500" });
  topicSessions.markDeleted("202");
  topicSessions.create({ channelId: "203", guildId: "999", title: "よその話", categoryId: "x" });

  const gateway = new FakeGateway({
    allow: ["send", "sendMessage", "channelExists", "countChannelsIn"],
    record: ["createTextChannel"],
    channelIdPrefix: "900",
  });
  gateway.alive.add("500");
  const mikaGateway = new FakeGateway({ allow: ["send", "sendMessage"] });
  const connected = { value: true };
  const personas = new PersonaRouter({
    personas: [
      { id: "default", name: "default", engine: "claude", runner: {} as AgentRunner, gateway, connected: () => connected.value },
      { id: "mika", name: "ミカ", engine: "claude", runner: {} as AgentRunner, gateway: mikaGateway, connected: () => true },
    ],
    guildSettings,
    topicSessions,
  });
  const cfg = { allowedGuildIds: [GUILD, GUILD_NOT_SET_UP], personas: [MIKA], publicBaseUrl: undefined, inboxChannelId: undefined };
  const resolveChannel = createChannelResolver(cfg, guildSettings, topicSessions);
  const runner = new FakeRunner(steps(topicSessions));
  const turnQueue = new KeyedSerialQueue(2);
  const channelOps = new RecordingChannelOps();
  const rotations: Array<{ guildId: string; kind: string; persona: string }> = [];
  const rotator = { result: "no_conversation" as RotateNowResult };
  const logs: string[] = [];
  const log = (line: string): number => (line.startsWith("トークン（") ? 0 : logs.push(line));
  const turn = { runner, sessions, seeds, topicSessions, inboxSummaries, memories, usage, log };
  const routes = [
    ...channelRoutes({ cfg, guildSettings, topicSessions, projects, history, personas, resolveChannel }),
    ...sessionRoutes({
      cfg,
      resolveChannel,
      gateway,
      defaultConnected: () => connected.value,
      guildSettings,
      topicSessions,
      queue: new KeyedSerialQueue(1),
      personas,
      ownerPosts: personas.ownerPosts(),
      tasks,
      channelOps,
      turnQueue,
      turn,
      projects,
      projectsDir: tempDir(t),
      inboxRotator: {
        rotateNow: async (guildId: string, kind: string, persona: string = "default") => {
          rotations.push({ guildId, kind, persona });
          return rotator.result;
        },
      },
      history,
      log,
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
  /** そのチャンネルの履歴の行（種類と本文） */
  const rows = (channelId: string) => history.list(channelId, { limit: 50 }).map((row) => ({ kind: row.kind, text: row.text, persona: row.persona }));
  const openTasks = () => tasks.list({ status: "open", limit: 50 }).map((task) => ({ title: task.title, due: task.due }));
  return { server, gateway, mikaGateway, connected, runner, turnQueue, channelOps, rotations, rotator, logs, rows, openTasks, ...stores };
}

test("POST /api/sessions: 既定の人格の Bot で進行中カテゴリにチャンネルを作り、最初の投稿をして 201 と channelId・link。log は Web から", async (t) => {
  const env = await setup(t);
  const res = await call(env.server, "POST", "/api/sessions", { guildId: GUILD, title: "  冬の旅行  " });
  assert.deepEqual(res, { status: 201, json: { channelId: "9001", link: `https://discord.com/channels/${GUILD}/9001` } });
  assert.deepEqual(env.gateway.callsOf("createTextChannel"), [
    { method: "createTextChannel", guildId: GUILD, options: { name: "冬の旅行", parentId: "500", topic: "冬の旅行" } },
  ]);
  assert.deepEqual(env.gateway.sent, [{ channelId: "9001", text: welcomeText("冬の旅行"), replyToId: undefined }]);
  const created = env.topicSessions.get("9001");
  assert.equal(created?.title, "冬の旅行");
  assert.equal(created?.state, "active");
  assert.deepEqual(env.logs, [`Web からセッションを作りました（guild=${GUILD}）`]);

  // 既定の人格（default）を明示しても同じ
  assert.equal((await call(env.server, "POST", "/api/sessions", { guildId: GUILD, title: "b", persona: "default" })).status, 201);
  assert.equal(env.topicSessions.personaOf("9002"), "default");
});

test("POST /api/sessions: 足した人格はチャンネル名 <NAME>-<題名>・その人格の Bot が最初の投稿をする", async (t) => {
  const env = await setup(t);
  const res = await call(env.server, "POST", "/api/sessions", { guildId: GUILD, title: "相談", persona: "mika" });
  assert.equal(res.status, 201);
  assert.deepEqual(env.gateway.callsOf("createTextChannel"), [
    { method: "createTextChannel", guildId: GUILD, options: { name: "ミカ-相談", parentId: "500", topic: "相談（ミカ）" } },
  ]);
  assert.deepEqual(env.gateway.sent, []);
  assert.deepEqual(env.mikaGateway.sent, [{ channelId: "9001", text: welcomeText("相談"), replyToId: undefined }]);
  assert.equal(env.topicSessions.personaOf("9001"), "mika");
  assert.deepEqual(env.logs, [`Web からセッションを作りました（guild=${GUILD}、人格 mika）`]);
});

test("POST /api/sessions: サーバー・人格・題名の形が違えば 400、空の題名は 400 empty_title、/setup 前は 409、Bot が未接続なら 503。どれも作らない", async (t) => {
  const env = await setup(t);
  const cases: Array<[unknown, Response]> = [
    [{ title: "a" }, { status: 400, json: { error: "bad_request" } }],
    [{ guildId: "999", title: "a" }, { status: 400, json: { error: "bad_request" } }],
    [{ guildId: GUILD, title: "a", persona: "nobody" }, { status: 400, json: { error: "bad_request" } }],
    [{ guildId: GUILD, title: "a", persona: 1 }, { status: 400, json: { error: "bad_request" } }],
    [{ guildId: GUILD }, { status: 400, json: { error: "bad_request" } }],
    [{ guildId: GUILD, title: " \n " }, { status: 400, json: { error: "empty_title" } }],
    [{ guildId: GUILD, title: "あ".repeat(101) }, { status: 400, json: { error: "too_long" } }],
    [{ guildId: GUILD_NOT_SET_UP, title: "a" }, { status: 409, json: { error: "not_set_up" } }],
  ];
  for (const [body, expected] of cases) assert.deepEqual(await call(env.server, "POST", "/api/sessions", body), expected, JSON.stringify(body));
  env.connected.value = false;
  assert.deepEqual(await call(env.server, "POST", "/api/sessions", { guildId: GUILD, title: "a" }), { status: 503, json: { error: "bot_disconnected" } });
  assert.deepEqual(env.gateway.callsOf("createTextChannel"), []);
  assert.deepEqual(env.gateway.sent, []);
  // 100 字ちょうどは作る
  env.connected.value = true;
  assert.equal((await call(env.server, "POST", "/api/sessions", { guildId: GUILD, title: "あ".repeat(100) })).status, 201);
});

test("POST /wait・/continue: 待ち ⇄ 進行中に移して 200 { state } と知らせの行。既にその状態なら 200 で何もしない。無い・よそのサーバーは 404、閉じていれば 409", async (t) => {
  const env = await setup(t);
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/200/wait"), { status: 200, json: { state: "waiting" } });
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/200/wait"), { status: 200, json: { state: "waiting" } });
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/200/continue"), { status: 200, json: { state: "active" } });
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/200/continue"), { status: 200, json: { state: "active" } });
  assert.deepEqual(env.rows("200"), [
    { kind: "notice", text: WAITED_REPLY, persona: "default" },
    { kind: "notice", text: CONTINUED_TEXT, persona: "default" },
  ]);
  assert.equal(env.channelOps.moves.length, 2);

  for (const id of ["999", "203"]) {
    assert.deepEqual(await call(env.server, "POST", `/api/sessions/${id}/wait`), { status: 404, json: { error: "not_found" } }, id);
    assert.deepEqual(await call(env.server, "POST", `/api/sessions/${id}/continue`), { status: 404, json: { error: "not_found" } }, id);
  }
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/201/wait"), { status: 409, json: { error: "closed" } });
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/202/wait"), { status: 409, json: { error: "closed" } });
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/202/continue"), { status: 409, json: { error: "deleted" } });
  // 完了は [続ける] で進行中に戻る（Discord の待ちの知らせの [続ける] と同じ）
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/201/continue"), { status: 200, json: { state: "active" } });
});

test("POST /close: 202 の後に要約のターン → 候補があれば closeDraft と確認待ちの知らせ、Discord にも同じ確認（ボタン付き）。confirm で登録して閉じ、2 回目は 409", async (t) => {
  const env = await setup(t, (topicSessions) => [reports(DRAFT, topicSessions)]);
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/200/close"), { status: 202, json: { accepted: true } });
  await until(() => env.gateway.posts.length === 1);
  assert.equal(env.runner.inputs[0]?.prompt, CLOSE_PROMPT);
  assert.deepEqual(env.gateway.posts[0], {
    channelId: "200",
    messageId: "message-1",
    message: { text: confirmText(DRAFT), components: [confirmButtons("200")] },
  });
  assert.deepEqual(env.rows("200"), [{ kind: "notice", text: CLOSE_CONFIRM_NOTICE, persona: "default" }]);
  const turns = await call(env.server, "GET", "/api/channels/200/turns");
  assert.deepEqual((turns.json.channel as Record<string, unknown>).closeDraft, DRAFT);
  assert.equal(env.topicSessions.get("200")?.state, "active");

  // 選んだ候補（添字）を登録して閉じる
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/200/close/confirm", { selected: [2, 0] }), {
    status: 200,
    json: { summary: DRAFT.summary, registered: 2 },
  });
  assert.deepEqual(env.openTasks(), [
    { title: "宿を予約する", due: "2026-10-05" },
    { title: "休みの申請", due: null },
  ]);
  assert.equal(env.topicSessions.get("200")?.state, "done");
  assert.deepEqual(env.rows("200").at(-1), { kind: "divider", text: closedText(DRAFT.summary, 2), persona: "default" });
  const after = await call(env.server, "GET", "/api/channels/200/turns");
  assert.equal((after.json.channel as Record<string, unknown>).closeDraft, null);
  // 先に確定した方が勝つ（Discord の確認のボタンも no_draft になる）
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/200/close/confirm", { selected: "all" }), { status: 409, json: { error: "no_draft" } });
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/200/close"), { status: 409, json: { error: "closed" } });
  await env.turnQueue.idle();
});

test("POST /close/confirm: Discord で先に確定していれば 409 no_draft で何も変えない。selected の形が違えば 400、セッションでなければ 404", async (t) => {
  const env = await setup(t);
  env.topicSessions.saveCloseDraft("200", DRAFT);
  for (const selected of [undefined, "some", [], [-1], [1.5], ["0"], Array.from({ length: 101 }, (_v, i) => i)]) {
    assert.deepEqual(await call(env.server, "POST", "/api/sessions/200/close/confirm", { selected }), { status: 400, json: { error: "bad_request" } }, JSON.stringify(selected));
  }
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/999/close/confirm", { selected: "all" }), { status: 404, json: { error: "not_found" } });
  // Discord の [登録しない] と同じ関数で先に閉じる
  assert.equal(confirmClose(GUILD, "200", "none", { ...env, channelOps: env.channelOps, log: () => 0 }).result, "closed");
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/200/close/confirm", { selected: "all" }), { status: 409, json: { error: "no_draft" } });
  assert.deepEqual(env.openTasks(), []);
});

test("POST /close: 候補が無ければそのまま閉じて区切りの行（Discord への投稿は無い）。要約に失敗したら知らせの行。閉じられなければ 404 / 409", async (t) => {
  const env = await setup(t, (topicSessions) => [
    reports({ summary: "まとめ" }, topicSessions),
    { ok: false, errorMessage: "error_during_execution: boom", sessionId: "session-1", sessionRecorded: true, toolCalls: 0 },
  ]);
  assert.equal((await call(env.server, "POST", "/api/sessions/200/close")).status, 202);
  await until(() => env.topicSessions.get("200")?.state === "done");
  await env.turnQueue.idle();
  assert.deepEqual(env.rows("200"), [{ kind: "divider", text: closedText("まとめ", 0), persona: "default" }]);
  assert.deepEqual(env.gateway.posts, []);

  // 進行中に戻してもう一度（今度は要約のターンが失敗する）
  assert.equal((await call(env.server, "POST", "/api/sessions/200/continue")).status, 200);
  assert.equal((await call(env.server, "POST", "/api/sessions/200/close")).status, 202);
  await until(() => env.rows("200").some((row) => row.text === SUMMARY_FAILURE_REPLY));
  assert.equal(env.topicSessions.get("200")?.state, "active");
  assert.deepEqual(env.gateway.posts, []);

  for (const id of ["999", "203"]) assert.deepEqual(await call(env.server, "POST", `/api/sessions/${id}/close`), { status: 404, json: { error: "not_found" } }, id);
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/201/close"), { status: 409, json: { error: "closed" } });
  assert.deepEqual(await call(env.server, "POST", "/api/sessions/202/close"), { status: 409, json: { error: "closed" } });
  assert.equal(env.runner.inputs.length, 2);
});

test("POST /renew: セッションは 202 の後に要約して区切りの行と、結果の文を持ち主の Bot で Discord に投稿する", async (t) => {
  const env = await setup(t, () => [ok("- 京都に 2 泊")]);
  assert.deepEqual(await call(env.server, "POST", "/api/channels/200/renew"), { status: 202, json: { accepted: true } });
  await until(() => env.gateway.sent.length === 1);
  assert.deepEqual(env.gateway.sent, [{ channelId: "200", text: renewedText("- 京都に 2 泊"), replyToId: undefined }]);
  // 区切りの行は返信の 1 行目と要約（session-renew.ts）
  const headline = renewedText("- 京都に 2 泊").split("\n")[0];
  assert.deepEqual(env.rows("200"), [{ kind: "divider", text: `${headline}\n- 京都に 2 泊`, persona: "default" }]);
  assert.equal(env.sessions.get("200"), undefined);
});

test("POST /renew: #inbox は rotateNow。区切りの行を書かない結果（会話が無い）は知らせの行にして、Discord にも投稿する。対象外は 404、閉じたセッションは 409", async (t) => {
  const env = await setup(t);
  assert.equal((await call(env.server, "POST", "/api/channels/100/renew")).status, 202);
  await until(() => env.gateway.sent.length === 1);
  assert.deepEqual(env.rotations, [{ guildId: GUILD, kind: "inbox", persona: "default" }]);
  assert.deepEqual(env.gateway.sent, [{ channelId: "100", text: NO_CONVERSATION_REPLY, replyToId: undefined }]);
  assert.deepEqual(env.rows("100"), [{ kind: "notice", text: NO_CONVERSATION_REPLY, persona: "default" }]);

  for (const id of ["999", "202", "203"]) {
    assert.deepEqual(await call(env.server, "POST", `/api/channels/${id}/renew`), { status: 404, json: { error: "not_found" } }, id);
  }
  assert.deepEqual(await call(env.server, "POST", "/api/channels/201/renew"), { status: 409, json: { error: "closed" } });
  assert.equal(env.rotations.length, 1);
  assert.equal(env.runner.inputs.length, 0);
});
