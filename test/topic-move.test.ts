import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../src/agent/runner.ts";
import type { ProjectSessionGate } from "../src/app/session-ops.ts";
import { RENEWED_SEED_HEADER } from "../src/app/session-renew.ts";
import {
  MOVE_FAILED_TEXT,
  MOVE_INTERRUPTED_TEXT,
  MOVE_NOTE_MAX_LENGTH,
  MOVE_NOTE_POST_MAX,
  MOVE_NOTE_PROMPT,
  type MoveDeps,
  type MoveInput,
  moveRefusalText,
  movedDividerText,
  movedNoticeText,
  movedPostText,
  movedSeed,
  moveTopic,
  parsePlace,
  placeLabel,
  placeLines,
  recoverMoves,
} from "../src/app/topic-move.ts";
import { RESUME_SEED_HEADER } from "../src/app/turn.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { TopicMoveStore } from "../src/store/topic-moves.ts";
import { RENEW_SUMMARY_MAX_LENGTH } from "../src/store/topic-sessions.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { RecordingQueue } from "./helpers/recording.ts";
import { FakeRunner, type FakeRunStep, turnUsage } from "./helpers/runner.ts";

const NOW = new Date("2026-11-14T01:00:00Z");
const TITLE = "旅行の計画";
const GENERAL = "general-dir";
const NOTE = "- 目的: 京都旅行の計画\n- 触ったファイル: notes.md（宿の候補を書いた）";

function ok(text: string, sessionId: string = "session-1"): RunResult {
  return { ok: true, text, sessionId, usage: turnUsage(10, 2000, 300), durationMs: 4200, toolCalls: 0, contextTokens: 2310 };
}

const RESUME_FAILURE: RunResult = {
  ok: false,
  errorMessage: "error_during_execution: No conversation found with session ID: session-1",
  sessionRecorded: false,
  toolCalls: 0,
};

const FAILED: RunResult = { ok: false, errorMessage: "error_during_execution: boom", sessionId: "session-1", sessionRecorded: true, toolCalls: 0 };

/** seed の書き込みで投げる（場所を変える書き込みの途中で投げたときを見る） */
class ThrowingSeeds extends ChannelSeedStore {
  override set(): void {
    throw new Error("seed の書き込みに失敗");
  }
}

type SetupOptions = {
  steps?: FakeRunStep[];
  projectSteps?: FakeRunStep[];
  projectDir?: string;
  permissionMode?: "default" | "acceptEdits" | "plan";
  persona?: string;
  conversation?: boolean;
};

function setup(t: TestContext, options: SetupOptions = {}) {
  const db = tempDb(t);
  const now = (): Date => NOW;
  const stores = createStores(db, now);
  const { topicSessions, sessions, seeds, usage, history } = stores;
  const moves = new TopicMoveStore(db, now);
  const runner = new FakeRunner(options.steps ?? []);
  const projectRunner = new FakeRunner(options.projectSteps ?? []);
  const turnQueue = new RecordingQueue(2);
  const ws = tempDir(t);
  for (const name of ["alpha", "beta"]) mkdirSync(join(ws, name));
  const gateState = { ready: true };
  const gate: ProjectSessionGate = { places: { workspaceDir: ws, protectedDirs: [], generalDir: GENERAL }, ready: () => gateState.ready };
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const running: Array<{ channelId: string; waitingPermission?: boolean }> = [];
  const topicCalls: Array<{ channelId: string; topic: string }> = [];
  const deps: MoveDeps = {
    topicSessions,
    moves,
    turnQueue,
    turn: { runner, projectRunner, sessions, seeds, usage, log },
    runningTurns: () => running,
    projectSessions: gate,
    history,
    setChannelTopic: async (channelId, topic) => {
      topicCalls.push({ channelId, topic });
    },
    log,
  };
  topicSessions.create({
    channelId: "topic-1",
    guildId: "guild-1",
    title: TITLE,
    categoryId: "active-1",
    ...(options.persona === undefined ? {} : { persona: options.persona }),
    ...(options.projectDir === undefined ? {} : { projectDir: options.projectDir, permissionMode: options.permissionMode ?? "default" }),
  });
  if (options.conversation !== false) sessions.set("topic-1", "session-1");
  const accepted: number[] = [];
  const onAccepted = (): void => {
    accepted.push(runner.inputs.length + projectRunner.inputs.length);
  };
  const input = (place: MoveInput["place"] = { kind: "project", name: "alpha" }): MoveInput => ({
    guildId: "guild-1",
    channelId: "topic-1",
    place,
    by: "web",
  });
  const rows = () => db.prepare("SELECT * FROM topic_moves ORDER BY id").all();
  const historyRows = () => history.list("topic-1", { limit: 50 }).map((row) => ({ kind: row.kind, source: row.source, text: row.text }));
  return { db, ws, gate, gateState, deps, runner, projectRunner, turnQueue, moves, running, topicCalls, logs, accepted, onAccepted, input, rows, historyRows, ...stores };
}

