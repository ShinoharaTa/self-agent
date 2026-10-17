// gh の実行（docs/plan/github-notifications.md §2・§7.1・§9）。gh api を GET と許可したパスだけで呼び、--include の出力を
// ステータス・ヘッダ・本文に分ける。シェルを通さない（execFile に固定の形の引数）。認証は gh の今のログイン（gh が自分の設定を読む）

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** 1 回の gh の時間の上限と出力の上限（§7.1） */
export const GH_TIMEOUT_MS = 20_000;
export const GH_MAX_BUFFER = 5 * 1024 * 1024;

/** 子の PATH（§7.1。gh 自身は起動時に解決した絶対パスで呼ぶ） */
export const GH_CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

/** gh の終了コード 4 = 認証が要る（ログインしていない） */
const GH_EXIT_AUTH = 4;

export type RunOptions = {
  env: Record<string, string>;
  timeoutMs: number;
  maxBuffer: number;
  /** あれば標準入力に書いて閉じる（作業ジョブの gh api の POST の本文。src/jobs/github-api.ts）。GET では渡さない（無ければ空で閉じる） */
  input?: string;
};

/** exited は終了した（code は終了コード。シグナルで終わったら null）。timeout は時間切れで止めた、too_large は出力が上限を超えて止めた、error は起動できなかった */
export type RunResult =
  | { kind: "exited"; code: number | null; stdout: string; stderr: string }
  | { kind: "timeout" }
  | { kind: "too_large" }
  | { kind: "error" };

/** 子プロセスの実行。テストでは偽物を注入する */
export type RunCommand = (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

/**
 * node:child_process の spawn で実行する（シェルを通さない。execFile と同じ結果の形）。reject しない。子は新しいプロセスグループで
 * 動かし（detached。execFile はこの指定を子に渡さないので spawn を使う）、時間切れ・出力の上限（標準出力・標準エラーのそれぞれ）では
 * グループごと SIGKILL で止める（git が起こす upload-pack・credential helper などの孫を残さない）
 */
export const execFileRun: RunCommand = (file, args, { env, timeoutMs, maxBuffer, input }) =>
  new Promise((resolvePromise) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise(result);
    };
    let child: ChildProcess;
    try {
      child = spawn(file, [...args], { env, detached: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch {
      finish({ kind: "error" });
      return;
    }
    let stopped: "timeout" | "too_large" | undefined;
    const stop = (reason: "timeout" | "too_large"): void => {
      stopped ??= reason;
      killGroup(child.pid);
    };
    const collect = (stream: NodeJS.ReadableStream | null): Buffer[] => {
      const chunks: Buffer[] = [];
      let length = 0;
      stream?.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxBuffer) stop("too_large");
        else chunks.push(chunk);
      });
      return chunks;
    };
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    // ENOENT などの起動の失敗
    child.once("error", () => finish({ kind: "error" }));
    child.once("close", (code) => {
      // 出力が上限を超えて止めたときは先に見る
      if (stopped === "too_large") return finish({ kind: "too_large" });
      if (stopped === "timeout") return finish({ kind: "timeout" });
      // code が null ならシグナルで終わった
      finish({
        kind: "exited",
        code: typeof code === "number" ? code : null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    // 子が先に終わったときの EPIPE で落ちないように
    child.stdin?.on("error", () => {});
    // input が無ければ空のまま閉じる（子が標準入力を待って止まらない）
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });

/** プロセスグループごと SIGKILL で止める（もう居なければ何もしない） */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // もう居ない
  }
}

/**
 * gh の子の env（許可方式）。HOME（gh が ~/.config/gh を読む）だけを写し、PATH・言語・gh の対話と更新の確認を止める変数を固定で足す。
 * Discord のトークン・CLAUDE_CODE_OAUTH_TOKEN・GH_TOKEN などはどれも写さない
 */
export function ghChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  if (source.HOME !== undefined) env.HOME = source.HOME;
  env.PATH = GH_CHILD_PATH;
  env.LANG = "C.UTF-8";
  env.GH_PROMPT_DISABLED = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  env.NO_COLOR = "1";
  return env;
}

const OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/;
const BOOLEAN_PATTERN = /^(true|false)$/;

/** パスの形ごとに使ってよいクエリの名前と値の形 */
const NOTIFICATIONS_QUERY: Readonly<Record<string, RegExp>> = {
  all: BOOLEAN_PATTERN,
  participating: BOOLEAN_PATTERN,
  per_page: NUMBER_PATTERN,
  page: NUMBER_PATTERN,
};
const TIMELINE_QUERY: Readonly<Record<string, RegExp>> = { per_page: NUMBER_PATTERN, page: NUMBER_PATTERN };
const NO_QUERY: Readonly<Record<string, RegExp>> = {};

export function isOwner(value: string): boolean {
  return OWNER_PATTERN.test(value);
}

/** `.`・`..` はパスの要素として解釈されうるので許さない */
export function isRepo(value: string): boolean {
  return REPO_PATTERN.test(value) && value !== "." && value !== "..";
}

function queryAllowed(query: string | undefined, allowed: Readonly<Record<string, RegExp>>): boolean {
  if (query === undefined) return true;
  if (query === "") return false;
  const seen = new Set<string>();
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return false;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    const pattern = Object.hasOwn(allowed, name) ? allowed[name] : undefined;
    if (pattern === undefined || seen.has(name) || !pattern.test(value)) return false;
    seen.add(name);
  }
  return true;
}

/**
 * 許可した API のパスか（§7.1）: `/notifications?…`・`/repos/<o>/<r>/issues/<n>`・`/repos/<o>/<r>/issues/<n>/timeline?…`・`/user`。
 * クエリは決まった名前と値の形だけ（同じ名前は 1 回）
 */
export function isAllowedGhPath(path: string): boolean {
  const question = path.indexOf("?");
  const base = question === -1 ? path : path.slice(0, question);
  const query = question === -1 ? undefined : path.slice(question + 1);
  if (base === "/user") return queryAllowed(query, NO_QUERY);
  if (base === "/notifications") return queryAllowed(query, NOTIFICATIONS_QUERY);
  const parts = base.split("/");
  // ["", "repos", o, r, "issues", n] か […, "timeline"]
  if (parts.length < 6 || parts.length > 7 || parts[0] !== "" || parts[1] !== "repos" || parts[4] !== "issues") return false;
  if (!isOwner(parts[2]!) || !isRepo(parts[3]!) || !NUMBER_PATTERN.test(parts[5]!)) return false;
  if (parts.length === 6) return queryAllowed(query, NO_QUERY);
  return parts[6] === "timeline" && queryAllowed(query, TIMELINE_QUERY);
}

/** If-Modified-Since・Last-Modified に使ってよい値（HTTP の日付の形の文字だけ。改行などは入れない） */
const HTTP_DATE_PATTERN = /^[A-Za-z0-9 ,:-]{1,64}$/;

export function isHttpDate(value: string): boolean {
  return HTTP_DATE_PATTERN.test(value);
}

export type GhRequest = {
  /** GET だけ（それ以外は投げる） */
  method: "GET";
  /** isAllowedGhPath を満たすパス（満たさなければ投げる） */
  path: string;
  /** 保存した Last-Modified。付ければ条件付き要求になる */
  ifModifiedSince?: string;
};

/** ヘッダ（名前は小文字。同じ名前が複数あれば ", " でつなぐ） */
export type GhHeaders = Readonly<Record<string, string>>;

/**
 * 応答の判定（§2・§11）。ok は 2xx、not_modified は 304（gh は終了コード 1 を返すのでステータス行で判定）、
 * auth は 401 か gh の終了コード 4、rate_limited は 403・429 で X-RateLimit-Remaining が 0 か Retry-After がある、
 * http_error はそれ以外のステータス、failed は時間切れ・出力が上限を超えた・起動の失敗・ステータス行の無い出力
 */
