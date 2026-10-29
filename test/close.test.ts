import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunInput, RunResult } from "../src/agent/runner.ts";
import { createSessionToolHandlers, type SessionReportArgs } from "../src/agent/tools.ts";
import {
  ALREADY_CLOSED_REPLY,
  CLOSE_PROMPT,
  closedText,
  closeStartButton,
  confirmText,
  createCloseCommand,
  createCloseComponent,
  NO_DRAFT_REPLY,
  NOT_SESSION_REPLY,
  SUMMARY_FAILURE_REPLY,
} from "../src/app/commands/close.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { EMPTY_SUMMARY } from "../src/app/summary.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import { type CloseDraft, TopicSessionStore } from "../src/store/topic-sessions.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { RecordingChannelOps, RecordingQueue } from "./helpers/recording.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

const NOW = new Date("2026-10-02T00:12:00Z");
const CLOSED_AT = new Date("2026-10-03T09:00:00Z");

type Step = (input: RunInput) => RunResult;

function ok(text: string, sessionId: string = "session-1"): RunResult {
  return {
    ok: true,
    text,
    sessionId,
    usage: turnUsage(10, 2000, 300),
    durationMs: 4200,
    toolCalls: 1,
    contextTokens: 2310,
  };
}

/** session_report を呼んでから返答するターン（ツールのハンドラは run に渡された context で動く） */
function reports(args: SessionReportArgs, topicSessions: TopicSessionStore, text: string = "閉じる準備ができました"): Step {
  return (input) => {
    const result = createSessionToolHandlers(topicSessions, input.context).sessionReport(args);
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: true });
    return ok(text);
  };
}

const BASE = { guildId: "guild-1", channelId: "topic-1", userId: "owner-1", createdAt: NOW };
const CLOSE: Extract<Interaction, { kind: "command" }> = { ...BASE, kind: "command", name: "close", options: {} };

function button(action: string, channelId: string = "topic-1"): Interaction {
  return { ...BASE, kind: "button", customId: `close:${action}:${channelId}` };
}

function select(values: string[], channelId: string = "topic-1"): Interaction {
  return { ...BASE, kind: "select", customId: `close:sel:${channelId}`, values };
}

