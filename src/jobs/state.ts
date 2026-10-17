import { escapeDiscordText } from "../discord/escape.ts";
import type { Job, JobRun } from "../store/jobs.ts";

/** ジョブの入口（docs/plan/coding-jobs.md §7）。command は /job run、new_repo は /job new、github は #github の [任せる]、inbox は job_start */
export const JOB_ORIGINS = ["command", "new_repo", "github", "inbox"] as const;
export type JobOrigin = (typeof JOB_ORIGINS)[number];

/** initial は最初の run、followup は同じブランチ・PR への続き（§10） */
export const JOB_RUN_KINDS = ["initial", "followup"] as const;
export type JobRunKind = (typeof JOB_RUN_KINDS)[number];

/** run の状態（§11） */
export const JOB_RUN_STATES = [
  "awaiting_confirm",
  "queued",
  "running",
  "held",
  "pushed",
  "pr_opened",
  "failed",
  "cancelled",
] as const;
export type JobRunState = (typeof JOB_RUN_STATES)[number];

/** job_result の outcome */
export const JOB_OUTCOMES = ["done", "cannot"] as const;
export type JobOutcome = (typeof JOB_OUTCOMES)[number];

/** job_result の tests（作業した Claude の申告） */
export const JOB_TESTS = ["passed", "failed", "not_run"] as const;
export type JobTests = (typeof JOB_TESTS)[number];

/** 失敗の固定の語（§13。branch_missing は §10） */
export const JOB_FAILURES = [
  "sandbox_unavailable",
  "disk_full",
  "too_many",
  "repo_unavailable",
  "repo_too_large",
  "repo_exists",
  "clone_failed",
  "branch_missing",
  "max_turns",
  "timeout",
  "aborted",
  "no_result",
  "declined",
  "no_commits",
  "import_failed",
  "forbidden_path",
  "bad_author",
  "too_large",
  "not_fast_forward",
  "push_rejected",
  "push_auth",
  "push_failed",
  "pr_failed",
  "interrupted",
] as const;
export type JobFailure = (typeof JOB_FAILURES)[number];

/** ジョブのブランチの接頭辞。ブランチ名はアプリが `self-agent/job-<job_id>` に決める（第三者・LLM の文字列を入れない） */
export const JOB_BRANCH_PREFIX = "self-agent/job-";

export function jobBranch(jobId: number): string {
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Error("ジョブの id が正の整数ではありません");
  return `${JOB_BRANCH_PREFIX}${jobId}`;
}

export function isJobRunState(value: unknown): value is JobRunState {
  return typeof value === "string" && (JOB_RUN_STATES as readonly string[]).includes(value);
}

export function isJobFailure(value: unknown): value is JobFailure {
  return typeof value === "string" && (JOB_FAILURES as readonly string[]).includes(value);
}

/**
 * 状態の遷移の表（§11）。failed から先（pushed・pr_opened・failed）は、push・PR の段の失敗（RETRYABLE_FAILURES）のときだけ。
 * held → failed は [ここまでを draft PR に] の push・PR が失敗したとき、failed → failed は [もう一度] でまた失敗したとき（語が変わりうる）で、
 * どちらも移った後の failure は RETRYABLE_FAILURES の語。
 * 準備の段の失敗（sandbox_unavailable・disk_full・too_many・repo_*・clone_failed・branch_missing）は、キューで順番が来て running にしてから failed にする
 * （queued → running → failed。queued から直接 failed には移さない）
 */
const TRANSITIONS: Readonly<Record<JobRunState, readonly JobRunState[]>> = {
  awaiting_confirm: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["pr_opened", "pushed", "held", "failed", "cancelled"],
  held: ["pr_opened", "pushed", "failed"],
  pushed: ["pr_opened"],
  failed: ["pushed", "pr_opened", "failed"],
  pr_opened: [],
  cancelled: [],
};

/**
 * push・PR の段の失敗（staged が残っていて、[もう一度] で push・PR だけをやり直せる）。pr_failed は普通は pushed に置くが、
 * failed → failed で語が変わるときのために failed にも置ける
 */
const RETRYABLE_FAILURES: readonly JobFailure[] = ["push_failed", "not_fast_forward", "push_rejected", "push_auth", "pr_failed"];

/** held の理由（コミットがあり検査を通ったが、終わり方が正常でない） */
const HELD_FAILURES: readonly JobFailure[] = ["max_turns", "timeout", "aborted", "no_result"];

