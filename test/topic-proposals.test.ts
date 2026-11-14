import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../src/agent/runner.ts";
import type { ProjectSessionGate } from "../src/app/session-ops.ts";
import { MOVE_FAILED_TEXT, type MoveDeps, movedPostText, moveRefusalText, moveTopic } from "../src/app/topic-move.ts";
import {
  createTopicProposals,
  MOVE_PROPOSAL_SWEEP_MS,
  MOVE_PROPOSAL_TTL_MS,
  moveProposalButtons,
  PROPOSAL_ACCEPTED,
  PROPOSAL_EXPIRED,
  PROPOSAL_EXPIRED_NOTICE,
  PROPOSAL_KEPT,
  PROPOSAL_KEPT_NOTICE,
  PROPOSAL_REFUSED,
  proposalText,
  proposedNoticeText,
  TopicProposalExpirer,
} from "../src/app/topic-proposals.ts";
import type { CcTimers } from "../src/cc/registry.ts";
import { escapeDiscordText } from "../src/discord/escape.ts";
import { TopicMoveStore } from "../src/store/topic-moves.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingQueue } from "./helpers/recording.ts";
import { FakeRunner, type FakeRunStep, turnUsage } from "./helpers/runner.ts";

const NOW = new Date("2026-11-14T01:00:00Z");
const TITLE = "旅行の計画";
const GENERAL = "general-dir";
const NOTE = "- 目的: 京都旅行の計画";

function ok(text: string): RunResult {
  return { ok: true, text, sessionId: "session-1", usage: turnUsage(10, 2000, 300), durationMs: 4200, toolCalls: 0, contextTokens: 2310 };
}
const FAILED: RunResult = { ok: false, errorMessage: "error_during_execution: boom", sessionId: "session-1", sessionRecorded: true, toolCalls: 0 };

type SetupOptions = { steps?: FakeRunStep[]; projectDir?: string; persona?: string };

function setup(t: TestContext, options: SetupOptions = {}) {
  const db = tempDb(t);
  const clock = { at: NOW };
  const now = (): Date => clock.at;
  const stores = createStores(db, now);
  const { topicSessions, sessions, seeds, usage, history } = stores;
  const moves = new TopicMoveStore(db, now);
  const runner = new FakeRunner(options.steps ?? []);
  const projectRunner = new FakeRunner([]);
  const turnQueue = new RecordingQueue(2);
  const ws = tempDir(t);
  for (const name of ["alpha", "beta"]) mkdirSync(join(ws, name));
  const gate: ProjectSessionGate = { places: { workspaceDir: ws, protectedDirs: [], generalDir: GENERAL }, ready: () => true };
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const running: Array<{ channelId: string }> = [];
  const move: MoveDeps = {
    topicSessions,
    moves,
    turnQueue,
    turn: { runner, projectRunner, sessions, seeds, usage, log },
    runningTurns: () => running,
    projectSessions: gate,
    history,
    log,
  };
  const gateway = new FakeGateway({ allow: ["send", "sendMessage", "editMessage"] });
  const createTopic = (channelId: string): void => {
    topicSessions.create({
      channelId,
      guildId: "guild-1",
      title: TITLE,
      categoryId: "active-1",
      ...(options.persona === undefined ? {} : { persona: options.persona }),
      ...(options.projectDir === undefined ? {} : { projectDir: options.projectDir, permissionMode: "default" as const }),
    });
    sessions.set(channelId, "session-1");
  };
  createTopic("topic-1");
  const make = (store: TopicMoveStore = moves) =>
    createTopicProposals({ move: { ...move, moves: store }, moves: store, ownerPosts: gateway, now, log });
  const proposals = make();
  const alpha = (channelId: string = "topic-1") => ({ guildId: "guild-1", channelId, place: { kind: "project" as const, name: "alpha" } });
  const rows = () => db.prepare("SELECT * FROM topic_moves ORDER BY id").all();
  const historyRows = (channelId: string = "topic-1") => history.list(channelId, { limit: 50 }).map((row) => ({ kind: row.kind, text: row.text }));
  const advance = (ms: number): void => {
    clock.at = new Date(clock.at.getTime() + ms);
  };
  return { db, clock, advance, moves, move, gateway, runner, running, logs, proposals, make, alpha, rows, historyRows, createTopic, ...stores };
}

