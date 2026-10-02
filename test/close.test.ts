import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRunner, RunInput, RunResult } from "../src/agent/runner.ts";
import { createSessionToolHandlers, type SessionReportArgs } from "../src/agent/tools.ts";
import type { MoveTarget } from "../src/app/channel-ops.ts";
import {
  ALREADY_CLOSED_REPLY,
  CLOSE_PROMPT,
  closedText,
  closeStartButton,
  confirmText,
  createCloseCommand,
  createCloseComponent,
  EMPTY_SUMMARY,
  NO_DRAFT_REPLY,
  NOT_SESSION_REPLY,
  SUMMARY_FAILURE_REPLY,
} from "../src/app/commands/close.ts";
import { HELP_TEXT } from "../src/app/commands/help.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { RESUME_SEED_HEADER } from "../src/app/turn.ts";
import type {
  ComponentRow,
  Interaction,
  InteractionResponder,
  ModalDef,
  OutgoingMessage,
} from "../src/discord/gateway.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { openDb } from "../src/store/db.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { type CloseDraft, TopicSessionStore } from "../src/store/topic-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";

const NOW = new Date("2026-10-02T00:12:00Z");
const CLOSED_AT = new Date("2026-10-03T09:00:00Z");

type Step = (input: RunInput) => RunResult;

/** 1 回の run ごとに、渡された関数で結果を作る（session_report を呼んだことにするなど） */
class FakeRunner implements AgentRunner {
  inputs: RunInput[] = [];
  private readonly steps: Step[];

  constructor(steps: Step[]) {
    this.steps = steps;
  }

  async run(input: RunInput): Promise<RunResult> {
    this.inputs.push(input);
    const step = this.steps.shift();
    if (step === undefined) throw new Error("想定外の呼び出し");
    return step(input);
  }
}

type ResponderCall =
  | { method: "defer"; ephemeral: boolean }
  | { method: "deferUpdate" }
  | { method: "reply" | "update"; message: OutgoingMessage }
  | { method: "showModal"; modal: ModalDef };

class FakeResponder implements InteractionResponder {
  calls: ResponderCall[] = [];

  async defer(ephemeral: boolean): Promise<void> {
    this.calls.push({ method: "defer", ephemeral });
  }
  async deferUpdate(): Promise<void> {
    this.calls.push({ method: "deferUpdate" });
  }
  async reply(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "reply", message });
  }
  async update(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "update", message });
  }
  async showModal(modal: ModalDef): Promise<void> {
    this.calls.push({ method: "showModal", modal });
  }
}

class RecordingChannelOps {
  moves: Array<{ channelId: string; target: MoveTarget }> = [];

  enqueueMove(channelId: string, target: MoveTarget): void {
    this.moves.push({ channelId, target });
  }
}

/** 受け取った key を記録する */
class RecordingQueue extends KeyedSerialQueue {
  keys: string[] = [];

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.keys.push(key);
    return super.run(key, fn);
  }
}

