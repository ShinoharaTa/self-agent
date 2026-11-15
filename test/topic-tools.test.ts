// 右腕のツール topic_list・topic_move（tools.ts の createTopicToolHandlers。docs/plan/web-ui-v3.md §4 の M6f）。
// 偽の list・move で歯止めを、本物の right-hand・topic-proposals・一時 SQLite・偽 Runner で「確認を出すだけ」を確かめる
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunContext, RunResult } from "../src/agent/runner.ts";
import {
  CC_NOT_AVAILABLE_MESSAGE,
  createTaskTools,
  TOPIC_LIST_FAILED_MESSAGE,
  TOPIC_MOVE_ONE_PER_TURN,
  type TextToolResult,
  type TopicListResult,
  type TopicMoveArgs,
  type TopicMoveToolResult,
  type TopicToolDeps,
} from "../src/agent/tools.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { createRightHand } from "../src/app/right-hand.ts";
import type { ProjectSessionGate } from "../src/app/session-ops.ts";
import type { MoveDeps } from "../src/app/topic-move.ts";
import { createTopicProposals } from "../src/app/topic-proposals.ts";
import { TopicMoveStore } from "../src/store/topic-moves.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingQueue } from "./helpers/recording.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

const NOW = new Date("2026-11-14T01:00:00Z");
const INBOX: RunContext = { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" };
/** 話題を出せない・使えないターン */
const DENIED: RunContext[] = [
  { ...INBOX, scheduled: true },
  { guildId: "guild-1", channelId: "topic-1", kind: "session", purpose: "close" },
  { guildId: "guild-1", channelId: "topic-1", kind: "session", purpose: "renew" },
];
const LISTED: TopicListResult = {
  result: "ok",
  注意: "注意の文",
  counts: { your_turn: 1, running: 0, total: 1 },
  topics: [{ channel_id: "700", kind: "session", title: "旅行の計画", place: "General", state: "your_turn", turn: "許可の要求", at: "2026-11-14 10:00" }],
  more: 0,
  places: ["General", "alpha"],
};
const PROPOSED: TopicMoveToolResult = { result: "proposed", channelId: "700", from: "なし", to: "alpha", message: "確認を出しました" };

/** 偽の list・move（呼ばれた数を残す。move の結果は results の先頭から、尽きたら proposed） */
function fakeTopics(results: TopicMoveToolResult[] = []) {
  const calls = { list: 0, move: [] as TopicMoveArgs[] };
  const topics: TopicToolDeps = {
    list: () => {
      calls.list++;
      return LISTED;
    },
    move: async (args) => {
      calls.move.push(args);
      return results.shift() ?? PROPOSED;
    },
  };
  return { topics, calls };
}

/** topic_list・topic_move を呼ぶ関数（同じ createTaskTools の中で何度でも呼べる。1 回の run と同じ） */
function topicTools(topics: TopicToolDeps | undefined, context: RunContext | undefined) {
  const definitions = createTaskTools(
    {} as never,
    {} as never,
    async () => assert.fail("想定外の呼び出し: openTopic"),
    {} as never,
    {} as never,
    {} as never,
    context,
    undefined,
    topics,
  );
  const call = async (name: string, args: unknown): Promise<unknown> => {
    const definition = definitions.find((candidate) => candidate.name === name);
    assert.ok(definition !== undefined);
    // 定義の配列は全ツールの入力の型の合併なので、引数の型は確かめない
    const result = (await definition.handler(args as never, {})) as TextToolResult;
    return JSON.parse(result.content[0].text);
  };
  return {
    list: () => call("topic_list", {}),
    move: (args: TopicMoveArgs = { topic: "700", place: "alpha" }) => call("topic_move", args),
  };
}

test("topic_list: 予約した依頼・close・renew・context なしでは not_available で、list を呼ばない", async () => {
  const fake = fakeTopics();
  for (const context of [...DENIED, undefined]) {
    assert.deepEqual(await topicTools(fake.topics, context).list(), { result: "not_available", message: CC_NOT_AVAILABLE_MESSAGE });
  }
  assert.equal(fake.calls.list, 0);
});

test("topic_list: topics が無いと not_available", async () => {
  assert.deepEqual(await topicTools(undefined, INBOX).list(), { result: "not_available", message: CC_NOT_AVAILABLE_MESSAGE });
});

test("topic_list: list の結果がそのまま JSON に入る", async () => {
  const fake = fakeTopics();
  assert.deepEqual(await topicTools(fake.topics, INBOX).list(), LISTED);
  assert.equal(fake.calls.list, 1);
});

test("topic_list: list が投げたら、ツールの呼び出しを失敗にせず not_available と読めなかった旨を返す", async () => {
  const topics: TopicToolDeps = {
    list: () => {
      throw new Error("読み取りの失敗");
    },
    move: async () => assert.fail("想定外の呼び出し: move"),
  };
  assert.deepEqual(await topicTools(topics, INBOX).list(), { result: "not_available", message: TOPIC_LIST_FAILED_MESSAGE });
});

test("topic_move: 予約した依頼・close・renew・context なしでは not_available で、move を呼ばない。topics が無くても not_available", async () => {
  const fake = fakeTopics();
  for (const context of [...DENIED, undefined]) {
    assert.deepEqual(await topicTools(fake.topics, context).move(), { result: "not_available", message: CC_NOT_AVAILABLE_MESSAGE });
  }
  assert.equal(fake.calls.move.length, 0);
  assert.deepEqual(await topicTools(undefined, INBOX).move(), { result: "not_available", message: CC_NOT_AVAILABLE_MESSAGE });
});

test("topic_move: 1 回の run で proposed を返した後の 2 回目は limit で、move を呼ばない。並べて呼んでも 2 つ目は limit", async () => {
  const fake = fakeTopics();
  const tools = topicTools(fake.topics, INBOX);
  assert.deepEqual(await tools.move(), PROPOSED);
  assert.deepEqual(await tools.move({ topic: "701", place: "General" }), { result: "limit", message: TOPIC_MOVE_ONE_PER_TURN });
  assert.equal(fake.calls.move.length, 1);

  const parallel = fakeTopics();
  const other = topicTools(parallel.topics, INBOX);
  const [first, second] = await Promise.all([other.move(), other.move({ topic: "701", place: "General" })]);
  assert.deepEqual(first, PROPOSED);
  assert.deepEqual(second, { result: "limit", message: TOPIC_MOVE_ONE_PER_TURN });
  assert.equal(parallel.calls.move.length, 1);
});

test("topic_move: 1 回目が refused・invalid_place なら 2 回目も move を呼ぶ（数えるのは proposed だけ）", async () => {
  const firsts: TopicMoveToolResult[] = [
    { result: "refused", reason: "same_place", message: "同じ場所です" },
    { result: "invalid_place", message: "その名前の場所はありません" },
  ];
  for (const first of firsts) {
    const fake = fakeTopics([first]);
    const tools = topicTools(fake.topics, INBOX);
    assert.deepEqual(await tools.move(), first);
    assert.deepEqual(await tools.move(), PROPOSED);
    assert.equal(fake.calls.move.length, 2, first.result);
  }
});

function ok(text: string): RunResult {
  return { ok: true, text, sessionId: "session-1", usage: turnUsage(10, 2000, 300), durationMs: 4200, toolCalls: 0, contextTokens: 2310 };
}

/** 本物の right-hand・topic-proposals・一時 SQLite。話題 700（場所なし）と、プロジェクト alpha・beta のあるワークスペース */
function realSetup(t: TestContext) {
  const db = tempDb(t);
  const now = (): Date => NOW;
  const stores = createStores(db, now);
  const { guildSettings, topicSessions, sessions, seeds, usage, history } = stores;
  guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  guildSettings.setStateCategory("guild-1", "active", 1, "active-1");
  const moves = new TopicMoveStore(db, now);
  const runner = new FakeRunner([ok("- 目的: 京都旅行の計画")]);
  const projectRunner = new FakeRunner([]);
  const ws = tempDir(t);
  for (const name of ["alpha", "beta"]) mkdirSync(join(ws, name));
  const gate: ProjectSessionGate = { places: { workspaceDir: ws, protectedDirs: [], generalDir: "general-dir" }, ready: () => true };
  const log = (): void => {};
  const move: MoveDeps = {
    topicSessions,
    moves,
    turnQueue: new RecordingQueue(2),
    turn: { runner, projectRunner, sessions, seeds, usage, log },
    runningTurns: () => [],
    projectSessions: gate,
    history,
    log,
  };
  const gateway = new FakeGateway({ allow: ["send", "sendMessage", "editMessage"] });
  topicSessions.create({ channelId: "700", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" });
  sessions.set("700", "session-1");
  const proposals = createTopicProposals({ move, moves, ownerPosts: gateway, now, log });
  const rightHand = createRightHand({
    cfg: { timeZone: "Asia/Tokyo", autoSessionPerDay: 3 },
    resolveChannel: (_guildId, channelId) => (channelId === "inbox-1" ? "inbox" : "session"),
    topicSessions,
    start: {
      gateway,
      guildSettings,
      topicSessions,
      queue: new KeyedSerialQueue(1),
      history,
      submitText: async () => assert.fail("想定外の呼び出し: submitText"),
      projectSessions: gate,
      log,
    },
    proposals,
    now,
    log,
  });
  const tools = topicTools({ list: rightHand.list, move: rightHand.move }, INBOX);
  const rows = () => db.prepare("SELECT state, by, to_dir FROM topic_moves ORDER BY id").all();
  return { tools, proposals, topicSessions, runner, projectRunner, gateway, rows };
}

/** 裏の処理（受け付けた後の結果の投稿）を待つ */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(cond(), "待っていた状態にならなかった");
}

test("topic_move は確認を出すだけ: 話題の project_dir は変わらず、topic_moves に proposed の行が 1 つあり、Runner は 1 回も呼ばれない。続けて accept すると場所が変わる", async (t) => {
  const env = realSetup(t);
  const result = (await env.tools.move({ topic: "700", place: "alpha" })) as { result: string; channelId: string };
  assert.equal(result.result, "proposed");
  assert.equal(result.channelId, "700");
  assert.equal(env.topicSessions.projectDirOf("700"), undefined);
  assert.deepEqual(env.rows().map((row) => ({ ...row })), [{ state: "proposed", by: "right_hand", to_dir: "alpha" }]);
  assert.equal(env.runner.inputs.length, 0);
  assert.equal(env.projectRunner.inputs.length, 0);
  // 札（[変える][このまま]）がその話題のチャンネルに出ている
  assert.deepEqual(env.gateway.posts.map((post) => post.channelId), ["700"]);

  // 道具から押すまでの 1 本: オーナーが [変える] を押すと（accept）付け替わる
  const pending = env.proposals.pending("700");
  assert.ok(pending !== undefined);
  assert.deepEqual(await env.proposals.accept(pending.id), { result: "accepted" });
  await waitFor(() => env.gateway.sent.length === 1);
  assert.equal(env.topicSessions.projectDirOf("700")?.projectDir, "alpha");
  assert.deepEqual(env.rows().map((row) => ({ ...row })), [{ state: "done", by: "right_hand", to_dir: "alpha" }]);
  assert.equal(env.runner.inputs.length, 1);
});