/**
 * from（今の状態と failure）から to（移った後の failure は toFailure）に移れるか。failed から先は from の failure が RETRYABLE_FAILURES のときだけ、
 * held・failed から failed へは toFailure も RETRYABLE_FAILURES のときだけ
 */
export function canTransition(
  from: { state: JobRunState; failure: JobFailure | null },
  to: JobRunState,
  toFailure: JobFailure | null = null,
): boolean {
  if (!TRANSITIONS[from.state].includes(to)) return false;
  if (from.state === "failed" && (from.failure === null || !RETRYABLE_FAILURES.includes(from.failure))) return false;
  if ((from.state === "held" || from.state === "failed") && to === "failed") {
    return toFailure !== null && RETRYABLE_FAILURES.includes(toFailure);
  }
  return true;
}

/**
 * その状態に置いてよい failure か。failed は何かの語が要る。held は終わり方の語（max_turns・timeout・aborted・no_result）だけ、
 * pushed は無しか pr_failed、cancelled は無しか aborted。それ以外の状態は無し
 */
export function failureAllowed(state: JobRunState, failure: JobFailure | null): boolean {
  switch (state) {
    case "failed":
      return failure !== null;
    case "held":
      return failure !== null && HELD_FAILURES.includes(failure);
    case "pushed":
      return failure === null || failure === "pr_failed";
    case "cancelled":
      return failure === null || failure === "aborted";
    default:
      return failure === null;
  }
}

/** 失敗の理由（#jobs の文面）。固定の語だけから作る */
const FAILURE_TEXTS: Readonly<Record<JobFailure, string>> = {
  sandbox_unavailable: "シェルを使えない状態のため始められません",
  disk_full: "ディスクの空きが足りません",
  too_many: "作業中のジョブが多すぎます",
  repo_unavailable: "リポジトリが無いか、見られません",
  repo_too_large: "リポジトリが大きすぎます",
  repo_exists: "同じ名前のリポジトリが既にあります",
  clone_failed: "リポジトリを取得できませんでした",
  branch_missing: "ジョブのブランチがありません",
  max_turns: "手順の上限",
  timeout: "時間切れ",
  aborted: "中断",
  no_result: "結果の報告がありませんでした",
  declined: "作業できませんでした",
  no_commits: "変更がありませんでした",
  import_failed: "変更を取り込めませんでした",
  forbidden_path: ".github/ を変えています",
  bad_author: "コミットの作者が違います",
  too_large: "大きすぎるファイルがあります",
  not_fast_forward: "ブランチが別に変わっていました",
  push_rejected: "push を拒否されました",
  push_auth: "push の認証に失敗しました",
  push_failed: "push に失敗しました（通信）",
  pr_failed: "PR を作れませんでした",
  interrupted: "再起動で止まりました",
};

export function failureText(failure: JobFailure): string {
  return FAILURE_TEXTS[failure];
}

/** #jobs の 1 メッセージの上限（メンションの `<@id> ` を足しても 2,000 字に収まるように） */
export const JOB_MESSAGE_MAX_LENGTH = 1900;
/** 文面に入れる summary の先頭（字） */
export const JOB_MESSAGE_SUMMARY_LENGTH = 600;
/** 確認の文面に入れる依頼の先頭（字。§7.4） */
export const JOB_MESSAGE_INSTRUCTION_LENGTH = 200;

const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^self-agent\/job-[1-9][0-9]{0,15}$/;

const TESTS_TEXTS: Readonly<Record<JobTests, string>> = {
  passed: "通った",
  failed: "失敗",
  not_run: "実行していない",
};

/** 先頭 length 字（コードポイントで数える） */
function head(text: string, length: number): string {
  return [...text].slice(0, length).join("");
}

/** 検証したリポジトリ名だけから組み立てた URL。形が違えば undefined */
function repoUrl(repo: string, path: string): string | undefined {
  return REPO_PATTERN.test(repo) ? `https://github.com/${repo}${path}` : undefined;
}

function prUrl(job: Job): string | undefined {
  return job.prNumber === null ? undefined : repoUrl(job.repo, `/pull/${job.prNumber}`);
}

function branchUrl(job: Job): string | undefined {
  return BRANCH_PATTERN.test(job.branch) ? repoUrl(job.repo, `/tree/${job.branch}`) : undefined;
}