const TOPIC = { channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" };

const REPORT: CloseDraft = {
  summary: "京都に 2 泊する。宿は候補を 2 つに絞った。",
  tasks: [{ title: "宿を予約する", due: "2026-10-05" }, { title: "新幹線の時刻を調べる" }, { title: "休みの申請" }],
};

/** 確認のメッセージ（reply・update）に付いたボタンを label で押す（custom_id はメッセージのものを使う） */
function pressLabel(call: ResponderCall | undefined, label: string): Interaction {
  assert.ok(call?.method === "reply" || call?.method === "update");
  const row = call.message.components?.[0];
  assert.ok(row?.kind === "buttons");
  const found = row.buttons.find((candidate) => candidate.label === label);
  assert.ok(found !== undefined, label);
  return { ...BASE, kind: "button", customId: found.customId };
}

/** 確認のボタンの label */
function labelsOf(call: ResponderCall | undefined): string[] {
  assert.ok(call?.method === "reply" || call?.method === "update");
  const row = call.message.components?.[0];
  assert.ok(row?.kind === "buttons");
  return row.buttons.map((candidate) => candidate.label);
}

function setup(t: TestContext, steps: (topicSessions: TopicSessionStore) => Step[]) {
  const db = tempDb(t);
  const clock = { now: NOW };
  const { topicSessions, tasks, sessions, seeds, inboxSummaries, memories, usage, projects, history } = createStores(db, () => clock.now);
  const projectsDir = join(tempDir(t), "projects");
  const runner = new FakeRunner(steps(topicSessions));
  const channelOps = new RecordingChannelOps();
  const turnQueue = new RecordingQueue(2);
  const logs: string[] = [];
  // ターンのトークンの行（recordTurnUsage）は tokenLogs に分ける
  const tokenLogs: string[] = [];
  const log = (line: string): number => (line.startsWith("トークン（") ? tokenLogs : logs).push(line);
  const deps = {
    topicSessions,
    tasks,
    channelOps,
    turnQueue,
    turn: { runner, sessions, seeds, topicSessions, inboxSummaries, memories, usage, log },
    projects,
    projectsDir,
    history,
    log,
  };
  const command = createCloseCommand(deps);
  const component = createCloseComponent(deps);
  topicSessions.create(TOPIC);
  sessions.set("topic-1", "session-1");

  const runClose = async (interaction: Interaction = CLOSE): Promise<ResponderCall[]> => {
    assert.equal(interaction.kind, "command");
    const responder = new FakeResponder();
    if (interaction.kind === "command") await command.handle(interaction, responder);
    return responder.calls;
  };
  const press = async (interaction: Interaction): Promise<ResponderCall[]> => {
    assert.notEqual(interaction.kind, "command");
    const responder = new FakeResponder();
    if (interaction.kind !== "command") await component.handle(interaction, responder);
    return responder.calls;
  };
  const openTasks = (): Array<{ title: string; due: string | null }> =>
    tasks.list({ status: "open", limit: 50 }).map((task) => ({ title: task.title, due: task.due }));
  return { db, clock, runner, topicSessions, tasks, sessions, seeds, usage, projects, projectsDir, channelOps, turnQueue, logs, tokenLogs, runClose, press, openTasks, history };
}

/** 閉じたあとの sessions の行と、完了カテゴリへの移動 */
function assertClosed(
  env: Pick<ReturnType<typeof setup>, "topicSessions" | "channelOps">,
  summary: string,
  closedAt: Date = CLOSED_AT,
): void {
  const session = env.topicSessions.get("topic-1");
  assert.equal(session?.state, "done");
  assert.equal(session?.closedAt, closedAt.toISOString());
  assert.equal(session?.summary, summary);
  assert.equal(env.topicSessions.getCloseDraft("topic-1"), undefined);
  assert.deepEqual(env.channelOps.moves, [
    { channelId: "topic-1", target: { kind: "state", guildId: "guild-1", state: "done" } },
  ]);
}

function assertOpen(env: Pick<ReturnType<typeof setup>, "topicSessions" | "channelOps">): void {
  const session = env.topicSessions.get("topic-1");
  assert.equal(session?.state, "active");
  assert.equal(session?.closedAt, null);
  assert.equal(session?.summary, null);
  assert.deepEqual(env.channelOps.moves, []);
}

test("/close・[閉じる]: セッション以外（#inbox・知らないチャンネル・別サーバーのセッション）と閉じたセッション（done・deleted）では ephemeral で断り、ターンを実行しない", async (t) => {
  const env = setup(t, () => []);
  env.topicSessions.create({ ...TOPIC, channelId: "topic-9", guildId: "guild-9" });
  const notSession = [{ method: "reply", message: { text: NOT_SESSION_REPLY, ephemeral: true } }];
  const closed = [{ method: "reply", message: { text: ALREADY_CLOSED_REPLY, ephemeral: true } }];

  for (const channelId of ["inbox-1", "unknown-1", "topic-9"]) {
    assert.deepEqual(await env.runClose({ ...CLOSE, channelId }), notSession, `/close ${channelId}`);
    const start: Interaction = { ...BASE, kind: "button", customId: closeStartButton(channelId).customId };
    assert.deepEqual(await env.press(start), notSession, `[閉じる] ${channelId}`);
  }
  assert.deepEqual(await env.runClose({ ...CLOSE, channelId: null }), notSession, "/close null");
  for (const state of ["done", "deleted"]) {
    env.db.prepare("UPDATE sessions SET state = ? WHERE channel_id = 'topic-1'").run(state);
    assert.deepEqual(await env.runClose(), closed, `/close ${state}`);
    assert.deepEqual(await env.press(button("start")), closed, `[閉じる] ${state}`);
  }
  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.turnQueue.keys, []);
});

