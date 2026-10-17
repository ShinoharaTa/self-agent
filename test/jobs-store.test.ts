import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupBeforeMigration, backupPath, MIGRATIONS, openDb } from "../src/store/db.ts";
import { GithubStore } from "../src/store/github.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { JOB_MAX_OPEN, JobStore, type NewJob } from "../src/store/jobs.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

/** 2026-10-17T00:<minute>:00.000Z */
function at(minute: number): Date {
  return new Date(Date.UTC(2026, 9, 17, 0, minute));
}

function tempStore(t: TestContext): { store: JobStore; db: DatabaseSync; setNow: (date: Date) => void } {
  let now = at(0);
  const db = tempDb(t);
  return {
    store: new JobStore(db, () => now),
    db,
    setNow: (date) => {
      now = date;
    },
  };
}

function newJob(overrides: Partial<NewJob> = {}): NewJob {
  return { guildId: "g", repo: "example-user/example-repo", baseBranch: "main", origin: "command", ...overrides };
}

test("openDb: v21 の DB を v22 に上げても既存のデータは残り、ジョブの表は空で使え、guild_settings の #jobs は null。移行の前に v21 の控えを取る", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const v21 = new DatabaseSync(path);
  v21.exec("PRAGMA journal_mode=WAL");
  for (const migration of MIGRATIONS.slice(0, 21)) v21.exec(migration);
  v21.exec("PRAGMA user_version = 21");
  const created = "2026-10-01T00:00:00.000Z";
  v21
    .prepare(
      "INSERT INTO guild_settings (guild_id, home_category_id, system_channel_id, github_channel_id, created_at, updated_at) VALUES ('g', 'home-1', 'system-1', 'github-1', ?, ?)",
    )
    .run(created, created);
  v21.prepare("INSERT INTO tasks (title, status, created_at) VALUES ('残る', 'open', ?)").run(created);
  v21.prepare("INSERT INTO github_poll_state (id, baseline_done) VALUES (1, 1)").run();
  v21.close();

  const logs: string[] = [];
  await backupBeforeMigration(path, (message) => logs.push(message));
  assert.ok(existsSync(backupPath(path, 21)));
  assert.deepEqual(logs, ["DB を移行する前に控えを取りました（v21）"]);

  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 22);

  const guildSettings = new GuildSettingsStore(db);
  assert.equal(guildSettings.get("g")?.githubChannelId, "github-1");
  assert.equal(guildSettings.jobsChannelId("g"), null);
  assert.deepEqual(new TaskStore(db).list({ status: "open", limit: 20 }).map((task) => task.title), ["残る"]);
  assert.equal(new GithubStore(db).getPollState().baselineDone, true);

  const store = new JobStore(db, () => at(0));
  assert.equal(store.countOpen(), 0);
  assert.equal(store.getJob(1), undefined);
  assert.deepEqual(store.listRunsByState(["queued"]), []);
  assert.equal(store.createJob(newJob(), { state: "queued", instruction: "直す" }).job.branch, "self-agent/job-1");
});

test("GuildSettingsStore: #jobs の ID は /setup 済み（guild_settings の行がある）のサーバーだけに保存し、作り直したら置き換える", (t) => {
  let now = at(0);
  const store = new GuildSettingsStore(tempDb(t), () => now);
  assert.equal(store.setJobsChannel("g", "jobs-0"), false);
  assert.equal(store.get("g"), undefined);
  assert.equal(store.jobsChannelId("g"), null);

  store.setChannel("g", "homeCategoryId", "home-1");
  now = at(3);
  assert.equal(store.setJobsChannel("g", "jobs-1"), true);
  assert.equal(store.jobsChannelId("g"), "jobs-1");
  assert.equal(store.setJobsChannel("g", "jobs-2"), true);
  assert.equal(store.jobsChannelId("g"), "jobs-2");
  assert.equal(store.get("g")?.homeCategoryId, "home-1");
  assert.equal(store.get("g")?.updatedAt, at(3).toISOString());
  assert.equal(store.jobsChannelId("other"), null);
});