// ---- 純関数 ----

test("parsePlace: general・p:<名前>・p:<General の名前> は general・other と形の違う物は undefined", () => {
  assert.deepEqual(parsePlace("general", GENERAL), { kind: "general" });
  assert.deepEqual(parsePlace(`p:${GENERAL}`, GENERAL), { kind: "general" });
  assert.deepEqual(parsePlace("p:alpha", GENERAL), { kind: "project", name: "alpha" });
  assert.deepEqual(parsePlace("p:alpha", undefined), { kind: "project", name: "alpha" });
  for (const value of ["other", "p:", "p:../x", "p:a/b", "p:.", "alpha", "", 1, null, undefined, { kind: "general" }]) {
    assert.equal(parsePlace(value, GENERAL), undefined, String(value));
  }
});

test("placeLabel・movedSeed・movedDividerText: なし・General・プロジェクトの呼び名。seed は見出し → 場所の 2 行 → 要点の順", () => {
  assert.equal(placeLabel(null, GENERAL), "なし");
  assert.equal(placeLabel(GENERAL, GENERAL), "General");
  assert.equal(placeLabel("alpha", GENERAL), "alpha");
  assert.equal(movedDividerText(null, "alpha", GENERAL), "場所を なし から alpha に変えました");
  assert.equal(movedDividerText("alpha", GENERAL, GENERAL), "場所を alpha から General に変えました");
  assert.equal(
    placeLines(null, "alpha", GENERAL),
    "作業する場所は alpha に変わりました（前は なし）。\nファイルは動かしていません。前の場所のファイルは前の場所にあります。",
  );
  const seed = movedSeed("alpha", GENERAL, NOTE, GENERAL).split("\n");
  assert.equal(seed[0], RENEWED_SEED_HEADER);
  assert.equal(seed[1], "作業する場所は General に変わりました（前は alpha）。");
  assert.equal(seed[2], "ファイルは動かしていません。前の場所のファイルは前の場所にあります。");
  assert.equal(seed.slice(3).join("\n"), NOTE);
  assert.equal(movedNoticeText(NOTE), `ファイルは動かしていません。担当に引き継いだ要点:\n${NOTE}`);
  assert.match(movedNoticeText(null), /引き継ぐ要点はありません/);
});

test("movedPostText: 要点は先頭 1,500 字で切って「…」。名前は escape される。要点なしの文", () => {
  const long = "あ".repeat(MOVE_NOTE_POST_MAX + 10);
  const text = movedPostText({ from: "my_app", to: "beta", note: long }, GENERAL);
  const [head, , label, body] = text.split("\n");
  assert.equal(head, "場所を **my\\_app** から **beta** に変えました。会話は新しくなりました（記録はこのまま残ります）。ファイルは動かしていません。");
  assert.equal(label, "**引き継いだ要点**");
  assert.equal(body, `${"あ".repeat(MOVE_NOTE_POST_MAX)}…`);
  const exact = movedPostText({ from: null, to: GENERAL, note: "あ".repeat(MOVE_NOTE_POST_MAX) }, GENERAL);
  assert.ok(exact.endsWith("あ".repeat(MOVE_NOTE_POST_MAX)));
  assert.ok(exact.startsWith("場所を **なし** から **General** に"));
  assert.equal(
    movedPostText({ from: null, to: "alpha", note: null }, GENERAL),
    "場所を **なし** から **alpha** に変えました。会話は新しくなりました（記録はこのまま残ります）。ファイルは動かしていません。\n引き継ぐ要点はありません。",
  );
});

