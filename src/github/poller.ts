// GitHub の通知のポーリング（docs/plan/github-notifications.md §2・§4・§11）。SELF_AGENT_GITHUB=1 のときだけ main が作る。
// 自前のタイマーで起動直後に 1 回、以後は max(設定, 直近の X-Poll-Interval) ごとに gh api で未読の通知を取り、振り分けて（classify.ts）
// 赤・黄を /setup 済みのサーバーの #github に投稿する（赤はオーナーだけをメンション）。最初の回は今ある未読を記録するだけで、開始の知らせを 1 通出す。
// 取得の失敗は #system に変わったときだけ知らせる。log にはリポジトリ名・題名・URL・ログインを出さない（件数と失敗の種類だけ）
import { withTimeout } from "../app/shell-state.ts";
import type { SystemNotifier } from "../app/system-notice.ts";
import type { Config } from "../config.ts";
import { escapeDiscordText } from "../discord/escape.ts";
import type { Gateway, OutgoingMessage } from "../discord/gateway.ts";
import type { GithubNotificationRow, GithubPollState, GithubStore, ThreadUpdate } from "../store/github.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import type { NoticeLevel } from "../store/notices.ts";
import {
  type Classification,
  classifyNotification,
  collectTimeline,
  type GithubIssueInfo,
  type GithubNotification,
  parseIssue,
  parseNotification,
  parseSubjectUrl,
  subjectHtmlUrl,
  timelineSince,
  wantsIssueInfo,
} from "./classify.ts";
import {
  effectivePollIntervalSec,
  type GhClient,
  type GhHeaders,
  type GhResponse,
  issuePath,
  lastModifiedFromHeaders,
  lastPageFromLink,
  notificationsPath,
  pollIntervalFromHeaders,
  rateLimitFromHeaders,
  retryAfterSecFromHeaders,
  timelinePath,
} from "./gh.ts";

/** 1 回のポーリングで取るページ数の上限（1 ページ 50 件。§2.1） */
export const GITHUB_MAX_PAGES = 4;
const GITHUB_PAGE_SIZE = 50;
/** 1 回のポーリングで投稿する件数の上限。超えた分は「ほか n 件」の 1 通にまとめる（§2.2） */
export const GITHUB_MAX_POSTS = 10;
/** 1 回のポーリングでタイムライン・本体を調べるスレッドの上限（§2.3） */
export const GITHUB_MAX_LOOKUP_THREADS = 20;
/** X-RateLimit-Remaining がこれ未満なら、タイムライン・本体を取らずに振り分ける（§2.3） */
export const GITHUB_LOW_RATE_REMAINING = 1000;
/** 認証の失敗の間はこの間隔に落とす（§11） */
export const GITHUB_AUTH_RETRY_MS = 15 * 60 * 1000;
/** 通信の失敗がこの回数続いたら #system に知らせる（§11。約 30 分） */
export const GITHUB_NETWORK_NOTICE_AFTER = 6;
/** レート制限で止める時間がこれを超えるときだけ #system に知らせる（§11） */
export const GITHUB_RATE_NOTICE_MS = 30 * 60 * 1000;
/** これより古い出来事・スレッドの行は tick で消す（§2.2） */
export const GITHUB_PRUNE_MS = 30 * 24 * 60 * 60 * 1000;
/** 次の回までの待ちの上限（X-Poll-Interval・Reset・Retry-After がどれだけ長くても、1 日に 1 回は取りに行く） */
export const GITHUB_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
/** 1 回の投稿を待つ上限（止まった投稿でポーリングを止めない） */
export const GITHUB_POST_TIMEOUT_MS = 10_000;
/** 1 回の未投稿の読み出しの上限 */
const UNPOSTED_LIMIT = 500;
/** 投稿の題名の上限（字） */
const TITLE_MAX_LENGTH = 100;

export const GITHUB_NOTIFICATIONS_URL = "https://github.com/notifications";
/** 投稿に添える「誰の操作か確かめられなかった」（§3.3） */
export const ACTOR_UNKNOWN_NOTE = "（誰の操作か確かめられませんでした）";
export const GITHUB_RECOVERED_NOTICE = "GitHub の通知の取得が戻りました";
export const GITHUB_AUTH_NOTICE = "GitHub の通知を取得できません（gh の認証）";
export const GITHUB_NETWORK_NOTICE = "GitHub の通知を取得できません（通信の失敗が続いています）";
export const GITHUB_NO_GH_NOTICE = "GitHub の通知を取得できません（gh が見つかりません）";
export const GITHUB_FORBIDDEN_NOTICE = "GitHub の通知を取得できません（GitHub が拒否しました（403））";
/** #github が 1 つも無いときの log（変わったときだけ） */
export const NO_GITHUB_CHANNEL_LOG = "#github がまだ無いため投稿していません（/setup を実行してください）";