/** 1 行目のリポジトリと依頼のもと（続き・Issue・PR の上・新しいリポジトリ） */
function where(job: Job, run: JobRun): string {
  let from = "";
  if (run.kind === "followup") from = "（続き）";
  else if (job.issueNumber !== null) from = `（Issue #${job.issueNumber} から）`;
  else if (job.stackedOnPr !== null) from = `（PR #${job.stackedOnPr} の上に）`;
  else if (job.origin === "new_repo") from = "（新しいリポジトリ）";
  return `  ${escapeDiscordText(job.repo)}${from}`;
}

/** 「コミット 3 件・テスト: 通った・45 分中 18 分・ツール 52 回」。分かる項目だけ。始めていなければ空 */
function stats(run: JobRun, timeoutMin: number): string {
  if (run.startedAt === null) return "";
  const parts: string[] = [];
  if (run.commits !== null) parts.push(`コミット ${run.commits} 件`);
  if (run.tests !== null) parts.push(`テスト: ${TESTS_TEXTS[run.tests]}`);
  if (run.finishedAt !== null) {
    const elapsedMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) parts.push(`${timeoutMin} 分中 ${Math.ceil(elapsedMs / 60_000)} 分`);
  }
  if (run.toolCalls !== null) parts.push(`ツール ${run.toolCalls} 回`);
  return parts.join("・");
}

function summary(run: JobRun): string {
  const text = head((run.summary ?? "").trim(), JOB_MESSAGE_SUMMARY_LENGTH);
  return text === "" ? "" : escapeDiscordText(text);
}

/**
 * #jobs の 1 run のメッセージの本文（§9・§13）。リポジトリ・summary・依頼は Markdown とメンションを無効にし、URL は検証した部品から組み立てて <> で囲む。
 * 途中経過（progress）はアプリが作った文で、running のときだけ使う（無ければ「作業中…」）。メンションとボタンは呼び出し側が付ける。
 * JOB_MESSAGE_MAX_LENGTH を超えたら切る
 */
export function formatJobMessage(job: Job, run: JobRun, options: { timeoutMin: number; progress?: string }): string {
  const place = where(job, run);
  const lines: string[] = [];
  const pr = prUrl(job);
  switch (run.state) {
    case "awaiting_confirm": {
      lines.push(`❔ ジョブ #${job.id} を始めますか？${place}`);
      const instruction = head(run.instruction.replace(/\s+/g, " ").trim(), JOB_MESSAGE_INSTRUCTION_LENGTH);
      if (instruction !== "") lines.push(escapeDiscordText(instruction));
      break;
    }
    case "queued":
      lines.push(`⏳ ジョブ #${job.id}${place}`, "順番を待っています");
      break;
    case "running":
      lines.push(`🔧 ジョブ #${job.id}${place}`, options.progress ?? "作業中…");
      break;
    case "pr_opened":
      lines.push(`✅ ジョブ #${job.id}${place}`);
      if (pr !== undefined) lines.push(`draft PR #${job.prNumber}: <${pr}>`);
      if (run.tests === "failed") lines.push("⚠ テストが通っていません");
      break;
    case "pushed":
      if (run.failure === "pr_failed") {
        lines.push(`⚠ ジョブ #${job.id} は push しましたが PR を作れませんでした${place}`);
        const branch = branchUrl(job);
        if (branch !== undefined) lines.push(`<${branch}>`);
      } else {
        lines.push(`✅ ジョブ #${job.id}${place}`);
        const branch = branchUrl(job);
        if (pr !== undefined) lines.push(`draft PR #${job.prNumber} に push しました: <${pr}>`);
        else if (branch !== undefined) lines.push(`push しました: <${branch}>`);
        if (run.tests === "failed") lines.push("⚠ テストが通っていません");
      }
      break;
    case "held":
    case "failed": {
      const reason = run.failure === null ? "" : `（${failureText(run.failure)}）`;
      lines.push(`⚠ ジョブ #${job.id} は push していません${reason}${place}`);
      break;
    }
    case "cancelled":
      lines.push(`⏹ ジョブ #${job.id} を${run.failure === "aborted" ? "中断しました" : "取り消しました"}${place}`);
      break;
  }
  if (run.state !== "awaiting_confirm" && run.state !== "queued" && run.state !== "running") {
    const line = stats(run, options.timeoutMin);
    if (line !== "") lines.push(line);
    const text = summary(run);
    if (text !== "") lines.push(text);
  }
  const text = lines.join("\n");
  return [...text].length <= JOB_MESSAGE_MAX_LENGTH ? text : `${head(text, JOB_MESSAGE_MAX_LENGTH - 1)}…`;
}