test("MOVE_NOTE_PROMPT: 行き先の名前・日時を含まない（静的）", () => {
  assert.ok(MOVE_NOTE_PROMPT.includes(`${MOVE_NOTE_MAX_LENGTH} 字以内`));
  assert.ok(!/alpha|beta|General|20\d\d|\d+:\d\d/.test(MOVE_NOTE_PROMPT));
  assert.equal(MOVE_NOTE_MAX_LENGTH, 4000);
});

// ---- moveTopic ----

test("moveTopic: 軽い話題をプロジェクトへ。要点のターンは今の SDK セッションを resume し context なしで人格の runner。終わると project_dir が変わり、SDK セッションの対応が消え、seed は見出し・場所の 2 行・要点、renewed_summary は要点の先頭 1,200 字、topic_moves は done で note に全文", async (t) => {
  const note = `${NOTE}\n${"い".repeat(RENEW_SUMMARY_MAX_LENGTH)}`;
  const env = setup(t, { steps: [ok(`  ${note}\n`)] });
  const outcome = await moveTopic(env.input(), env.deps, env.onAccepted);
  assert.deepEqual(outcome, { result: "moved", from: null, to: "alpha", note });
  assert.deepEqual(env.runner.inputs, [{ prompt: MOVE_NOTE_PROMPT, sessionId: "session-1", context: undefined, allowedUrls: [] }]);
  assert.equal(env.projectRunner.inputs.length, 0);
  assert.deepEqual(env.turnQueue.keys, ["topic-1"]);
  assert.deepEqual(env.turnQueue.options, [{ session: true }]);
  assert.deepEqual(env.topicSessions.projectDirOf("topic-1"), { projectDir: "alpha", permissionMode: "default" });
  assert.equal(env.sessions.get("topic-1"), undefined);
  assert.equal(env.seeds.get("topic-1"), movedSeed(null, "alpha", note, GENERAL));
  assert.equal(env.topicSessions.get("topic-1")?.renewedSummary, note.slice(0, RENEW_SUMMARY_MAX_LENGTH));
  const [row] = env.rows();
  assert.equal(row?.state, "done");
  assert.equal(row?.note, note);
  assert.equal(row?.from_dir, null);
  assert.equal(row?.to_dir, "alpha");
  assert.equal(row?.by, "web");
});

test("moveTopic: プロジェクトの話題を別のプロジェクトへ。要点のターンは projectRunner で、context は前の場所・purpose renew。許可のモードは default に戻る", async (t) => {
  const env = setup(t, { projectSteps: [ok(NOTE)], projectDir: "alpha", permissionMode: "acceptEdits" });
  const outcome = await moveTopic(env.input({ kind: "project", name: "beta" }), env.deps);
  assert.deepEqual(outcome, { result: "moved", from: "alpha", to: "beta", note: NOTE });
  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.projectRunner.inputs, [
    {
      prompt: MOVE_NOTE_PROMPT,
      sessionId: "session-1",
      context: { guildId: "guild-1", channelId: "topic-1", kind: "session", purpose: "renew", projectDir: "alpha", permissionMode: "acceptEdits" },
      allowedUrls: [],
    },
  ]);
  assert.deepEqual(env.topicSessions.projectDirOf("topic-1"), { projectDir: "beta", permissionMode: "default" });
  assert.equal(env.rows()[0]?.from_dir, "alpha");
});