function ok(text: string, sessionId: string = "session-1"): RunResult {
  return {
    ok: true,
    text,
    sessionId,
    usage: { inputTokens: 10, cacheReadInputTokens: 2000, cacheCreationInputTokens: 300 },
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

const BUTTONS: ComponentRow = {
  kind: "buttons",
  buttons: [
    { customId: "close:all:topic-1", label: "全部登録", style: "primary" },
    { customId: "close:pick:topic-1", label: "選ぶ" },
    { customId: "close:none:topic-1", label: "登録しない" },
  ],
};

function stores(db: DatabaseSync, now: () => Date) {
  return {
    topicSessions: new TopicSessionStore(db, now),
    tasks: new TaskStore(db, now),
    sessions: new SdkSessionStore(db, now),
    seeds: new ChannelSeedStore(db, now),
    usage: new UsageStore(db, now),
  };
}

function setup(t: TestContext, steps: (topicSessions: TopicSessionStore) => Step[]) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: NOW };
  const { topicSessions, tasks, sessions, seeds, usage } = stores(db, () => clock.now);
  const runner = new FakeRunner(steps(topicSessions));
  const channelOps = new RecordingChannelOps();
  const turnQueue = new RecordingQueue(2);
  const logs: string[] = [];
  const log = (line: string): number => logs.push(line);
  const deps = {
    topicSessions,
    tasks,
    channelOps,
    turnQueue,
    turn: { runner, sessions, seeds, topicSessions, usage, log },
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
  return { db, clock, runner, topicSessions, tasks, sessions, seeds, usage, channelOps, turnQueue, logs, runClose, press, openTasks };
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

test("/close: セッション以外（#inbox・知らないチャンネル・別サーバーのセッション・削除済み）では ephemeral で断り、ターンを実行しない", async (t) => {
  const env = setup(t, () => []);
  env.topicSessions.create({ ...TOPIC, channelId: "topic-9", guildId: "guild-9" });

  for (const channelId of ["inbox-1", "unknown-1", "topic-9", null]) {
    const calls = await env.runClose({ ...CLOSE, channelId });
    assert.deepEqual(calls, [{ method: "reply", message: { text: NOT_SESSION_REPLY, ephemeral: true } }], String(channelId));
  }
  assert.equal(NOT_SESSION_REPLY, "セッションのチャンネルで実行してください");
  assert.equal(env.runner.inputs.length, 0);
});

test("/close: 閉じたセッション（done・deleted）では ephemeral で「このセッションは閉じています」と返す", async (t) => {
  const env = setup(t, () => []);

  for (const state of ["done", "deleted"]) {
    env.db.prepare("UPDATE sessions SET state = ? WHERE channel_id = 'topic-1'").run(state);
    const calls = await env.runClose();
    assert.deepEqual(calls, [{ method: "reply", message: { text: ALREADY_CLOSED_REPLY, ephemeral: true } }], state);
  }
  assert.equal(env.runner.inputs.length, 0);
});

test("/close: 公開で defer → 静的な prompt で resume → 要約とタスク候補（番号付き）と 3 つのボタンを出す。まだ閉じない", async (t) => {
  const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);

  const calls = await env.runClose();

  assert.deepEqual(env.runner.inputs, [
    { prompt: CLOSE_PROMPT, sessionId: "session-1", context: { guildId: "guild-1", channelId: "topic-1" } },
  ]);
  assert.match(CLOSE_PROMPT, /session_report を 1 回だけ呼んでください。$/);
  assert.deepEqual(calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: confirmText(REPORT), components: [BUTTONS] } },
  ]);
  const reply = calls[1];
  assert.ok(reply?.method === "reply");
  assert.equal(
    reply.message.text,
    [
      "**要約**",
      "京都に 2 泊する。宿は候補を 2 つに絞った。",
      "",
      "**やることの候補**",
      "1. 宿を予約する（期限 2026-10-05）",
      "2. 新幹線の時刻を調べる",
      "3. 休みの申請",
      "",
      "タスクとして登録するものを選んでください。",
    ].join("\n"),
  );
  assert.deepEqual(env.topicSessions.getCloseDraft("topic-1"), REPORT);
  assertOpen(env);
  assert.deepEqual(env.openTasks(), []);
  // 発言と同じキューの同じ key（channelId）で実行する
  assert.deepEqual(env.turnQueue.keys, ["topic-1"]);
  // ターンの usage と SDK セッションも記録する
  assert.equal(env.usage.recent(10).length, 1);
  assert.equal(env.sessions.get("topic-1"), "session-1");
});

test("[全部登録]: 候補をすべて登録して閉じ、確認メッセージのボタンを外して「閉じました（登録 3 件）」にする", async (t) => {
  const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);
  await env.runClose();
  env.clock.now = CLOSED_AT;

  const calls = await env.press(button("all"));

  assert.deepEqual(calls, [{ method: "update", message: { text: closedText(REPORT.summary, 3), components: [] } }]);
  assert.match(closedText(REPORT.summary, 3), /\n閉じました（登録 3 件）$/);
  assert.deepEqual(env.openTasks(), [
    { title: "宿を予約する", due: "2026-10-05" },
    { title: "新幹線の時刻を調べる", due: null },
    { title: "休みの申請", due: null },
  ]);
  assertClosed(env, REPORT.summary);
  assert.ok(env.logs.includes("/close でセッションを閉じました（guild=guild-1、登録 3 件）"));
});

test("[登録しない]: タスクは登録せずに閉じる", async (t) => {
  const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);
  await env.runClose();
  env.clock.now = CLOSED_AT;

  const calls = await env.press(button("none"));

  assert.deepEqual(calls, [{ method: "update", message: { text: closedText(REPORT.summary, 0), components: [] } }]);
  assert.deepEqual(env.openTasks(), []);
  assertClosed(env, REPORT.summary);
});

