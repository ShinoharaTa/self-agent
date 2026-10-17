// 作業ジョブの gh api（docs/plan/coding-jobs.md §6.3・§6.4・§7.5）。gh.ts の GET 専用の包み（通知のポーリング）とは別に、
// ジョブが使う GET（リポジトリ・Issue・コメント・PR・レビュー）と、固定の 2 つの POST（draft PR の作成・リポジトリの作成）だけを許す。
// シェルを通さない（execFile に固定の形の引数）。POST の本文は `--input -` で標準入力から渡し、コマンドの引数には出さない。
// 応答は形を確かめてから使い、画面の URL は検証した部品から組み立てる。log・例外の message にリポジトリ名・題名・URL を入れない
import { isBranchName, isJobBranch } from "./git.ts";
import {
  execFileRun,
  GH_MAX_BUFFER,
  GH_TIMEOUT_MS,
  ghChildEnv,
  interpretGhResult,
  isOwner,
  isRepo,
  lastPageFromLink,
  parseIncludeOutput,
  type GhResponse,
  type RunCommand,
} from "../github/gh.ts";

const NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/;
const PER_PAGE_PATTERN = /^(?:[1-9]|[1-9][0-9]|100)$/;
const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
/** レビュー・コメントの作成者（Bot の `<名前>[bot]` を含む） */
const AUTHOR_LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/;
const STATE_PATTERN = /^(?:open|closed|all)$/;

const PAGE_QUERY: Readonly<Record<string, RegExp>> = { per_page: PER_PAGE_PATTERN, page: NUMBER_PATTERN };

function queryAllowed(query: string | undefined, allowed: Readonly<Record<string, (value: string) => boolean>>): boolean {
  if (query === undefined) return true;
  if (query === "") return false;
  const seen = new Set<string>();
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return false;
    const name = part.slice(0, eq);
    const check = Object.hasOwn(allowed, name) ? allowed[name] : undefined;
    if (check === undefined || seen.has(name) || !check(part.slice(eq + 1))) return false;
    seen.add(name);
  }
  return true;
}

function patterns(record: Readonly<Record<string, RegExp>>): Record<string, (value: string) => boolean> {
  return Object.fromEntries(Object.entries(record).map(([name, pattern]) => [name, (value: string) => pattern.test(value)]));
}

/**
 * ジョブが GET してよいパスか（§7.5）: `/user`・`/repos/<o>/<r>`・`/repos/<o>/<r>/issues/<n>`・その `/comments?…`・
 * `/repos/<o>/<r>/pulls/<n>`・その `/comments?…`・`/reviews?…`・`/repos/<o>/<r>/pulls?head=<o>:self-agent/…&state=…`。
 * クエリは決まった名前と値の形だけ（同じ名前は 1 回）
 */
export function isAllowedJobGetPath(path: string): boolean {
  const question = path.indexOf("?");
  const base = question === -1 ? path : path.slice(0, question);
  const query = question === -1 ? undefined : path.slice(question + 1);
  if (base === "/user") return query === undefined;
  const parts = base.split("/");
  if (parts.length < 4 || parts[0] !== "" || parts[1] !== "repos" || !isOwner(parts[2]!) || !isRepo(parts[3]!)) return false;
  const owner = parts[2]!;
  const rest = parts.slice(4);
  if (rest.length === 0) return query === undefined;
  if (rest.length === 1 && rest[0] === "pulls") {
    return (
      query !== undefined &&
      query.includes("head=") &&
      queryAllowed(query, {
        head: (value) => value.startsWith(`${owner}:`) && isJobBranch(value.slice(owner.length + 1)),
        state: (value) => STATE_PATTERN.test(value),
        ...patterns(PAGE_QUERY),
      })
    );
  }
  if ((rest[0] !== "issues" && rest[0] !== "pulls") || !NUMBER_PATTERN.test(rest[1] ?? "")) return false;
  if (rest.length === 2) return query === undefined;
  if (rest.length !== 3) return false;
  if (rest[2] === "comments" || (rest[0] === "pulls" && rest[2] === "reviews")) return queryAllowed(query, patterns(PAGE_QUERY));
  return false;
}