export type GhResponse =
  | { kind: "ok"; status: number; headers: GhHeaders; body: string }
  | { kind: "not_modified"; status: 304; headers: GhHeaders }
  | { kind: "auth"; status: number | null }
  | { kind: "rate_limited"; status: number; headers: GhHeaders }
  | { kind: "http_error"; status: number; headers: GhHeaders }
  | { kind: "failed"; reason: "timeout" | "output_too_large" | "spawn" | "no_status" | "exit" };

/** gh api の引数（固定の形）。パスは最後で、`/` で始まるので引数のオプションとは解釈されない */
export function ghApiArgs(request: GhRequest): string[] {
  if (request.method !== "GET") throw new Error("gh api は GET だけを使えます");
  if (!isAllowedGhPath(request.path)) throw new Error("許可していない GitHub API のパスです");
  const args = [
    "api",
    "--method",
    "GET",
    "--include",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
  ];
  if (request.ifModifiedSince !== undefined) {
    if (!isHttpDate(request.ifModifiedSince)) throw new Error("If-Modified-Since の値の形が違います");
    args.push("-H", `If-Modified-Since: ${request.ifModifiedSince}`);
  }
  args.push(request.path);
  return args;
}

const STATUS_LINE_PATTERN = /^HTTP\/[0-9.]+ ([0-9]{3})(?: .*)?$/;

/** --include の出力をステータス・ヘッダ・本文に分ける。ステータス行が無ければ undefined */
export function parseIncludeOutput(stdout: string): { status: number; headers: GhHeaders; body: string } | undefined {
  let rest = stdout;
  const readLine = (): string | undefined => {
    if (rest === "") return undefined;
    const newline = rest.indexOf("\n");
    const line = newline === -1 ? rest : rest.slice(0, newline);
    rest = newline === -1 ? "" : rest.slice(newline + 1);
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  };
  const statusLine = readLine();
  const match = statusLine === undefined ? null : STATUS_LINE_PATTERN.exec(statusLine);
  if (match === null) return undefined;
  const headers: Record<string, string> = {};
  for (;;) {
    const line = readLine();
    if (line === undefined || line === "") break;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = Object.hasOwn(headers, name) ? `${headers[name]}, ${value}` : value;
  }
  return { status: Number(match[1]), headers, body: rest };
}

/** 実行の結果から応答を判定する（§11 の失敗の分け方） */
export function interpretGhResult(result: RunResult): GhResponse {
  if (result.kind === "timeout") return { kind: "failed", reason: "timeout" };
  if (result.kind === "too_large") return { kind: "failed", reason: "output_too_large" };
  if (result.kind === "error") return { kind: "failed", reason: "spawn" };
  if (result.code === GH_EXIT_AUTH) return { kind: "auth", status: null };
  const parsed = parseIncludeOutput(result.stdout);
  if (parsed === undefined) return { kind: "failed", reason: "no_status" };
  const { status, headers, body } = parsed;
  if (status === 304) return { kind: "not_modified", status: 304, headers };
  if (status >= 200 && status < 300) {
    return result.code === 0 ? { kind: "ok", status, headers, body } : { kind: "failed", reason: "exit" };
  }
  if (status === 401) return { kind: "auth", status };
  if ((status === 403 || status === 429) && (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined)) {
    return { kind: "rate_limited", status, headers };
  }
  return { kind: "http_error", status, headers };
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]{1,10}$/.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

/** X-Poll-Interval（秒）。無い・形が違えば undefined */
export function pollIntervalFromHeaders(headers: GhHeaders): number | undefined {
  return positiveInt(headers["x-poll-interval"]);
}

/** 次のポーリングまでの秒数: 設定と直近の X-Poll-Interval の大きい方（§2.1） */
export function effectivePollIntervalSec(configuredSec: number, serverSec: number | null | undefined): number {
  return serverSec === null || serverSec === undefined ? configuredSec : Math.max(configuredSec, serverSec);
}