/** 裏の処理（受け付けた後の結果の投稿）を待つ */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(cond(), "待っていた状態にならなかった");
}

test("propose: proposed の行を 1 つ作り、その話題のチャンネルに [変える][このまま] の 1 通を出し、message_id を残す", async (t) => {
  const env = setup(t);
  const result = await env.proposals.propose(env.alpha());
  assert.equal(result.result, "proposed");
  if (result.result !== "proposed") return;
  assert.deepEqual(result, { result: "proposed", id: result.id, channelId: "topic-1", from: "なし", to: "alpha" });
  assert.deepEqual(env.gateway.posts, [
    { channelId: "topic-1", messageId: "message-1", message: { text: proposalText("なし", "alpha"), components: moveProposalButtons(result.id) } },
  ]);
  assert.deepEqual(moveProposalButtons(result.id), [
    {
      kind: "buttons",
      buttons: [
        { customId: `move:ok:${result.id}`, label: "変える", style: "primary" },
        { customId: `move:keep:${result.id}`, label: "このまま", style: "secondary" },
      ],
    },
  ]);
  const rows = env.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]?.state, rows[0]?.by, rows[0]?.from_dir, rows[0]?.to_dir, rows[0]?.message_id], ["proposed", "right_hand", null, "alpha", "message-1"]);
  assert.deepEqual(env.historyRows(), [{ kind: "notice", text: proposedNoticeText("なし", "alpha") }]);
});

test("propose: 場所を変えない（project_dir・SDK セッション・seed がそのまま）", async (t) => {
  const env = setup(t);
  env.seeds.set("topic-1", "前の seed");
  await env.proposals.propose(env.alpha());
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
  assert.equal(env.sessions.get("topic-1"), "session-1");
  assert.equal(env.seeds.get("topic-1"), "前の seed");
  assert.equal(env.runner.inputs.length, 0);
});

test("propose: 実行中の話題でも出せる", async (t) => {
  const env = setup(t);
  env.running.push({ channelId: "topic-1" });
  assert.equal((await env.proposals.propose(env.alpha())).result, "proposed");
});

test("propose: 閉じた話題・人格の話題・同じ場所・知らないプロジェクトは refused で、行も投稿も作らない", async (t) => {
  type Env = ReturnType<typeof setup>;
  const cases: Array<{ expected: string; options?: SetupOptions; arrange?: (env: Env) => void; name?: string }> = [
    { expected: "closed", arrange: (env) => void env.topicSessions.close("topic-1", "要約") },
    { expected: "persona", options: { persona: "beta-persona" } },
    { expected: "same_place", options: { projectDir: "alpha" } },
    { expected: "invalid_project", name: "missing" },
  ];
  for (const item of cases) {
    const env = setup(t, item.options);
    item.arrange?.(env);
    const result = await env.proposals.propose({ ...env.alpha(), place: { kind: "project", name: item.name ?? "alpha" } });
    assert.deepEqual(result, { result: "refused", reason: item.expected }, item.expected);
    assert.equal(env.rows().length, 0, item.expected);
    assert.equal(env.gateway.posts.length, 0, item.expected);
  }
});

test("propose: 答えていない確認がある話題にもう 1 度出すと already_proposed で、投稿は増えない", async (t) => {
  const env = setup(t);
  await env.proposals.propose(env.alpha());
  assert.deepEqual(await env.proposals.propose({ ...env.alpha(), place: { kind: "general" } }), { result: "already_proposed", channelId: "topic-1" });
  assert.equal(env.gateway.posts.length, 1);
  assert.equal(env.rows().length, 1);
});

test("propose: 期限の切れた確認が残っている話題に出すと、古い札が「期限が切れました」になり、新しい確認が出る", async (t) => {
  const env = setup(t);
  await env.proposals.propose(env.alpha());
  env.advance(MOVE_PROPOSAL_TTL_MS + 1000);
  const result = await env.proposals.propose({ ...env.alpha(), place: { kind: "general" } });
  assert.equal(result.result, "proposed");
  assert.deepEqual(env.gateway.edits, [{ channelId: "topic-1", messageId: "message-1", message: { text: PROPOSAL_EXPIRED, components: [] } }]);
  assert.equal(env.gateway.posts.length, 2);
  assert.deepEqual(env.rows().map((row) => row.state), ["cancelled", "proposed"]);
});