test("/close: 公開で defer → 静的な prompt で resume → 要約とタスク候補と 3 つのボタンを出す。まだ閉じない", async (t) => {
  const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);

  const calls = await env.runClose();

  // オーナーの発言ではないので、WebFetch に許す URL は無い。/close のターンの印（Bash を使わせない）を context に付ける
  assert.deepEqual(env.runner.inputs, [
    {
      prompt: CLOSE_PROMPT,
      sessionId: "session-1",
      context: { guildId: "guild-1", channelId: "topic-1", kind: "session", purpose: "close" },
      allowedUrls: [],
    },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { method: "defer", ephemeral: false });
  const reply = calls[1];
  assert.ok(reply?.method === "reply");
  assert.equal(reply.message.text, confirmText(REPORT));
  assert.equal(reply.message.ephemeral, undefined);
  assert.deepEqual(labelsOf(reply), ["全部登録", "選ぶ", "登録しない"]);
  assert.deepEqual(env.topicSessions.getCloseDraft("topic-1"), REPORT);
  assertOpen(env);
  assert.deepEqual(env.openTasks(), []);
  // 発言と同じキューで、セッションのジョブとして実行する
  assert.deepEqual(env.turnQueue.options, [{ session: true }]);
  // ターンの usage と SDK セッションも記録する
  assert.equal(env.usage.recent(10).length, 1);
  assert.equal(env.sessions.get("topic-1"), "session-1");
});

test("[全部登録]・[登録しない]: 候補を全部・0 件登録して閉じ、確認メッセージのボタンを外す", async (t) => {
  const cases = [
    {
      label: "全部登録",
      registered: [
        { title: "宿を予約する", due: "2026-10-05" },
        { title: "新幹線の時刻を調べる", due: null },
        { title: "休みの申請", due: null },
      ],
    },
    { label: "登録しない", registered: [] },
  ];

  for (const { label, registered } of cases) {
    const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);
    const [, reply] = await env.runClose();
    env.clock.now = CLOSED_AT;

    const calls = await env.press(pressLabel(reply, label));

    assert.deepEqual(
      calls,
      [{ method: "update", message: { text: closedText(REPORT.summary, registered.length), components: [] } }],
      label,
    );
    assert.deepEqual(env.openTasks(), registered, label);
    assertClosed(env, REPORT.summary);
    assert.equal(env.logs.length, 1, label);
    assert.ok(!env.logs[0]!.includes("topic-1"), label);
  }
});

test("[選ぶ]: 同じメッセージに複数選択のセレクトを足し、選んだものだけ登録して閉じる", async (t) => {
  const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);
  const [, reply] = await env.runClose();

  const pickCalls = await env.press(pressLabel(reply, "選ぶ"));

  const update = pickCalls[0];
  assert.equal(pickCalls.length, 1);
  assert.ok(update?.method === "update");
  assert.equal(update.message.text, confirmText(REPORT));
  // ボタンはそのまま残し、2 行目にセレクトを足す
  assert.ok(reply?.method === "reply");
  assert.deepEqual(update.message.components?.[0], reply.message.components?.[0]);
  const row = update.message.components?.[1];
  assert.ok(row?.kind === "select");
  assert.equal(row.select.minValues, 1);
  assert.equal(row.select.maxValues, 3);
  assert.deepEqual(
    row.select.options.map((option) => [option.label, option.value, option.description]),
    [
      ["1. 宿を予約する", "0", "期限 2026-10-05"],
      ["2. 新幹線の時刻を調べる", "1", undefined],
      ["3. 休みの申請", "2", undefined],
    ],
  );
  // セレクトを出しただけでは閉じない
  assertOpen(env);

  env.clock.now = CLOSED_AT;
  const selectCalls = await env.press({ ...BASE, kind: "select", customId: row.select.customId, values: ["2", "0"] });

  assert.deepEqual(selectCalls, [{ method: "update", message: { text: closedText(REPORT.summary, 2), components: [] } }]);
  // 選んだ順ではなく候補の順に登録する
  assert.deepEqual(
    env.tasks.list({ status: "open", limit: 50 }).map((task) => [task.id, task.title]),
    [
      [1, "宿を予約する"],
      [2, "休みの申請"],
    ],
  );
  assertClosed(env, REPORT.summary);
});