test("[選ぶ]: 同じメッセージに複数選択のセレクトを足し、選んだものだけ登録して閉じる", async (t) => {
  const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);
  await env.runClose();

  const pickCalls = await env.press(button("pick"));

  assert.deepEqual(pickCalls, [
    {
      method: "update",
      message: {
        text: confirmText(REPORT),
        components: [
          BUTTONS,
          {
            kind: "select",
            select: {
              customId: "close:sel:topic-1",
              placeholder: "登録するものを選んでください",
              minValues: 1,
              maxValues: 3,
              options: [
                { label: "1. 宿を予約する", value: "0", description: "期限 2026-10-05" },
                { label: "2. 新幹線の時刻を調べる", value: "1" },
                { label: "3. 休みの申請", value: "2" },
              ],
            },
          },
        ],
      },
    },
  ]);
  // セレクトを出しただけでは閉じない
  assertOpen(env);

  env.clock.now = CLOSED_AT;
  const selectCalls = await env.press(select(["2", "0"]));

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

test("session_report が呼ばれなければ返答本文の先頭 600 字を要約にし、タスク無しで閉じる", async (t) => {
  const long = `${"あ".repeat(599)}😀以降は切る`;
  const env = setup(t, () => [() => ok(`  ${long}  `), () => ok(" \n ")]);
  env.clock.now = CLOSED_AT;

  const calls = await env.runClose();

  // 600 単位目がサロゲートペアの前半なので、その文字ごと落とす
  const summary = "あ".repeat(599);
  assert.deepEqual(calls[1], { method: "reply", message: { text: closedText(summary, 0) } });
  assertClosed(env, summary);

  // 返答も空なら「（要約なし）」
  env.db.prepare("UPDATE sessions SET state = 'active' WHERE channel_id = 'topic-1'").run();
  const empty = await env.runClose();
  assert.deepEqual(empty[1], { method: "reply", message: { text: closedText(EMPTY_SUMMARY, 0) } });
});

test("前の /close で残った下書きは使わない（ターンの前に消す）", async (t) => {
  const env = setup(t, () => [() => ok("今回の要約")]);
  env.topicSessions.saveCloseDraft("topic-1", { summary: "古い要約", tasks: [{ title: "古いタスク" }] });

  const calls = await env.runClose();

  assert.deepEqual(calls[1], { method: "reply", message: { text: closedText("今回の要約", 0) } });
  assert.deepEqual(env.openTasks(), []);
});

test("ターンが失敗したら「要約に失敗しました…」と返し、状態は変えない", async (t) => {
  const env = setup(t, () => [() => ({ ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 0 })]);

  const calls = await env.runClose();

  assert.deepEqual(calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: SUMMARY_FAILURE_REPLY } },
  ]);
  assert.equal(SUMMARY_FAILURE_REPLY, "要約に失敗しました。もう一度 /close を実行してください");
  assertOpen(env);
  assert.equal(env.topicSessions.getCloseDraft("topic-1"), undefined);
  assert.deepEqual(env.openTasks(), []);
  assert.deepEqual(env.logs, ["/close のターンが失敗しました: timeout"]);
});