test("propose: 投稿に失敗すると行は cancelled になり、例外が出る", async (t) => {
  const env = setup(t);
  env.gateway.beforeSendMessage = () => {
    throw new Error("送れない");
  };
  await assert.rejects(env.proposals.propose(env.alpha()), /送れない/);
  assert.deepEqual(env.rows().map((row) => row.state), ["cancelled"]);
});

test("accept: moveTopic が 1 回走り、同じ行が running → done（by は right_hand）。札は「変えています」でボタンが消え、終わるとチャンネルに結果の文", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const proposed = await env.proposals.propose(env.alpha());
  assert.equal(proposed.result, "proposed");
  if (proposed.result !== "proposed") return;
  assert.deepEqual(await env.proposals.accept(proposed.id), { result: "accepted" });
  assert.deepEqual(env.gateway.edits, [{ channelId: "topic-1", messageId: "message-1", message: { text: PROPOSAL_ACCEPTED("alpha"), components: [] } }]);
  await waitFor(() => env.gateway.sent.length === 1);
  assert.equal(env.gateway.sent[0]?.text, movedPostText({ from: null, to: "alpha", note: NOTE }, GENERAL));
  assert.equal(env.runner.inputs.length, 1);
  const rows = env.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]?.id, rows[0]?.state, rows[0]?.by], [proposed.id, "done", "right_hand"]);
  assert.equal(env.topicSessions.projectDirOf("topic-1")?.projectDir, "alpha");
});

test("accept: 2 回続けて呼ぶと 2 回目は stale で、付け替えは 1 回だけ", async (t) => {
  const env = setup(t, { steps: [ok(NOTE), ok(NOTE)] });
  const proposed = await env.proposals.propose(env.alpha());
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  const [first, second] = await Promise.all([env.proposals.accept(proposed.id), env.proposals.accept(proposed.id)]);
  assert.deepEqual(first, { result: "accepted" });
  assert.deepEqual(second, { result: "stale" });
  await waitFor(() => env.gateway.sent.length === 1);
  assert.equal(env.runner.inputs.length, 1);
  assert.equal(env.rows().length, 1);
});

test("accept: 実行中の話題は refused（busy・kept true）で、札と行は残り、後でもう 1 度 accept できる", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const proposed = await env.proposals.propose(env.alpha());
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  env.running.push({ channelId: "topic-1" });
  assert.deepEqual(await env.proposals.accept(proposed.id), { result: "refused", reason: "busy", kept: true });
  assert.equal(env.rows()[0]?.state, "proposed");
  assert.equal(env.gateway.edits.length, 0);
  env.running.length = 0;
  assert.deepEqual(await env.proposals.accept(proposed.id), { result: "accepted" });
  await waitFor(() => env.gateway.sent.length === 1);
  assert.equal(env.rows()[0]?.state, "done");
});

test("accept: 同じ場所になっていた話題は refused（same_place・kept false）で、行は cancelled、札は断りの文", async (t) => {
  const env = setup(t);
  const proposed = await env.proposals.propose(env.alpha());
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  env.topicSessions.setProject("topic-1", "alpha", "default");
  assert.deepEqual(await env.proposals.accept(proposed.id), { result: "refused", reason: "same_place", kept: false });
  assert.equal(env.rows()[0]?.state, "cancelled");
  assert.deepEqual(env.gateway.edits, [
    { channelId: "topic-1", messageId: "message-1", message: { text: PROPOSAL_REFUSED(moveRefusalText("same_place")), components: [] } },
  ]);
  assert.deepEqual(env.historyRows().at(-1), { kind: "notice", text: PROPOSAL_REFUSED(moveRefusalText("same_place")) });
  assert.equal(env.runner.inputs.length, 0);
});

test("accept・keep: 10 分を過ぎた確認は stale で、場所は変わらない", async (t) => {
  for (const action of ["accept", "keep"] as const) {
    const env = setup(t, { steps: [ok(NOTE)] });
    const proposed = await env.proposals.propose(env.alpha());
    if (proposed.result !== "proposed") return assert.fail("proposed でない");
    env.advance(MOVE_PROPOSAL_TTL_MS + 1000);
    assert.deepEqual(await env.proposals[action](proposed.id), { result: "stale" }, action);
    assert.equal(env.rows()[0]?.state, "cancelled", action);
    assert.deepEqual(env.gateway.edits.map((edit) => edit.message.text), [PROPOSAL_EXPIRED], action);
    assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined, action);
    assert.equal(env.runner.inputs.length, 0, action);
  }
});