test("タスク候補が 0 件なら確認なしで閉じ、保留中の応答を「閉じました（登録 0 件）」にする", async (t) => {
  const env = setup(t, (topicSessions) => [reports({ summary: "話しただけで終わった" }, topicSessions)]);
  env.clock.now = CLOSED_AT;

  const calls = await env.runClose();

  assert.deepEqual(calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: closedText("話しただけで終わった", 0) } },
  ]);
  assertClosed(env, "話しただけで終わった");
  assert.deepEqual(env.openTasks(), []);
});

test("session_report が呼ばれなければ返答本文の先頭 600 字を要約にし、タスク無しで閉じる（前の /close で残った下書きは使わない）", async (t) => {
  const long = `${"あ".repeat(599)}😀以降は切る`;
  const env = setup(t, () => [() => ok(`  ${long}  `), () => ok(" \n ")]);
  env.topicSessions.saveCloseDraft("topic-1", { summary: "古い要約", tasks: [{ title: "古いタスク" }] });
  env.clock.now = CLOSED_AT;

  const calls = await env.runClose();

  // 600 単位目がサロゲートペアの前半なので、その文字ごと落とす
  const summary = "あ".repeat(599);
  assert.deepEqual(calls[1], { method: "reply", message: { text: closedText(summary, 0) } });
  assertClosed(env, summary);
  assert.deepEqual(env.openTasks(), []);

  // 返答も空なら「（要約なし）」
  env.db.prepare("UPDATE sessions SET state = 'active' WHERE channel_id = 'topic-1'").run();
  const empty = await env.runClose();
  assert.deepEqual(empty[1], { method: "reply", message: { text: closedText(EMPTY_SUMMARY, 0) } });
});

test("ターンが失敗したら「要約に失敗しました…」と返し、状態は変えない", async (t) => {
  const env = setup(t, () => [() => ({ ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 0 })]);

  const calls = await env.runClose();

  assert.deepEqual(calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: SUMMARY_FAILURE_REPLY } },
  ]);
  assertOpen(env);
  assert.equal(env.topicSessions.getCloseDraft("topic-1"), undefined);
  assert.deepEqual(env.openTasks(), []);
  assert.equal(env.logs.length, 1);
  assert.match(env.logs[0]!, /timeout/);
});

test("下書きが無いボタン（閉じた後・/close 前）は ephemeral で /close のやり直しを案内し、何も変えない", async (t) => {
  const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);

  for (const interaction of [button("all"), button("pick"), button("none"), select(["0"])]) {
    const calls = await env.press(interaction);
    assert.deepEqual(calls, [{ method: "reply", message: { text: NO_DRAFT_REPLY, ephemeral: true } }]);
  }
  assertOpen(env);

  // 1 回押して閉じた後の 2 回目は登録し直さない
  await env.runClose();
  env.clock.now = CLOSED_AT;
  await env.press(button("all"));
  const again = await env.press(button("all"));
  assert.deepEqual(again, [{ method: "reply", message: { text: NO_DRAFT_REPLY, ephemeral: true } }]);
  assert.equal(env.openTasks().length, 3);
  assert.equal(env.channelOps.moves.length, 1);
});

test("再起動の後（新しいストアとハンドラ）でも、DB の下書きでボタンが動く", async (t) => {
  const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);
  await env.runClose();

  const restarted = createStores(env.db, () => CLOSED_AT);
  const channelOps = new RecordingChannelOps();
  const log = (): void => {};
  const component = createCloseComponent({
    topicSessions: restarted.topicSessions,
    tasks: restarted.tasks,
    channelOps,
    turnQueue: new KeyedSerialQueue(1),
    turn: { runner: new FakeRunner([]), ...restarted, log },
    projects: restarted.projects,
    projectsDir: env.projectsDir,
    log,
  });
  const responder = new FakeResponder();
  await component.handle(select(["1"]) as Exclude<Interaction, { kind: "command" }>, responder);

  assert.deepEqual(responder.calls, [
    { method: "update", message: { text: closedText(REPORT.summary, 1), components: [] } },
  ]);
  assert.deepEqual(
    env.openTasks().map((task) => task.title),
    ["新幹線の時刻を調べる"],
  );
  assertClosed({ topicSessions: env.topicSessions, channelOps }, REPORT.summary);
});

