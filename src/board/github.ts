// 進行状況の GitHub の読み取り（docs/plan/project-board.md §4 PS1）。gh.ts の GhClient で GET だけ（open な PR・issue と、自分の PR の check-runs）。
// 応答の形はすべて確かめてから使い、URL は検証した owner・repo・番号から組み立てる。題名は先頭 200 字で改行を空白にする（信頼しないデータ）
import {
  checkRunsPath,
  type GhClient,
  type GhHeaders,
  type GhResponse,
  isOwner,
  isRepo,
  openIssuesPath,
  openPullsPath,
} from "../github/gh.ts";
import type { BoardCapped, BoardCi, BoardItem } from "./classify.ts";

/** 題名の上限（字） */
export const BOARD_TITLE_MAX = 200;
/** 1 プロジェクトで check-runs を引く自分の PR（draft でないもの）の上限 */
export const BOARD_MAX_CHECK_RUNS = 5;
/** 1 回に取る open な PR・issue の数（gh.ts の openPullsPath・openIssuesPath の per_page）。これだけ取れたら上限に当たったとみなす */
export const BOARD_PULLS_PAGE = 30;
export const BOARD_ISSUES_PAGE = 50;

export type GhGet = Pick<GhClient, "get">;

/** 取得の結果 */
export type FetchItemsResult =
  | { kind: "ok"; items: BoardItem[]; capped: BoardCapped }
  | { kind: "not_found" }
  | { kind: "rate_limited" }
  | { kind: "failed" };

export type RateObserver = (headers: GhHeaders) => void;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out", "cancelled", "action_required"]);
const SUCCESS_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** 題名を先頭 200 字（コードポイント）にし、改行・制御文字を空白にする */
export function cleanTitle(value: string): string {
  const oneLine = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return [...oneLine].slice(0, BOARD_TITLE_MAX).join("");
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 9_999_999_999;
}

function loginOf(user: unknown): string | undefined {
  if (!isObject(user)) return undefined;
  return typeof user.login === "string" && LOGIN_PATTERN.test(user.login) ? user.login : undefined;
}

export function itemUrl(owner: string, repo: string, kind: "pr" | "issue", number: number): string {
  return `https://github.com/${owner}/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`;
}

type ParsedPull = { item: BoardItem; sha: string | undefined };

/** pulls の 1 要素。形が違えば undefined */
export function parsePull(value: unknown, owner: string, repo: string, me: string): ParsedPull | undefined {
  if (!isObject(value) || !validNumber(value.number) || typeof value.title !== "string") return undefined;
  const author = loginOf(value.user);
  if (author === undefined) return undefined;
  const draft = value.draft === true;
  const head = isObject(value.head) ? value.head : undefined;
  const sha = head !== undefined && typeof head.sha === "string" && SHA_PATTERN.test(head.sha) ? head.sha : undefined;
  return {
    item: {
      kind: "pr",
      number: value.number,
      title: cleanTitle(value.title),
      url: itemUrl(owner, repo, "pr", value.number),
      mine: author.toLowerCase() === me.toLowerCase(),
      draft,
      // 自分の PR は check-runs を引いたら書き換える。引かなければ unchecked のまま（他人の PR は見ない）
      ci: author.toLowerCase() === me.toLowerCase() ? "unchecked" : "none",
    },
    sha,
  };
}

/** issues の 1 要素（pull_request を持つものは undefined）。形が違えば undefined */
export function parseIssueItem(value: unknown, owner: string, repo: string, me: string): BoardItem | undefined {
  if (!isObject(value) || Object.hasOwn(value, "pull_request")) return undefined;
  if (!validNumber(value.number) || typeof value.title !== "string") return undefined;
  const author = loginOf(value.user);
  return {
    kind: "issue",
    number: value.number,
    title: cleanTitle(value.title),
    url: itemUrl(owner, repo, "issue", value.number),
    mine: author !== undefined && author.toLowerCase() === me.toLowerCase(),
    draft: false,
    ci: "none",
  };
}