test("keep: 行を cancelled にし、札を「このままにしました」にし、場所を変えない", async (t) => {
  const env = setup(t);
  const proposed = await env.proposals.propose(env.alpha());
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  assert.deepEqual(await env.proposals.keep(proposed.id), { result: "kept" });
  assert.equal(env.rows()[0]?.state, "cancelled");
  assert.deepEqual(env.gateway.edits, [{ channelId: "topic-1", messageId: "message-1", message: { text: PROPOSAL_KEPT("なし"), components: [] } }]);
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
  assert.deepEqual(env.historyRows().map((row) => row.text), [proposedNoticeText("なし", "alpha"), PROPOSAL_KEPT_NOTICE]);
  assert.deepEqual(await env.proposals.keep(proposed.id), { result: "stale" });
  assert.deepEqual(await env.proposals.accept(proposed.id), { result: "stale" });
});

test("accept: 要点のターンが失敗したとき、場所は変わらず、チャンネルに失敗の文が出て、行は failed", async (t) => {
  const env = setup(t, { steps: [FAILED] });
  const proposed = await env.proposals.propose(env.alpha());
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  assert.deepEqual(await env.proposals.accept(proposed.id), { result: "accepted" });
  await waitFor(() => env.gateway.sent.length === 1);
  assert.equal(env.gateway.sent[0]?.text, MOVE_FAILED_TEXT);
  assert.equal(env.rows()[0]?.state, "failed");
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
});

test("sweep: 期限の切れた確認だけを片付け、期限の中の確認は残す。pendingAll は期限の中の確認だけで、from・to は場所の名前", async (t) => {
  const env = setup(t);
  env.createTopic("topic-2");
  await env.proposals.propose(env.alpha("topic-2"));
  env.advance(MOVE_PROPOSAL_TTL_MS + 1000);
  const fresh = await env.proposals.propose({ guildId: "guild-1", channelId: "topic-1", place: { kind: "general" } });
  if (fresh.result !== "proposed") return assert.fail("proposed でない");
  const pending = env.proposals.pendingAll();
  assert.deepEqual(pending, [
    {
      id: fresh.id,
      channelId: "topic-1",
      from: "なし",
      to: "General",
      createdAt: env.clock.at.toISOString(),
      expiresAt: new Date(env.clock.at.getTime() + MOVE_PROPOSAL_TTL_MS).toISOString(),
    },
  ]);
  assert.equal(env.proposals.pending("topic-2"), undefined);
  assert.deepEqual(env.proposals.pending("topic-1"), pending[0]);
  await env.proposals.sweep();
  assert.deepEqual(env.rows().map((row) => [row.channel_id, row.state]), [
    ["topic-2", "cancelled"],
    ["topic-1", "proposed"],
  ]);
  assert.deepEqual(env.gateway.edits, [{ channelId: "topic-2", messageId: "message-1", message: { text: PROPOSAL_EXPIRED, components: [] } }]);
  assert.deepEqual(env.historyRows("topic-2").map((row) => row.text).at(-1), PROPOSAL_EXPIRED_NOTICE);
  assert.equal(env.proposals.channelOf(fresh.id), "topic-1");
  assert.equal(env.proposals.channelOf(9999), undefined);
});

test("作り直した（再起動に当たる）後も、期限の中の確認は accept できる", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const proposed = await env.proposals.propose(env.alpha());
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  env.advance(5 * 60_000);
  const restarted = env.make(new TopicMoveStore(env.db, () => env.clock.at));
  assert.equal(restarted.pending("topic-1")?.id, proposed.id);
  assert.deepEqual(await restarted.accept(proposed.id), { result: "accepted" });
  await waitFor(() => env.gateway.sent.length === 1);
  assert.equal(env.rows()[0]?.state, "done");
});

