// 取り込んだ会話の最初のターンの前置き（turn.ts の takeover。docs/plan/takeover.md §3.6.1・§3.6.3）と TAKEOVER_NOTE
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { RunResult } from "../src/agent/runner.ts";
import { PROJECT_APPEND, TAKEOVER_NOTE, TAKEOVER_NOTE_HEAD } from "../src/agent/system-prompt.ts";
import {
  ABORTED_ERROR,
  type ChannelTurn,
  RESUME_FAILURE_LIMIT,
  runChannelTurn,
  TIMEOUT_ERROR,
  type TurnDeps,
} from "../src/app/turn.ts";
import { CcTakeover, TAKEOVER_DROPPED_TEXT } from "../src/cc/takeover.ts";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { CcTakeoverStore } from "../src/store/cc-takeovers.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps, RecordingQueue } from "./helpers/recording.ts";
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
type TakeoverStep = "noteFor" | "noteDone" | "resumeDropped";

function fakeTakeover(takenSessionId: string, options: { throws?: readonly TakeoverStep[] } = {}) {
  const throws = (step: TakeoverStep): boolean => options.throws?.includes(step) === true;
  const calls = {
    noteFor: [] as Array<[string, string, { purpose?: string; scheduled?: boolean }]>,
    noteDone: [] as string[],
    resumeDropped: [] as Array<[string, string]>,
  };
  let pending = true;
  const takeover: NonNullable<TurnDeps["takeover"]> = {
    noteFor(key, sessionId, turn) {
      calls.noteFor.push([key, sessionId, turn]);
      if (throws("noteFor")) throw new TypeError("noteFor");
      if (!pending || turn.purpose !== undefined || turn.scheduled === true || sessionId !== takenSessionId) return undefined;
      return NOTE;
    },
    noteDone(key) {
      calls.noteDone.push(key);
      if (throws("noteDone")) throw new TypeError("noteDone");
      pending = false;
    },
    resumeDropped(key, sessionId) {
      calls.resumeDropped.push([key, sessionId]);
      if (throws("resumeDropped")) throw new TypeError("resumeDropped");
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
  for (const step of [failed(ABORTED_ERROR, false), failed(TIMEOUT_ERROR, false), failed("boom", false)]) {
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

test("noteFor が投げてもターンは壊れない（前置きは付かず、log は段の名前と例外の種類だけ）", async (t) => {
  const fake = fakeTakeover("session-taken", { throws: ["noteFor"] });
  const { runner, sessions, logs, run } = setup(t, [ok("session-taken")], fake.takeover);
  sessions.set("topic-1", "session-taken");

  assert.ok((await run()).ok);
  assert.equal(runner.inputs[0]!.prompt, PROMPT);
  assert.deepEqual(fake.calls.noteDone, []);
  assert.deepEqual(logs, ["取り込みの noteFor で例外（TypeError）が出たため、飛ばしてターンを続けます"]);
});

test("noteDone が投げても、成功した resume の結果は ok のまま", async (t) => {
  const fake = fakeTakeover("session-taken", { throws: ["noteDone"] });
  const { runner, sessions, logs, run } = setup(t, [ok("session-taken")], fake.takeover);
  sessions.set("topic-1", "session-taken");

  const result = await run();
  assert.ok(result.ok);
  assert.equal(runner.inputs[0]!.prompt, `${NOTE}\n\n${PROMPT}`);
  assert.deepEqual(fake.calls.noteDone, ["topic-1"]);
  assert.equal(sessions.get("topic-1"), "session-taken");
  assert.deepEqual(logs, ["取り込みの noteDone で例外（TypeError）が出たため、飛ばしてターンを続けます"]);
});

test("resumeDropped が投げても、捨てて新規でやり直す", async (t) => {
  const fake = fakeTakeover("session-taken", { throws: ["resumeDropped"] });
  const { runner, sessions, logs, run } = setup(
    t,
    [failed("No conversation found with session ID: x", false), ok("session-new")],
    fake.takeover,
  );
  sessions.set("topic-1", "session-taken");

  assert.ok((await run()).ok);
  assert.equal(runner.inputs.length, 2);
  assert.ok(!runner.inputs[1]!.prompt.includes(NOTE));
  assert.deepEqual(fake.calls.resumeDropped, [["topic-1", "session-taken"]]);
  assert.ok(logs.includes("取り込みの resumeDropped で例外（TypeError）が出たため、飛ばしてターンを続けます"));
  assert.equal(sessions.get("topic-1"), "session-new");
});

test("runner.run が投げたら noteDone は呼ばない（前置きは残る）", async (t) => {
  const fake = fakeTakeover("session-taken");
  const { runner, sessions, run } = setup(t, [new Error("落ちた")], fake.takeover);
  sessions.set("topic-1", "session-taken");

  await assert.rejects(run());
  assert.equal(runner.inputs[0]!.prompt, `${NOTE}\n\n${PROMPT}`);
  assert.deepEqual(fake.calls.noteDone, []);
  assert.equal(fake.pending(), true);
});

test("前置きを消した後のターンで捨てても、resumeDropped は呼ぶ", async (t) => {
  const fake = fakeTakeover("session-taken");
  const { runner, sessions, run } = setup(
    t,
    [ok("session-taken"), failed("No conversation found with session ID: x", false), ok("session-new")],
    fake.takeover,
  );
  sessions.set("topic-1", "session-taken");

  assert.ok((await run()).ok);
  assert.deepEqual(fake.calls.noteDone, ["topic-1"]);
  assert.ok((await run()).ok);
  assert.equal(runner.inputs[1]!.prompt, PROMPT);
  assert.deepEqual(fake.calls.resumeDropped, [["topic-1", "session-taken"]]);
});

test("画像の拒否で sessionRecorded が false: noteDone は呼ばず、resumeDropped が 1 回", async (t) => {
  const fake = fakeTakeover("session-taken");
  const rejected: RunResult = { ...failed("Could not process image", false), imageRejected: true } as RunResult;
  const { runner, sessions, run } = setup(t, [rejected, ok("session-new")], fake.takeover);
  sessions.set("topic-1", "session-taken");

  assert.ok((await run()).ok);
  assert.equal(runner.inputs[0]!.prompt, `${NOTE}\n\n${PROMPT}`);
  assert.ok(!runner.inputs[1]!.prompt.includes(NOTE));
  assert.deepEqual(fake.calls.noteDone, []);
  assert.deepEqual(fake.calls.resumeDropped, [["topic-1", "session-taken"]]);
});

/** 本物の CcTakeover（cc/takeover.ts）。noteFor・noteDone・resumeDropped が使わない部品は、呼ばれたら投げる */
function realSetup(t: TestContext, steps: FakeRunStep[]) {
  const db = tempDb(t);
  const now = (): Date => NOW;
  const runner = new FakeRunner(steps);
  const stores = createStores(db, now);
  const { sessions, seeds, topicSessions, memories, inboxSummaries, usage, guildSettings } = stores;
  const takeovers = new CcTakeoverStore(db, now);
  const gateway = new FakeGateway({ allow: ["sendMessage"], messageIdPrefix: "msg-" });
  const unused = (name: string) => (): never => {
    throw new Error(`想定外の呼び出し: ${name}`);
  };
  const takeover = new CcTakeover({
    db,
    cfg: { workspaceDir: "/nonexistent" },
    home: "/nonexistent",
    claudeConfigDir: "/nonexistent",
    registry: { tick: unused("tick"), snapshot: unused("snapshot") },
    panes: { lookup: unused("lookup") },
    probePane: unused("probePane"),
    dirs: { sessionFile: unused("sessionFile") },
    takeovers,
    ccChannels: new CcChannelStore(db, now),
    ccSessions: new CcSessionStore(db, now),
    ccSends: new CcSendStore(db, now),
    ccPermissions: new CcPermissionStore(db, now),
    topicSessions,
    sdkSessions: sessions,
    guildSettings,
    ready: () => true,
    checkSessionProject: unused("checkSessionProject"),
    verifiedProjectDir: unused("verifiedProjectDir"),
    findStateCategory: unused("findStateCategory"),
    queue: new RecordingQueue(1),
    channelOps: new RecordingChannelOps(),
    gateway,
    kill: unused("kill"),
    readProc: unused("readProc"),
    readBtime: unused("readBtime"),
    sleep: unused("sleep"),
    now,
    ownPid: 1,
    replayEnded: unused("replayEnded"),
    note: TAKEOVER_NOTE,
    log: () => {},
  });
  // 取り込みは通さず、ストアに done・note_pending = 1 の行を直接作る
  const row = takeovers.propose({
    sessionId: "session-taken",
    source: "ended",
    project: "alpha",
    guildId: "guild-1",
    channelId: "topic-1",
    entry: "discord",
    permissionMode: "default",
  })!;
  assert.ok(takeovers.start(row.id));
  assert.ok(takeovers.finish(row.id));
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "作業", categoryId: "active-1" });
  sessions.set("topic-1", "session-taken");
  const deps: TurnDeps = { runner, sessions, seeds, topicSessions, inboxSummaries, memories, usage, log: () => {}, takeover };
  return { runner, takeovers, gateway, run: () => runChannelTurn(deps, TURN) };
}

test("本物の CcTakeover: done・note_pending = 1 の行 → 最初の resume に前置き → 消えて次のターンは付かない", async (t) => {
  const { runner, takeovers, run } = realSetup(t, [ok("session-taken"), ok("session-taken")]);
  assert.equal(takeovers.takenFor("topic-1")?.notePending, true);

  assert.ok((await run()).ok);
  assert.equal(runner.inputs[0]!.prompt, `${TAKEOVER_NOTE}\n\n${PROMPT}`);
  assert.equal(takeovers.takenFor("topic-1")?.notePending, false);

  assert.ok((await run()).ok);
  assert.equal(runner.inputs[1]!.prompt, PROMPT);
});

test("本物の CcTakeover: SDK セッションを捨てたら resumeDropped で知らせが 1 通", async (t) => {
  const { runner, takeovers, gateway, run } = realSetup(t, [
    failed("No conversation found with session ID: x", false),
    ok("session-new"),
  ]);

  assert.ok((await run()).ok);
  assert.ok(!runner.inputs[1]!.prompt.includes(TAKEOVER_NOTE_HEAD));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    gateway.posts.map((post) => [post.channelId, post.message.text]),
    [["topic-1", TAKEOVER_DROPPED_TEXT]],
  );
  assert.equal(takeovers.takenFor("topic-1")?.notePending, false);
});