test("moveTopic: General へ。to_dir は General のディレクトリの名前で、呼び名は General", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const outcome = await moveTopic(env.input({ kind: "general" }), env.deps);
  assert.deepEqual(outcome, { result: "moved", from: null, to: GENERAL, note: NOTE });
  assert.equal(env.rows()[0]?.to_dir, GENERAL);
  assert.equal(env.topicSessions.projectDirOf("topic-1")?.projectDir, GENERAL);
  assert.ok(env.seeds.get("topic-1")?.includes("作業する場所は General に変わりました（前は なし）。"));
  assert.ok(env.logs.includes("General のディレクトリを作りました"));
});

test("moveTopic: 履歴に仕切り「場所を <旧> から <新> に変えました」と、要点の知らせが 1 行ずつ。source は system", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  await moveTopic(env.input(), env.deps);
  assert.deepEqual(env.historyRows(), [
    { kind: "divider", source: "system", text: "場所を なし から alpha に変えました" },
    { kind: "notice", source: "system", text: movedNoticeText(NOTE) },
  ]);
});

test("moveTopic: usage に kind topic-move の行が 1 つ", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  await moveTopic(env.input(), env.deps);
  const rows = env.db.prepare("SELECT key, kind, ok FROM usage_log").all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ key: "topic-1", kind: "topic-move", ok: 1 }]);
});

test("moveTopic: 要点の返答が空なら seed は題名、renewed_summary は触らない、note は null", async (t) => {
  const env = setup(t, { steps: [ok("  \n")] });
  env.topicSessions.setRenewed("topic-1", "前の要約");
  const outcome = await moveTopic(env.input(), env.deps);
  assert.deepEqual(outcome, { result: "moved", from: null, to: "alpha", note: null });
  assert.equal(env.seeds.get("topic-1"), movedSeed(null, "alpha", `題名: ${TITLE}`, GENERAL));
  assert.equal(env.topicSessions.get("topic-1")?.renewedSummary, "前の要約");
  assert.equal(env.rows()[0]?.note, null);
  assert.equal(env.rows()[0]?.state, "done");
});

test("moveTopic: 会話がまだ無い話題はターンを走らせずに場所だけ変える。seed が無ければ作らない", async (t) => {
  const env = setup(t, { conversation: false });
  const outcome = await moveTopic(env.input(), env.deps, env.onAccepted);
  assert.deepEqual(outcome, { result: "moved", from: null, to: "alpha", note: null });
  assert.equal(env.runner.inputs.length, 0);
  assert.equal(env.topicSessions.projectDirOf("topic-1")?.projectDir, "alpha");
  assert.equal(env.seeds.get("topic-1"), undefined);
  assert.equal(env.rows()[0]?.state, "done");
  assert.deepEqual(env.historyRows()[1], { kind: "notice", source: "system", text: movedNoticeText(null) });
});

test("moveTopic: 会話がまだ無く seed がある話題は、seed の末尾に場所の 2 行を足す（元の seed は残る）", async (t) => {
  const env = setup(t, { conversation: false });
  env.seeds.set("topic-1", "右腕からの引き渡し");
  await moveTopic(env.input(), env.deps);
  assert.equal(env.seeds.get("topic-1"), `右腕からの引き渡し\n\n${placeLines(null, "alpha", GENERAL)}`);
});

test("moveTopic: No conversation found なら要点なしで進める。SDK セッションの対応が消え、seed は resume の復旧の seed + 場所の 2 行", async (t) => {
  const env = setup(t, { steps: [RESUME_FAILURE] });
  const outcome = await moveTopic(env.input(), env.deps);
  assert.deepEqual(outcome, { result: "moved", from: null, to: "alpha", note: null });
  assert.equal(env.sessions.get("topic-1"), undefined);
  assert.equal(env.seeds.get("topic-1"), `${RESUME_SEED_HEADER}\n題名: ${TITLE}\n\n${placeLines(null, "alpha", GENERAL)}`);
  assert.equal(env.topicSessions.projectDirOf("topic-1")?.projectDir, "alpha");
  assert.equal(env.rows()[0]?.state, "done");
  assert.equal(env.rows()[0]?.note, null);
});