test("TopicProposalExpirer: start の直後に 1 回 sweep し、以後は MOVE_PROPOSAL_SWEEP_MS ごと。sweep が投げても log だけ", async () => {
  let sweeps = 0;
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const timers: CcTimers = {
    after: (fn, ms) => {
      scheduled.push({ fn, ms });
      return () => {};
    },
  };
  const logs: string[] = [];
  const expirer = new TopicProposalExpirer({
    proposals: {
      sweep: async () => {
        sweeps += 1;
        if (sweeps === 2) throw new TypeError("boom");
      },
    },
    log: (line) => logs.push(line),
    timers,
  });
  expirer.start();
  await expirer.idle();
  await waitFor(() => scheduled.length === 1);
  assert.equal(sweeps, 1);
  assert.equal(scheduled[0]?.ms, MOVE_PROPOSAL_SWEEP_MS);
  scheduled[0]?.fn();
  await waitFor(() => scheduled.length === 2);
  assert.equal(sweeps, 2);
  assert.deepEqual(logs, ["場所を変える確認の失効を確かめられませんでした（TypeError）"]);
  expirer.stop();
});

test("log に話題の ID・場所の名前・題名が出ない", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  env.createTopic("topic-2");
  const first = await env.proposals.propose(env.alpha());
  await env.proposals.propose({ guildId: "guild-1", channelId: "topic-2", place: { kind: "general" } });
  if (first.result !== "proposed") return assert.fail("proposed でない");
  env.gateway.beforeEdit = () => {
    throw new Error("書けない");
  };
  await env.proposals.accept(first.id);
  await waitFor(() => env.gateway.sent.length === 1);
  env.advance(MOVE_PROPOSAL_TTL_MS + 1000);
  await env.proposals.sweep();
  assert.ok(env.logs.some((line) => line.includes("書き換えに失敗しました（Error）")));
  assert.ok(env.logs.some((line) => line.includes("1 件片付けました")));
  for (const line of env.logs) {
    for (const secret of ["topic-1", "topic-2", "alpha", GENERAL, TITLE, "message-"]) {
      assert.ok(!line.includes(secret), `${secret} が log に出た: ${line}`);
    }
  }
});

test("期限切れの片付け: sweep が 1 行目の札の書き換えを待つ間に 2 行目が accept で片付いても、2 行目の札の書き換えと履歴の知らせは 1 回で、付け替えは走らない", async (t) => {
  const env = setup(t);
  env.createTopic("topic-2");
  await env.proposals.propose(env.alpha());
  const second = await env.proposals.propose(env.alpha("topic-2"));
  if (second.result !== "proposed") return assert.fail("proposed でない");
  env.advance(MOVE_PROPOSAL_TTL_MS + 1000);
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let editStarted = false;
  env.gateway.beforeEdit = (channelId) => {
    if (channelId !== "topic-1") return;
    editStarted = true;
    return held;
  };
  const sweeping = env.proposals.sweep();
  await waitFor(() => editStarted);
  assert.deepEqual(await env.proposals.accept(second.id), { result: "stale" });
  release();
  await sweeping;
  assert.equal(env.gateway.edits.filter((edit) => edit.channelId === "topic-2").length, 1);
  assert.equal(env.historyRows("topic-2").filter((row) => row.text === PROPOSAL_EXPIRED_NOTICE).length, 1);
  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.rows().map((row) => row.state), ["cancelled", "cancelled"]);
});

test("期限の境目: ちょうど TTL の確認は pending でなく、accept は stale で行を取り消し、sweep でも片付けの対象になる", async (t) => {
  const env = setup(t);
  const proposed = await env.proposals.propose(env.alpha());
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  env.advance(MOVE_PROPOSAL_TTL_MS - 1);
  assert.equal(env.proposals.pending("topic-1")?.id, proposed.id);
  env.advance(1);
  assert.equal(env.proposals.pending("topic-1"), undefined);
  assert.deepEqual(env.proposals.pendingAll(), []);
  assert.deepEqual(await env.proposals.accept(proposed.id), { result: "stale" });
  assert.equal(env.rows()[0]?.state, "cancelled");
  assert.deepEqual(env.gateway.edits.map((edit) => edit.message.text), [PROPOSAL_EXPIRED]);

  const other = setup(t);
  await other.proposals.propose(other.alpha());
  other.advance(MOVE_PROPOSAL_TTL_MS);
  await other.proposals.sweep();
  assert.equal(other.rows()[0]?.state, "cancelled");
});