test("/close のターンは同じチャンネルの発言のターンが終わるのを待ち、その間に閉じられていたらターンを実行せずに「このセッションは閉じています」と返す", async (t) => {
  const env = setup(t, () => []);
  let release = (): void => {};
  const running = env.turnQueue.run("topic-1", () => new Promise<void>((resolve) => (release = resolve)));

  const closing = env.runClose();
  await new Promise((resolve) => setImmediate(resolve));
  env.topicSessions.close("topic-1", "先に閉じた");
  release();
  await running;

  assert.deepEqual(await closing, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: ALREADY_CLOSED_REPLY } },
  ]);
  assert.equal(env.runner.inputs.length, 0);
});

test("確認メッセージは候補の題名を 100 字で切り、最大の候補でも 2000 字に収まる", async (t) => {
  const tasks = Array.from({ length: 10 }, (_, index) => ({ title: `${index}`.repeat(200), due: "2026-10-05" }));
  const draft = { summary: "要".repeat(600), tasks };
  const env = setup(t, (topicSessions) => [reports(draft, topicSessions)]);

  const calls = await env.runClose();

  const reply = calls[1];
  assert.ok(reply?.method === "reply");
  assert.ok(reply.message.text.length <= 2000, String(reply.message.text.length));
  assert.ok(reply.message.text.includes(`1. ${"0".repeat(99)}…（期限 2026-10-05）`));

  const pick = await env.press(pressLabel(reply, "選ぶ"));
  const update = pick[0];
  assert.ok(update?.method === "update");
  const row = update.message.components?.[1];
  assert.ok(row?.kind === "select");
  assert.equal(row.select.options[0]?.label.length, 100);
  assert.equal(row.select.maxValues, 10);
});

test("[閉じる]: 元メッセージは変えずに保留 → /close と同じターン → 待ちの知らせを要約とタスク候補・確認のボタンに書き換える", async (t) => {
  const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);
  // 12 時間で待ちにされたセッション
  env.topicSessions.setWaiting("topic-1");

  const calls = await env.press({ ...BASE, kind: "button", customId: closeStartButton("topic-1").customId });

  assert.deepEqual(env.runner.inputs, [
    {
      prompt: CLOSE_PROMPT,
      sessionId: "session-1",
      context: { guildId: "guild-1", channelId: "topic-1", kind: "session", purpose: "close" },
      allowedUrls: [],
    },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { method: "deferUpdate" });
  const update = calls[1];
  assert.ok(update?.method === "update");
  assert.equal(update.message.text, confirmText(REPORT));
  assert.deepEqual(labelsOf(update), ["全部登録", "選ぶ", "登録しない"]);
  assert.deepEqual(env.turnQueue.options, [{ session: true }]);
  // まだ閉じない（待ちのまま）
  assert.equal(env.topicSessions.get("topic-1")?.state, "waiting");
  assert.deepEqual(env.channelOps.moves, []);

  // 書き換えた確認のボタンは /close のものと同じに動く
  env.clock.now = CLOSED_AT;
  const confirmCalls = await env.press(pressLabel(update, "全部登録"));
  assert.deepEqual(confirmCalls, [{ method: "update", message: { text: closedText(REPORT.summary, 3), components: [] } }]);
  assertClosed(env, REPORT.summary);
});