/** ジョブが POST してよいパスか（§6.3・§6.4）: `/repos/<o>/<r>/pulls` と `/user/repos` の 2 つだけ */
export function isAllowedJobPostPath(path: string): boolean {
  if (path === "/user/repos") return true;
  const parts = path.split("/");
  return parts.length === 5 && parts[0] === "" && parts[1] === "repos" && isOwner(parts[2]!) && isRepo(parts[3]!) && parts[4] === "pulls";
}

export type JobGhRequest = { method: "GET"; path: string } | { method: "POST"; path: string };

/** gh api の引数（固定の形）。POST は `--input -`（本文は標準入力）。許可していないメソッド・パスは投げる */
export function jobGhApiArgs(request: JobGhRequest): string[] {
  if (request.method === "GET") {
    if (!isAllowedJobGetPath(request.path)) throw new Error("許可していない GitHub API のパスです");
  } else if (request.method === "POST") {
    if (!isAllowedJobPostPath(request.path)) throw new Error("許可していない GitHub API のパスです");
  } else {
    throw new Error("gh api は GET と POST だけを使えます");
  }
  const args = [
    "api",
    "--method",
    request.method,
    "--include",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
  ];
  if (request.method === "POST") args.push("--input", "-");
  args.push(request.path);
  return args;
}

/**
 * 失敗の種類。auth は 401・ログインしていない、not_found は 404（見る権限が無いときも 404）、exists は作ろうとしたものが既にある、
 * rate_limited はレート制限、http_error はそれ以外のステータス、failed は gh が動かなかった、bad_response は応答の形が違う
 */
export type JobApiFailure = "auth" | "not_found" | "exists" | "rate_limited" | "http_error" | "failed" | "bad_response";

export type JobApiResult<T> = { ok: true; value: T } | { ok: false; failure: JobApiFailure; status: number | null };

function failureOf(response: Exclude<GhResponse, { kind: "ok" }>): { ok: false; failure: JobApiFailure; status: number | null } {
  switch (response.kind) {
    case "auth":
      return { ok: false, failure: "auth", status: response.status };
    case "rate_limited":
      return { ok: false, failure: "rate_limited", status: response.status };
    case "http_error":
      return { ok: false, failure: response.status === 404 ? "not_found" : "http_error", status: response.status };
    case "not_modified":
      return { ok: false, failure: "failed", status: 304 };
    case "failed":
      return { ok: false, failure: "failed", status: null };
  }
}

const BAD_RESPONSE = { ok: false, failure: "bad_response", status: null } as const;

type Json = Record<string, unknown>;

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function loginOf(user: unknown, pattern = AUTHOR_LOGIN_PATTERN): string | undefined {
  // 消えたアカウントは null で返ることがある
  if (user === null) return "ghost";
  if (!isObject(user) || typeof user.login !== "string" || !pattern.test(user.login)) return undefined;
  return user.login;
}

function textOrEmpty(value: unknown): string | undefined {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : undefined;
}

/** `/user` の応答 */
export type GithubUser = { id: number; login: string; name: string | null };

export function parseUser(body: string): GithubUser | undefined {
  const value = parseJson(body);
  if (!isObject(value)) return undefined;
  const id = positiveInt(value.id);
  const login = typeof value.login === "string" && LOGIN_PATTERN.test(value.login) ? value.login : undefined;
  if (id === undefined || login === undefined) return undefined;
  const name = typeof value.name === "string" ? value.name : null;
  return { id, login, name };
}

/** commit の author（§4.3）。email は `<id>+<login>@users.noreply.github.com`、name は `/user` の name（無い・使えなければ login） */
export type CommitAuthor = { name: string; email: string };

/** /user から noreply の author を作る（§4.3。実メールは使わない）。name の制御文字と `<>` は除き、100 字で切る */
export function noreplyAuthor(user: GithubUser): CommitAuthor {
  if (positiveInt(user.id) === undefined || !LOGIN_PATTERN.test(user.login)) throw new Error("GitHub のユーザーの形が違います");
  const cleaned = (user.name ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 100).trim();
  return { name: cleaned === "" ? user.login : cleaned, email: `${user.id}+${user.login}@users.noreply.github.com` };
}