/** 外から開けるまで待つ Promise */
function hold(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("札がまだ出ていない（sendMessage を待っている）確認は pending・pendingAll に出ず、accept・keep は stale で行は proposed のまま。出た後は accept できる", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const sending = hold();
  env.gateway.beforeSendMessage = () => sending.promise;
  const proposing = env.proposals.propose(env.alpha());
  await waitFor(() => env.rows().length === 1);
  const id = Number(env.rows()[0]?.id);
  assert.equal(env.proposals.pending("topic-1"), undefined);
  assert.deepEqual(env.proposals.pendingAll(), []);
  assert.deepEqual(await env.proposals.accept(id), { result: "stale" });
  assert.deepEqual(await env.proposals.keep(id), { result: "stale" });
  assert.equal(env.rows()[0]?.state, "proposed");
  assert.equal(env.gateway.edits.length, 0);
  sending.release();
  const proposed = await proposing;
  assert.equal(proposed.result, "proposed");
  assert.equal(env.proposals.pending("topic-1")?.id, id);
  assert.deepEqual(await env.proposals.accept(id), { result: "accepted" });
  await waitFor(() => env.gateway.sent.length === 1);
  assert.equal(env.rows()[0]?.state, "done");
});

test("pending・pendingAll: 閉じた話題・話題の無い確認は出さない（行は proposed のまま）", async (t) => {
  const env = setup(t);
  const proposed = await env.proposals.propose(env.alpha());
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  const ghost = env.moves.propose({ channelId: "ghost-1", fromDir: null, toDir: "alpha", by: "right_hand" });
  if (ghost === undefined) return assert.fail("行が作れない");
  env.moves.setMessageId(ghost, "message-9");
  assert.deepEqual(env.proposals.pendingAll().map((row) => row.id), [proposed.id]);
  assert.equal(env.proposals.pending("ghost-1"), undefined);
  env.topicSessions.close("topic-1", "要約");
  assert.equal(env.proposals.pending("topic-1"), undefined);
  assert.deepEqual(env.proposals.pendingAll(), []);
  assert.deepEqual(env.rows().map((row) => row.state), ["proposed", "proposed"]);
});

test("accept: 待てば通る断りの間に keep が片付けた行は stale（kept の refused にしない）", async (t) => {
  const env = setup(t);
  const proposed = await env.proposals.propose(env.alpha());
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  env.running.push({ channelId: "topic-1" });
  const [accepted, kept] = await Promise.all([env.proposals.accept(proposed.id), env.proposals.keep(proposed.id)]);
  assert.deepEqual(accepted, { result: "stale" });
  assert.deepEqual(kept, { result: "kept" });
  assert.equal(env.rows()[0]?.state, "cancelled");
});

test("accept: 札の書き換えが済むまで結果の投稿は出ない", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const proposed = await env.proposals.propose(env.alpha());
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  const editing = hold();
  env.gateway.beforeEdit = () => editing.promise;
  const accepting = env.proposals.accept(proposed.id);
  await waitFor(() => env.rows()[0]?.state === "done");
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.gateway.sent.length, 0);
  editing.release();
  assert.deepEqual(await accepting, { result: "accepted" });
  await waitFor(() => env.gateway.sent.length === 1);
  assert.equal(env.gateway.edits.length, 1);
});

test("accept: 別の付け替えが走っている間は refused（moving・kept true）で、行は proposed のまま", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const proposed = await env.proposals.propose({ ...env.alpha(), place: { kind: "general" } });
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  const turn = hold();
  env.runner.gates[0] = turn.promise;
  const other = moveTopic({ ...env.alpha(), by: "web" }, env.move);
  await waitFor(() => env.runner.inputs.length === 1);
  assert.deepEqual(await env.proposals.accept(proposed.id), { result: "refused", reason: "moving", kept: true });
  assert.deepEqual(env.rows().map((row) => row.state), ["proposed", "running"]);
  assert.equal(env.gateway.edits.length, 0);
  turn.release();
  assert.equal((await other).result, "moved");
  assert.equal(env.rows()[0]?.state, "proposed");
});