/** 最初の回の開始の知らせ（#github） */
export function githubStartNotice(count: number): string {
  return `GitHub の通知の取得を始めました（今ある未読 ${count} 件は過去の分として流しません）`;
}

/** 上限を超えた分をまとめた 1 通。red はそのうちの赤の数（1 件以上ならオーナーをメンションする） */
export function githubFoldedNotice(count: number, red = 0): string {
  return `ほか ${count} 件${red > 0 ? `（うち自分宛て ${red} 件）` : ""}（<${GITHUB_NOTIFICATIONS_URL}>）`;
}

/** レート制限で止めた知らせ（#system） */
export function githubRateLimitNotice(minutes: number): string {
  return `GitHub の通知の取得を止めています（レート制限。約 ${minutes} 分）`;
}

/** 取得の失敗の種類（§11）。forbidden はレート制限でない 403、shape は応答の形が違う（その回を捨てるだけで知らせない） */
export type GithubFailure =
  | { kind: "auth" }
  | { kind: "rate_limited"; until: Date }
  | { kind: "forbidden" }
  | { kind: "network" }
  | { kind: "shape" };

/** DB に残った失敗の種類（error_kind）のうち、#system に知らせる種類 */
const NOTICE_KINDS: ReadonlySet<string> = new Set(["auth", "rate_limited", "forbidden", "network"]);

export type GhGet = Pick<GhClient, "get">;