/** `/repos/<o>/<r>` の応答。sizeKb は GitHub の size（KB） */
export type GithubRepo = { defaultBranch: string; sizeKb: number; private: boolean; archived: boolean; canPush: boolean };

export function parseRepo(body: string): GithubRepo | undefined {
  const value = parseJson(body);
  if (!isObject(value)) return undefined;
  const { default_branch: defaultBranch, size } = value;
  if (typeof defaultBranch !== "string" || !isBranchName(defaultBranch)) return undefined;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
  if (typeof value.private !== "boolean") return undefined;
  const permissions = isObject(value.permissions) ? value.permissions : {};
  return { defaultBranch, sizeKb: size, private: value.private, archived: value.archived === true, canPush: permissions.push === true };
}

/** `/repos/<o>/<r>/issues/<n>` の応答（PR も Issue として返る。isPullRequest で分かる） */
export type GithubIssue = { number: number; title: string; body: string; author: string; state: "open" | "closed"; isPullRequest: boolean };

export function parseIssue(body: string): GithubIssue | undefined {
  const value = parseJson(body);
  if (!isObject(value)) return undefined;
  const number = positiveInt(value.number);
  const author = loginOf(value.user);
  const text = textOrEmpty(value.body);
  if (number === undefined || typeof value.title !== "string" || author === undefined || text === undefined) return undefined;
  if (value.state !== "open" && value.state !== "closed") return undefined;
  return { number, title: value.title, body: text, author, state: value.state, isPullRequest: isObject(value.pull_request) };
}

/** Issue・PR のコメント（`/issues/<n>/comments`）と PR のレビューコメント（`/pulls/<n>/comments`。path が付く） */
export type GithubComment = { id: number; author: string; body: string; createdAt: string; path?: string };

function parseComment(value: unknown): GithubComment | undefined {
  if (!isObject(value)) return undefined;
  const id = positiveInt(value.id);
  const author = loginOf(value.user);
  const text = textOrEmpty(value.body);
  if (id === undefined || author === undefined || text === undefined || typeof value.created_at !== "string") return undefined;
  return { id, author, body: text, createdAt: value.created_at, ...(typeof value.path === "string" ? { path: value.path } : {}) };
}

/** PR のレビュー（`/pulls/<n>/reviews`） */
export type GithubReview = { id: number; author: string; body: string; state: string; submittedAt: string | null };

function parseReview(value: unknown): GithubReview | undefined {
  if (!isObject(value)) return undefined;
  const id = positiveInt(value.id);
  const author = loginOf(value.user);
  const text = textOrEmpty(value.body);
  if (id === undefined || author === undefined || text === undefined || typeof value.state !== "string") return undefined;
  const submittedAt = typeof value.submitted_at === "string" ? value.submitted_at : null;
  return { id, author, body: text, state: value.state, submittedAt };
}

/** 一覧の応答（配列で、どの要素も形が合うときだけ） */
function parseList<T>(body: string, parse: (value: unknown) => T | undefined): T[] | undefined {
  const value = parseJson(body);
  if (!Array.isArray(value)) return undefined;
  const items: T[] = [];
  for (const element of value) {
    const item = parse(element);
    if (item === undefined) return undefined;
    items.push(item);
  }
  return items;
}

export function parseComments(body: string): GithubComment[] | undefined {
  return parseList(body, parseComment);
}

export function parseReviews(body: string): GithubReview[] | undefined {
  return parseList(body, parseReview);
}

/** PR（`/pulls/<n>` と `/pulls?head=…` の要素）。headRepo は head のリポジトリの `owner/repo`（fork が消えていれば null） */
export type GithubPull = {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headRef: string;
  headRepo: string | null;
  baseRef: string;
};

