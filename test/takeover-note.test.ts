// 取り込んだ会話の最初のターンの前置き（turn.ts の takeover。docs/plan/takeover.md §3.6.1・§3.6.3）と TAKEOVER_NOTE
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { RunResult } from "../src/agent/runner.ts";
import { PROJECT_APPEND, TAKEOVER_NOTE, TAKEOVER_NOTE_HEAD } from "../src/agent/system-prompt.ts";
import { ABORTED_ERROR, type ChannelTurn, RESUME_FAILURE_LIMIT, runChannelTurn, type TurnDeps } from "../src/app/turn.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeRunner, type FakeRunStep, turnUsage } from "./helpers/runner.ts";

const NOW = new Date("2026-11-13T00:00:00.000Z");
const PROMPT = "[2026-11-13(金) 09:00 JST #作業]\n続きをお願い";
const NOTE = "（前置き）";
const TURN: ChannelTurn = { guildId: "guild-1", channelId: "topic-1", kind: "session", prompt: PROMPT, allowedUrls: [] };

function ok(sessionId: string): RunResult {
  return { ok: true, text: "はい", sessionId, usage: turnUsage(1, 0, 0), durationMs: 1, toolCalls: 0, contextTokens: 1 };
}

function failed(errorMessage: string, sessionRecorded: boolean, sessionId?: string): RunResult {
  return {
    ok: false,
    errorMessage,
    ...(sessionId === undefined ? {} : { sessionId }),
    sessionRecorded,
    toolCalls: 0,
  };
}

/** 偽の takeover。本体（cc/takeover.ts の noteFor）と同じく、purpose・予約・session_id の違い・消した後は返さない */
function fakeTakeover(takenSessionId: string, options: { throws?: boolean } = {}) {
  const calls = {
    noteFor: [] as Array<[string, string, { purpose?: string; scheduled?: boolean }]>,
    noteDone: [] as string[],
    resumeDropped: [] as Array<[string, string]>,
  };
  let pending = true;
  const takeover: NonNullable<TurnDeps["takeover"]> = {
    noteFor(key, sessionId, turn) {
      calls.noteFor.push([key, sessionId, turn]);
      if (options.throws === true) throw new Error("noteFor");
      if (!pending || turn.purpose !== undefined || turn.scheduled === true || sessionId !== takenSessionId) return undefined;
      return NOTE;
    },
    noteDone(key) {
      calls.noteDone.push(key);
      if (options.throws === true) throw new Error("noteDone");
      pending = false;
    },
    resumeDropped(key, sessionId) {
      calls.resumeDropped.push([key, sessionId]);
      if (options.throws === true) throw new Error("resumeDropped");
      if (sessionId === takenSessionId) pending = false;
    },
  };
  return { takeover, calls, pending: () => pending };
}

function setup(t: TestContext, steps: FakeRunStep[], takeover?: TurnDeps["takeover"]) {
  const db = tempDb(t);
  const runner = new FakeRunner(steps);
  const { sessions, seeds, topicSessions, memories, inboxSummaries, usage } = createStores(db, () => NOW);
  const logs: string[] = [];
  const deps: TurnDeps = {
    runner,
    sessions,
    seeds,
    topicSessions,
    inboxSummaries,
    memories,
    usage,
    log: (line) => {
      if (!line.startsWith("トークン（")) logs.push(line);
    },
    ...(takeover === undefined ? {} : { takeover }),
  };
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "作業", categoryId: "active-1" });
  return { runner, sessions, logs, run: (turn: ChannelTurn = TURN) => runChannelTurn(deps, turn) };
}

test("TAKEOVER_NOTE は頭書きの後に PROJECT_APPEND をそのまま含む", () => {
  assert.equal(TAKEOVER_NOTE, `${TAKEOVER_NOTE_HEAD}\n${PROJECT_APPEND}`);
  assert.ok(TAKEOVER_NOTE.includes(PROJECT_APPEND));
  assert.ok(TAKEOVER_NOTE_HEAD.startsWith("（self-agent が付けた知らせです。オーナーの発言ではありません）"));
});