test("JobStore: createJob は open の job と最初の run（initial）を作り、branch は採番した id から self-agent/job-<id>", (t) => {
  const { store } = tempStore(t);
  const { job, run } = store.createJob(newJob({ issueNumber: 3 }), { state: "queued", instruction: "Issue を直す" });
  assert.deepEqual(job, {
    id: 1,
    guildId: "g",
    repo: "example-user/example-repo",
    baseBranch: "main",
    branch: "self-agent/job-1",
    origin: "command",
    issueNumber: 3,
    stackedOnPr: null,
    prNumber: null,
    prUrl: null,
    pushedSha: null,
    state: "open",
    createdAt: at(0).toISOString(),
    updatedAt: at(0).toISOString(),
    closedAt: null,
  });
  assert.deepEqual(run, {
    id: 1,
    jobId: 1,
    kind: "initial",
    state: "queued",
    failure: null,
    instruction: "Issue を直す",
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
    createdAt: at(0).toISOString(),
    startedAt: null,
    finishedAt: null,
  });
  assert.deepEqual(store.getJob(1), job);
  assert.deepEqual(store.getRun(1), run);

  const second = store.createJob(newJob({ origin: "github", stackedOnPr: 7 }), {
    state: "awaiting_confirm",
    instruction: "積む",
    sourceNotificationId: 42,
  });
  assert.equal(second.job.id, 2);
  assert.equal(second.job.branch, "self-agent/job-2");
  assert.equal(second.job.stackedOnPr, 7);
  assert.equal(second.run.state, "awaiting_confirm");
  assert.equal(second.run.sourceNotificationId, 42);
  assert.equal(store.countOpen(), 2);
  assert.ok(JOB_MAX_OPEN === 20);
});