test("下書きが無いボタン（閉じた後・/close 前）は ephemeral で /close のやり直しを案内し、何も変えない", async (t) => {
  const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);

  for (const interaction of [button("all"), button("pick"), button("none"), select(["0"])]) {
    const calls = await env.press(interaction);
    assert.deepEqual(calls, [{ method: "reply", message: { text: NO_DRAFT_REPLY, ephemeral: true } }]);
  }
  assert.equal(NO_DRAFT_REPLY, "/close をもう一度実行してください");
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

  const restarted = stores(env.db, () => CLOSED_AT);
  const channelOps = new RecordingChannelOps();
  const log = (): void => {};
  const component = createCloseComponent({
    topicSessions: restarted.topicSessions,
    tasks: restarted.tasks,
    channelOps,
    turnQueue: new KeyedSerialQueue(1),
    turn: { runner: new FakeRunner([]), ...restarted, log },
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

test("resume に失敗したら要約の seed で新しいセッションを起こし、1 回だけやり直して閉じる", async (t) => {
  const env = setup(t, (topicSessions) => [
    () => ({
      ok: false,
      errorMessage: "error_during_execution: No conversation found with session ID: session-1",
      sessionRecorded: false,
      toolCalls: 0,
    }),
    reports({ summary: "題名だけから再開した" }, topicSessions),
  ]);

  const calls = await env.runClose();

  const seed = `${RESUME_SEED_HEADER}\n題名: 旅行の計画`;
  assert.deepEqual(
    env.runner.inputs.map((input) => [input.prompt, input.sessionId]),
    [
      [CLOSE_PROMPT, "session-1"],
      [`${seed}\n\n${CLOSE_PROMPT}`, undefined],
    ],
  );
  assert.deepEqual(calls[1], { method: "reply", message: { text: closedText("題名だけから再開した", 0) } });
  assert.equal(env.seeds.get("topic-1"), undefined);
});

test("/close のターンは同じチャンネルの発言のターンが終わるのを待つ", async (t) => {
  const env = setup(t, (topicSessions) => [reports({ summary: "要約" }, topicSessions)]);
  let release = (): void => {};
  const running = env.turnQueue.run("topic-1", () => new Promise<void>((resolve) => (release = resolve)));

  const closing = env.runClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.runner.inputs.length, 0);

  release();
  await running;
  const calls = await closing;
  assert.equal(env.runner.inputs.length, 1);
  assert.deepEqual(calls[1], { method: "reply", message: { text: closedText("要約", 0) } });
});

test("/close の待ち中に閉じられていたら、ターンを実行せずに「このセッションは閉じています」と返す", async (t) => {
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

  const pick = await env.press(button("pick"));
  const update = pick[0];
  assert.ok(update?.method === "update");
  const row = update.message.components?.[1];
  assert.ok(row?.kind === "select");
  assert.equal(row.select.options[0]?.label.length, 100);
  assert.equal(row.select.maxValues, 10);
});

test("[閉じる]（close:start）: 元メッセージは変えずに保留 → /close と同じターン → 待ちの知らせを要約とタスク候補・確認のボタンに書き換える", async (t) => {
  const env = setup(t, (topicSessions) => [reports(REPORT, topicSessions)]);
  // 12 時間で待ちにされたセッション
  env.topicSessions.setWaiting("topic-1");

  const calls = await env.press(button("start"));

  assert.deepEqual(env.runner.inputs, [
    { prompt: CLOSE_PROMPT, sessionId: "session-1", context: { guildId: "guild-1", channelId: "topic-1" } },
  ]);
  assert.deepEqual(calls, [
    { method: "deferUpdate" },
    { method: "update", message: { text: confirmText(REPORT), components: [BUTTONS] } },
  ]);
  assert.deepEqual(env.turnQueue.keys, ["topic-1"]);
  // まだ閉じない（待ちのまま）
  assert.equal(env.topicSessions.get("topic-1")?.state, "waiting");
  assert.deepEqual(env.channelOps.moves, []);

  // 書き換えた確認のボタンは /close のものと同じに動く
  env.clock.now = CLOSED_AT;
  const confirmCalls = await env.press(button("all"));
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
  assert.deepEqual(env.logs, ["/close のターンが失敗しました: timeout"]);

  env.clock.now = CLOSED_AT;
  const closed = await env.press(button("start"));

  assert.deepEqual(closed, [
    { method: "deferUpdate" },
    { method: "update", message: { text: closedText("話しただけで終わった", 0), components: [] } },
  ]);
  assertClosed(env, "話しただけで終わった");
});

test("[閉じる]: 閉じたセッション・セッション以外では ephemeral で断り、ターンを実行しない", async (t) => {
  const env = setup(t, () => []);
  env.topicSessions.create({ ...TOPIC, channelId: "topic-9", guildId: "guild-9" });

  for (const channelId of ["unknown-1", "topic-9"]) {
    const calls = await env.press(button("start", channelId));
    assert.deepEqual(calls, [{ method: "reply", message: { text: NOT_SESSION_REPLY, ephemeral: true } }], channelId);
  }
  for (const state of ["done", "deleted"]) {
    env.db.prepare("UPDATE sessions SET state = ? WHERE channel_id = 'topic-1'").run(state);
    const calls = await env.press(button("start"));
    assert.deepEqual(calls, [{ method: "reply", message: { text: ALREADY_CLOSED_REPLY, ephemeral: true } }], state);
  }
  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.turnQueue.keys, []);
});

test("[閉じる] ボタンの custom_id は close:start:<channelId>", () => {
  assert.deepEqual(closeStartButton("topic-1"), { customId: "close:start:topic-1", label: "閉じる" });
});

test("/help に /close の説明がある", () => {
  assert.match(HELP_TEXT, /^`\/close` /m);
});