/**
 * check-runs の応答から CI を決める（純関数）。failure: conclusion が failure・timed_out・cancelled・action_required のどれかを含む、
 * pending: status が completed でないものがある、success: 全部 success・neutral・skipped、none: 0 件。
 * それ以外（stale など知らない conclusion）は決められないので pending にする。形が違えば undefined
 */
export function ciOfCheckRuns(body: unknown): BoardCi | undefined {
  if (!isObject(body) || !Array.isArray(body.check_runs)) return undefined;
  const runs = body.check_runs;
  if (runs.length === 0) return "none";
  let pending = false;
  let allSuccess = true;
  for (const run of runs) {
    if (!isObject(run) || typeof run.status !== "string") return undefined;
    const conclusion = typeof run.conclusion === "string" ? run.conclusion : null;
    if (conclusion !== null && FAILURE_CONCLUSIONS.has(conclusion)) return "failure";
    if (run.status !== "completed") pending = true;
    if (conclusion === null || !SUCCESS_CONCLUSIONS.has(conclusion)) allSuccess = false;
  }
  if (pending) return "pending";
  return allSuccess ? "success" : "pending";
}

type GetResult = { kind: "ok"; body: unknown } | { kind: "not_found" } | { kind: "rate_limited" } | { kind: "failed" };

async function getJson(gh: GhGet, path: string, observe: RateObserver): Promise<GetResult> {
  let response: GhResponse;
  try {
    response = await gh.get({ method: "GET", path });
  } catch {
    return { kind: "failed" };
  }
  if ("headers" in response) observe(response.headers);
  if (response.kind === "ok") {
    const body = parseJson(response.body);
    return body === undefined ? { kind: "failed" } : { kind: "ok", body };
  }
  if (response.kind === "rate_limited") return { kind: "rate_limited" };
  if (response.kind === "http_error" && response.status === 404) return { kind: "not_found" };
  return { kind: "failed" };
}

/**
 * open な PR（30 件）と issue（50 件。PR を除く）を取り、自分の PR のうち draft でないものの head の CI を BOARD_MAX_CHECK_RUNS 件まで引く
 * （引かなかったもの（draft・上限の後・sha が無い）は unchecked のまま）。1 ページの上限まで取れたら capped に印を付ける。
 * どれかの取得に失敗したらその種類を返す（呼び出し側は前回の items を残す）。並びは PR → issue（それぞれ GitHub の順）
 */
export async function fetchBoardItems(gh: GhGet, repoFull: string, me: string, observe: RateObserver): Promise<FetchItemsResult> {
  const [owner, repo] = repoFull.split("/");
  if (owner === undefined || repo === undefined || !isOwner(owner) || !isRepo(repo)) return { kind: "failed" };
  const pulls = await getJson(gh, openPullsPath(owner, repo), observe);
  if (pulls.kind !== "ok") return pulls;
  if (!Array.isArray(pulls.body)) return { kind: "failed" };
  const issues = await getJson(gh, openIssuesPath(owner, repo), observe);
  if (issues.kind !== "ok") return issues;
  if (!Array.isArray(issues.body)) return { kind: "failed" };

  const parsedPulls = pulls.body.map((value) => parsePull(value, owner, repo, me)).filter((value) => value !== undefined);
  let checked = 0;
  for (const pull of parsedPulls) {
    if (!pull.item.mine || pull.item.draft || pull.sha === undefined || checked >= BOARD_MAX_CHECK_RUNS) continue;
    checked++;
    const runs = await getJson(gh, checkRunsPath(owner, repo, pull.sha), observe);
    if (runs.kind !== "ok") return runs.kind === "not_found" ? { kind: "failed" } : runs;
    const ci = ciOfCheckRuns(runs.body);
    if (ci === undefined) return { kind: "failed" };
    pull.item.ci = ci;
  }
  const issueItems = issues.body.map((value) => parseIssueItem(value, owner, repo, me)).filter((value) => value !== undefined);
  return {
    kind: "ok",
    items: [...parsedPulls.map((pull) => pull.item), ...issueItems],
    capped: { pulls: pulls.body.length >= BOARD_PULLS_PAGE, issues: issues.body.length >= BOARD_ISSUES_PAGE },
  };
}