function parsePullValue(value: unknown): GithubPull | undefined {
  if (!isObject(value)) return undefined;
  const number = positiveInt(value.number);
  if (number === undefined || (value.state !== "open" && value.state !== "closed")) return undefined;
  const { head, base } = value;
  if (!isObject(head) || !isObject(base) || typeof head.ref !== "string" || typeof base.ref !== "string") return undefined;
  let headRepo: string | null = null;
  if (isObject(head.repo)) {
    const fullName = head.repo.full_name;
    const [owner, repo, extra] = typeof fullName === "string" ? fullName.split("/") : [];
    if (owner === undefined || repo === undefined || extra !== undefined || !isOwner(owner) || !isRepo(repo)) return undefined;
    headRepo = `${owner}/${repo}`;
  } else if (head.repo !== null) {
    return undefined;
  }
  const merged = value.merged === true || typeof value.merged_at === "string";
  return { number, state: value.state, merged, draft: value.draft === true, headRef: head.ref, headRepo, baseRef: base.ref };
}

export function parsePull(body: string): GithubPull | undefined {
  return parsePullValue(parseJson(body));
}

export function parsePulls(body: string): GithubPull[] | undefined {
  return parseList(body, parsePullValue);
}

/** 1 ページ分の一覧と、Link の rel="last" のページ番号（無ければ undefined = このページが最後） */
export type Page<T> = { items: T[]; lastPage: number | undefined };

/** PR の画面の URL（検証した部品から組み立てる。API の html_url は使わない） */
export function pullUrl(owner: string, repo: string, number: number): string {
  if (!isOwner(owner) || !isRepo(repo) || positiveInt(number) === undefined) throw new Error("PR の形が違います");
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}

/** リポジトリの画面の URL（検証した部品から組み立てる） */
export function repoUrl(owner: string, repo: string): string {
  if (!isOwner(owner) || !isRepo(repo)) throw new Error("リポジトリの名前の形が違います");
  return `https://github.com/${owner}/${repo}`;
}

/** PR の本文の上限（GitHub の上限 65,536 字） */
export const PULL_BODY_MAX_CHARS = 65_536;
/** PR の題名の上限 */
export const PULL_TITLE_MAX_CHARS = 256;

/** 1 ページの件数（GitHub の上限） */
const MAX_PER_PAGE = 100;

export type JobGithubApiOptions = {
  /** 起動時に解決した gh の絶対パス */
  ghPath: string;
  run?: RunCommand;
  /** 子の env の元（既定 process.env）。ghChildEnv で許可したものだけを渡す */
  sourceEnv?: NodeJS.ProcessEnv;
};

/** 作業ジョブの gh api。許可外のメソッド・パス・名前の形は実行せずに投げる。応答は reject せず JobApiResult で返す */
export class JobGithubApi {
  private readonly ghPath: string;
  private readonly run: RunCommand;
  private readonly env: Record<string, string>;

  constructor(options: JobGithubApiOptions) {
    if (!options.ghPath.startsWith("/")) throw new Error("gh のパスは絶対パスにしてください");
    this.ghPath = options.ghPath;
    this.run = options.run ?? execFileRun;
    this.env = ghChildEnv(options.sourceEnv);
  }

  private async request(request: JobGhRequest, body?: Json): Promise<GhResponse> {
    return (await this.requestWithErrorBody(request, body)).response;
  }

  /** 実行して応答を判定する。http_error のときは本文（エラーの JSON）も返す */
  private async requestWithErrorBody(request: JobGhRequest, body?: Json): Promise<{ response: GhResponse; errorBody: string }> {
    const args = jobGhApiArgs(request);
    const result = await this.run(this.ghPath, args, {
      env: { ...this.env },
      timeoutMs: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
      ...(body === undefined ? {} : { input: JSON.stringify(body) }),
    });
    const response = interpretGhResult(result);
    const errorBody = response.kind === "http_error" && result.kind === "exited" ? (parseIncludeOutput(result.stdout)?.body ?? "") : "";
    return { response, errorBody };
  }

  private async getParsed<T>(path: string, parse: (body: string) => T | undefined): Promise<JobApiResult<T>> {
    const response = await this.request({ method: "GET", path });
    if (response.kind !== "ok") return failureOf(response);
    const value = parse(response.body);
    return value === undefined ? BAD_RESPONSE : { ok: true, value };
  }

