import { test } from "node:test";
import assert from "node:assert/strict";
import { type BoardCcSession, type BoardItem, type BoardLocal, type ClassifyInput, BOARD_MAX_REASONS, classifyProject } from "../src/board/classify.ts";

const CLEAN: BoardLocal = { branch: "main", dirty: 0, ahead: 0, behind: 0, lastCommitAt: "2026-11-13T00:00:00.000Z" };

function pr(number: number, overrides: Partial<BoardItem> = {}): BoardItem {
  return { kind: "pr", number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, mine: true, draft: false, ci: "success", ...overrides };
}

function issue(number: number): BoardItem {
  return { kind: "issue", number, title: `Issue ${number}`, url: `https://github.com/o/r/issues/${number}`, mine: false, draft: false, ci: "none" };
}

function cc(state: BoardCcSession["state"], pendingPermission = false, id = "s"): BoardCcSession {
  return { sessionId: id, state, pendingPermission };
}

function input(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return { noRemote: false, local: CLEAN, items: [], ccSessions: [], sessionTurnRunning: false, ...overrides };
}

test("classifyProject: 何も無ければ done（根拠は「open な issue・PR はありません」）", () => {
  assert.deepEqual(classifyProject(input()), { state: "done", reasons: ["open な issue・PR はありません"] });
});

test("classifyProject: working は Claude Code の running（数）とプロジェクトのセッションのターン", () => {
  assert.deepEqual(classifyProject(input({ ccSessions: [cc("running", false, "a"), cc("running", false, "b"), cc("idle", false, "c")] })), {
    state: "working",
    reasons: ["Claude Code が作業中（2）"],
  });
  assert.deepEqual(classifyProject(input({ sessionTurnRunning: true })), { state: "working", reasons: ["self-agent のセッションが作業中"] });
});

test("classifyProject: working が owner・agent より先。根拠は当たったものすべて（状態の順）", () => {
  const result = classifyProject(
    input({
      ccSessions: [cc("running", false, "a"), cc("needs_input", false, "b")],
      items: [pr(3, { mine: false }), pr(4, { ci: "failure" }), issue(9)],
      local: { ...CLEAN, dirty: 2 },
    }),
  );
  assert.equal(result.state, "working");
  assert.deepEqual(result.reasons, [
    "Claude Code が作業中（1）",
    "Claude Code が判断を待っています（1）",
    "レビュー待ちの PR #3",
    "CI が落ちている PR #4",
    "手つかずの issue 1 件",
  ]);
});

test("classifyProject: owner は Claude Code の needs_input・許可の pending・マージの判断待ち・他人の PR", () => {
  assert.deepEqual(classifyProject(input({ ccSessions: [cc("needs_input"), cc("idle", true, "b")] })), {
    state: "owner",
    reasons: ["Claude Code が判断を待っています（2）"],
  });
  assert.deepEqual(classifyProject(input({ items: [pr(5, { ci: "success" }), pr(6, { ci: "none" })] })), {
    state: "owner",
    reasons: ["マージの判断待ちの PR #5", "マージの判断待ちの PR #6"],
  });
  assert.deepEqual(classifyProject(input({ items: [pr(7, { mine: false, draft: true, ci: "none" })] })), {
    state: "owner",
    reasons: ["レビュー待ちの PR #7"],
  });
});

test("classifyProject: owner が agent より先", () => {
  const result = classifyProject(input({ items: [pr(1), pr(2, { ci: "failure" }), issue(3)] }));
  assert.equal(result.state, "owner");
  assert.deepEqual(result.reasons, ["マージの判断待ちの PR #1", "CI が落ちている PR #2", "手つかずの issue 1 件"]);
});

test("classifyProject: agent は CI の失敗・draft・issue・未コミット・未 push", () => {
  assert.deepEqual(classifyProject(input({ items: [pr(2, { ci: "failure" })] })), { state: "agent", reasons: ["CI が落ちている PR #2"] });
  assert.deepEqual(classifyProject(input({ items: [pr(2, { draft: true, ci: "success" })] })), { state: "agent", reasons: ["作業途中の draft PR #2"] });
  // draft で CI も落ちていれば CI の行だけ
  assert.deepEqual(classifyProject(input({ items: [pr(2, { draft: true, ci: "failure" })] })), { state: "agent", reasons: ["CI が落ちている PR #2"] });
  assert.deepEqual(classifyProject(input({ items: [issue(1), issue(2), issue(3)] })), { state: "agent", reasons: ["手つかずの issue 3 件"] });
  assert.deepEqual(classifyProject(input({ local: { ...CLEAN, dirty: 4, ahead: 2 } })), {
    state: "agent",
    reasons: ["未コミットの変更 4 ファイル", "push していないコミット 2 件"],
  });
});

test("classifyProject: 未コミット・未 push があり待機のセッションだけなら owner（次の指示を待っている）、セッションが無ければ agent", () => {
  assert.deepEqual(classifyProject(input({ local: { ...CLEAN, dirty: 1, ahead: 2 }, ccSessions: [cc("idle", false, "a"), cc("idle", false, "b")] })), {
    state: "owner",
    reasons: ["Claude Code が次の指示を待っています（2）", "未コミットの変更 1 ファイル", "push していないコミット 2 件"],
  });
  // owner が agent より先。issue の行も並べる
  assert.deepEqual(classifyProject(input({ local: { ...CLEAN, dirty: 1 }, ccSessions: [cc("idle")], items: [issue(1)] })), {
    state: "owner",
    reasons: ["Claude Code が次の指示を待っています（1）", "未コミットの変更 1 ファイル", "手つかずの issue 1 件"],
  });
  // 変更が無ければ待機のセッションは何も決めない
  assert.deepEqual(classifyProject(input({ ccSessions: [cc("idle")] })), { state: "done", reasons: ["open な issue・PR はありません"] });
});