/** 応答の失敗を §11 の種類に分ける。rate_limited の再開は Retry-After、無ければ X-RateLimit-Reset、どちらも無ければ fallbackMs 後 */
export function failureOf(response: Exclude<GhResponse, { kind: "ok" | "not_modified" }>, now: Date, fallbackMs: number): GithubFailure {
  switch (response.kind) {
    case "auth":
      return { kind: "auth" };
    case "rate_limited": {
      const retryAfter = retryAfterSecFromHeaders(response.headers);
      const { resetAt } = rateLimitFromHeaders(response.headers);
      const until =
        retryAfter !== undefined ? new Date(now.getTime() + retryAfter * 1000) : (resetAt ?? new Date(now.getTime() + fallbackMs));
      return { kind: "rate_limited", until };
    }
    case "http_error":
      return response.status === 403 ? { kind: "forbidden" } : { kind: "network" };
    case "failed":
      return response.reason === "output_too_large" ? { kind: "shape" } : { kind: "network" };
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

/** gh のログイン（GET /user の login）。取れなければ失敗の種類 */
export async function fetchLogin(gh: GhGet, now: Date, fallbackMs: number): Promise<{ login: string } | { failure: GithubFailure }> {
  const response = await gh.get({ method: "GET", path: "/user" });
  if (response.kind === "not_modified") return { failure: { kind: "shape" } };
  if (response.kind !== "ok") return { failure: failureOf(response, now, fallbackMs) };
  const body = parseJson(response.body);
  const login = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).login : undefined;
  if (typeof login !== "string" || !LOGIN_PATTERN.test(login)) return { failure: { kind: "shape" } };
  return { login };
}

/** 通知の一覧の取得の結果。headers は最初のページのもの、remaining は最後に受けた応答のもの */
export type FetchNotificationsResult =
  | { kind: "not_modified"; headers: GhHeaders }
  | { kind: "ok"; items: unknown[]; headers: GhHeaders; remaining: number | undefined }
  | { kind: "failed"; failure: GithubFailure };

/**
 * 未読の通知を最大 GITHUB_MAX_PAGES ページ取る（§2.1）。ifModifiedSince は最初のページにだけ付ける。
 * 途中のページで失敗したらその回は失敗（取れたページも使わない。Last-Modified を保存しないので次の回に取り直す）
 */
export async function fetchNotifications(
  gh: GhGet,
  ifModifiedSince: string | undefined,
  now: Date,
  fallbackMs: number,
): Promise<FetchNotificationsResult> {
  const items: unknown[] = [];
  let firstHeaders: GhHeaders | undefined;
  let remaining: number | undefined;
  for (let page = 1; page <= GITHUB_MAX_PAGES; page++) {
    const response = await gh.get({
      method: "GET",
      path: notificationsPath(page),
      ...(page === 1 && ifModifiedSince !== undefined ? { ifModifiedSince } : {}),
    });
    if (response.kind === "not_modified") {
      // 2 ページ目以降は条件を付けないので 304 は来ないはず
      return page === 1 ? { kind: "not_modified", headers: response.headers } : { kind: "failed", failure: { kind: "shape" } };
    }
    if (response.kind !== "ok") return { kind: "failed", failure: failureOf(response, now, fallbackMs) };
    firstHeaders ??= response.headers;
    remaining = rateLimitFromHeaders(response.headers).remaining ?? remaining;
    const body = parseJson(response.body);
    if (!Array.isArray(body)) return { kind: "failed", failure: { kind: "shape" } };
    items.push(...body);
    if (body.length < GITHUB_PAGE_SIZE) break;
  }
  return { kind: "ok", items, headers: firstHeaders ?? {}, remaining };
}

/** 1 回のポーリングの中で、タイムライン・本体を取りに行ける残り（§2.3） */
export type LookupBudget = {
  /** 調べたスレッドの数 */
  threads: number;
  /** 直近の X-RateLimit-Remaining。分からなければ undefined */
  remaining: number | undefined;
  /** レート制限・認証の失敗を受けたら、この回はもう取りに行かない */
  stopped: boolean;
};

export function newLookupBudget(remaining: number | undefined): LookupBudget {
  return { threads: 0, remaining, stopped: false };
}

function canLookup(budget: LookupBudget): boolean {
  return (
    !budget.stopped &&
    budget.threads < GITHUB_MAX_LOOKUP_THREADS &&
    (budget.remaining === undefined || budget.remaining >= GITHUB_LOW_RATE_REMAINING)
  );
}

/** 調べる 1 回の GET。残りを更新し、取れれば JSON を返す。レート制限・認証の失敗ならこの回の調べを止める */
async function lookup(gh: GhGet, path: string, budget: LookupBudget): Promise<{ body: unknown; headers: GhHeaders } | undefined> {
  const response = await gh.get({ method: "GET", path });
  if ("headers" in response) {
    budget.remaining = rateLimitFromHeaders(response.headers).remaining ?? budget.remaining;
  }
  if (response.kind === "rate_limited" || response.kind === "auth") budget.stopped = true;
  if (response.kind !== "ok") return undefined;
  return { body: parseJson(response.body), headers: response.headers };
}

export type ClassifyContext = {
  gh: GhGet;
  me: string;
  owners: readonly string[];
  now: Date;
  /** タイムラインの起点を決めるときの間隔（秒） */
  pollIntervalSec: number;
  /** このスレッドで前回見た updated_at。初めてなら null */
  previousUpdatedAt: string | null;
  /** 最後に取得できた時刻（前回の回）。初めて見たスレッドの窓を、止まっていた間まで広げる。無ければ null */
  lastSuccessAt: string | null;
  firstSeen: boolean;
  budget: LookupBudget;
};

/**
 * 1 件の通知を振り分ける（§3）。まずタイムラインなしで振り分け、白なら調べない（調べても白は変わらない。分からないときは流す側に倒すため）。
 * 残りがあれば、黄の候補のときだけ本体を、続いてタイムライン（最初のページと、Link の最後のページ）を取って振り分け直す。
 * 取れなければ「分からない」のまま（§3.3）
 */
export async function classifyWithLookups(notification: GithubNotification, context: ClassifyContext): Promise<Classification> {
  const { gh, me, owners, now, firstSeen, budget } = context;
  const base = classifyNotification({ notification, me, owners, firstSeen, timeline: undefined, now });
  if (base.level === "drop" || base.subject === null || !canLookup(budget)) return base;
  budget.threads++;
  const { owner, repo, number } = base.subject;
  let issue: GithubIssueInfo | undefined;
  if (wantsIssueInfo(notification, owners, firstSeen)) {
    const result = await lookup(gh, issuePath(owner, repo, number), budget);
    issue = result === undefined ? undefined : parseIssue(result.body);
  }
  let items: unknown[] | undefined;
  if (!budget.stopped) {
    const first = await lookup(gh, timelinePath(owner, repo, number, 1), budget);
    if (first !== undefined && Array.isArray(first.body)) {
      items = first.body;
      const lastPage = lastPageFromLink(first.headers.link);
      if (lastPage !== undefined && lastPage > 1) {
        // 新しい出来事は最後のページにある。取れなければ分からないとする
        const last = budget.stopped ? undefined : await lookup(gh, timelinePath(owner, repo, number, lastPage), budget);
        items = last !== undefined && Array.isArray(last.body) ? [...items, ...last.body] : undefined;
      }
    }
  }
  const since = timelineSince({
    previousUpdatedAt: context.previousUpdatedAt,
    lastReadAt: notification.lastReadAt,
    now,
    pollIntervalSec: context.pollIntervalSec,
    lastSuccessAt: context.lastSuccessAt,
  });
  const timeline = items === undefined ? undefined : collectTimeline(items, since, issue);
  return classifyNotification({ notification, me, owners, firstSeen, timeline, ...(issue === undefined ? {} : { issue }), now });
}

const HTML_URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(pull|issues)\/([1-9][0-9]{0,9})$/;

/**
 * #github への投稿（§4.3）。1 行目は印・種別・リポジトリ・番号・人、2 行目は題名（先頭 100 字・改行を空白に・Markdown を無効化）、3 行目は <URL>（プレビューを出さない）。
 * 誰の操作か確かめられなかったものは 4 行目に注記する。赤はオーナーだけをメンションする
 */
export function formatGithubPost(row: GithubNotificationRow, ownerUserId: string | undefined): OutgoingMessage {
  const match = row.url === null ? null : HTML_URL_PATTERN.exec(row.url);
  const mark = row.level === "red" ? "🔴" : "🟡";
  const where = match === null ? "" : `  ${escapeDiscordText(`${match[1]}/${match[2]}`)}  ${match[3] === "pull" ? "PR" : "Issue"} #${match[4]}`;
  const actor = row.actorLogin === null ? "" : `  （${escapeDiscordText(row.actorLogin)}）`;
  const title = [...(row.title ?? "").replace(/\s+/g, " ").trim()].slice(0, TITLE_MAX_LENGTH).join("");
  const lines = [`${mark} ${row.label}${where}${actor}`];
  if (title !== "") lines.push(escapeDiscordText(title));
  if (match !== null) lines.push(`<${row.url}>`);
  if (!row.actorKnown) lines.push(ACTOR_UNKNOWN_NOTE);
  return {
    text: lines.join("\n"),
    ...(row.level === "red" && ownerUserId !== undefined ? { mentionUserId: ownerUserId } : {}),
  };
}

/** テストでは偽のタイマーに差し替える */
export type GithubTimers = {
  /** ms 後に fn を 1 回呼び、取り消す関数を返す */
  after(fn: () => void, ms: number): () => void;
};

const REAL_TIMERS: GithubTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export type GithubPollerDeps = {
  /** allowedGuildIds は投稿先のサーバー、ownerUserId は赤でメンションする相手 */
  cfg: Pick<Config, "allowedGuildIds" | "ownerUserId" | "githubPollSec" | "githubOwners">;
  /** gh の実行。gh が見つからなければ undefined（取得せず、#system に 1 回知らせる） */
  gh: GhGet | undefined;
  store: Pick<
    GithubStore,
    "getThread" | "recordThread" | "addNotification" | "listUnposted" | "markPosted" | "markSkipped" | "prune" | "getPollState" | "savePollState"
  >;
  /** 投稿先の #github */
  guildSettings: Pick<GuildSettingsStore, "get">;
  /** 既定の人格の Bot（#github への投稿） */
  gateway: Pick<Gateway, "sendMessage">;
  /** 失敗・戻ったの知らせ（#system。system-notice.ts） */
  notify: SystemNotifier;
  now: () => Date;
  timers?: GithubTimers;
  log: (message: string) => void;
  /** 既定は GITHUB_POST_TIMEOUT_MS */
  postTimeoutMs?: number;
};

/** まだ投稿できていない知らせ（サーバーごと。投稿できたものから除く） */
type PendingNotice = { text: string; guilds: Set<string> };

/** #system への知らせ（失敗・戻った）。level は notices の記録の重さ */
type PendingSystemNotice = PendingNotice & { level: NoticeLevel };

/** SELF_AGENT_GITHUB=1 のときだけポーラーを作る。無効なら undefined（何も動かさない） */
export function createGithubPoller(deps: GithubPollerDeps & { cfg: Pick<Config, "github"> }): GithubPoller | undefined {
  return deps.cfg.github ? new GithubPoller(deps) : undefined;
}

export class GithubPoller {
  private readonly deps: GithubPollerDeps;
  private readonly timers: GithubTimers;
  private cancelTimer: (() => void) | undefined;
  private started = false;
  private stopped = false;
  /** 実行中の tick */
  private running: Promise<number> | undefined;
  /** gh のログイン（最初に取れたらプロセスの間は使い続ける） */
  private me: string | undefined;
  /** レート制限で止めている間はこの時刻まで取得しない */
  private pausedUntil: Date | undefined;
  /** 続いている通信の失敗の数 */
  private networkFailures = 0;
  /** 直近に log に出した失敗の種類（同じ種類が続く間は出さない） */
  private loggedFailure: GithubFailure["kind"] | undefined;
  /** #system に知らせている失敗の種類。知らせていなければ undefined */
  private announcedFailure: GithubFailure["kind"] | "no_gh" | undefined;
  /** #system への知らせ（失敗・戻った） */
  private systemNotice: PendingSystemNotice | undefined;
  /** #github への開始の知らせのうち、最初の #github に出した後でまだ出せていないサーバーの分（プロセスの中だけ） */
  private startNotice: PendingNotice | undefined;
  /** DB に残った失敗の種類から、知らせ済みの状態を戻したか（最初の tick で 1 回） */
  private restored = false;
  /** #github が 1 つも無いことを log に出したか（変わったときだけ出す） */
  private noChannelLogged = false;

  constructor(deps: GithubPollerDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 直後に 1 回 tick し、以後は tick が返す間隔ごとに tick する。gh が無ければ取得せず #system に知らせる。stop の後・2 回目は何もしない */
  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    if (this.deps.gh === undefined) {
      this.deps.log("gh が見つからないため、GitHub の通知を取得しません");
      this.announcedFailure = "no_gh";
      this.systemNotice = { text: GITHUB_NO_GH_NOTICE, level: "danger", guilds: new Set(this.deps.cfg.allowedGuildIds) };
      this.running = this.postSystemNotice().then(() => 0);
      void this.running.finally(() => {
        this.running = undefined;
      });
      return;
    }
    this.loop();
  }

  /** 以後の tick を止める。実行中の tick は、まだ始めていない処理・投稿を行わずに終わる（終わるのは idle で待つ） */
  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /** 実行中の tick（投稿を含む）が終わったら resolve する（停止時に使う） */
  async idle(): Promise<void> {
    await this.running;
  }

  /** 1 回分の処理。前の tick が終わっていなければ重ねずにそれを返す。次の tick までのミリ秒を返す。reject しない（失敗は log に出す） */
  tick(): Promise<number> {
    if (this.running !== undefined) return this.running;
    const running = this.runTick().finally(() => {
      this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private loop(): void {
    if (this.stopped) return;
    void this.tick().then((delay) => {
      if (this.stopped) return;
      this.cancelTimer = this.timers.after(() => {
        this.cancelTimer = undefined;
        this.loop();
      }, delay);
    });
  }

  /** 通常の間隔: max(設定, 直近の X-Poll-Interval)。GITHUB_MAX_WAIT_MS まで */
  private intervalMs(state: GithubPollState): number {
    return Math.min(effectivePollIntervalSec(this.deps.cfg.githubPollSec, state.pollIntervalSec) * 1000, GITHUB_MAX_WAIT_MS);
  }

  private async runTick(): Promise<number> {
    const { store, log } = this.deps;
    const gh = this.deps.gh;
    let interval = this.deps.cfg.githubPollSec * 1000;
    if (this.stopped || gh === undefined) return interval;
    try {
      const now = this.deps.now();
      store.prune(new Date(now.getTime() - GITHUB_PRUNE_MS));
      const state = store.getPollState();
      interval = this.intervalMs(state);
      this.restoreFailure(state, now, interval);
      const channels = this.githubChannels();
      const delay = await this.poll(gh, state, now, channels);
      if (this.stopped) return delay;
      await this.postStartNotice();
      await this.postPending(channels);
      await this.postSystemNotice();
      return Math.min(delay, GITHUB_MAX_WAIT_MS);
    } catch (error) {
      log(`GitHub の通知の処理に失敗しました（${error instanceof Error ? error.name : "unknown"}）`);
      return interval;
    }
  }

  /**
   * 再起動の前から続いている失敗（DB の error_kind）を知らせ済みとして戻す（同じ失敗を再起動のたびに #system に出さない）。
   * 通信の失敗は、続いている時間が知らせるまでの回数分（GITHUB_NETWORK_NOTICE_AFTER - 1 回の間隔）を超えていれば知らせ済みとみなす
   */
  private restoreFailure(state: GithubPollState, now: Date, interval: number): void {
    if (this.restored) return;
    this.restored = true;
    const kind = state.errorKind;
    if (kind === null || !NOTICE_KINDS.has(kind)) return;
    if (kind === "network") {
      const since = state.errorSince === null ? Number.NaN : Date.parse(state.errorSince);
      if (!(now.getTime() - since >= (GITHUB_NETWORK_NOTICE_AFTER - 1) * interval)) return;
      this.networkFailures = GITHUB_NETWORK_NOTICE_AFTER;
    }
    this.announcedFailure = kind as GithubFailure["kind"];
  }

  /** /setup 済みのサーバーの #github。1 つも無ければ log に出す（変わったときだけ） */
  private githubChannels(): string[] {
    const channels = this.deps.cfg.allowedGuildIds.flatMap((guildId) => {
      const channelId = this.githubChannelOf(guildId);
      return channelId === null ? [] : [channelId];
    });
    if (channels.length === 0 && !this.noChannelLogged) this.deps.log(NO_GITHUB_CHANNEL_LOG);
    this.noChannelLogged = channels.length === 0;
    return channels;
  }

  /** 取得して振り分け、記録する。次の tick までのミリ秒を返す */
  private async poll(gh: GhGet, state: GithubPollState, now: Date, channels: readonly string[]): Promise<number> {
    const interval = this.intervalMs(state);
    if (this.pausedUntil !== undefined && now.getTime() < this.pausedUntil.getTime()) {
      return Math.max(this.pausedUntil.getTime() - now.getTime(), interval);
    }
    this.pausedUntil = undefined;
    if (this.me === undefined) {
      const result = await fetchLogin(gh, now, interval);
      if ("failure" in result) return this.fail(result.failure, now, interval);
      this.me = result.login;
    }
    // 最初の回（記録が無い）は条件を付けずに全部取る
    const ifModifiedSince = state.baselineDone ? (state.lastModified ?? undefined) : undefined;
    const fetched = await fetchNotifications(gh, ifModifiedSince, now, interval);
    if (fetched.kind === "failed") return this.fail(fetched.failure, now, interval);
    if (fetched.kind === "not_modified") return this.succeed(fetched.headers, undefined, now);
    const notifications: GithubNotification[] = [];
    let invalid = 0;
    for (const item of fetched.items) {
      const notification = parseNotification(item);
      if (notification === undefined) invalid++;
      else notifications.push(notification);
    }
    if (invalid > 0) this.deps.log(`GitHub の通知のうち形の違う ${invalid} 件を飛ばしました`);
    if (!state.baselineDone) {
      // 開始の知らせをどこにも出せなければ、最初の回を終えない（次の回・次の起動でやり直す）
      if (!(await this.recordBaseline(notifications, channels))) return this.succeed(fetched.headers, undefined, now);
    } else {
      const completed = await this.classifyAll(gh, notifications, fetched.remaining, now, interval / 1000, state.lastSuccessAt);
      // 止められて途中で終えたら、Last-Modified を保存しない（次の起動で取り直す）
      if (!completed) return interval;
    }
    return this.succeed(fetched.headers, lastModifiedFromHeaders(fetched.headers), now);
  }

  /**
   * 最初の回: 今ある未読をすべて「見た」として記録し、投稿しない。開始の知らせを #github に出し、1 つでも出せたら最初の回を終えたと記録する
   * （出せなかったサーバーの分は、プロセスの中で次の回にやり直す）。#github が無い・どこにも出せなければ false（記録はそのまま残り、次の回にやり直す）
   */
  private async recordBaseline(notifications: readonly GithubNotification[], channels: readonly string[]): Promise<boolean> {
    const { store, cfg, log } = this.deps;
    for (const notification of notifications) store.recordThread(threadUpdate(notification));
    if (channels.length === 0 || this.stopped) return false;
    const notice: PendingNotice = { text: githubStartNotice(notifications.length), guilds: new Set(cfg.allowedGuildIds) };
    await this.postNotice(notice, (guildId, text) => this.postGithubNotice(guildId, text));
    if (notice.guilds.size === cfg.allowedGuildIds.length) return false;
    store.savePollState({ baselineDone: true });
    this.startNotice = notice;
    log(`GitHub の通知の取得を始めました（今ある未読 ${notifications.length} 件は流しません）`);
    return true;
  }

  /**
   * 前回より新しい出来事（GITHUB_PRUNE_MS より古いものを除く）を振り分けて記録する。タイムライン・本体を調べる枠は新しい出来事から使い
   * （溜まった古いものが「確かめられませんでした」になる）、記録は古い順に行う（投稿の順）。止められたら何も記録せずに false
   */
  private async classifyAll(
    gh: GhGet,
    notifications: readonly GithubNotification[],
    remaining: number | undefined,
    now: Date,
    pollIntervalSec: number,
    lastSuccessAt: string | null,
  ): Promise<boolean> {
    const { store, cfg, log } = this.deps;
    const me = this.me!;
    const owners = cfg.githubOwners.length > 0 ? cfg.githubOwners : [me];
    const budget = newLookupBudget(remaining);
    const counts = { red: 0, yellow: 0, drop: 0 };
    // 残す期間より古い出来事は見ない（スレッドの行は prune で消えるので、初めて見たものに見えて流してしまうため）
    const cutoff = now.getTime() - GITHUB_PRUNE_MS;
    const newestFirst = notifications
      .filter((notification) => Date.parse(notification.updatedAt) >= cutoff)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const classified: Array<{ notification: GithubNotification; classification: Classification }> = [];
    for (const notification of newestFirst) {
      if (this.stopped) return false;
      const thread = store.getThread(notification.threadId);
      // 前回見た出来事より新しくなければ、もう記録してある
      if (thread !== undefined && !(Date.parse(notification.updatedAt) > Date.parse(thread.lastUpdatedAt))) continue;
      const classification = await classifyWithLookups(notification, {
        gh,
        me,
        owners,
        now,
        pollIntervalSec,
        previousUpdatedAt: thread?.lastUpdatedAt ?? null,
        lastSuccessAt,
        firstSeen: thread === undefined,
        budget,
      });
      classified.push({ notification, classification });
    }
    if (this.stopped) return false;
    for (const { notification, classification } of classified.reverse()) {
      const added = store.addNotification({
        threadId: notification.threadId,
        updatedAt: notification.updatedAt,
        reason: notification.reason,
        level: classification.level,
        label: classification.label,
        actorLogin: classification.actorLogin,
        actorKnown: classification.actorKnown,
        title: notification.title,
        url: classification.subject === null ? null : subjectHtmlUrl(classification.subject),
        repoPrivate: notification.repoPrivate,
        // [対応] は段 2（PR-G4）から
        handoffOk: false,
      });
      store.recordThread(threadUpdate(notification));
      if (added.result === "added") counts[classification.level]++;
    }
    const total = counts.red + counts.yellow + counts.drop;
    if (total > 0) log(`GitHub の通知: 新しい ${total} 件（赤 ${counts.red}・黄 ${counts.yellow}・白 ${counts.drop}）`);
    return true;
  }

  /** 取得できた: 状態を記録し、失敗を知らせていたら戻ったことを知らせる。次の tick までのミリ秒を返す */
  private succeed(headers: GhHeaders, lastModified: string | undefined, now: Date): number {
    const { store, log } = this.deps;
    const pollIntervalSec = pollIntervalFromHeaders(headers);
    const { remaining, resetAt } = rateLimitFromHeaders(headers);
    const state = store.savePollState({
      lastSuccessAt: now.toISOString(),
      errorKind: null,
      errorSince: null,
      ...(pollIntervalSec === undefined ? {} : { pollIntervalSec }),
      ...(remaining === undefined ? {} : { rateRemaining: remaining }),
      ...(resetAt === undefined ? {} : { rateResetAt: resetAt.toISOString() }),
      ...(lastModified === undefined ? {} : { lastModified }),
    });
    this.networkFailures = 0;
    if (this.loggedFailure !== undefined) log("GitHub の通知の取得が戻りました");
    this.loggedFailure = undefined;
    if (this.announcedFailure !== undefined) {
      this.announcedFailure = undefined;
      this.systemNotice = { text: GITHUB_RECOVERED_NOTICE, level: "success", guilds: new Set(this.deps.cfg.allowedGuildIds) };
    }
    const interval = this.intervalMs(state);
    // 残りが 0 なら Reset まで取得も止める（§2.3）
    if (remaining === 0 && resetAt !== undefined && resetAt.getTime() > now.getTime()) {
      this.pausedUntil = new Date(Math.min(resetAt.getTime(), now.getTime() + GITHUB_MAX_WAIT_MS));
      return Math.max(this.pausedUntil.getTime() - now.getTime(), interval);
    }
    return interval;
  }

  /** 取得できなかった（§11）: 状態を記録し、種類ごとに間隔と #system への知らせを決める。次の tick までのミリ秒を返す */
  private fail(failure: GithubFailure, now: Date, interval: number): number {
    const { store, log } = this.deps;
    const previous = store.getPollState();
    store.savePollState({
      errorKind: failure.kind,
      errorSince: previous.errorKind === failure.kind && previous.errorSince !== null ? previous.errorSince : now.toISOString(),
    });
    if (this.loggedFailure !== failure.kind) log(`GitHub の通知を取得できませんでした（${failure.kind}）`);
    this.loggedFailure = failure.kind;
    if (failure.kind !== "network") this.networkFailures = 0;
    switch (failure.kind) {
      case "auth":
        this.announce("auth", GITHUB_AUTH_NOTICE);
        return Math.max(GITHUB_AUTH_RETRY_MS, interval);
      case "rate_limited": {
        this.pausedUntil = new Date(Math.min(failure.until.getTime(), now.getTime() + GITHUB_MAX_WAIT_MS));
        const waitMs = Math.max(this.pausedUntil.getTime() - now.getTime(), 0);
        if (waitMs > GITHUB_RATE_NOTICE_MS) this.announce("rate_limited", githubRateLimitNotice(Math.ceil(waitMs / 60_000)));
        return Math.max(waitMs, interval);
      }
      case "forbidden":
        this.announce("forbidden", GITHUB_FORBIDDEN_NOTICE);
        return interval;
      case "network":
        this.networkFailures++;
        if (this.networkFailures >= GITHUB_NETWORK_NOTICE_AFTER) this.announce("network", GITHUB_NETWORK_NOTICE);
        return interval;
      case "shape":
        return interval;
    }
  }

  /** 知らせている失敗と違うときだけ、#system への知らせを差し替える（レート制限は warning、それ以外は danger） */
  private announce(kind: GithubFailure["kind"], text: string): void {
    if (this.announcedFailure === kind) return;
    this.announcedFailure = kind;
    const level: NoticeLevel = kind === "rate_limited" ? "warning" : "danger";
    this.systemNotice = { text, level, guilds: new Set(this.deps.cfg.allowedGuildIds) };
  }

  /** まだ投稿できていない #system への知らせを出す（#system が無い・失敗したサーバーは次の tick でやり直す） */
  private async postSystemNotice(): Promise<void> {
    const notice = this.systemNotice;
    if (notice === undefined) return;
    const timeoutMs = this.deps.postTimeoutMs ?? GITHUB_POST_TIMEOUT_MS;
    await this.postNotice(notice, (guildId, text) => this.deps.notify(guildId, { text }, { level: notice.level, timeoutMs }));
  }

  /** まだ投稿できていない #github への開始の知らせを出す */
  private async postStartNotice(): Promise<void> {
    await this.postNotice(this.startNotice, (guildId, text) => this.postGithubNotice(guildId, text));
  }

  /** #github に知らせを出す。#github が無ければ undefined */
  private async postGithubNotice(guildId: string, text: string): Promise<string | undefined> {
    const channelId = this.githubChannelOf(guildId);
    return channelId === null ? undefined : this.post(channelId, { text });
  }

  /** まだ出せていないサーバーに post で出す（投稿先が無い（undefined）・失敗したサーバーは残す） */
  private async postNotice(
    notice: PendingNotice | undefined,
    post: (guildId: string, text: string) => Promise<string | undefined>,
  ): Promise<void> {
    if (notice === undefined) return;
    for (const guildId of [...notice.guilds]) {
      if (this.stopped) return;
      try {
        const messageId = await post(guildId, notice.text);
        if (messageId === undefined) continue;
        notice.guilds.delete(guildId);
      } catch (error) {
        this.deps.log(`GitHub の通知の知らせの投稿に失敗しました（guild=${guildId}）: ${describeError(error)}`);
      }
    }
  }

  private githubChannelOf(guildId: string): string | null {
    return this.deps.guildSettings.get(guildId)?.githubChannelId ?? null;
  }

  private async post(channelId: string, message: OutgoingMessage): Promise<string> {
    return withTimeout(this.deps.gateway.sendMessage(channelId, message), this.deps.postTimeoutMs ?? GITHUB_POST_TIMEOUT_MS);
  }

  /**
   * まだ投稿していない赤・黄を、/setup 済みのサーバーの #github に赤 → 黄の順（それぞれ古い順）で投稿する（§2.2・§4）。同じスレッドのものは新しい 1 件だけにする。
   * GITHUB_MAX_POSTS 件を超えた分は「ほか n 件」の 1 通にまとめる（赤を含めば、その数を書いてオーナーをメンションする）。
   * どこにも投稿できなかったものは未投稿のまま次の回に出し直す。#github が 1 つも無ければ何もしない（未投稿のまま残す）
   */
  private async postPending(channels: readonly string[]): Promise<void> {
    const { store, cfg, log } = this.deps;
    if (channels.length === 0) return;
    const latest = new Map<string, GithubNotificationRow>();
    for (const row of store.listUnposted(UNPOSTED_LIMIT)) {
      const previous = latest.get(row.threadId);
      if (previous !== undefined) store.markSkipped(previous.id);
      latest.set(row.threadId, row);
    }
    const rank = (row: GithubNotificationRow): number => (row.level === "red" ? 0 : 1);
    const rows = [...latest.values()].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
    if (rows.length === 0) return;
    const toPost = rows.slice(0, GITHUB_MAX_POSTS);
    const folded = rows.slice(GITHUB_MAX_POSTS);
    let failed = 0;
    for (const row of toPost) {
      if (this.stopped) return;
      const posted = await this.postToAll(channels, formatGithubPost(row, cfg.ownerUserId));
      if (posted === undefined) failed++;
      else store.markPosted(row.id, posted.channelId, posted.messageId);
    }
    if (folded.length > 0 && !this.stopped) {
      const red = folded.filter((row) => row.level === "red").length;
      const posted = await this.postToAll(channels, {
        text: githubFoldedNotice(folded.length, red),
        ...(red > 0 && cfg.ownerUserId !== undefined ? { mentionUserId: cfg.ownerUserId } : {}),
      });
      if (posted === undefined) failed += folded.length;
      else for (const row of folded) store.markSkipped(row.id);
    }
    if (failed > 0) log(`GitHub の通知 ${failed} 件を投稿できませんでした（次の回に出し直します）`);
  }

  /** すべての #github に投稿し、最初に投稿できたものを返す。どこにも投稿できなければ undefined */
  private async postToAll(channels: readonly string[], message: OutgoingMessage): Promise<{ channelId: string; messageId: string } | undefined> {
    let first: { channelId: string; messageId: string } | undefined;
    for (const channelId of channels) {
      try {
        const messageId = await this.post(channelId, message);
        first ??= { channelId, messageId };
      } catch {
        // 件数だけを呼び出し側で log に出す（本文・リポジトリ名は出さない）
      }
    }
    return first;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** スレッドの記録（番号は subject.url から取れたときだけ） */
function threadUpdate(notification: GithubNotification): ThreadUpdate {
  return {
    threadId: notification.threadId,
    repo: notification.repoFullName,
    subjectType: notification.subjectType,
    number: parseSubjectUrl(notification.subjectUrl)?.number ?? null,
    updatedAt: notification.updatedAt,
  };
}