test("moveTopic: 要点のターンが失敗したら何も変えない（project_dir・SDK セッション・seed・renewed_summary）。topic_moves は failed、履歴に知らせ 1 行、結果は failed", async (t) => {
  const env = setup(t, { steps: [FAILED] });
  env.seeds.set("topic-1", "前の seed");
  env.topicSessions.setRenewed("topic-1", "前の要約");
  const outcome = await moveTopic(env.input(), env.deps);
  assert.deepEqual(outcome, { result: "failed" });
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
  assert.equal(env.sessions.get("topic-1"), "session-1");
  assert.equal(env.seeds.get("topic-1"), "前の seed");
  assert.equal(env.topicSessions.get("topic-1")?.renewedSummary, "前の要約");
  assert.equal(env.rows()[0]?.state, "failed");
  assert.deepEqual(env.historyRows(), [{ kind: "notice", source: "system", text: MOVE_FAILED_TEXT }]);
});

test("moveTopic: 失敗でも会話が記録されて id が変わっていれば、その id を保存する", async (t) => {
  const env = setup(t, { steps: [{ ...FAILED, sessionId: "session-2" }] });
  assert.deepEqual(await moveTopic(env.input(), env.deps), { result: "failed" });
  assert.equal(env.sessions.get("topic-1"), "session-2");
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
});

test("moveTopic: runner が投げても running の行を残さない", async (t) => {
  const env = setup(t, { steps: [new Error("boom")] });
  assert.deepEqual(await moveTopic(env.input(), env.deps), { result: "failed" });
  assert.equal(env.moves.running("topic-1"), undefined);
  assert.equal(env.rows()[0]?.state, "failed");
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
  assert.equal(env.sessions.get("topic-1"), "session-1");
});

test("moveTopic: 場所を変える書き込みの途中で投げたら、どれも元のまま（seed の書き込みを投げる store に差し替えて確かめる）", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  env.deps.turn = { ...env.deps.turn, seeds: new ThrowingSeeds(env.db, () => NOW) };
  assert.deepEqual(await moveTopic(env.input(), env.deps), { result: "failed" });
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
  assert.equal(env.sessions.get("topic-1"), "session-1");
  assert.equal(env.seeds.get("topic-1"), undefined);
  assert.equal(env.topicSessions.get("topic-1")?.renewedSummary, null);
  assert.equal(env.rows()[0]?.state, "failed");
  assert.equal(env.rows()[0]?.note, null);
  assert.deepEqual(env.historyRows(), [{ kind: "notice", source: "system", text: MOVE_FAILED_TEXT }]);
});