test("[閉じる]: タスク候補が 0 件なら閉じて、待ちの知らせを「閉じました」にしてボタンを外す。失敗なら失敗の文面にしてボタンを外す", async (t) => {
  const env = setup(t, (topicSessions) => [
    () => ({ ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 0 }),
    reports({ summary: "話しただけで終わった" }, topicSessions),
  ]);
  env.topicSessions.setWaiting("topic-1");

  const failed = await env.press(button("start"));

  assert.deepEqual(failed, [
    { method: "deferUpdate" },
    { method: "update", message: { text: SUMMARY_FAILURE_REPLY, components: [] } },
  ]);
  assert.equal(env.topicSessions.get("topic-1")?.state, "waiting");
  assert.equal(env.logs.length, 1);

  env.clock.now = CLOSED_AT;
  const closed = await env.press(button("start"));

  assert.deepEqual(closed, [
    { method: "deferUpdate" },
    { method: "update", message: { text: closedText("話しただけで終わった", 0), components: [] } },
  ]);
  assertClosed(env, "話しただけで終わった");
});

/** topic-1 のプロジェクトを作り、node_modules（直下と app/ の下。site/ の下のものは消さない）と普通のファイルを置く。プロジェクトの dir を返す */
function projectWithNodeModules(env: Pick<ReturnType<typeof setup>, "projects" | "projectsDir">): string {
  const project = env.projects.create({ guildId: "guild-1", channelId: "topic-1", name: "kakeibo", title: "家計簿" });
  const dir = join(env.projectsDir, project.slug);
  mkdirSync(join(dir, "node_modules", "react"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "react", "index.js"), "x");
  mkdirSync(join(dir, "app", "node_modules"), { recursive: true });
  mkdirSync(join(dir, "site", "node_modules"), { recursive: true });
  writeFileSync(join(dir, "site", "index.html"), "<p>");
  return dir;
}

test("閉じたら（/close で候補 0 件・確認のボタン）そのチャンネルのプロジェクトの node_modules を消し、件数だけを log に出す。閉じなければ消さない", async (t) => {
  const failed = setup(t, () => [() => ({ ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 0 })]);
  const failedDir = projectWithNodeModules(failed);
  await failed.runClose();
  assert.ok(existsSync(join(failedDir, "node_modules")));
  assert.ok(existsSync(join(failedDir, "app", "node_modules")));

  const finalized = setup(t, (topicSessions) => [reports({ summary: "話しただけで終わった" }, topicSessions)]);
  const finalizedDir = projectWithNodeModules(finalized);
  finalized.clock.now = CLOSED_AT;
  await finalized.runClose();
  assertClosed(finalized, "話しただけで終わった");

  const confirmed = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);
  const confirmedDir = projectWithNodeModules(confirmed);
  const [, reply] = await confirmed.runClose();
  // 確認を出しただけでは消さない
  assert.ok(existsSync(join(confirmedDir, "node_modules")));
  confirmed.clock.now = CLOSED_AT;
  await confirmed.press(pressLabel(reply, "登録しない"));
  assertClosed(confirmed, REPORT.summary);

  for (const [label, env, dir] of [
    ["候補 0 件", finalized, finalizedDir],
    ["確認のボタン", confirmed, confirmedDir],
  ] as const) {
    assert.ok(!existsSync(join(dir, "node_modules")), label);
    assert.ok(!existsSync(join(dir, "app", "node_modules")), label);
    assert.ok(existsSync(join(dir, "site", "node_modules")), label);
    assert.ok(existsSync(join(dir, "site", "index.html")), label);
    assert.equal(env.logs.at(-1), "node_modules を消しました（2 件）", label);
    // 消すのもそのチャンネルのキュー（セッションのジョブ）で行う
    assert.deepEqual(env.turnQueue.keys.slice(-1), ["topic-1"], label);
    assert.deepEqual(env.turnQueue.options.slice(-1), [{ session: true }], label);
  }
  // 候補 0 件: /close のターンと node_modules の削除
  assert.deepEqual(finalized.turnQueue.keys, ["topic-1", "topic-1"]);
});