test("resume が成功: 前置きを prompt の頭に付けて消す。noteFor には key・今の session_id・ターンが渡る。次のターンには付かない", async (t) => {
  const fake = fakeTakeover("session-taken");
  const { runner, sessions, run } = setup(t, [ok("session-taken"), ok("session-taken")], fake.takeover);
  sessions.set("topic-1", "session-taken");

  assert.ok((await run()).ok);
  assert.equal(runner.inputs[0]!.prompt, `${NOTE}\n\n${PROMPT}`);
  assert.equal(runner.inputs[0]!.sessionId, "session-taken");
  assert.deepEqual(fake.calls.noteFor, [["topic-1", "session-taken", {}]]);
  assert.deepEqual(fake.calls.noteDone, ["topic-1"]);

  assert.ok((await run()).ok);
  assert.equal(runner.inputs[1]!.prompt, PROMPT);
  assert.deepEqual(fake.calls.resumeDropped, []);
});

test("result の届いた失敗（手順数の上限など）: 記録済みなので前置きを消す", async (t) => {
  const fake = fakeTakeover("session-taken");
  const { runner, sessions, run } = setup(t, [failed("error_max_turns", true, "session-taken")], fake.takeover);
  sessions.set("topic-1", "session-taken");

  const result = await run();
  assert.equal(result.ok, false);
  assert.equal(runner.inputs.length, 1);
  assert.equal(runner.inputs[0]!.prompt, `${NOTE}\n\n${PROMPT}`);
  assert.deepEqual(fake.calls.noteDone, ["topic-1"]);
  assert.equal(fake.pending(), false);
});

test("中断・タイムアウト・result の届かない失敗: 前置きを残し、次の resume にも付ける", async (t) => {
  for (const step of [failed(ABORTED_ERROR, false), failed("timeout", false), failed("boom", false)]) {
    const fake = fakeTakeover("session-taken");
    const { runner, sessions, run } = setup(t, [step, ok("session-taken")], fake.takeover);
    sessions.set("topic-1", "session-taken");

    assert.equal((await run()).ok, false);
    assert.deepEqual(fake.calls.noteDone, []);
    assert.deepEqual(fake.calls.resumeDropped, []);
    assert.equal(fake.pending(), true);

    assert.ok((await run()).ok);
    assert.equal(runner.inputs[1]!.prompt, `${NOTE}\n\n${PROMPT}`);
    assert.deepEqual(fake.calls.noteDone, ["topic-1"]);
  }
});

test("No conversation found で捨てる: resumeDropped が 1 回（捨てる session_id で）。やり直しの新規の prompt に前置きは入らない", async (t) => {
  const fake = fakeTakeover("session-taken");
  const { runner, sessions, run } = setup(
    t,
    [failed("No conversation found with session ID: x", false), ok("session-new")],
    fake.takeover,
  );
  sessions.set("topic-1", "session-taken");

  assert.ok((await run()).ok);
  assert.equal(runner.inputs.length, 2);
  assert.equal(runner.inputs[1]!.sessionId, undefined);
  assert.ok(!runner.inputs[1]!.prompt.includes(NOTE));
  assert.ok(runner.inputs[1]!.prompt.endsWith(PROMPT));
  assert.deepEqual(fake.calls.resumeDropped, [["topic-1", "session-taken"]]);
  assert.deepEqual(fake.calls.noteFor.length, 1);
  assert.deepEqual(fake.calls.noteDone, []);
  assert.equal(fake.pending(), false);
  assert.equal(sessions.get("topic-1"), "session-new");
});

test("画像の拒否で捨てる: resumeDropped が 1 回。やり直しの prompt に前置きは入らない", async (t) => {
  const fake = fakeTakeover("session-taken");
  const rejected: RunResult = { ...failed("success (is_error)", true, "session-taken"), imageRejected: true } as RunResult;
  const { runner, sessions, run } = setup(t, [rejected, ok("session-new")], fake.takeover);
  sessions.set("topic-1", "session-taken");

  assert.ok((await run()).ok);
  assert.ok(!runner.inputs[1]!.prompt.includes(NOTE));
  assert.deepEqual(fake.calls.resumeDropped, [["topic-1", "session-taken"]]);
  assert.equal(fake.pending(), false);
});

