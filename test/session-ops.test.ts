import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import type { RunResult } from "../src/agent/runner.ts";
import { createSessionToolHandlers } from "../src/agent/tools.ts";
import { TITLE_MAX_LENGTH } from "../src/app/commands/new.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { ChannelOpsQueue } from "../src/app/channel-ops.ts";
import { ensureGuildLayout } from "../src/app/commands/setup.ts";
import { createHandler, type Handler, type SubmitTextResult } from "../src/app/handler.ts";
import type { RotateNowResult } from "../src/app/inbox-rotate.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import {
  closeInProgress,
  closeSession,
  confirmClose,
  CONTINUED_TEXT,
  continueSession,
  createTopicChannel,
  createTopicSession,
  openTopicSession,
  type ProjectSessionGate,
  renewChannel,
  rightHandWelcomeText,
  startedDividerText,
  startTopic,
  type StartTopicInput,
  titleFromText,
  TOPIC_TEXT_MAX_LENGTH,
  TOPIC_TITLE_FROM_TEXT_MAX,
  TOPIC_TITLE_MAX_LENGTH,
  UNTITLED_TOPIC,
  WAITED_REPLY,
  waitSession,
  welcomeText,
} from "../src/app/session-ops.ts";
import type { SummaryChannelKind } from "../src/store/inbox-summaries.ts";
import { WEB_MESSAGE_MAX_LENGTH } from "../src/web/routes/turns.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps, RecordingQueue } from "./helpers/recording.ts";
import { FakeRunner, type FakeRunStep, turnUsage } from "./helpers/runner.ts";

const NOW = new Date("2026-10-02T00:12:00Z");
const TOPIC = { channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" };

function ok(text: string): RunResult {
  return { ok: true, text, sessionId: "session-1", usage: turnUsage(10, 2000, 300), durationMs: 4200, toolCalls: 0, contextTokens: 2310 };
}

const FAILED: RunResult = {
  ok: false,
  errorMessage: "error_during_execution: boom",
  sessionId: "session-1",
  sessionRecorded: true,
  toolCalls: 0,
};

class FakeRotator {
  calls: SummaryChannelKind[] = [];
  async rotateNow(_guildId: string, kind: SummaryChannelKind): Promise<RotateNowResult> {
    this.calls.push(kind);
    return "rotated";
  }
}

function setup(t: TestContext, steps: FakeRunStep[] = []) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { topicSessions, tasks, sessions, seeds, inboxSummaries, memories, usage, projects, history, guildSettings } = stores;
  const runner = new FakeRunner(steps);
  const channelOps = new RecordingChannelOps();
  const turnQueue = new RecordingQueue(2);
  const inboxRotator = new FakeRotator();
  const logs: string[] = [];
  const log = (line: string): number => logs.push(line);
  const deps = {
    topicSessions,
    tasks,
    channelOps,
    turnQueue,
    turn: { runner, sessions, seeds, topicSessions, inboxSummaries, memories, usage, log },
    projects,
    projectsDir: join(tempDir(t), "projects"),
    guildSettings,
    inboxRotator,
    history,
    log,
  };
  topicSessions.create(TOPIC);
  sessions.set("topic-1", "session-1");
  guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  /** 受け付けた（onAccepted を呼んだ）回数 */
  const accepted = { count: 0 };
  const onAccepted = async (): Promise<void> => {
    accepted.count += 1;
  };
  return { deps, runner, history, inboxRotator, logs, accepted, onAccepted };
}

test("openTopicSession: 空の題名は empty_title（受け付けない）、/setup 前は not_set_up、作れたら created と最初の投稿", async (t) => {
  const db = tempDb(t);
  const gateway = new FakeGateway({
    allow: ["getParentId", "sendMessage", "pinMessage", "messageExists"],
    record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn", "moveChannel", "send"],
  });
  const { guildSettings, topicSessions } = createStores(db, () => NOW);
  const channelOps = { enqueueMove: () => assert.fail("想定外の移動") };
  const deps = { gateway, guildSettings, topicSessions, queue: new KeyedSerialQueue(1), channelOps, log: () => {} };
  let accepted = 0;
  const onAccepted = async (): Promise<void> => {
    accepted += 1;
  };

  assert.deepEqual(await openTopicSession("guild-1", "  ", undefined, deps, "/new で", onAccepted), { result: "empty_title" });
  assert.equal(accepted, 0);
  assert.deepEqual(await openTopicSession("guild-1", "旅行", undefined, deps, "/new で", onAccepted), { result: "not_set_up" });
  assert.equal(accepted, 1);

  assert.equal((await ensureGuildLayout("guild-1", deps)).failure, null);
  gateway.reset();
  const result = await openTopicSession("guild-1", " 旅行 ", undefined, deps, "/new で", onAccepted);
  assert.equal(result.result, "created");
  assert.ok(result.result === "created");
  assert.equal(topicSessions.get(result.channelId)?.title, "旅行");
  assert.deepEqual(
    gateway.sent.map((sent) => ({ channelId: sent.channelId, text: sent.text })),
    [{ channelId: result.channelId, text: welcomeText("旅行") }],
  );
});