test("node_modules を消すのに失敗しても（プロジェクトを引けない・dir が symlink）閉じる処理はそのまま。log にパス・例外の中身は出さない。プロジェクトが無ければ何も出さない", async (t) => {
  const broken = setup(t, (topicSessions) => [reports({ summary: "話しただけで終わった" }, topicSessions)]);
  broken.projects.getByChannel = () => {
    throw new Error(`database is locked: ${broken.projectsDir}`);
  };
  broken.clock.now = CLOSED_AT;

  const calls = await broken.runClose();

  assert.deepEqual(calls.at(-1), { method: "reply", message: { text: closedText("話しただけで終わった", 0) } });
  assertClosed(broken, "話しただけで終わった");
  assert.equal(broken.logs.at(-1), "node_modules を消せませんでした");

  // プロジェクトの dir が外を指す symlink なら、何も消さずに log だけ
  const linked = setup(t, (topicSessions) => [reports({ summary: "話しただけで終わった" }, topicSessions)]);
  const project = linked.projects.create({ guildId: "guild-1", channelId: "topic-1", name: "kakeibo", title: "家計簿" });
  const outside = tempDir(t);
  mkdirSync(join(outside, "node_modules"));
  mkdirSync(linked.projectsDir);
  symlinkSync(outside, join(linked.projectsDir, project.slug));
  linked.clock.now = CLOSED_AT;
  await linked.runClose();
  assertClosed(linked, "話しただけで終わった");
  assert.ok(existsSync(join(outside, "node_modules")));
  assert.equal(linked.logs.at(-1), "プロジェクトのディレクトリを確かめられないため node_modules を消しませんでした");

  const none = setup(t, (topicSessions) => [reports({ summary: "話しただけで終わった" }, topicSessions)]);
  none.clock.now = CLOSED_AT;
  await none.runClose();
  assertClosed(none, "話しただけで終わった");
  assert.ok(none.logs.every((line) => !line.includes("node_modules")));
});

test("node_modules はキューの中で完了のままか確かめてから消す。キューを待つ間に進行中に戻っていれば消さない（log も出さない）", async (t) => {
  const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);
  const dir = projectWithNodeModules(env);
  const [, reply] = await env.runClose();
  env.clock.now = CLOSED_AT;
  // 同じチャンネルの前のジョブ（発言のターンなど）が動いている間に閉じる
  let release = (): void => {};
  const running = env.turnQueue.run("topic-1", () => new Promise<void>((resolve) => (release = resolve)), { session: true });

  const pressed = env.press(pressLabel(reply, "登録しない"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.topicSessions.get("topic-1")?.state, "done");
  // 待っている間に発言で進行中に戻る
  env.topicSessions.setActive("topic-1");
  release();
  await running;
  await pressed;

  assert.ok(existsSync(join(dir, "node_modules")));
  assert.ok(existsSync(join(dir, "app", "node_modules")));
  assert.ok(env.logs.every((line) => !line.includes("node_modules")));
});

test("history: /close の確定（候補 0 件で即時・確認のボタン）で divider（閉じた返信の本文）を 1 行。確認を待つ間と失敗では書かない", async (t) => {
  const rows = (env: ReturnType<typeof setup>) =>
    env.history.list("topic-1", { limit: 10 }).map(({ guildId, kind, source, persona, text }) => ({ guildId, kind, source, persona, text }));
  const divider = (text: string) => ({ guildId: "guild-1", kind: "divider", source: "system", persona: "default", text });

  const immediate = setup(t, (topicSessions) => [reports({ summary: "話しただけで終わった" }, topicSessions)]);
  await immediate.runClose();
  assert.deepEqual(rows(immediate), [divider(closedText("話しただけで終わった", 0))]);

  const confirmed = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);
  const [, reply] = await confirmed.runClose();
  assert.deepEqual(rows(confirmed), []);
  await confirmed.press(pressLabel(reply, "全部登録"));
  assert.deepEqual(rows(confirmed), [divider(closedText(REPORT.summary, 3))]);

  const failed = setup(t, () => [() => ({ ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 0 })]);
  await failed.runClose();
  assert.deepEqual(rows(failed), []);
});