test("moveTopic: 断る順（not_session・closed・persona・closing・busy・cc_disabled・unify_not_ready・invalid_project・same_place）。どれも onAccepted を呼ばず、topic_moves に行を足さず、runner を呼ばない", async (t) => {
  type Env = ReturnType<typeof setup>;
  const cases: Array<{ label: string; expected: string; options?: SetupOptions; arrange?: (env: Env) => void; input?: (env: Env) => MoveInput }> = [
    { label: "知らないチャンネル", expected: "not_session", input: (env) => ({ ...env.input(), channelId: "unknown-1" }) },
    { label: "別のサーバー", expected: "not_session", input: (env) => ({ ...env.input(), guildId: "guild-2" }) },
    { label: "消したチャンネル", expected: "not_session", arrange: (env) => void env.topicSessions.markDeleted("topic-1") },
    { label: "完了", expected: "closed", arrange: (env) => void env.topicSessions.close("topic-1", "要約") },
    {
      label: "完了で作業中（完了が先）",
      expected: "closed",
      arrange: (env) => {
        env.topicSessions.close("topic-1", "要約");
        env.running.push({ channelId: "topic-1" });
      },
    },
    { label: "足した人格", expected: "persona", options: { persona: "beta-persona" } },
    { label: "/close の確認待ち", expected: "closing", arrange: (env) => void env.topicSessions.saveCloseDraft("topic-1", { summary: "s", tasks: [] }) },
    { label: "作業中", expected: "busy", arrange: (env) => env.running.push({ channelId: "topic-1" }) },
    {
      label: "作業中で連携なし（作業中が先）",
      expected: "busy",
      arrange: (env) => {
        env.running.push({ channelId: "topic-1" });
        env.deps.projectSessions = undefined;
      },
    },
    { label: "連携なし", expected: "cc_disabled", arrange: (env) => (env.deps.projectSessions = undefined) },
    { label: "共有の link が済んでいない", expected: "unify_not_ready", arrange: (env) => (env.gateState.ready = false) },
    { label: "無いプロジェクト", expected: "invalid_project", input: (env) => env.input({ kind: "project", name: "missing" }) },
    { label: "今と同じプロジェクト", expected: "same_place", options: { projectDir: "alpha" } },
    { label: "今と同じ General", expected: "same_place", options: { projectDir: GENERAL }, input: (env) => env.input({ kind: "general" }) },
  ];
  for (const item of cases) {
    const env = setup(t, { steps: [ok(NOTE)], ...item.options });
    item.arrange?.(env);
    const input = item.input?.(env) ?? env.input();
    assert.deepEqual(await moveTopic(input, env.deps, env.onAccepted), { result: item.expected }, item.label);
    assert.deepEqual(env.accepted, [], item.label);
    assert.equal(env.rows().length, 0, item.label);
    assert.equal(env.runner.inputs.length, 0, item.label);
    assert.equal(env.turnQueue.keys.length, 0, item.label);
  }
});

test("moveTopic: 許可を待っているターンがある話題は busy", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  env.running.push({ channelId: "topic-1", waitingPermission: true });
  assert.deepEqual(await moveTopic(env.input(), env.deps), { result: "busy" });
  assert.equal(env.rows().length, 0);
  // ほかのチャンネルのターンは関係ない
  env.running.splice(0, 1, { channelId: "topic-2" });
  assert.equal((await moveTopic(env.input(), env.deps)).result, "moved");
});

test("moveTopic: /close の確認待ち（close_draft がある）は closing", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  env.topicSessions.saveCloseDraft("topic-1", { summary: "要約", tasks: [{ title: "宿を決める" }] });
  assert.deepEqual(await moveTopic(env.input(), env.deps, env.onAccepted), { result: "closing" });
  assert.deepEqual(env.accepted, []);
  assert.equal(env.runner.inputs.length, 0);
});

test("moveTopic: 2 つ続けて頼むと 2 つ目は moving で、要点のターンは 1 回だけ", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const first = moveTopic(env.input(), env.deps);
  const second = await moveTopic({ ...env.input({ kind: "project", name: "beta" }), by: "discord" }, env.deps);
  assert.deepEqual(second, { result: "moving" });
  assert.equal((await first).result, "moved");
  assert.equal(env.runner.inputs.length, 1);
  assert.equal(env.rows().length, 1);
});

test("moveTopic: onAccepted は受け付けた後・要点のターンの前に 1 回", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const states: unknown[] = [];
  await moveTopic(env.input(), env.deps, () => {
    env.onAccepted();
    states.push(env.moves.running("topic-1")?.state);
  });
  assert.deepEqual(env.accepted, [0]);
  assert.deepEqual(states, ["running"]);
  assert.equal(env.runner.inputs.length, 1);
});

test("moveTopic: キューで待つ間に閉じられたら、ターンを走らせずに closed。行は failed、履歴に知らせ", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  let release!: () => void;
  const held = env.turnQueue.run("topic-1", () => new Promise<void>((resolve) => (release = resolve)), { session: true });
  let accepted!: () => void;
  const acceptedPromise = new Promise<void>((resolve) => (accepted = resolve));
  const moving = moveTopic(env.input(), env.deps, () => accepted());
  await acceptedPromise;
  env.topicSessions.close("topic-1", "要約");
  release();
  await held;
  assert.deepEqual(await moving, { result: "closed" });
  assert.equal(env.runner.inputs.length, 0);
  assert.equal(env.rows()[0]?.state, "failed");
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
  assert.deepEqual(env.historyRows(), [
    { kind: "notice", source: "system", text: `場所を変えられませんでした: ${moveRefusalText("closed")}` },
  ]);
});