test("createTopicChannel: /setup 前は not_set_up で何も作らない", async (t) => {
  const db = tempDb(t);
  const gateway = new FakeGateway({ record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn"] });
  const { guildSettings, topicSessions } = createStores(db, () => NOW);

  assert.deepEqual(await createTopicChannel("guild-1", "旅行", { gateway, guildSettings, log: () => {} }, undefined, "app"), { result: "not_set_up" });
  assert.deepEqual(gateway.calls, []);
  assert.deepEqual(topicSessions.listUndeleted("guild-1"), []);
});

test("createTopicChannel: 作ると sessions に行が無く、名前・topic・親は createTopicSession と同じ", async (t) => {
  const db = tempDb(t);
  const gateway = new FakeGateway({
    allow: ["getParentId", "sendMessage", "pinMessage", "messageExists", "moveChannel", "send"],
    record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn"],
  });
  const { guildSettings, topicSessions } = createStores(db, () => NOW);
  const deps = { gateway, guildSettings, topicSessions, queue: new KeyedSerialQueue(1), log: () => {} };
  assert.equal((await ensureGuildLayout("guild-1", deps)).failure, null);

  gateway.reset();
  const channel = await createTopicChannel("guild-1", "旅行", deps, undefined, "app");
  assert.equal(channel.result, "created");
  assert.ok(channel.result === "created");
  assert.equal(topicSessions.get(channel.channelId), undefined);
  assert.deepEqual(topicSessions.listUndeleted("guild-1"), []);
  const channelOptions = gateway.callsOf("createTextChannel").map((call) => (call.method === "createTextChannel" ? call.options : undefined));

  gateway.reset();
  const session = await createTopicSession("guild-1", "旅行", deps, "command", undefined, "app");
  assert.ok(session.result === "created");
  const sessionOptions = gateway.callsOf("createTextChannel").map((call) => (call.method === "createTextChannel" ? call.options : undefined));
  assert.deepEqual(channelOptions, sessionOptions);
  assert.equal(channelOptions.length, 1);
  assert.equal(channel.categoryId, channelOptions[0]?.parentId);
  assert.equal(topicSessions.get(session.channelId)?.categoryId, channel.categoryId);
});

test("waitSession・continueSession: 結果の種類と、変えたときだけ history の知らせ", (t) => {
  const env = setup(t);
  const notices = (): string[] => env.history.list("topic-1", { limit: 50 }).map((row) => `${row.kind}:${row.text}`);

  assert.equal(waitSession("guild-1", "unknown", env.deps), "not_session");
  assert.equal(waitSession("guild-2", "topic-1", env.deps), "not_session");
  assert.equal(continueSession("guild-1", "unknown", env.deps), "not_session");
  assert.equal(continueSession("guild-1", "topic-1", env.deps), "unchanged");
  assert.equal(waitSession("guild-1", "topic-1", env.deps), "waited");
  assert.equal(waitSession("guild-1", "topic-1", env.deps), "unchanged");
  assert.equal(continueSession("guild-1", "topic-1", env.deps), "continued");
  assert.deepEqual(notices(), [`notice:${WAITED_REPLY}`, `notice:${CONTINUED_TEXT}`]);

  env.deps.topicSessions.close("topic-1", "要約");
  assert.equal(waitSession("guild-1", "topic-1", env.deps), "closed");
  env.deps.topicSessions.markDeleted("topic-1");
  assert.equal(waitSession("guild-1", "topic-1", env.deps), "closed");
  assert.equal(continueSession("guild-1", "topic-1", env.deps), "deleted");
});

test("waitSession・continueSession・閉じる（#530 の WP3）: ローカルの話題は状態だけ変わり、本物の移動の列から Discord を 1 度も呼ばない。Discord の話題は今と同じに 3 回移す", async (t) => {
  const env = setup(t, [ok("閉じました"), ok("閉じました")]);
  const gateway = new FakeGateway({ record: ["getParentId", "moveChannel", "channelExists", "countChannelsIn", "createCategory"] });
  for (const state of ["active", "waiting", "done"] as const) {
    env.deps.guildSettings.setStateCategory("guild-1", state, 1, `${state}-1`);
    gateway.alive.add(`${state}-1`);
  }
  gateway.parents.set("topic-1", "active-1");
  const channelOps = new ChannelOpsQueue({
    gateway,
    guildSettings: env.deps.guildSettings,
    topicSessions: env.deps.topicSessions,
    gapMs: 0,
    timers: { sleep: async () => {} },
    log: (line) => env.logs.push(line),
  });
  const deps = { ...env.deps, channelOps };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await flush();
    await channelOps.idle();
  };
  const local = "100000000000000000001";
  deps.topicSessions.create({ channelId: local, guildId: "guild-1", title: "ローカル", categoryId: "local", place: "local" });
  deps.turn.sessions.set(local, "session-local");

  assert.equal(waitSession("guild-1", local, deps), "waited");
  await settle();
  assert.equal(deps.topicSessions.get(local)?.state, "waiting");
  assert.equal(continueSession("guild-1", local, deps), "continued");
  await settle();
  assert.equal(deps.topicSessions.get(local)?.state, "active");
  assert.deepEqual(await closeSession("guild-1", local, deps, env.onAccepted), { result: "finalized", summary: "閉じました" });
  await settle();
  assert.equal(deps.topicSessions.get(local)?.state, "done");
  assert.equal(deps.topicSessions.get(local)?.categoryId, "local");
  assert.deepEqual(gateway.callsOf("getParentId", "moveChannel", "channelExists", "countChannelsIn", "createCategory"), []);

  // Discord の話題は今と同じ
  assert.equal(waitSession("guild-1", "topic-1", deps), "waited");
  await settle();
  assert.equal(continueSession("guild-1", "topic-1", deps), "continued");
  await settle();
  assert.deepEqual(await closeSession("guild-1", "topic-1", deps, env.onAccepted), { result: "finalized", summary: "閉じました" });
  await settle();
  assert.deepEqual(gateway.moves(), [
    ["topic-1", "waiting-1"],
    ["topic-1", "active-1"],
    ["topic-1", "done-1"],
  ]);
  assert.equal(deps.topicSessions.get("topic-1")?.categoryId, "done-1");
});

test("closeSession: セッションでない・閉じているなら受け付けない。失敗は failed、候補が無ければ finalized", async (t) => {
  const env = setup(t, [FAILED, ok("閉じました")]);

  assert.deepEqual(await closeSession("guild-1", "inbox-1", env.deps, env.onAccepted), { result: "not_session" });
  assert.equal(env.accepted.count, 0);

  const failed = await closeSession("guild-1", "topic-1", env.deps, env.onAccepted);
  assert.equal(failed.result, "failed");
  assert.equal(env.accepted.count, 1);

  const finalized = await closeSession("guild-1", "topic-1", env.deps, env.onAccepted);
  assert.deepEqual(finalized, { result: "finalized", summary: "閉じました" });
  assert.equal(env.deps.topicSessions.get("topic-1")?.state, "done");

  assert.deepEqual(await closeSession("guild-1", "topic-1", env.deps, env.onAccepted), { result: "closed" });
  assert.equal(env.accepted.count, 2);
});

test("closeSession: 同じチャンネルの要約が走っている間（キューで待っている間を含む）は要約を始めずに closing（onAccepted は呼ばない）。終われば・投げても印を外す", async (t) => {
  const env = setup(t, [ok("閉じました")]);
  // 同じチャンネルの発言のターンが走っていて、/close はキューで待つ
  let release = (): void => {};
  const running = env.deps.turnQueue.run("topic-1", () => new Promise<void>((resolve) => (release = resolve)), { session: true });

  const first = closeSession("guild-1", "topic-1", env.deps, env.onAccepted);
  assert.equal(closeInProgress("topic-1"), true);
  assert.deepEqual(await closeSession("guild-1", "topic-1", env.deps, env.onAccepted), { result: "closing" });
  assert.equal(env.accepted.count, 1);
  release();
  await running;
  assert.deepEqual(await first, { result: "finalized", summary: "閉じました" });
  assert.equal(env.runner.inputs.length, 1);
  assert.equal(closeInProgress("topic-1"), false);

  // onAccepted が投げても印は外れる
  const env2 = setup(t, []);
  await assert.rejects(
    closeSession("guild-1", "topic-1", env2.deps, async () => {
      throw new Error("保留に失敗しました");
    }),
  );
  assert.equal(closeInProgress("topic-1"), false);
});

test("closeSession → confirmClose: 候補があれば confirm、確定で closed と登録数、2 回目は no_draft", async (t) => {
  const draft = { summary: "京都に 2 泊する", tasks: [{ title: "宿を予約する" }, { title: "休みの申請" }] };
  const steps: FakeRunStep[] = [];
  const env = setup(t, steps);
  // session_report を呼んでから返答するターン（ツールのハンドラは run に渡された context で動く）
  steps.push((input) => {
    createSessionToolHandlers(env.deps.topicSessions, input.context).sessionReport(draft);
    return ok("閉じる準備ができました");
  });

  assert.deepEqual(confirmClose("guild-1", "topic-1", "all", env.deps), { result: "no_draft" });
  const outcome = await closeSession("guild-1", "topic-1", env.deps);
  assert.deepEqual(outcome, { result: "confirm", draft });

  assert.deepEqual(confirmClose("guild-1", "topic-1", [1], env.deps), { result: "closed", summary: draft.summary, registered: 1 });
  assert.equal(env.deps.topicSessions.get("topic-1")?.state, "done");
  assert.deepEqual(confirmClose("guild-1", "topic-1", "all", env.deps), { result: "no_draft" });
});

test("renewChannel: 受け付けないチャンネルは not_renewable、閉じたセッションは closed、#inbox・セッションは done と結果の文", async (t) => {
  const env = setup(t, [ok("- 要約")]);

  assert.deepEqual(await renewChannel("guild-1", "unknown", env.deps, env.onAccepted), { result: "not_renewable" });
  assert.equal(env.accepted.count, 0);

  const inbox = await renewChannel("guild-1", "inbox-1", env.deps, env.onAccepted);
  assert.equal(inbox.result, "done");
  assert.deepEqual(env.inboxRotator.calls, ["inbox"]);

  const session = await renewChannel("guild-1", "topic-1", env.deps, env.onAccepted);
  assert.equal(session.result, "done");
  assert.ok(session.result === "done" && session.text.includes("- 要約"));
  assert.equal(env.accepted.count, 2);

  env.deps.topicSessions.close("topic-1", "要約");
  assert.deepEqual(await renewChannel("guild-1", "topic-1", env.deps, env.onAccepted), { result: "closed" });
  assert.equal(env.accepted.count, 2);
});

// ---- 話題を始める（startTopic。docs/plan/web-ui-v3.md §11 の M4） ----

test("titleFromText: 最初の空でない行・制御文字は空白・30 字で切る（絵文字などは 1 字と数える）・空なら 無題", () => {
  assert.equal(titleFromText("\n  \n  旅行の\t計画  \n2 行目"), "旅行の 計画");
  assert.equal(titleFromText("a".repeat(40)), "a".repeat(TOPIC_TITLE_FROM_TEXT_MAX));
  assert.equal(titleFromText("😀".repeat(31)), "😀".repeat(30));
  // 切った末尾の空白は除く（「…」は付けない）
  assert.equal(titleFromText(`${"a".repeat(29)} bcd`), "a".repeat(29));
  assert.equal(titleFromText("\u0007\u0007"), UNTITLED_TOPIC);
  assert.equal(titleFromText(""), UNTITLED_TOPIC);
  // 長さの定数は今の Web の数と同じ
  assert.equal(TOPIC_TEXT_MAX_LENGTH, WEB_MESSAGE_MAX_LENGTH);
  assert.equal(TOPIC_TITLE_MAX_LENGTH, TITLE_MAX_LENGTH);
});

/**
 * /setup 済みのサーバー guild-1 と、ワークスペース（alpha・link（alpha への symlink））。連携（gate）は cc で付け、link の済みは ready で変える。
 * submitText は next の順の結果（無ければ accepted）。seeds を渡すと deps に入れる
 */
async function startSetup(
  t: TestContext,
  options: { cc?: boolean; general?: string; seeds?: { set(channelId: string, text: string): void } } = {},
) {
  const db = tempDb(t);
  const gateway = new FakeGateway({
    allow: ["getParentId", "sendMessage", "pinMessage", "messageExists"],
    record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn", "moveChannel", "send"],
  });
  const { guildSettings, topicSessions, history } = createStores(db, () => NOW);
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const layout = { gateway, guildSettings, topicSessions, queue: new KeyedSerialQueue(1), channelOps: { enqueueMove: () => undefined }, log };
  assert.equal((await ensureGuildLayout("guild-1", layout)).failure, null);
  gateway.reset();
  const workspace = realpathSync(tempDir(t));
  mkdirSync(join(workspace, "alpha"));
  symlinkSync(join(workspace, "alpha"), join(workspace, "link"));
  const ready = { value: true };
  const gate: ProjectSessionGate = {
    places: { workspaceDir: workspace, protectedDirs: [], generalDir: options.general ?? "General" },
    ready: () => ready.value,
  };
  const submits: Array<Parameters<Handler["submitText"]>[0]> = [];
  const next: SubmitTextResult[] = [];
  const deps = {
    gateway,
    guildSettings,
    topicSessions,
    queue: layout.queue,
    history,
    log,
    submitText: async (input: Parameters<Handler["submitText"]>[0]): Promise<SubmitTextResult> => {
      submits.push(input);
      return next.shift() ?? { result: "accepted", turnId: 1, messageId: "m-1" };
    },
    ...(options.cc === false ? {} : { projectSessions: gate }),
    ...(options.seeds === undefined ? {} : { seeds: options.seeds }),
  };
  const start = (input: Partial<StartTopicInput>) => startTopic({ guildId: "guild-1", place: { kind: "general" }, by: "web", at: NOW, ...input }, deps);
  return { deps, start, gateway, topicSessions, history, workspace, ready, submits, next, logs };
}

test("startTopic: 題名も一言も空は empty、長すぎる題名・一言は too_long で、どれも作らない", async (t) => {
  const s = await startSetup(t);
  assert.deepEqual(await s.start({}), { result: "empty" });
  assert.deepEqual(await s.start({ title: " \n\t ", text: "   " }), { result: "empty" });
  assert.deepEqual(await s.start({ title: "a".repeat(101) }), { result: "too_long", field: "title" });
  assert.deepEqual(await s.start({ text: "a".repeat(1901) }), { result: "too_long", field: "text" });
  assert.equal(s.gateway.calls.length, 0);
  assert.equal(s.submits.length, 0);
  assert.equal(existsSync(join(s.workspace, "General")), false);
});

test("startTopic（general）: 連携があり link が済んでいれば General を作って project_dir 付きで作り、仕切り「General で始めました」と最初のターン（submitText に channelId・本文・source web）", async (t) => {
  const s = await startSetup(t);
  const result = await s.start({ title: "旅行", text: "  京都に行きたい  " });
  assert.ok(result.result === "created");
  assert.deepEqual(result, { result: "created", channelId: result.channelId, title: "旅行", projectDir: "General", turn: "started" });
  assert.deepEqual(readdirSync(join(s.workspace, "General")), []);
  assert.equal(s.topicSessions.projectDirOf(result.channelId)?.projectDir, "General");
  const created = s.gateway.calls.find((call) => call.method === "createTextChannel");
  assert.ok(created !== undefined && created.method === "createTextChannel");
  assert.equal(created.options.topic, "旅行（General）");
  assert.deepEqual(
    s.gateway.sent.map((sent) => sent.text),
    [welcomeText("旅行", "General")],
  );
  const rows = s.history.list(result.channelId, { limit: 10 });
  assert.deepEqual(
    rows.map((row) => [row.kind, row.source, row.text]),
    [["divider", "system", "General で始めました"]],
  );
  assert.deepEqual(s.submits, [{ guildId: "guild-1", channelId: result.channelId, content: "京都に行きたい", at: NOW, source: "web" }]);
  assert.ok(s.logs.includes("General のディレクトリを作りました"));
  // 2 回目はあるものを使う（作ったの log は出ない）
  s.logs.length = 0;
  assert.equal((await s.start({ title: "もう 1 つ" })).result, "created");
  assert.equal(s.logs.includes("General のディレクトリを作りました"), false);
});

test("startTopic（general）: 連携が無い・link が無い・General が symlink のときは軽いセッション（project_dir なし）で作り、仕切りは「場所なしで始めました」", async (t) => {
  const check = async (s: Awaited<ReturnType<typeof startSetup>>, label: string) => {
    const result = await s.start({ title: "雑談" });
    assert.ok(result.result === "created", label);
    assert.equal(result.projectDir, null, label);
    assert.equal(result.turn, "none", label);
    assert.equal(s.topicSessions.projectDirOf(result.channelId), undefined, label);
    assert.deepEqual(
      s.history.list(result.channelId, { limit: 10 }).map((row) => row.text),
      ["場所なしで始めました"],
      label,
    );
  };
  const off = await startSetup(t, { cc: false });
  await check(off, "連携なし");
  assert.equal(existsSync(join(off.workspace, "General")), false);

  const notReady = await startSetup(t);
  notReady.ready.value = false;
  await check(notReady, "link なし");
  assert.equal(existsSync(join(notReady.workspace, "General")), false);

  const linked = await startSetup(t, { general: "link" });
  await check(linked, "symlink");
});

test("startTopic（project）: 連携が無ければ cc_disabled、link が無ければ unify_not_ready、無い名前・symlink は invalid_project で、どれも作らない", async (t) => {
  const off = await startSetup(t, { cc: false });
  assert.deepEqual(await off.start({ title: "x", place: { kind: "project", name: "alpha" } }), { result: "cc_disabled" });
  assert.equal(off.gateway.calls.length, 0);

  const s = await startSetup(t);
  s.ready.value = false;
  assert.deepEqual(await s.start({ title: "x", place: { kind: "project", name: "alpha" } }), { result: "unify_not_ready" });
  s.ready.value = true;
  for (const name of ["missing", "link", "../alpha", "a/b"]) {
    assert.deepEqual(await s.start({ title: "x", place: { kind: "project", name } }), { result: "invalid_project" }, name);
  }
  assert.equal(s.gateway.calls.length, 0);

  const result = await s.start({ title: "直す", place: { kind: "project", name: "alpha" } });
  assert.ok(result.result === "created");
  assert.equal(result.projectDir, "alpha");
  assert.deepEqual(
    s.history.list(result.channelId, { limit: 10 }).map((row) => row.text),
    ["alpha で始めました"],
  );
});

test("startTopic: 題名を省くと一言の先頭から作る。一言を省くとターンを始めない（turn none）", async (t) => {
  const s = await startSetup(t);
  const fromText = await s.start({ text: "\n請求書の整理をしたい。\n先月の分から" });
  assert.ok(fromText.result === "created");
  assert.equal(fromText.title, "請求書の整理をしたい。");
  assert.equal(s.topicSessions.get(fromText.channelId)?.title, "請求書の整理をしたい。");
  assert.equal(fromText.turn, "started");

  const titleOnly = await s.start({ title: " 題名\tだけ " });
  assert.ok(titleOnly.result === "created");
  assert.equal(titleOnly.title, "題名 だけ");
  assert.equal(titleOnly.turn, "none");
  assert.equal(s.submits.length, 1);
});

test("startTopic: 最初の一言が受け付けられなくても created で turn failed（チャンネルと仕切りは残る）", async (t) => {
  const s = await startSetup(t);
  s.next.push({ result: "bot_disconnected" });
  const result = await s.start({ title: "t", text: "本文" });
  assert.ok(result.result === "created");
  assert.equal(result.turn, "failed");
  assert.equal(s.topicSessions.get(result.channelId)?.state, "active");
  assert.equal(s.history.list(result.channelId, { limit: 10 }).length, 1);
  assert.ok(s.logs.some((line) => line.startsWith("話題は作りましたが、最初の一言を送れませんでした")));
});

test("startTopic: /setup 前は not_set_up", async (t) => {
  const s = await startSetup(t);
  assert.deepEqual(await s.start({ guildId: "guild-2", title: "x" }), { result: "not_set_up" });
  assert.equal(s.submits.length, 0);
});

test("startTopic: log に題名・本文・プロジェクトの名前が出ない", async (t) => {
  const s = await startSetup(t, { general: "Freeform" });
  s.next.push({ result: "accepted", turnId: 1, messageId: "m" }, { result: "echo_failed" });
  const a = await s.start({ title: "秘密の題名", text: "秘密の本文" });
  const b = await s.start({ title: "別の題名", text: "別の本文", place: { kind: "project", name: "alpha" } });
  assert.ok(a.result === "created" && b.result === "created");
  const joined = s.logs.join("\n");
  for (const word of ["秘密", "別の", "alpha", "Freeform", s.workspace, a.channelId, b.channelId]) {
    assert.equal(joined.includes(word), false, word);
  }
  assert.ok(s.logs.length > 0);
});

// ---- 右腕から始める（docs/plan/web-ui-v3.md §4・§11 の M6a） ----

test("startTopic（right_hand）: origin は inbox、最初の投稿に「#inbox の話の続きです。」（from を渡すとその名前）、submitText に via right_hand", async (t) => {
  const s = await startSetup(t);
  const result = await s.start({ title: "旅行", text: "京都に行きたい", by: "right_hand" });
  assert.ok(result.result === "created");
  assert.equal(result.projectDir, "General");
  assert.equal(s.topicSessions.get(result.channelId)?.origin, "inbox");
  assert.deepEqual(
    s.gateway.sent.map((sent) => sent.text),
    [rightHandWelcomeText("旅行", "inbox", "General")],
  );
  assert.ok(s.gateway.sent[0]?.text.endsWith("\n#inbox の話の続きです。"));
  assert.deepEqual(s.submits, [
    { guildId: "guild-1", channelId: result.channelId, content: "京都に行きたい", at: NOW, source: "web", via: "right_hand" },
  ]);

  const from = await s.start({ title: "別件", by: "right_hand", from: "luna" });
  assert.ok(from.result === "created");
  assert.equal(s.gateway.sent.at(-1)?.text, `${welcomeText("別件", "General")}\n#luna の話の続きです。`);
  assert.equal(from.turn, "none");
});

test("startTopic（right_hand）: 仕切りは「右腕が General で始めました」「右腕が <名前> で始めました」「右腕が場所なしで始めました」", async (t) => {
  const s = await startSetup(t);
  const general = await s.start({ title: "a", by: "right_hand" });
  const project = await s.start({ title: "b", by: "right_hand", place: { kind: "project", name: "alpha" } });
  assert.ok(general.result === "created" && project.result === "created");
  assert.deepEqual(s.history.list(general.channelId, { limit: 10 }).map((row) => row.text), ["右腕が General で始めました"]);
  assert.deepEqual(s.history.list(project.channelId, { limit: 10 }).map((row) => row.text), ["右腕が alpha で始めました"]);

  const off = await startSetup(t, { cc: false });
  const light = await off.start({ title: "c", by: "right_hand" });
  assert.ok(light.result === "created");
  assert.equal(light.projectDir, null);
  assert.deepEqual(off.history.list(light.channelId, { limit: 10 }).map((row) => row.text), ["右腕が場所なしで始めました"]);
});

// ---- GitHub の通知の［対応］から始める（docs/plan/terminal-handover.md の H5） ----

test("startTopic（github）: origin は command、最初の投稿は welcomeText、仕切りは「GitHub の通知から <名前> で始めました」、submitText に via github", async (t) => {
  const s = await startSetup(t);
  const result = await s.start({ title: "GitHub PR 12", text: "対応依頼", by: "github", place: { kind: "project", name: "alpha" } });
  assert.ok(result.result === "created");
  assert.equal(result.projectDir, "alpha");
  assert.equal(s.topicSessions.get(result.channelId)?.origin, "command");
  assert.deepEqual(s.gateway.sent.map((sent) => sent.text), [welcomeText("GitHub PR 12", "alpha")]);
  assert.deepEqual(s.history.list(result.channelId, { limit: 10 }).map((row) => row.text), ["GitHub の通知から alpha で始めました"]);
  assert.deepEqual(s.submits, [
    { guildId: "guild-1", channelId: result.channelId, content: "対応依頼", at: NOW, source: "web", via: "github" },
  ]);
  assert.ok(s.logs.some((line) => line.startsWith("GitHub の通知からセッションを作りました")));
});

test("startedDividerText: github の 3 つの文。web・right_hand の文は今と同じ", () => {
  const project = { kind: "project", name: "alpha" } as const;
  const general = { kind: "general" } as const;
  assert.equal(startedDividerText(project, "alpha", "github"), "GitHub の通知から alpha で始めました");
  assert.equal(startedDividerText(general, "General", "github"), "GitHub の通知から General で始めました");
  assert.equal(startedDividerText(general, undefined, "github"), "GitHub の通知から場所なしで始めました");
  assert.equal(startedDividerText(project, "alpha"), "alpha で始めました");
  assert.equal(startedDividerText(general, "General", "web"), "General で始めました");
  assert.equal(startedDividerText(general, undefined, "web"), "場所なしで始めました");
  assert.equal(startedDividerText(project, "alpha", "right_hand"), "右腕が alpha で始めました");
  assert.equal(startedDividerText(general, "General", "right_hand"), "右腕が General で始めました");
  assert.equal(startedDividerText(general, undefined, "right_hand"), "右腕が場所なしで始めました");
});

test("startTopic: seed を渡すと最初の投稿より前に seeds.set が呼ばれる。seeds が無ければ何もせずに作れる", async (t) => {
  const order: string[] = [];
  const seeded: Array<[string, string]> = [];
  const s = await startSetup(t, {
    seeds: {
      set: (channelId, text) => {
        order.push(`seed:${s.gateway.sent.length}`);
        seeded.push([channelId, text]);
      },
    },
  });
  const result = await s.start({ title: "続き", text: "一言", by: "right_hand", seed: "#inbox からの続き:\n文脈" });
  assert.ok(result.result === "created");
  order.push(`sent:${s.gateway.sent.length}`);
  // set の時点ではまだ最初の投稿をしていない
  assert.deepEqual(order, ["seed:0", "sent:1"]);
  assert.deepEqual(seeded, [[result.channelId, "#inbox からの続き:\n文脈"]]);

  const none = await startSetup(t);
  const plain = await none.start({ title: "続き", by: "right_hand", seed: "x" });
  assert.equal(plain.result, "created");
});

test("startTopic: owner を渡すと place が project でも軽いセッション（projectDir null・仕切りは場所なし）で、持ち主はその人格", async (t) => {
  const s = await startSetup(t);
  const result = await s.start({ title: "相談", by: "right_hand", place: { kind: "project", name: "alpha" }, owner: { id: "luna", name: "LUNA" } });
  assert.ok(result.result === "created");
  assert.equal(result.projectDir, null);
  assert.equal(s.topicSessions.projectDirOf(result.channelId), undefined);
  assert.equal(s.topicSessions.personaOf(result.channelId), "luna");
  const created = s.gateway.calls.find((call) => call.method === "createTextChannel");
  assert.ok(created !== undefined && created.method === "createTextChannel");
  assert.equal(created.options.topic, "相談（LUNA）");
  assert.deepEqual(s.history.list(result.channelId, { limit: 10 }).map((row) => row.text), ["右腕が場所なしで始めました"]);
});

test("startTopic（web）: 新しい引数が無ければ origin は command・最初の投稿と仕切りは今の文・submitText に via は無い", async (t) => {
  const s = await startSetup(t);
  const result = await s.start({ title: "旅行", text: "一言" });
  assert.ok(result.result === "created");
  assert.equal(s.topicSessions.get(result.channelId)?.origin, "command");
  assert.deepEqual(s.gateway.sent.map((sent) => sent.text), [welcomeText("旅行", "General")]);
  assert.deepEqual(s.history.list(result.channelId, { limit: 10 }).map((row) => row.text), ["General で始めました"]);
  assert.equal(s.submits.length, 1);
  assert.equal("via" in (s.submits[0] ?? {}), false);
});

test("startTopic: seeds.set が投げても created で、最初の投稿・仕切り・最初の一言は進み、log は 1 行だけ（中身・題名は出さない）", async (t) => {
  const s = await startSetup(t, {
    seeds: {
      set: () => {
        throw new Error("SQLITE_BUSY");
      },
    },
  });
  const result = await s.start({ title: "秘密の題名", text: "一言", by: "right_hand", seed: "秘密の seed" });
  assert.ok(result.result === "created");
  assert.equal(result.turn, "started");
  assert.deepEqual(s.gateway.sent.map((sent) => sent.text), [rightHandWelcomeText("秘密の題名", "inbox", "General")]);
  assert.deepEqual(s.history.list(result.channelId, { limit: 10 }).map((row) => row.text), ["右腕が General で始めました"]);
  assert.equal(s.submits.length, 1);
  assert.deepEqual(
    s.logs.filter((line) => line.startsWith("seed")),
    ["seed を入れられませんでした: SQLITE_BUSY"],
  );
  const joined = s.logs.join("\n");
  for (const word of ["秘密", result.channelId]) assert.equal(joined.includes(word), false, word);
});

test("startTopic: seed を渡したのに seeds が無ければ、作って log に 1 行", async (t) => {
  const s = await startSetup(t);
  const result = await s.start({ title: "続き", by: "right_hand", seed: "秘密の seed" });
  assert.equal(result.result, "created");
  assert.deepEqual(
    s.logs.filter((line) => line.startsWith("seed")),
    ["seed の置き場が無いので入れませんでした"],
  );
  assert.equal(s.logs.join("\n").includes("秘密"), false);
});

test("startTopic: owner があれば仕切りの history の行はその人格で書く。無ければ persona を渡さない（今までと同じ行）", async (t) => {
  const s = await startSetup(t);
  const rows: Array<Parameters<typeof s.history.add>[0]> = [];
  const add = s.history.add.bind(s.history);
  s.history.add = (row) => {
    rows.push(row);
    return add(row);
  };
  const owned = await s.start({ title: "相談", by: "right_hand", owner: { id: "luna", name: "LUNA" } });
  const plain = await s.start({ title: "雑談", by: "right_hand" });
  assert.ok(owned.result === "created" && plain.result === "created");
  assert.deepEqual(s.history.list(owned.channelId, { limit: 10 }).map((row) => [row.kind, row.persona]), [["divider", "luna"]]);
  assert.deepEqual(s.history.list(plain.channelId, { limit: 10 }).map((row) => [row.kind, row.persona]), [["divider", "default"]]);
  assert.deepEqual(rows[1], {
    guildId: "guild-1",
    channelId: plain.channelId,
    kind: "divider",
    source: "system",
    text: "右腕が General で始めました",
  });
});

test("startTopic（right_hand）: log に題名・本文・チャンネル ID・プロジェクトの名前・from・seed の中身が出ない", async (t) => {
  const s = await startSetup(t, { general: "Freeform", seeds: { set: () => undefined } });
  s.next.push({ result: "accepted", turnId: 1, messageId: "m" }, { result: "echo_failed" });
  const a = await s.start({ title: "秘密の題名", text: "秘密の本文", by: "right_hand", from: "ひみつ部屋", seed: "隠した seed", owner: { id: "luna", name: "LUNA" } });
  const b = await s.start({ title: "別の題名", text: "別の本文", by: "right_hand", from: "ひみつ部屋", seed: "隠した seed", place: { kind: "project", name: "alpha" } });
  assert.ok(a.result === "created" && b.result === "created");
  const joined = s.logs.join("\n");
  for (const word of ["秘密", "別の", "ひみつ部屋", "隠した", "alpha", "Freeform", s.workspace, a.channelId, b.channelId]) {
    assert.equal(joined.includes(word), false, word);
  }
  assert.ok(s.logs.length > 0);
});

test("startTopic（right_hand）: 本物の handler と seeds で、1 ターン目のプロンプトは seed → 一言の順。seed・一言の URL は allowedUrls に入らない", async (t) => {
  const db = tempDb(t);
  const gateway = new FakeGateway({
    allow: ["getParentId", "sendMessage", "pinMessage", "messageExists", "send", "editMessage", "startTyping"],
    record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn", "moveChannel", "send"],
  });
  const stores = createStores(db, () => NOW);
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const layoutQueue = new KeyedSerialQueue(1);
  const layout = { gateway, guildSettings: stores.guildSettings, topicSessions: stores.topicSessions, queue: layoutQueue, channelOps: { enqueueMove: () => undefined }, log };
  assert.equal((await ensureGuildLayout("guild-1", layout)).failure, null);
  gateway.reset();
  const workspace = realpathSync(tempDir(t));
  const gate: ProjectSessionGate = { places: { workspaceDir: workspace, protectedDirs: [], generalDir: "General" }, ready: () => true };
  const runner = new FakeRunner([ok("はい")]);
  const cfg = { allowedGuildIds: ["guild-1"], inboxChannelId: "env-inbox", ownerUserId: "owner-1", timeZone: "Asia/Tokyo" };
  const handler = createHandler({
    cfg,
    resolveChannel: createChannelResolver(cfg, stores.guildSettings, stores.topicSessions),
    gateway,
    runner,
    projectRunner: runner,
    sessions: stores.sessions,
    seeds: stores.seeds,
    topicSessions: stores.topicSessions,
    inboxSummaries: stores.inboxSummaries,
    memories: stores.memories,
    channelOps: new RecordingChannelOps(),
    usage: stores.usage,
    queue: new KeyedSerialQueue(2),
    now: () => NOW,
    history: stores.history,
    log,
  });
  const seed = "#inbox からの続き:\n文脈 https://seed.example/x";
  const text = "これを読んで https://example.com/a";
  const result = await startTopic(
    { guildId: "guild-1", place: { kind: "general" }, by: "right_hand", at: NOW, title: "調べ物", text, seed },
    {
      gateway,
      guildSettings: stores.guildSettings,
      topicSessions: stores.topicSessions,
      queue: layoutQueue,
      history: stores.history,
      log,
      submitText: handler.submitText,
      projectSessions: gate,
      seeds: stores.seeds,
    },
  );
  assert.ok(result.result === "created");
  assert.equal(result.turn, "started");
  for (let i = 0; i < 100 && runner.inputs.length === 0; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runner.inputs.length, 1);
  const first = runner.inputs[0]!;
  const seedAt = first.prompt.indexOf(seed);
  assert.ok(seedAt >= 0 && seedAt < first.prompt.indexOf(text), first.prompt);
  assert.deepEqual(first.allowedUrls, []);
});