test("JobStore: branch は一意（同じブランチ名の行は入らない）。作れなかったら job も run も残らない", (t) => {
  const { store, db } = tempStore(t);
  store.createJob(newJob(), { state: "queued", instruction: "一つ目" });
  assert.throws(() =>
    db
      .prepare(
        "INSERT INTO jobs (guild_id, repo, base_branch, branch, origin, state, created_at, updated_at) VALUES ('g', 'r/r', 'main', 'self-agent/job-1', 'command', 'open', 'x', 'x')",
      )
      .run(),
  );
  // 制約に反する run（CHECK）なら job ごと巻き戻す
  assert.throws(() => store.createJob(newJob(), { state: "nope" as "queued", instruction: "不正" }));
  assert.equal(store.countOpen(), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM job_runs").get()?.count), 1);
  // 巻き戻した分は採番も戻る
  assert.equal(store.createJob(newJob(), { state: "queued", instruction: "二つ目" }).job.branch, "self-agent/job-2");
});

test("JobStore: addRun は続きの run を足して job の updated_at を今にする。無い job なら undefined", (t) => {
  const { store, setNow } = tempStore(t);
  const { job } = store.createJob(newJob(), { state: "queued", instruction: "最初" });
  setNow(at(10));
  const run = store.addRun(job.id, "followup", { state: "queued", instruction: "レビューに対応する" });
  assert.equal(run?.kind, "followup");
  assert.equal(run?.jobId, job.id);
  assert.equal(run?.createdAt, at(10).toISOString());
  assert.equal(store.getJob(job.id)?.updatedAt, at(10).toISOString());
  assert.deepEqual(store.listRuns(job.id).map((item) => item.instruction), ["最初", "レビューに対応する"]);
  assert.equal(store.latestRun(job.id)?.id, run?.id);
  assert.equal(store.addRun(99, "followup", { state: "queued", instruction: "無い" }), undefined);
  assert.equal(store.latestRun(99), undefined);
});

test("JobStore: transitionRun は表どおりの遷移だけ書き、started_at・finished_at を入れる。結果の項目も同じ UPDATE で書く", (t) => {
  const { store, setNow } = tempStore(t);
  const { run } = store.createJob(newJob(), { state: "awaiting_confirm", instruction: "作る" });
  setNow(at(1));
  const queued = store.transitionRun(run.id, { from: "awaiting_confirm", to: "queued" });
  assert.equal(queued.result, "updated");
  setNow(at(2));
  const running = store.transitionRun(run.id, { from: "queued", to: "running" });
  assert.equal(running.result === "updated" && running.run.startedAt, at(2).toISOString());
  setNow(at(20));
  const held = store.transitionRun(run.id, {
    from: "running",
    to: "held",
    failure: "max_turns",
    fields: { commits: 2, toolCalls: 100, stagedSha: "a".repeat(40), summary: "途中まで", sdkSessionId: "s-1" },
  });
  assert.equal(held.result, "updated");
  const afterHeld = store.getRun(run.id)!;
  assert.equal(afterHeld.state, "held");
  assert.equal(afterHeld.failure, "max_turns");
  assert.equal(afterHeld.finishedAt, at(20).toISOString());
  assert.equal(afterHeld.commits, 2);
  assert.equal(afterHeld.toolCalls, 100);
  assert.equal(afterHeld.stagedSha, "a".repeat(40));
  assert.equal(afterHeld.sdkSessionId, "s-1");

  // [ここまでを draft PR に] → PR の作成に失敗 → [もう一度]
  setNow(at(30));
  const pushed = store.transitionRun(run.id, { from: "held", to: "pushed", failure: "pr_failed" });
  assert.equal(pushed.result === "updated" && pushed.run.failure, "pr_failed");
  // finished_at は最初に終わった時刻のまま
  assert.equal(store.getRun(run.id)?.finishedAt, at(20).toISOString());
  const opened = store.transitionRun(run.id, { from: "pushed", to: "pr_opened" });
  assert.equal(opened.result === "updated" && opened.run.failure, null);
  assert.equal(opened.result === "updated" && opened.run.state, "pr_opened");
});

test("JobStore: 許されない遷移・その状態に置けない failure は投げて DB を変えない。今の状態が from と違えば stale、無い run は not_found", (t) => {
  const { store } = tempStore(t);
  const { run } = store.createJob(newJob(), { state: "queued", instruction: "作る" });
  const before = store.getRun(run.id);
  assert.throws(() => store.transitionRun(run.id, { from: "queued", to: "pr_opened" }), /queued から pr_opened/);
  assert.throws(() => store.transitionRun(run.id, { from: "queued", to: "running", failure: "timeout" }), /failure/);
  assert.throws(() => store.transitionRun(run.id, { from: "queued", to: "cancelled", failure: "push_failed" }), /failure/);
  assert.deepEqual(store.getRun(run.id), before);

  const stale = store.transitionRun(run.id, { from: "running", to: "failed", failure: "interrupted" });
  assert.equal(stale.result, "stale");
  assert.equal(stale.result === "stale" && stale.run.state, "queued");
  assert.deepEqual(store.transitionRun(99, { from: "queued", to: "running" }), { result: "not_found" });

  store.transitionRun(run.id, { from: "queued", to: "running" });
  assert.throws(() => store.transitionRun(run.id, { from: "running", to: "failed" }), /failure/);
  assert.throws(() => store.transitionRun(run.id, { from: "running", to: "held", failure: "no_commits" }), /failure/);
  assert.throws(() => store.transitionRun(run.id, { from: "running", to: "queued" }), /running から queued/);
  assert.equal(store.transitionRun(run.id, { from: "running", to: "failed", failure: "clone_failed" }).result, "updated");
  // push・PR だけの失敗でなければ failed から先へは移れない
  assert.throws(() => store.transitionRun(run.id, { from: "failed", to: "pushed" }), /failed から pushed/);
  assert.equal(store.getRun(run.id)?.failure, "clone_failed");
});

test("JobStore: failed（push_failed）は [もう一度] で pushed・pr_opened に移れる。cancelled・pr_opened からは移れない", (t) => {
  const { store } = tempStore(t);
  const { run } = store.createJob(newJob(), { state: "queued", instruction: "作る" });
  store.transitionRun(run.id, { from: "queued", to: "running" });
  store.transitionRun(run.id, { from: "running", to: "failed", failure: "push_failed" });
  assert.equal(store.transitionRun(run.id, { from: "failed", to: "pr_opened" }).result, "updated");
  assert.throws(() => store.transitionRun(run.id, { from: "pr_opened", to: "pushed" }));

  const other = store.createJob(newJob(), { state: "awaiting_confirm", instruction: "やめる" }).run;
  assert.equal(store.transitionRun(other.id, { from: "awaiting_confirm", to: "cancelled" }).result, "updated");
  assert.throws(() => store.transitionRun(other.id, { from: "cancelled", to: "queued" }));
});

test("JobStore: 再起動の材料（状態ごとの run）・updateRun・PR と push の記録・close と open の数", (t) => {
  const { store, setNow } = tempStore(t);
  const a = store.createJob(newJob(), { state: "queued", instruction: "a" });
  const b = store.createJob(newJob(), { state: "awaiting_confirm", instruction: "b" });
  const c = store.createJob(newJob(), { state: "queued", instruction: "c" });
  store.transitionRun(a.run.id, { from: "queued", to: "running" });
  assert.deepEqual(
    store.listRunsByState(["running", "queued"]).map((run) => run.instruction),
    ["a", "c"],
  );
  assert.deepEqual(store.listRunsByState(["awaiting_confirm"]).map((run) => run.instruction), ["b"]);
  assert.deepEqual(store.listRunsByState([]), []);

  assert.equal(store.updateRun(a.run.id, { reportChannelId: "jobs-1", reportMessageId: "m-1", outcome: "done", tests: "passed", prTitle: "題名" }), true);
  const updated = store.getRun(a.run.id)!;
  assert.equal(updated.state, "running");
  assert.equal(updated.reportChannelId, "jobs-1");
  assert.equal(updated.reportMessageId, "m-1");
  assert.equal(updated.outcome, "done");
  assert.equal(updated.tests, "passed");
  assert.equal(updated.prTitle, "題名");
  assert.equal(store.updateRun(a.run.id, { prTitle: null }), true);
  assert.equal(store.getRun(a.run.id)?.prTitle, null);
  assert.equal(store.updateRun(99, { summary: "x" }), false);
  assert.equal(store.updateRun(a.run.id, {}), true);
  assert.equal(store.updateRun(99, {}), false);
  // 値の CHECK は DB が守る
  assert.throws(() => store.updateRun(a.run.id, { tests: "maybe" as "passed" }));

  setNow(at(5));
  assert.equal(store.setPushed(a.job.id, "b".repeat(40)), true);
  assert.equal(store.setPullRequest(a.job.id, 34, "https://github.com/example-user/example-repo/pull/34"), true);
  const job = store.getJob(a.job.id)!;
  assert.equal(job.pushedSha, "b".repeat(40));
  assert.equal(job.prNumber, 34);
  assert.equal(job.prUrl, "https://github.com/example-user/example-repo/pull/34");
  assert.equal(job.updatedAt, at(5).toISOString());
  assert.equal(store.setPushed(99, "x"), false);
  assert.equal(store.setPullRequest(99, 1, "x"), false);

  assert.equal(store.countOpen(), 3);
  setNow(at(9));
  assert.equal(store.close(b.job.id), true);
  assert.equal(store.close(b.job.id), false);
  assert.equal(store.close(99), false);
  assert.equal(store.getJob(b.job.id)?.state, "closed");
  assert.equal(store.getJob(b.job.id)?.closedAt, at(9).toISOString());
  assert.equal(store.countOpen(), 2);
  assert.deepEqual(store.listOpen().map((item) => item.id), [a.job.id, c.job.id]);
});

/** running まで進めた run（staged があり held にできる） */
function runningRun(store: JobStore): number {
  const { run } = store.createJob(newJob(), { state: "queued", instruction: "作る" });
  store.transitionRun(run.id, { from: "queued", to: "running" });
  return run.id;
}

test("JobStore: held は pushed・pr_opened に移れ、[ここまでを draft PR に] の push が失敗したら push・PR の段の語で failed に移れる", (t) => {
  const { store } = tempStore(t);
  const toHeld = (): number => {
    const id = runningRun(store);
    store.transitionRun(id, { from: "running", to: "held", failure: "timeout", fields: { stagedSha: "c".repeat(40) } });
    return id;
  };
  const a = toHeld();
  assert.equal(store.transitionRun(a, { from: "held", to: "pushed" }).result, "updated");
  const b = toHeld();
  const opened = store.transitionRun(b, { from: "held", to: "pr_opened" });
  assert.equal(opened.result === "updated" && opened.run.failure, null);
  const c = toHeld();
  assert.throws(() => store.transitionRun(c, { from: "held", to: "failed", failure: "no_commits" }), /held から failed/);
  assert.throws(() => store.transitionRun(c, { from: "held", to: "failed" }), /held から failed/);
  const failed = store.transitionRun(c, { from: "held", to: "failed", failure: "push_rejected" });
  assert.equal(failed.result === "updated" && failed.run.failure, "push_rejected");
  // staged は残る
  assert.equal(store.getRun(c)?.stagedSha, "c".repeat(40));
});

test("JobStore: failed（push・PR の段の失敗）は [もう一度] でまた失敗したら別の語の failed に移れる。準備の段の失敗からは移れない", (t) => {
  const { store } = tempStore(t);
  const id = runningRun(store);
  store.transitionRun(id, { from: "running", to: "failed", failure: "push_failed" });
  const again = store.transitionRun(id, { from: "failed", to: "failed", failure: "pr_failed" });
  assert.equal(again.result === "updated" && again.run.failure, "pr_failed");
  const third = store.transitionRun(id, { from: "failed", to: "failed", failure: "push_auth" });
  assert.equal(third.result === "updated" && third.run.failure, "push_auth");
  assert.throws(() => store.transitionRun(id, { from: "failed", to: "failed", failure: "import_failed" }), /failed から failed/);
  assert.equal(store.transitionRun(id, { from: "failed", to: "pushed" }).result, "updated");

  const prep = runningRun(store);
  store.transitionRun(prep, { from: "running", to: "failed", failure: "clone_failed" });
  assert.throws(() => store.transitionRun(prep, { from: "failed", to: "failed", failure: "push_failed" }), /failed から failed/);
});

test("JobStore: failure が表に無い語の行も stale にならず、表どおりに移せる（比べ合わせは DB の生の値）", (t) => {
  const { store, db } = tempStore(t);
  const id = runningRun(store);
  db.prepare("UPDATE job_runs SET failure = 'unknown_word' WHERE id = ?").run(id);
  assert.equal(store.getRun(id)?.failure, null);
  const result = store.transitionRun(id, { from: "running", to: "failed", failure: "interrupted" });
  assert.equal(result.result, "updated");
  assert.equal(store.getRun(id)?.failure, "interrupted");
});

test("JobStore: fields の undefined の項目は書き換えない（null は NULL にする）", (t) => {
  const { store } = tempStore(t);
  const id = runningRun(store);
  store.updateRun(id, { summary: "要約", commits: 2, prTitle: "題名" });
  assert.equal(store.updateRun(id, { summary: undefined, commits: undefined, prTitle: null }), true);
  let run = store.getRun(id)!;
  assert.equal(run.summary, "要約");
  assert.equal(run.commits, 2);
  assert.equal(run.prTitle, null);
  assert.equal(store.updateRun(id, { summary: undefined }), true);
  assert.equal(store.updateRun(99, { summary: undefined }), false);

  const result = store.transitionRun(id, {
    from: "running",
    to: "pr_opened",
    fields: { summary: undefined, toolCalls: 7, commits: undefined },
  });
  assert.equal(result.result, "updated");
  run = store.getRun(id)!;
  assert.equal(run.summary, "要約");
  assert.equal(run.commits, 2);
  assert.equal(run.toolCalls, 7);
});