test("moveTopic: General が使えない（symlink）なら invalid_project で、軽いセッションに倒さない", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  symlinkSync(join(env.ws, "alpha"), join(env.ws, GENERAL));
  assert.deepEqual(await moveTopic(env.input({ kind: "general" }), env.deps, env.onAccepted), { result: "invalid_project" });
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
  assert.equal(env.sessions.get("topic-1"), "session-1");
  assert.equal(env.rows().length, 0);
  assert.equal(env.runner.inputs.length, 0);
});

test("moveTopic: 終わったら topic を「題名（<新>）」に書き換える。書き換えが失敗・終わらなくても結果は moved（待たない）", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  await moveTopic(env.input(), env.deps);
  assert.deepEqual(env.topicCalls, [{ channelId: "topic-1", topic: `${TITLE}（alpha）` }]);

  const pending = setup(t, { steps: [ok(NOTE)] });
  pending.deps.setChannelTopic = () => new Promise<void>(() => {});
  assert.equal((await moveTopic(pending.input(), pending.deps)).result, "moved");

  const failing = setup(t, { steps: [ok(NOTE)] });
  let rejected!: Promise<void>;
  failing.deps.setChannelTopic = () => {
    rejected = Promise.reject(new TypeError("rate limited"));
    return rejected;
  };
  assert.equal((await moveTopic(failing.input(), failing.deps)).result, "moved");
  await rejected.catch(() => {});
  await Promise.resolve();
  assert.ok(failing.logs.includes("topic の書き換えに失敗しました（TypeError）"));
});

test("moveTopic: log にチャンネル ID・題名・プロジェクトの名前・要点が出ない", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)], projectSteps: [FAILED, RESUME_FAILURE] });
  await moveTopic(env.input(), env.deps);
  env.sessions.set("topic-1", "session-1");
  await moveTopic(env.input({ kind: "project", name: "beta" }), env.deps);
  await moveTopic(env.input({ kind: "general" }), env.deps);
  await moveTopic(env.input({ kind: "general" }), env.deps);
  assert.ok(env.logs.length > 0);
  for (const line of env.logs) {
    for (const secret of ["topic-1", TITLE, "alpha", "beta", GENERAL, "京都", "session-1", env.ws]) {
      assert.ok(!line.includes(secret), `${line} に ${secret}`);
    }
  }
});

// ---- recoverMoves ----

test("recoverMoves: running の行を failed にし、その話題の履歴に知らせを 1 行。行が無ければ何もしない。場所は変わらない", (t) => {
  const env = setup(t);
  const recover = () => recoverMoves({ moves: env.moves, topicSessions: env.topicSessions, history: env.history, log: env.deps.log });
  recover();
  assert.deepEqual(env.logs, []);
  assert.deepEqual(env.historyRows(), []);

  const id = env.moves.start({ channelId: "topic-1", fromDir: null, toDir: "alpha", by: "discord" })!;
  // 話題の行が無いチャンネルの行は失敗にするだけ
  const orphan = env.moves.start({ channelId: "gone-1", fromDir: null, toDir: "alpha", by: "web" })!;
  recover();
  assert.equal(env.moves.get(id)?.state, "failed");
  assert.equal(env.moves.get(orphan)?.state, "failed");
  assert.deepEqual(env.historyRows(), [{ kind: "notice", source: "system", text: MOVE_INTERRUPTED_TEXT }]);
  assert.equal(env.history.list("gone-1", { limit: 10 }).length, 0);
  assert.deepEqual(env.logs, ["途中で止まった場所の付け替えを 2 件、失敗にしました"]);
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
});