test("classifyProject: 未コミット・未 push は running・needs_input のセッションがあれば数えない", () => {
  assert.deepEqual(classifyProject(input({ local: { ...CLEAN, dirty: 1 }, ccSessions: [cc("running"), cc("idle", false, "b")] })), {
    state: "working",
    reasons: ["Claude Code が作業中（1）"],
  });
  assert.deepEqual(classifyProject(input({ local: { ...CLEAN, ahead: 1 }, ccSessions: [cc("needs_input")] })), {
    state: "owner",
    reasons: ["Claude Code が判断を待っています（1）"],
  });
  // 許可の要求を保留している idle は生きているとみなす
  assert.deepEqual(classifyProject(input({ local: { ...CLEAN, dirty: 1 }, ccSessions: [cc("idle", true)] })), {
    state: "owner",
    reasons: ["Claude Code が判断を待っています（1）"],
  });
});

test("classifyProject: CI を確かめていない自分の PR は根拠の行だけで owner に数えない", () => {
  assert.deepEqual(classifyProject(input({ items: [pr(9, { ci: "unchecked" })] })), {
    state: "unknown",
    reasons: ["CI を確かめていない PR #9", "状態を決められません"],
  });
  assert.deepEqual(classifyProject(input({ items: [pr(9, { ci: "unchecked" }), pr(10)] })), {
    state: "owner",
    reasons: ["マージの判断待ちの PR #10", "CI を確かめていない PR #9"],
  });
  // draft は draft の行だけ
  assert.deepEqual(classifyProject(input({ items: [pr(9, { ci: "unchecked", draft: true })] })), {
    state: "agent",
    reasons: ["作業途中の draft PR #9"],
  });
});

test("classifyProject: issue の一覧が上限に当たっていれば「n 件以上」", () => {
  const issues = Array.from({ length: 50 }, (_, i) => issue(i + 1));
  assert.deepEqual(classifyProject(input({ items: issues, capped: { pulls: false, issues: true } })).reasons, ["手つかずの issue 50 件以上"]);
  assert.deepEqual(classifyProject(input({ items: issues })).reasons, ["手つかずの issue 50 件"]);
});

test("classifyProject: CI 実行中の自分の PR は根拠の行だけで状態は決めない", () => {
  assert.deepEqual(classifyProject(input({ items: [pr(8, { ci: "pending" })] })), {
    state: "unknown",
    reasons: ["CI 実行中の PR #8", "状態を決められません"],
  });
  assert.deepEqual(classifyProject(input({ items: [pr(8, { ci: "pending" }), issue(1)] })), {
    state: "agent",
    reasons: ["手つかずの issue 1 件", "CI 実行中の PR #8"],
  });
  // draft の pending は draft の行だけ
  assert.deepEqual(classifyProject(input({ items: [pr(8, { ci: "pending", draft: true })] })), {
    state: "agent",
    reasons: ["作業途中の draft PR #8"],
  });
});

test("classifyProject: unknown は remote が無い・GitHub を読めていない・git が失敗した", () => {
  assert.deepEqual(classifyProject(input({ noRemote: true, items: null })), { state: "unknown", reasons: ["remote がありません"] });
  assert.deepEqual(classifyProject(input({ items: null })), { state: "unknown", reasons: ["GitHub をまだ読めていません"] });
  assert.deepEqual(classifyProject(input({ local: null })), { state: "unknown", reasons: ["git が失敗しました"] });
  assert.deepEqual(classifyProject(input({ local: null, items: null })), {
    state: "unknown",
    reasons: ["GitHub をまだ読めていません", "git が失敗しました"],
  });
  assert.deepEqual(classifyProject(input({ unchecked: true, local: null, items: null })), { state: "unknown", reasons: ["まだ確かめていません"] });
});

test("classifyProject: remote が無ければ古い items は使わない。unknown の理由はほかの状態でも根拠に並べる", () => {
  assert.deepEqual(classifyProject(input({ noRemote: true, items: [pr(1)] })), { state: "unknown", reasons: ["remote がありません"] });
  assert.deepEqual(classifyProject(input({ noRemote: true, items: null, local: { ...CLEAN, dirty: 3 } })), {
    state: "agent",
    reasons: ["未コミットの変更 3 ファイル", "remote がありません"],
  });
  assert.deepEqual(classifyProject(input({ local: null, ccSessions: [cc("running")] })), {
    state: "working",
    reasons: ["Claude Code が作業中（1）", "git が失敗しました"],
  });
});

test("classifyProject: 根拠の行は 8 件まで・題名は入れない", () => {
  const items = Array.from({ length: 12 }, (_, i) => pr(i + 1, { mine: false, title: "秘密の題名" }));
  const result = classifyProject(input({ items }));
  assert.equal(result.state, "owner");
  assert.equal(result.reasons.length, BOARD_MAX_REASONS);
  assert.ok(result.reasons.every((line) => !line.includes("秘密")));
});