test("連続失敗で捨てる: 上限に届いたターンだけ resumeDropped が 1 回", async (t) => {
  const fake = fakeTakeover("session-taken");
  const steps: FakeRunStep[] = [];
  for (let i = 0; i < RESUME_FAILURE_LIMIT; i++) steps.push(failed("boom", false));
  steps.push(ok("session-new"));
  const { runner, sessions, run } = setup(t, steps, fake.takeover);
  sessions.set("topic-1", "session-taken");

  for (let i = 0; i < RESUME_FAILURE_LIMIT - 1; i++) {
    assert.equal((await run()).ok, false);
    assert.deepEqual(fake.calls.resumeDropped, []);
  }
  assert.ok((await run()).ok);
  assert.deepEqual(fake.calls.resumeDropped, [["topic-1", "session-taken"]]);
  const fresh = runner.inputs[RESUME_FAILURE_LIMIT]!;
  assert.equal(fresh.sessionId, undefined);
  assert.ok(!fresh.prompt.includes(NOTE));
});

test("session_id が取り込んだものと違えば付かない（noteFor には今の session_id が渡る）", async (t) => {
  const fake = fakeTakeover("session-taken");
  const { runner, sessions, run } = setup(t, [ok("session-other")], fake.takeover);
  sessions.set("topic-1", "session-other");

  assert.ok((await run()).ok);
  assert.equal(runner.inputs[0]!.prompt, PROMPT);
  assert.deepEqual(fake.calls.noteFor, [["topic-1", "session-other", {}]]);
  assert.deepEqual(fake.calls.noteDone, []);
});

test("/close（purpose close）・予約のターンでは付かない（noteFor にその印が渡る）", async (t) => {
  const fake = fakeTakeover("session-taken");
  const { runner, sessions, run } = setup(t, [ok("session-taken"), ok("session-taken")], fake.takeover);
  sessions.set("topic-1", "session-taken");

  assert.ok((await run({ ...TURN, purpose: "close" })).ok);
  assert.ok((await run({ ...TURN, scheduled: true })).ok);
  assert.equal(runner.inputs[0]!.prompt, PROMPT);
  assert.equal(runner.inputs[1]!.prompt, PROMPT);
  assert.deepEqual(fake.calls.noteFor, [
    ["topic-1", "session-taken", { purpose: "close" }],
    ["topic-1", "session-taken", { scheduled: true }],
  ]);
  assert.deepEqual(fake.calls.noteDone, []);
  assert.equal(fake.pending(), true);
});

test("SDK セッションが無い（新規）ターンでは noteFor を呼ばず、prompt に前置きは入らない", async (t) => {
  const fake = fakeTakeover("session-taken");
  const { runner, run } = setup(t, [ok("session-new")], fake.takeover);

  assert.ok((await run()).ok);
  assert.equal(runner.inputs[0]!.prompt, PROMPT);
  assert.deepEqual(fake.calls.noteFor, []);
  assert.deepEqual(fake.calls.resumeDropped, []);
});

test("takeover を渡さないときは、resume・捨ててやり直しの prompt が今と同じ", async (t) => {
  const { runner, sessions, run } = setup(t, [
    ok("session-a"),
    failed("No conversation found with session ID: x", false),
    ok("session-b"),
  ]);
  sessions.set("topic-1", "session-a");

  assert.ok((await run()).ok);
  assert.equal(runner.inputs[0]!.prompt, PROMPT);
  assert.ok((await run()).ok);
  assert.equal(runner.inputs[1]!.prompt, PROMPT);
  assert.equal(runner.inputs[2]!.prompt, `前の会話の記録が切れたため、要約から再開します。\n題名: 作業\n\n${PROMPT}`);
});

test("takeover の 3 つが投げてもターンは壊れない（前置きは付かず、log は段の名前だけ）", async (t) => {
  const fake = fakeTakeover("session-taken", { throws: true });
  const { runner, sessions, logs, run } = setup(
    t,
    [failed("No conversation found with session ID: x", false), ok("session-new")],
    fake.takeover,
  );
  sessions.set("topic-1", "session-taken");

  assert.ok((await run()).ok);
  assert.equal(runner.inputs[0]!.prompt, PROMPT);
  assert.deepEqual(fake.calls.resumeDropped, [["topic-1", "session-taken"]]);
  assert.ok(logs.includes("取り込みの noteFor で例外が出たため、飛ばしてターンを続けます"));
  assert.ok(logs.includes("取り込みの resumeDropped で例外が出たため、飛ばしてターンを続けます"));
  assert.equal(sessions.get("topic-1"), "session-new");
});
