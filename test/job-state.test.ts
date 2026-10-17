import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  failureAllowed,
  failureText,
  formatJobMessage,
  JOB_FAILURES,
  JOB_MESSAGE_MAX_LENGTH,
  JOB_RUN_STATES,
  jobBranch,
  type JobFailure,
  type JobRunState,
} from "../src/jobs/state.ts";
import type { Job, JobRun } from "../src/store/jobs.ts";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 12,
    guildId: "g",
    repo: "example-user/example-repo",
    baseBranch: "main",
    branch: "self-agent/job-12",
    origin: "command",
    issueNumber: null,
    stackedOnPr: null,
    prNumber: null,
    prUrl: null,
    pushedSha: null,
    state: "open",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

function run(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: 30,
    jobId: 12,
    kind: "initial",
    state: "queued",
    failure: null,
    instruction: "CLI を作る",
    sourceNotificationId: null,
    reportChannelId: null,
    reportMessageId: null,
    sdkSessionId: null,
    outcome: null,
    tests: null,
    prTitle: null,
    summary: null,
    stagedSha: null,
    commits: null,
    toolCalls: null,
    keptDir: null,
    createdAt: "2026-10-17T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

/** 走り終えた run（18 分・コミット 3 件・ツール 52 回） */
function finished(overrides: Partial<JobRun> = {}): JobRun {
  return run({
    startedAt: "2026-10-17T00:00:00.000Z",
    finishedAt: "2026-10-17T00:17:30.000Z",
    commits: 3,
    tests: "passed",
    toolCalls: 52,
    outcome: "done",
    summary: "CLI とテストを足しました",
    ...overrides,
  });
}

const RETRYABLE: readonly JobFailure[] = ["push_failed", "not_fast_forward", "push_rejected", "push_auth", "pr_failed"];

test("canTransition: §11 の遷移の表どおり（failed から先は push・PR の段の失敗のときだけ）", () => {
  const allowed: Record<JobRunState, JobRunState[]> = {
    awaiting_confirm: ["queued", "cancelled"],
    queued: ["running", "cancelled"],
    running: ["pr_opened", "pushed", "held", "failed", "cancelled"],
    held: ["pr_opened", "pushed", "failed"],
    pushed: ["pr_opened"],
    failed: ["pushed", "pr_opened", "failed"],
    pr_opened: [],
    cancelled: [],
  };
  for (const from of JOB_RUN_STATES) {
    const failure: JobFailure | null = from === "failed" ? "push_failed" : null;
    for (const to of JOB_RUN_STATES) {
      const toFailure: JobFailure | null = to === "failed" ? "push_failed" : null;
      assert.equal(canTransition({ state: from, failure }, to, toFailure), allowed[from].includes(to), `${from} → ${to}`);
    }
  }
  // 準備の段の失敗は queued から直接ではなく running を経る
  assert.equal(canTransition({ state: "queued", failure: null }, "failed", "clone_failed"), false);
  assert.equal(canTransition({ state: "running", failure: null }, "failed", "clone_failed"), true);
  for (const failure of RETRYABLE) {
    assert.equal(canTransition({ state: "failed", failure }, "pushed"), true, failure);
    assert.equal(canTransition({ state: "failed", failure }, "pr_opened"), true, failure);
  }
  for (const failure of JOB_FAILURES.filter((item) => !RETRYABLE.includes(item))) {
    assert.equal(canTransition({ state: "failed", failure }, "pushed"), false, failure);
    assert.equal(canTransition({ state: "failed", failure }, "pr_opened"), false, failure);
    assert.equal(canTransition({ state: "failed", failure }, "failed", "push_failed"), false, failure);
  }
  assert.equal(canTransition({ state: "failed", failure: null }, "pushed"), false);
});

test("canTransition: held → failed と failed → failed は、移った後の failure が push・PR の段の語のときだけ", () => {
  for (const toFailure of JOB_FAILURES) {
    const expected = RETRYABLE.includes(toFailure);
    assert.equal(canTransition({ state: "held", failure: "max_turns" }, "failed", toFailure), expected, `held → ${toFailure}`);
    assert.equal(canTransition({ state: "failed", failure: "push_failed" }, "failed", toFailure), expected, `failed → ${toFailure}`);
    // running からはどの語でも failed にできる
    assert.equal(canTransition({ state: "running", failure: null }, "failed", toFailure), true, `running → ${toFailure}`);
  }
  assert.equal(canTransition({ state: "held", failure: "max_turns" }, "failed"), false);
  assert.equal(canTransition({ state: "failed", failure: "push_auth" }, "failed", "pr_failed"), true);
  assert.equal(canTransition({ state: "failed", failure: "pr_failed" }, "failed", "push_rejected"), true);
});

test("failureAllowed: failed は語が要る、held は終わり方の語だけ、pushed は無しか pr_failed、cancelled は無しか aborted、それ以外は無し", () => {
  assert.equal(failureAllowed("failed", null), false);
  for (const failure of JOB_FAILURES) assert.equal(failureAllowed("failed", failure), true, failure);
  for (const failure of JOB_FAILURES) {
    assert.equal(failureAllowed("held", failure), ["max_turns", "timeout", "aborted", "no_result"].includes(failure), failure);
    assert.equal(failureAllowed("pushed", failure), failure === "pr_failed", failure);
    assert.equal(failureAllowed("cancelled", failure), failure === "aborted", failure);
    for (const state of ["awaiting_confirm", "queued", "running", "pr_opened"] as const) {
      assert.equal(failureAllowed(state, failure), false, `${state} ${failure}`);
    }
  }
  assert.equal(failureAllowed("held", null), false);
  for (const state of ["awaiting_confirm", "queued", "running", "pr_opened", "pushed", "cancelled"] as const) {
    assert.equal(failureAllowed(state, null), true, state);
  }
});

test("failureText: どの失敗の語にも理由の文がある。jobBranch は self-agent/job-<id> で、正の整数でなければ投げる", () => {
  for (const failure of JOB_FAILURES) assert.ok(failureText(failure).length > 0, failure);
  assert.equal(failureText("sandbox_unavailable"), "シェルを使えない状態のため始められません");
  assert.equal(failureText("clone_failed"), "リポジトリを取得できませんでした");
  assert.equal(jobBranch(1), "self-agent/job-1");
  assert.equal(jobBranch(12), "self-agent/job-12");
  for (const id of [0, -1, 1.5, Number.NaN]) assert.throws(() => jobBranch(id), String(id));
});

test("formatJobMessage: PR を作ったら §9 の形（1 行目・draft PR の URL を <> で・統計・summary）", () => {
  const text = formatJobMessage(
    job({ issueNumber: 3, prNumber: 34, prUrl: "https://github.com/example-user/example-repo/pull/34" }),
    finished({ state: "pr_opened" }),
    { timeoutMin: 45 },
  );
  assert.equal(
    text,
    [
      "✅ ジョブ #12  example\\-user/example\\-repo（Issue #3 から）",
      "draft PR #34: <https://github.com/example-user/example-repo/pull/34>",
      "コミット 3 件・テスト: 通った・45 分中 18 分・ツール 52 回",
      "CLI とテストを足しました",
    ].join("\n"),
  );
});

test("formatJobMessage: テストが失敗なら注記、PR の URL は DB の pr_url ではなく検証したリポジトリと番号から作る", () => {
  const text = formatJobMessage(
    job({ prNumber: 34, prUrl: "https://evil.example/x" }),
    finished({ state: "pr_opened", tests: "failed" }),
    { timeoutMin: 45 },
  );
  assert.match(text, /draft PR #34: <https:\/\/github\.com\/example-user\/example-repo\/pull\/34>/);
  assert.match(text, /\n⚠ テストが通っていません\n/);
  assert.ok(!text.includes("evil"));
  // 形の違うリポジトリ名なら URL を出さない
  const broken = formatJobMessage(job({ repo: "a b/c", prNumber: 34 }), finished({ state: "pr_opened" }), { timeoutMin: 45 });
  assert.ok(!broken.includes("https://"));
});

test("formatJobMessage: summary と依頼は Markdown・メンションを無効にし、summary は先頭 600 字", () => {
  const text = formatJobMessage(
    job({ prNumber: 1 }),
    finished({ state: "pr_opened", summary: "@everyone **太字** <@123> [x](https://example.com) # 見出し" }),
    { timeoutMin: 45 },
  );
  const last = text.split("\n").at(-1)!;
  assert.equal(last, "\\@everyone \\*\\*太字\\*\\* \\<\\@123\\> \\[x\\]\\(https\\://example.com\\) \\# 見出し");

  const long = formatJobMessage(job({ prNumber: 1 }), finished({ state: "pr_opened", summary: "あ".repeat(700) }), { timeoutMin: 45 });
  assert.equal(long.split("\n").at(-1), "あ".repeat(600));

  const confirm = formatJobMessage(job(), run({ state: "awaiting_confirm", instruction: `@here\n${"い".repeat(300)}` }), { timeoutMin: 45 });
  assert.equal(confirm.split("\n")[0], "❔ ジョブ #12 を始めますか？  example\\-user/example\\-repo");
  assert.equal(confirm.split("\n")[1], `\\@here ${"い".repeat(194)}`);
});

test("formatJobMessage: 待ち・実行中・続き・PR の上・新しいリポジトリの 1 行目", () => {
  assert.equal(formatJobMessage(job(), run(), { timeoutMin: 45 }), "⏳ ジョブ #12  example\\-user/example\\-repo\n順番を待っています");
  assert.equal(
    formatJobMessage(job(), run({ state: "running", startedAt: "2026-10-17T00:00:00.000Z" }), {
      timeoutMin: 45,
      progress: "作業中…（1 分 0 秒・ツール 3 回）",
    }),
    "🔧 ジョブ #12  example\\-user/example\\-repo\n作業中…（1 分 0 秒・ツール 3 回）",
  );
  assert.equal(
    formatJobMessage(job(), run({ state: "running" }), { timeoutMin: 45 }).split("\n")[1],
    "作業中…",
  );
  assert.match(formatJobMessage(job({ issueNumber: 3 }), run({ kind: "followup" }), { timeoutMin: 45 }), /（続き）\n/);
  assert.match(formatJobMessage(job({ stackedOnPr: 7, origin: "github" }), run(), { timeoutMin: 45 }), /（PR #7 の上に）\n/);
  assert.match(formatJobMessage(job({ origin: "new_repo" }), run(), { timeoutMin: 45 }), /（新しいリポジトリ）\n/);
});

test("formatJobMessage: push だけ・PR の作成の失敗・held・failed・cancelled", () => {
  const followup = formatJobMessage(job({ prNumber: 34 }), finished({ state: "pushed", kind: "followup" }), { timeoutMin: 45 });
  assert.equal(followup.split("\n")[1], "draft PR #34 に push しました: <https://github.com/example-user/example-repo/pull/34>");

  const noPr = formatJobMessage(job(), finished({ state: "pushed" }), { timeoutMin: 45 });
  assert.equal(noPr.split("\n")[1], "push しました: <https://github.com/example-user/example-repo/tree/self-agent/job-12>");

  const prFailed = formatJobMessage(job(), finished({ state: "pushed", failure: "pr_failed" }), { timeoutMin: 45 });
  assert.deepEqual(prFailed.split("\n").slice(0, 2), [
    "⚠ ジョブ #12 は push しましたが PR を作れませんでした  example\\-user/example\\-repo",
    "<https://github.com/example-user/example-repo/tree/self-agent/job-12>",
  ]);
  // ブランチ名の形が違えば（BRANCH_PATTERN に合わなければ）URL を出さない
  for (const branch of ["main", "self-agent/job-0", "self-agent/job-12/x", "self-agent/job-12 ", "self-agent/job-abc", "x/self-agent/job-12"]) {
    for (const state of [finished({ state: "pushed", failure: "pr_failed" }), finished({ state: "pushed" })]) {
      const text = formatJobMessage(job({ branch }), state, { timeoutMin: 45 });
      assert.ok(!text.includes("https://"), `${branch}: ${text}`);
    }
  }

  const held = formatJobMessage(job(), finished({ state: "held", failure: "max_turns", tests: null, outcome: null, summary: null }), {
    timeoutMin: 45,
  });
  assert.equal(held, "⚠ ジョブ #12 は push していません（手順の上限）  example\\-user/example\\-repo\nコミット 3 件・45 分中 18 分・ツール 52 回");

  // 始める前の失敗は統計を出さない
  assert.equal(
    formatJobMessage(job(), run({ state: "failed", failure: "sandbox_unavailable" }), { timeoutMin: 45 }),
    "⚠ ジョブ #12 は push していません（シェルを使えない状態のため始められません）  example\\-user/example\\-repo",
  );
  const declined = formatJobMessage(job(), finished({ state: "failed", failure: "declined", outcome: "cannot", summary: "権限が足りません" }), {
    timeoutMin: 45,
  });
  assert.equal(declined.split("\n")[0], "⚠ ジョブ #12 は push していません（作業できませんでした）  example\\-user/example\\-repo");
  assert.equal(declined.split("\n").at(-1), "権限が足りません");

  assert.equal(formatJobMessage(job(), run({ state: "cancelled" }), { timeoutMin: 45 }), "⏹ ジョブ #12 を取り消しました  example\\-user/example\\-repo");
  assert.equal(
    formatJobMessage(job(), run({ state: "cancelled", failure: "aborted" }), { timeoutMin: 45 }),
    "⏹ ジョブ #12 を中断しました  example\\-user/example\\-repo",
  );
});

test("formatJobMessage: 途中経過が長くても JOB_MESSAGE_MAX_LENGTH（メンションを足しても 2,000 字）に収める", () => {
  const text = formatJobMessage(job(), run({ state: "running" }), { timeoutMin: 45, progress: "x".repeat(3000) });
  assert.equal([...text].length, JOB_MESSAGE_MAX_LENGTH);
  assert.ok(text.endsWith("…"));
  assert.ok(JOB_MESSAGE_MAX_LENGTH + "<@12345678901234567890> ".length <= 2000);
  // summary が全部エスケープされる文字でも 2,000 字を超えない
  const escaped = formatJobMessage(job({ prNumber: 1 }), finished({ state: "pr_opened", summary: "-".repeat(600) }), { timeoutMin: 45 });
  assert.ok([...escaped].length <= JOB_MESSAGE_MAX_LENGTH);
});