  private async getPage<T>(path: string, parse: (body: string) => T[] | undefined): Promise<JobApiResult<Page<T>>> {
    const response = await this.request({ method: "GET", path });
    if (response.kind !== "ok") return failureOf(response);
    const items = parse(response.body);
    return items === undefined ? BAD_RESPONSE : { ok: true, value: { items, lastPage: lastPageFromLink(response.headers.link) } };
  }

  /** `GET /user`（noreply の author を作る） */
  async getUser(): Promise<JobApiResult<GithubUser>> {
    return this.getParsed("/user", parseUser);
  }

  /** `GET /repos/<o>/<r>`（既定のブランチ・大きさ・push できるか） */
  async getRepo(owner: string, repo: string): Promise<JobApiResult<GithubRepo>> {
    return this.getParsed(repoPath(owner, repo), parseRepo);
  }

  /** `GET /repos/<o>/<r>/issues/<n>`（Issue の本文。§7.5 の参考資料） */
  async getIssue(owner: string, repo: string, number: number): Promise<JobApiResult<GithubIssue>> {
    return this.getParsed(`${repoPath(owner, repo)}/issues/${checkNumber(number)}`, parseIssue);
  }

  /** `GET /repos/<o>/<r>/issues/<n>/comments?per_page&page`（Issue・PR のコメント） */
  async listIssueComments(owner: string, repo: string, number: number, page = 1, perPage = MAX_PER_PAGE): Promise<JobApiResult<Page<GithubComment>>> {
    return this.getPage(`${repoPath(owner, repo)}/issues/${checkNumber(number)}/comments?${pageQuery(page, perPage)}`, parseComments);
  }

  /** `GET /repos/<o>/<r>/pulls/<n>`（PR の状態・head・base） */
  async getPull(owner: string, repo: string, number: number): Promise<JobApiResult<GithubPull>> {
    return this.getParsed(`${repoPath(owner, repo)}/pulls/${checkNumber(number)}`, parsePull);
  }

  /** `GET /repos/<o>/<r>/pulls/<n>/reviews?per_page&page`（PR のレビュー） */
  async listPullReviews(owner: string, repo: string, number: number, page = 1, perPage = MAX_PER_PAGE): Promise<JobApiResult<Page<GithubReview>>> {
    return this.getPage(`${repoPath(owner, repo)}/pulls/${checkNumber(number)}/reviews?${pageQuery(page, perPage)}`, parseReviews);
  }

  /** `GET /repos/<o>/<r>/pulls/<n>/comments?per_page&page`（PR のレビューコメント） */
  async listPullReviewComments(
    owner: string,
    repo: string,
    number: number,
    page = 1,
    perPage = MAX_PER_PAGE,
  ): Promise<JobApiResult<Page<GithubComment>>> {
    return this.getPage(`${repoPath(owner, repo)}/pulls/${checkNumber(number)}/comments?${pageQuery(page, perPage)}`, parseComments);
  }

  /** `GET /repos/<o>/<r>/pulls?head=<o>:<ジョブのブランチ>&state=all`（同じリポジトリのジョブのブランチの PR） */
  async findPullsByHead(owner: string, repo: string, branch: string): Promise<JobApiResult<GithubPull[]>> {
    if (!isJobBranch(branch)) throw new Error("ジョブのブランチの形が違います");
    return this.getParsed(`${repoPath(owner, repo)}/pulls?head=${owner}:${branch}&state=all&per_page=${MAX_PER_PAGE}`, parsePulls);
  }