/** Last-Modified（次の If-Modified-Since に使える形のときだけ） */
export function lastModifiedFromHeaders(headers: GhHeaders): string | undefined {
  const value = headers["last-modified"];
  return value !== undefined && isHttpDate(value) ? value : undefined;
}

/** レート制限の残りとリセットの時刻（X-RateLimit-Remaining・X-RateLimit-Reset（UNIX 秒））。無いものは undefined */
export function rateLimitFromHeaders(headers: GhHeaders): { remaining?: number; resetAt?: Date } {
  const remainingText = headers["x-ratelimit-remaining"];
  const remaining = remainingText !== undefined && /^[0-9]{1,10}$/.test(remainingText) ? Number(remainingText) : undefined;
  const reset = positiveInt(headers["x-ratelimit-reset"]);
  return {
    ...(remaining === undefined ? {} : { remaining }),
    ...(reset === undefined ? {} : { resetAt: new Date(reset * 1000) }),
  };
}

/** Retry-After（秒の形だけ）。無い・形が違えば undefined */
export function retryAfterSecFromHeaders(headers: GhHeaders): number | undefined {
  return positiveInt(headers["retry-after"]);
}

/**
 * Link の rel="last" のページ番号（§3.2 のタイムラインの最後のページ）。無ければ undefined。
 * Link の URL はそのまま使わない（パスの形が許可したものと違いうる）。番号だけを取り、パスはこちらで組み立て直す
 */
export function lastPageFromLink(link: string | undefined): number | undefined {
  if (link === undefined) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]*)>\s*;\s*rel="last"/.exec(part);
    if (match === null) continue;
    const query = match[1]!.split("?")[1] ?? "";
    for (const pair of query.split("&")) {
      const [name, value] = pair.split("=");
      if (name === "page") return positiveInt(value);
    }
  }
  return undefined;
}

/** 通知の一覧のパス（未読だけ・自分が関わらないものも・1 ページ 50 件） */
export function notificationsPath(page: number): string {
  return `/notifications?all=false&participating=false&per_page=50&page=${page}`;
}

/** Issue・PR の本体のパス（作成者と作成時刻を取る） */
export function issuePath(owner: string, repo: string, number: number): string {
  return `/repos/${owner}/${repo}/issues/${number}`;
}

/** Issue・PR のタイムラインのパス（1 ページ 100 件） */
export function timelinePath(owner: string, repo: string, number: number, page = 1): string {
  return `/repos/${owner}/${repo}/issues/${number}/timeline?per_page=100&page=${page}`;
}

/** PATH から gh の絶対パスを解決する（§10。起動時に 1 回）。PATH の絶対パスの要素だけを見て、実行できるファイルが無ければ undefined */
export function resolveGhPath(pathEnv: string | undefined = process.env.PATH): string | undefined {
  for (const dir of (pathEnv ?? "").split(":")) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, "gh");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 無い・実行できない
    }
  }
  return undefined;
}

export type GhClientOptions = {
  /** 起動時に解決した gh の絶対パス */
  ghPath: string;
  run?: RunCommand;
  /** 子の env の元（既定 process.env）。ghChildEnv で許可したものだけを渡す */
  sourceEnv?: NodeJS.ProcessEnv;
};

/** gh api の GET を実行する。パス・メソッドが許可外なら実行せずに投げる。応答は reject せず GhResponse で返す */
export class GhClient {
  private readonly ghPath: string;
  private readonly run: RunCommand;
  private readonly env: Record<string, string>;

  constructor(options: GhClientOptions) {
    if (!isAbsolute(options.ghPath)) throw new Error("gh のパスは絶対パスにしてください");
    this.ghPath = options.ghPath;
    this.run = options.run ?? execFileRun;
    this.env = ghChildEnv(options.sourceEnv);
  }

  async get(request: GhRequest): Promise<GhResponse> {
    const args = ghApiArgs(request);
    const result = await this.run(this.ghPath, args, { env: { ...this.env }, timeoutMs: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER });
    return interpretGhResult(result);
  }
}
