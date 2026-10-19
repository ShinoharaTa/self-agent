import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  canTransition,
  failureAllowed,
  isJobFailure,
  isJobRunState,
  JOB_ORIGINS,
  JOB_OUTCOMES,
  JOB_RUN_KINDS,
  JOB_TESTS,
  jobBranch,
  type JobFailure,
  type JobOrigin,
  type JobOutcome,
  type JobRunKind,
  type JobRunState,
  type JobTests,
} from "../jobs/state.ts";

/** open の jobs の上限（bare リポジトリの数。docs/plan/coding-jobs.md §12）。呼び出し側が countOpen で確かめる */
export const JOB_MAX_OPEN = 20;

/** open は使っている、closed は PR が閉じた・捨てた（掃除の対象） */
export type JobState = "open" | "closed";

/** 作業（jobs。1 ブランチ・1 PR）。時刻はすべて ISO */
export type Job = {
  id: number;
  guildId: string;
  /** owner/repo（検証済み・小文字にしない） */
  repo: string;
  baseBranch: string;
  /** self-agent/job-<id>（アプリが決める） */
  branch: string;
  origin: JobOrigin;
  /** Issue からのジョブなら番号（Closes に使う） */
  issueNumber: number | null;
  /** PR の上に積んだときの PR の番号 */
  stackedOnPr: number | null;
  prNumber: number | null;
  prUrl: string | null;
  /** 最後に push した先端 */
  pushedSha: string | null;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

/** 1 回の実行（job_runs） */
export type JobRun = {
  id: number;
  jobId: number;
  kind: JobRunKind;
  state: JobRunState;
  /** 固定の語（§13）。失敗でなければ null */
  failure: JobFailure | null;
  /** オーナーの指示（ローカルの DB だけ） */
  instruction: string;
  /** #github の [任せる] から作ったときの github_notifications の行 */
  sourceNotificationId: number | null;
  reportChannelId: string | null;
  reportMessageId: string | null;
  sdkSessionId: string | null;
  outcome: JobOutcome | null;
  tests: JobTests | null;
  prTitle: string | null;
  summary: string | null;
  /** 取り込んで検査を通った先端（held のとき push できる） */
  stagedSha: string | null;
  commits: number | null;
  toolCalls: number | null;
  /** 残した作業場所（jobs/kept/<run_id>） */
  keptDir: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type NewJob = {
  guildId: string;
  repo: string;
  baseBranch: string;
  origin: JobOrigin;
  issueNumber?: number | null;
  stackedOnPr?: number | null;
};

export type NewJobRun = {
  /** 作るときの状態。job_start の確認待ちは awaiting_confirm、それ以外は queued */
  state: "awaiting_confirm" | "queued";
  instruction: string;
  sourceNotificationId?: number | null;
};

/** run の状態と一緒に、または別に書き換えられる結果・報告の項目 */
export type JobRunFields = Partial<
  Pick<
    JobRun,
    | "reportChannelId"
    | "reportMessageId"
    | "sdkSessionId"
    | "outcome"
    | "tests"
    | "prTitle"
    | "summary"
    | "stagedSha"
    | "commits"
    | "toolCalls"
    | "keptDir"
  >
>;

export type JobRunTransition = {
  /** 今の状態（違えば stale で何も変えない。押した時点の DB の状態で動くボタンのため） */
  from: JobRunState;
  to: JobRunState;
  /** 移った後の failure。省略すると null */
  failure?: JobFailure | null;
  fields?: JobRunFields;
};

export type TransitionResult =
  | { result: "updated"; run: JobRun }
  /** 今の状態が from と違う（ボタンが古い・別の処理が先に変えた） */
  | { result: "stale"; run: JobRun }
  | { result: "not_found" };

/** 書き換えた後に finished_at を入れる状態（running の後の状態）。既に入っていれば変えない */
const FINISHED_STATES: readonly JobRunState[] = ["held", "pushed", "pr_opened", "failed", "cancelled"];

/** JobRunFields の列の対応 */
const RUN_FIELD_COLUMNS: Readonly<Record<keyof JobRunFields, string>> = {
  reportChannelId: "report_channel_id",
  reportMessageId: "report_message_id",
  sdkSessionId: "sdk_session_id",
  outcome: "outcome",
  tests: "tests",
  prTitle: "pr_title",
  summary: "summary",
  stagedSha: "staged_sha",
  commits: "commits",
  toolCalls: "tool_calls",
  keptDir: "kept_dir",
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: SQLOutputValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** 列の値が list の語ならそれを、違えば fallback（CHECK 制約があるので普通は起きない） */
function oneOf<T extends string>(list: readonly T[], value: SQLOutputValue | undefined, fallback: T): T {
  return list.find((item) => item === value) ?? fallback;
}

function nullableOneOf<T extends string>(list: readonly T[], value: SQLOutputValue | undefined): T | null {
  return list.find((item) => item === value) ?? null;
}

function toJob(row: Record<string, SQLOutputValue>): Job {
  return {
    id: Number(row.id),
    guildId: String(row.guild_id),
    repo: String(row.repo),
    baseBranch: String(row.base_branch),
    branch: String(row.branch),
    origin: oneOf(JOB_ORIGINS, row.origin, "command"),
    issueNumber: nullableNumber(row.issue_number),
    stackedOnPr: nullableNumber(row.stacked_on_pr),
    prNumber: nullableNumber(row.pr_number),
    prUrl: nullableString(row.pr_url),
    pushedSha: nullableString(row.pushed_sha),
    state: row.state === "closed" ? "closed" : "open",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    closedAt: nullableString(row.closed_at),
  };
}

function toRun(row: Record<string, SQLOutputValue>): JobRun {
  return {
    id: Number(row.id),
    jobId: Number(row.job_id),
    kind: oneOf(JOB_RUN_KINDS, row.kind, "initial"),
    state: isJobRunState(row.state) ? row.state : "failed",
    failure: isJobFailure(row.failure) ? row.failure : null,
    instruction: String(row.instruction),
    sourceNotificationId: nullableNumber(row.source_notification_id),
    reportChannelId: nullableString(row.report_channel_id),
    reportMessageId: nullableString(row.report_message_id),
    sdkSessionId: nullableString(row.sdk_session_id),
    outcome: nullableOneOf(JOB_OUTCOMES, row.outcome),
    tests: nullableOneOf(JOB_TESTS, row.tests),
    prTitle: nullableString(row.pr_title),
    summary: nullableString(row.summary),
    stagedSha: nullableString(row.staged_sha),
    commits: nullableNumber(row.commits),
    toolCalls: nullableNumber(row.tool_calls),
    keptDir: nullableString(row.kept_dir),
    createdAt: String(row.created_at),
    startedAt: nullableString(row.started_at),
    finishedAt: nullableString(row.finished_at),
  };
}

/** fields の SET 句と値（渡した項目だけ。値が undefined の項目は飛ばし、null は NULL で書く） */
function fieldUpdates(fields: JobRunFields | undefined): { sets: string[]; values: Array<string | number | null> } {
  if (fields === undefined) return { sets: [], values: [] };
  const keys = (Object.keys(fields) as (keyof JobRunFields)[]).filter(
    (key) => Object.hasOwn(RUN_FIELD_COLUMNS, key) && fields[key] !== undefined,
  );
  return {
    sets: keys.map((key) => `${RUN_FIELD_COLUMNS[key]} = ?`),
    values: keys.map((key) => fields[key] ?? null),
  };
}

/**
 * 作業ジョブ（jobs・job_runs。docs/plan/coding-jobs.md §11）。物理削除はしない。
 * run の状態は src/jobs/state.ts の遷移の表で確かめてから書く（許されない遷移は投げて DB を変えない）。上限（JOB_MAX_OPEN）は呼び出し側が確かめる
 */
export class JobStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /**
   * open の job と最初の run（kind initial）を 1 つのトランザクションで作る。branch は採番した id から self-agent/job-<id> にする
   * （id は AUTOINCREMENT なので、消した行の id・ブランチ名を使い回さない）
   */
  createJob(job: NewJob, run: NewJobRun): { job: Job; run: JobRun } {
    const at = this.now().toISOString();
    this.db.exec("BEGIN");
    try {
      // branch は NOT NULL UNIQUE なので仮の値で入れ、同じトランザクションの中で id から決めたものに書き換える
      const inserted = this.db
        .prepare(
          "INSERT INTO jobs (guild_id, repo, base_branch, branch, origin, issue_number, stacked_on_pr, state, created_at, updated_at) " +
            "VALUES (?, ?, ?, 'self-agent/job-pending', ?, ?, ?, 'open', ?, ?) RETURNING id",
        )
        .get(job.guildId, job.repo, job.baseBranch, job.origin, job.issueNumber ?? null, job.stackedOnPr ?? null, at, at);
      const id = Number(inserted!.id);
      const row = this.db.prepare("UPDATE jobs SET branch = ? WHERE id = ? RETURNING *").get(jobBranch(id), id);
      const created = this.insertRun(id, "initial", run, at);
      this.db.exec("COMMIT");
      return { job: toJob(row!), run: created };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getJob(id: number): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row === undefined ? undefined : toJob(row);
  }

  /** open の jobs の数（JOB_MAX_OPEN と比べる。全サーバー分） */
  countOpen(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state = 'open'").get();
    return Number(row?.count ?? 0);
  }

  /** open の jobs を作った順に */
  listOpen(): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE state = 'open' ORDER BY id").all().map(toJob);
  }

  /**
   * base のブランチを決める（受け付けたときは決まっていない。準備でリポジトリの既定のブランチ・作ったリポジトリの既定のブランチを引いて書く）。
   * 無い job なら false
   */
  setBaseBranch(jobId: number, baseBranch: string): boolean {
    const result = this.db
      .prepare("UPDATE jobs SET base_branch = ?, updated_at = ? WHERE id = ?")
      .run(baseBranch, this.now().toISOString(), jobId);
    return Number(result.changes) > 0;
  }

  /** 最後に push した先端を記録する。無い job なら false */
  setPushed(jobId: number, sha: string): boolean {
    const result = this.db
      .prepare("UPDATE jobs SET pushed_sha = ?, updated_at = ? WHERE id = ?")
      .run(sha, this.now().toISOString(), jobId);
    return Number(result.changes) > 0;
  }

  /** 作った（引いた）PR を記録する。無い job なら false */
  setPullRequest(jobId: number, prNumber: number, prUrl: string): boolean {
    const result = this.db
      .prepare("UPDATE jobs SET pr_number = ?, pr_url = ?, updated_at = ? WHERE id = ?")
      .run(prNumber, prUrl, this.now().toISOString(), jobId);
    return Number(result.changes) > 0;
  }

  /** closed にする。無い・既に closed なら何もせず false */
  close(jobId: number): boolean {
    const at = this.now().toISOString();
    const result = this.db
      .prepare("UPDATE jobs SET state = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND state = 'open'")
      .run(at, at, jobId);
    return Number(result.changes) > 0;
  }

  /** closed の job を open に戻す（準備で閉じた job の [もう一度]）。無い・既に open なら何もせず false */
  reopen(jobId: number): boolean {
    const result = this.db
      .prepare("UPDATE jobs SET state = 'open', closed_at = NULL, updated_at = ? WHERE id = ? AND state = 'closed'")
      .run(this.now().toISOString(), jobId);
    return Number(result.changes) > 0;
  }

  /** その job に run を足す（続き・[もう一度]）。無い job なら undefined。job の updated_at を今にする */
  addRun(jobId: number, kind: JobRunKind, run: NewJobRun): JobRun | undefined {
    const at = this.now().toISOString();
    this.db.exec("BEGIN");
    try {
      const touched = this.db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(at, jobId);
      if (Number(touched.changes) === 0) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const created = this.insertRun(jobId, kind, run, at);
      this.db.exec("COMMIT");
      return created;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(id: number): JobRun | undefined {
    const row = this.db.prepare("SELECT * FROM job_runs WHERE id = ?").get(id);
    return row === undefined ? undefined : toRun(row);
  }

  /** その job の run を作った順に */
  listRuns(jobId: number): JobRun[] {
    return this.db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY id").all(jobId).map(toRun);
  }

  /** その job の最後の run */
  latestRun(jobId: number): JobRun | undefined {
    const row = this.db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(jobId);
    return row === undefined ? undefined : toRun(row);
  }

  /** その状態の run を作った順に（再起動の処理・キューの入れ直し） */
  listRunsByState(states: readonly JobRunState[]): JobRun[] {
    if (states.length === 0) return [];
    return this.db
      .prepare(`SELECT * FROM job_runs WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY id`)
      .all(...states)
      .map(toRun);
  }

  /**
   * run の状態を from から to に移す（fields も同じ UPDATE で書く）。今の状態が from でなければ何もせず stale。
   * 遷移の表（canTransition）にない・その状態に置けない failure（failureAllowed）なら投げて DB を変えない。
   * running に移ったら started_at を、running の後の状態に移ったら（まだ無ければ）finished_at を今にする
   */
  transitionRun(runId: number, transition: JobRunTransition): TransitionResult {
    const current = this.getRun(runId);
    if (current === undefined) return { result: "not_found" };
    if (current.state !== transition.from) return { result: "stale", run: current };
    const failure = transition.failure ?? null;
    if (!canTransition(current, transition.to, failure)) {
      throw new Error(`ジョブの run は ${current.state} から ${transition.to} に移れません`);
    }
    if (!failureAllowed(transition.to, failure)) {
      throw new Error(`ジョブの run を ${transition.to} にするときの failure が合いません`);
    }
    // 書くときの比べ合わせは DB の生の値で行う（表に無い語が入った行を、toRun が null に読み替えても永久に stale にしない）
    const raw = this.db.prepare("SELECT failure FROM job_runs WHERE id = ?").get(runId);
    const rawFailure = raw === undefined ? null : nullableString(raw.failure);
    const at = this.now().toISOString();
    const { sets, values } = fieldUpdates(transition.fields);
    const started = transition.to === "running" ? ", started_at = ?" : "";
    const finished = FINISHED_STATES.includes(transition.to) ? ", finished_at = COALESCE(finished_at, ?)" : "";
    const extra = sets.length > 0 ? `, ${sets.join(", ")}` : "";
    const row = this.db
      .prepare(
        `UPDATE job_runs SET state = ?, failure = ?${started}${finished}${extra} ` +
          "WHERE id = ? AND state = ? AND failure IS ? RETURNING *",
      )
      .get(
        transition.to,
        failure,
        ...(started === "" ? [] : [at]),
        ...(finished === "" ? [] : [at]),
        ...values,
        runId,
        current.state,
        rawFailure,
      );
    // 読んでから書くまでに別の変更が入った
    if (row === undefined) {
      const latest = this.getRun(runId);
      return latest === undefined ? { result: "not_found" } : { result: "stale", run: latest };
    }
    return { result: "updated", run: toRun(row) };
  }

  /** 状態を変えずに結果・報告の項目を書き換える（渡した項目だけ。undefined の項目は変えず、null は NULL にする）。無い run なら false */
  updateRun(runId: number, fields: JobRunFields): boolean {
    const { sets, values } = fieldUpdates(fields);
    if (sets.length === 0) return this.getRun(runId) !== undefined;
    const result = this.db.prepare(`UPDATE job_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values, runId);
    return Number(result.changes) > 0;
  }

  private insertRun(jobId: number, kind: JobRunKind, run: NewJobRun, at: string): JobRun {
    const row = this.db
      .prepare(
        "INSERT INTO job_runs (job_id, kind, state, instruction, source_notification_id, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(jobId, kind, run.state, run.instruction, run.sourceNotificationId ?? null, at);
    return toRun(row!);
  }
}