  /**
   * draft PR を作る（§6.3。`POST /repos/<o>/<r>/pulls`。head は同じリポジトリのジョブのブランチ、maintainer_can_modify は false）。
   * 既にある（422）なら findPullsByHead で引いて、head が同じリポジトリのそのブランチで open のものを existing: true で返す
   * （closed・merged しか無ければ http_error）。
   * 未確認 U5（coding-jobs.md §1.5）: `gh api --method POST --input -`（標準入力の JSON）で作れること・既にあるときの 422 の形は実機で確かめていない
   */
  async createDraftPull(input: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<JobApiResult<{ number: number; url: string; existing: boolean }>> {
    const path = `${repoPath(input.owner, input.repo)}/pulls`;
    if (!isJobBranch(input.head)) throw new Error("ジョブのブランチの形が違います");
    if (!isBranchName(input.base)) throw new Error("base のブランチの形が違います");
    if (input.title.length === 0 || input.title.length > PULL_TITLE_MAX_CHARS) throw new Error("PR の題名の長さが違います");
    if (input.body.length > PULL_BODY_MAX_CHARS) throw new Error("PR の本文が長すぎます");
    const response = await this.request(
      { method: "POST", path },
      { title: input.title, head: input.head, base: input.base, body: input.body, draft: true, maintainer_can_modify: false },
    );
    if (response.kind === "ok") {
      const value = parseJson(response.body);
      const number = isObject(value) ? positiveInt(value.number) : undefined;
      if (number === undefined) return BAD_RESPONSE;
      return { ok: true, value: { number, url: pullUrl(input.owner, input.repo, number), existing: false } };
    }
    if (response.kind !== "http_error" || response.status !== 422) return failureOf(response);
    const found = await this.findPullsByHead(input.owner, input.repo, input.head);
    if (!found.ok) return found;
    const fullName = `${input.owner}/${input.repo}`.toLowerCase();
    // 閉じた・マージ済みの PR は使わない（作り直せないので失敗にする）
    const pull = found.value.find((item) => item.state === "open" && item.headRef === input.head && item.headRepo?.toLowerCase() === fullName);
    if (pull === undefined) return { ok: false, failure: "http_error", status: 422 };
    return { ok: true, value: { number: pull.number, url: pullUrl(input.owner, input.repo, pull.number), existing: true } };
  }

  /**
   * ログインしているユーザーのリポジトリを作る（§6.4。`POST /user/repos`。auto_init で既定のブランチに最初のコミットを作る。
   * 既定は非公開）。同じ名前が既にあれば exists。返す owner はログイン（応答の owner.login）。
   * 未確認 U5（coding-jobs.md §1.5）: `gh api --method POST --input -` で作れること・既にあるときの 422 の形は実機で確かめていない
   */
  async createRepo(input: {
    name: string;
    private?: boolean;
  }): Promise<JobApiResult<{ owner: string; repo: string; defaultBranch: string; url: string }>> {
    if (!isRepo(input.name)) throw new Error("リポジトリの名前の形が違います");
    const { response, errorBody } = await this.requestWithErrorBody(
      { method: "POST", path: "/user/repos" },
      { name: input.name, private: input.private ?? true, auto_init: true },
    );
    if (response.kind === "ok") {
      const value = parseJson(response.body);
      if (!isObject(value) || value.name !== input.name) return BAD_RESPONSE;
      const owner = loginOf(value.owner, LOGIN_PATTERN);
      const defaultBranch = value.default_branch;
      if (owner === undefined || owner === "ghost" || typeof defaultBranch !== "string" || !isBranchName(defaultBranch)) return BAD_RESPONSE;
      return { ok: true, value: { owner, repo: input.name, defaultBranch, url: repoUrl(owner, input.name) } };
    }
    if (response.kind === "http_error" && response.status === 422) {
      return { ok: false, failure: alreadyExists(errorBody) ? "exists" : "http_error", status: 422 };
    }
    return failureOf(response);
  }
}

/** 422 の本文が「既にある」か（errors[].message に already exists） */
export function alreadyExists(errorBody: string): boolean {
  const value = parseJson(errorBody);
  if (!isObject(value) || !Array.isArray(value.errors)) return false;
  return value.errors.some((error) => isObject(error) && typeof error.message === "string" && /already exists/i.test(error.message));
}

function repoPath(owner: string, repo: string): string {
  if (!isOwner(owner) || !isRepo(repo)) throw new Error("リポジトリの名前の形が違います");
  return `/repos/${owner}/${repo}`;
}

function checkNumber(number: number): number {
  if (positiveInt(number) === undefined || number > 9_999_999_999) throw new Error("番号の形が違います");
  return number;
}

function pageQuery(page: number, perPage: number): string {
  if (positiveInt(page) === undefined || positiveInt(perPage) === undefined || perPage > MAX_PER_PAGE) throw new Error("ページの形が違います");
  return `per_page=${perPage}&page=${page}`;
}