test("accept: 閉じる途中・連携が無い・設定が済んでいないは refused（kept true）で、行は proposed のまま", async (t) => {
  type Env = ReturnType<typeof setup>;
  const cases: Array<{ expected: string; arrange: (env: Env) => MoveDeps }> = [
    {
      expected: "closing",
      arrange: (env) => {
        env.topicSessions.saveCloseDraft("topic-1", { summary: "要約", tasks: [] });
        return env.move;
      },
    },
    { expected: "cc_disabled", arrange: (env) => ({ ...env.move, projectSessions: undefined }) },
    { expected: "unify_not_ready", arrange: (env) => ({ ...env.move, projectSessions: { ...env.move.projectSessions!, ready: () => false } }) },
  ];
  for (const item of cases) {
    const env = setup(t);
    const proposed = await env.proposals.propose(env.alpha());
    if (proposed.result !== "proposed") return assert.fail("proposed でない");
    const move = item.arrange(env);
    const proposals = createTopicProposals({ move, moves: env.moves, ownerPosts: env.gateway, now: () => env.clock.at, log: () => {} });
    assert.deepEqual(await proposals.accept(proposed.id), { result: "refused", reason: item.expected, kept: true }, item.expected);
    assert.equal(env.rows()[0]?.state, "proposed", item.expected);
    assert.equal(env.gateway.edits.length, 0, item.expected);
  }
});

test("accept: 受け付けた後のキューの中の例外は log・履歴・チャンネルの失敗の文になり、reject を外に出さない", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const proposed = await env.proposals.propose(env.alpha());
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  const sessions = Object.create(env.sessions) as typeof env.sessions;
  sessions.get = () => {
    throw new TypeError("boom");
  };
  const move: MoveDeps = { ...env.move, turn: { ...env.move.turn, sessions } };
  const proposals = createTopicProposals({ move, moves: env.moves, ownerPosts: env.gateway, now: () => env.clock.at, log: (line) => env.logs.push(line) });
  assert.deepEqual(await proposals.accept(proposed.id), { result: "accepted" });
  await waitFor(() => env.gateway.sent.length === 1);
  assert.equal(env.gateway.sent[0]?.text, MOVE_FAILED_TEXT);
  assert.ok(env.logs.includes("確認からの場所の付け替えに失敗しました（TypeError）"));
  assert.deepEqual(env.historyRows().at(-1), { kind: "notice", text: MOVE_FAILED_TEXT });
  assert.equal(env.rows()[0]?.state, "failed");
});

test("accept: 話題の行が無い確認は、行を cancelled にして stale", async (t) => {
  const env = setup(t);
  const id = env.moves.propose({ channelId: "ghost-1", fromDir: null, toDir: "alpha", by: "right_hand" });
  if (id === undefined) return assert.fail("行が作れない");
  env.moves.setMessageId(id, "message-9");
  assert.deepEqual(await env.proposals.accept(id), { result: "stale" });
  assert.equal(env.rows()[0]?.state, "cancelled");
  assert.equal(env.runner.inputs.length, 0);
});

test("escape: 札の文は場所の名前を escape し、履歴の知らせは生の名前", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const name = "my_proj-1";
  mkdirSync(join(env.move.projectSessions!.places.workspaceDir, name));
  const escaped = escapeDiscordText(name);
  assert.notEqual(escaped, name);
  const proposed = await env.proposals.propose({ ...env.alpha(), place: { kind: "project", name } });
  if (proposed.result !== "proposed") return assert.fail("proposed でない");
  assert.equal(env.gateway.posts[0]?.message.text, proposalText("なし", escaped));
  assert.deepEqual(env.historyRows(), [{ kind: "notice", text: proposedNoticeText("なし", name) }]);
  assert.deepEqual(await env.proposals.accept(proposed.id), { result: "accepted" });
  assert.equal(env.gateway.edits[0]?.message.text, PROPOSAL_ACCEPTED(escaped));
  await waitFor(() => env.gateway.sent.length === 1);
});

test("TopicProposalExpirer: stop は予約済みのタイマーを取り消し、sweep を並べて呼ぶと proposals.sweep は 1 回", async () => {
  let sweeps = 0;
  const gate = hold();
  let cancelled = 0;
  const scheduled: Array<() => void> = [];
  const timers: CcTimers = {
    after: (fn) => {
      scheduled.push(fn);
      return () => {
        cancelled += 1;
      };
    },
  };
  const expirer = new TopicProposalExpirer({
    proposals: {
      sweep: async () => {
        sweeps += 1;
        if (sweeps === 2) await gate.promise;
      },
    },
    log: () => {},
    timers,
  });
  expirer.start();
  await waitFor(() => scheduled.length === 1);
  const both = Promise.all([expirer.sweep(), expirer.sweep()]);
  gate.release();
  await both;
  assert.equal(sweeps, 2);
  expirer.stop();
  assert.equal(cancelled, 1);
  scheduled[0]?.();
  await expirer.idle();
  assert.equal(sweeps, 2);
});
