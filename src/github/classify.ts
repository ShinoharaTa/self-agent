// GitHub の通知の振り分け（docs/plan/github-notifications.md §3）。純関数。API の応答は形を確かめてから使い、
// 第三者の文字列（題名・ログイン）は Discord に出すためだけに持つ

import type { GithubLevel } from "../store/github.ts";

/** 投稿の 1 行目の種別（§4.3 の固定の語） */
export type GithubLabel =
  | "レビュー依頼"
  | "メンション"
  | "担当"
  | "レビュー"
  | "コメント"
  | "状態の変化"
  | "新しい Issue"
  | "新しい PR";

/** 白（投稿しない）の行に残す種別 */
export const DROP_LABEL = "対象外";

/** 黄（規則 7）の「作られてから」の上限 */
export const NEW_THREAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 規則 2 で捨てる reason */
const DROP_REASONS: ReadonlySet<string> = new Set([
  "ci_activity",
  "security_alert",
  "security_advisory_credit",
  "state_change",
  "member_feature_requested",
  "agent_session_finished",
]);

/** 規則 5（自分宛て）の reason と種別 */
const DIRECT_REASONS: Readonly<Record<string, GithubLabel>> = {
  review_requested: "レビュー依頼",
  approval_requested: "レビュー依頼",
  mention: "メンション",
  team_mention: "メンション",
  assign: "担当",
};

/** 規則 6 の reason（自分のスレッド・自分がコメントしたスレッド） */
const THREAD_REASONS: ReadonlySet<string> = new Set(["author", "comment"]);

/** 規則 7 の reason（watch しているリポジトリ） */
const WATCH_REASONS: ReadonlySet<string> = new Set(["subscribed", "manual"]);

/**
 * 「誰の操作か」に数えるタイムラインの出来事（§3.2）。actor がその操作をした本人であるものだけ。
 * commented・commit-commented はコメント、reviewed・line-commented はレビュー、ここに挙げた残りは状態の変化。
 * mentioned・subscribed・unsubscribed（actor は宛てられた人・購読した人）、assigned・review_requested など（宛てる操作。§3.1 の規則 4 の例外に使う）、
 * cross-referenced・referenced・connected（ほかの場所での操作）、committed（GitHub のユーザーと結びつかない）、それ以外の知らない種類は数えない
 */
const COMMENT_EVENTS: ReadonlySet<string> = new Set(["commented", "commit-commented"]);
const REVIEW_EVENTS: ReadonlySet<string> = new Set(["reviewed", "line-commented"]);
const STATE_EVENTS: ReadonlySet<string> = new Set([
  "closed",
  "reopened",
  "merged",
  "ready_for_review",
  "convert_to_draft",
  "renamed",
  "labeled",
  "unlabeled",
  "locked",
  "unlocked",
  "milestoned",
  "demilestoned",
  "review_dismissed",
  "head_ref_force_pushed",
  "head_ref_deleted",
  "head_ref_restored",
  "base_ref_changed",
  "marked_as_duplicate",
  "unmarked_as_duplicate",
  "transferred",
  "pinned",
  "unpinned",
  "converted_to_discussion",
]);

/** 通知のうち振り分けに使うもの（GET /notifications の 1 要素） */
export type GithubNotification = {
  threadId: string;
  reason: string;
  updatedAt: string;
  lastReadAt: string | null;
  title: string;
  /** API の URL（`https://api.github.com/repos/<o>/<r>/(issues|pulls)/<n>`）。無いことがある */
  subjectUrl: string | null;
  subjectType: string;
  /** owner/repo */
  repoFullName: string;
  repoOwner: string;
  repoPrivate: boolean;
};

/** subject.url から取った Issue・PR（部品はパスに使える形だけ） */
export type GithubSubject = {
  owner: string;
  repo: string;
  number: number;
  kind: "issue" | "pull";
};

export type GithubActor = { login: string; isBot: boolean };

/** タイムラインの窓（前回より後）の中の出来事（§3.2） */
export type TimelineActivity = {
  /** 数える出来事をした人（自分・Bot を含む。重ねない）。空なら誰の操作か分からない */
  actors: GithubActor[];
  /** そのうちコメントした人・レビューした人 */
  commenters: GithubActor[];
  reviewers: GithubActor[];
  /** 宛てられた人のログイン（小文字）: mentioned の actor・review_requested の requested_reviewer・assigned の assignee */
  addressed: string[];
  /** チームへのレビュー依頼がある（自分がそのチームにいるかは分からないので、宛てられたとみなす） */
  teamReviewRequested: boolean;
};

/** Issue・PR の本体のうち規則 3・7 に使うもの */
export type GithubIssueInfo = { author: GithubActor; createdAt: string };

export type ClassifyInput = {
  notification: GithubNotification;
  /** gh のログイン（大小を区別しない） */
  me: string;
  /** 「自分のリポジトリ」とみなす持ち主（大小を区別しない） */
  owners: readonly string[];
  /** このスレッドを初めて見たか（github_threads に行が無い） */
  firstSeen: boolean;
  /** collectTimeline の結果。取らなかった・取れなかった（レート制限を含む）なら undefined */
  timeline: TimelineActivity | undefined;
  /** 取らなかった・取れなかったら undefined（規則 3 はこれがあるときだけ当てる） */
  issue?: GithubIssueInfo;
  now: Date;
};

export type Classification = {
  level: GithubLevel;
  /** 当たった規則（§3.1 の #） */
  rule: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  label: GithubLabel | typeof DROP_LABEL;
  /** 投稿に添える人。分からなければ null */
  actorLogin: string | null;
  /** 誰の操作か確かめられたか（false なら投稿に「（誰の操作か確かめられませんでした）」） */
  actorKnown: boolean;
  /** Issue・PR の番号が取れたものだけ */
  subject: GithubSubject | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** GET /notifications の 1 要素を確かめて取り出す。必要な欄が無い・型が違えば undefined */
export function parseNotification(raw: unknown): GithubNotification | undefined {
  if (!isRecord(raw) || !isRecord(raw.subject) || !isRecord(raw.repository) || !isRecord(raw.repository.owner)) return undefined;
  const { id, reason, updated_at: updatedAt } = raw;
  const lastReadAt = stringOrNull(raw.last_read_at ?? null);
  const { title, url, type } = raw.subject;
  const subjectUrl = stringOrNull(url ?? null);
  const { full_name: fullName, private: isPrivate } = raw.repository;
  const ownerLogin = raw.repository.owner.login;
  if (typeof id !== "string" || typeof reason !== "string" || typeof updatedAt !== "string") return undefined;
  if (lastReadAt === undefined || subjectUrl === undefined) return undefined;
  if (typeof title !== "string" || typeof type !== "string") return undefined;
  if (typeof fullName !== "string" || typeof isPrivate !== "boolean" || typeof ownerLogin !== "string") return undefined;
  return {
    threadId: id,
    reason,
    updatedAt,
    lastReadAt,
    title,
    subjectUrl,
    subjectType: type,
    repoFullName: fullName,
    repoOwner: ownerLogin,
    repoPrivate: isPrivate,
  };
}

const SUBJECT_URL_PATTERN =
  /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(issues|pulls)\/([1-9][0-9]{0,9})$/;

/** subject.url から Issue・PR を取る（§3.2）。形が違えば undefined */
export function parseSubjectUrl(url: string | null): GithubSubject | undefined {
  if (url === null) return undefined;
  const match = SUBJECT_URL_PATTERN.exec(url);
  if (match === null) return undefined;
  const repo = match[2]!;
  if (repo === "." || repo === "..") return undefined;
  return { owner: match[1]!, repo, number: Number(match[4]), kind: match[3] === "pulls" ? "pull" : "issue" };
}

/** 検証した部品から組み立てた GitHub の画面の URL（§4.3。API の html_url は使わない） */
export function subjectHtmlUrl(subject: GithubSubject): string {
  return `https://github.com/${subject.owner}/${subject.repo}/${subject.kind === "pull" ? "pull" : "issues"}/${subject.number}`;
}

/** Bot か: type が Bot か、ログインが [bot] で終わる（§3.1） */
export function isBotUser(user: unknown): boolean {
  if (!isRecord(user)) return false;
  return user.type === "Bot" || (typeof user.login === "string" && user.login.toLowerCase().endsWith("[bot]"));
}

function toActor(user: unknown): GithubActor | undefined {
  if (!isRecord(user) || typeof user.login !== "string" || user.login === "") return undefined;
  return { login: user.login, isBot: isBotUser(user) };
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

/** GET /repos/<o>/<r>/issues/<n> から作成者と作成時刻を取る。形が違えば undefined */
export function parseIssue(raw: unknown): GithubIssueInfo | undefined {
  if (!isRecord(raw)) return undefined;
  const author = toActor(raw.user);
  if (author === undefined || parseTime(raw.created_at) === undefined) return undefined;
  return { author, createdAt: raw.created_at as string };
}

/**
 * タイムラインを見る起点（§3.2）: 前回見た updated_at、無ければ last_read_at、それも無ければ「今からポーリング間隔の 2 回分前」と
 * 「最後に取得できた時刻（lastSuccessAt）」の早い方（止まっていた間の出来事も窓に入れる。lastSuccessAt が無ければ 2 回分前）
 */
export function timelineSince(input: {
  previousUpdatedAt: string | null | undefined;
  lastReadAt: string | null;
  now: Date;
  pollIntervalSec: number;
  lastSuccessAt?: string | null;
}): Date {
  for (const value of [input.previousUpdatedAt, input.lastReadAt]) {
    const time = parseTime(value);
    if (time !== undefined) return new Date(time);
  }
  const twoIntervals = input.now.getTime() - 2 * input.pollIntervalSec * 1000;
  const lastSuccess = parseTime(input.lastSuccessAt);
  return new Date(lastSuccess === undefined ? twoIntervals : Math.min(twoIntervals, lastSuccess));
}

/**
 * タイムラインの要素のうち since より後の出来事を集める（§3.2）。数えるのは COMMENT_EVENTS・REVIEW_EVENTS・STATE_EVENTS の人だけ:
 * commented などは actor（無ければ user）と created_at、reviewed は user と submitted_at、line-commented・commit-commented は comments[].user と
 * comments[].created_at。mentioned・review_requested・assigned は宛てられた人として別に集める。
 * issue（規則 7 の候補で本体を取ったときだけ渡す）が since より後に作られていれば、その作成者も数える
 * （作成はタイムラインに出ないので、Bot が先に反応すると自分と Bot だけに見えてしまうため）
 */
export function collectTimeline(items: readonly unknown[], since: Date, issue?: GithubIssueInfo): TimelineActivity {
  const actors = new Map<string, GithubActor>();
  const commenters = new Map<string, GithubActor>();
  const reviewers = new Map<string, GithubActor>();
  const addressed = new Set<string>();
  let teamReviewRequested = false;
  const add = (actor: GithubActor | undefined, kind?: Map<string, GithubActor>): void => {
    if (actor === undefined) return;
    const key = actor.login.toLowerCase();
    if (!actors.has(key)) actors.set(key, actor);
    if (kind !== undefined && !kind.has(key)) kind.set(key, actor);
  };
  const after = (value: unknown): boolean => {
    const time = parseTime(value);
    return time !== undefined && time > since.getTime();
  };
  const address = (user: unknown): void => {
    const actor = toActor(user);
    if (actor !== undefined) addressed.add(actor.login.toLowerCase());
  };
  if (issue !== undefined && after(issue.createdAt)) add(issue.author);
  for (const item of items) {
    if (!isRecord(item) || typeof item.event !== "string") continue;
    const event = item.event;
    if (event === "reviewed") {
      if (after(item.submitted_at)) add(toActor(item.user), reviewers);
    } else if (event === "line-commented" || event === "commit-commented") {
      if (!Array.isArray(item.comments)) continue;
      for (const comment of item.comments) {
        if (isRecord(comment) && after(comment.created_at)) add(toActor(comment.user), event === "line-commented" ? reviewers : commenters);
      }
    } else if (!after(item.created_at)) {
      continue;
    } else if (COMMENT_EVENTS.has(event)) {
      add(toActor(item.actor) ?? toActor(item.user), commenters);
    } else if (STATE_EVENTS.has(event)) {
      add(toActor(item.actor));
    } else if (event === "mentioned") {
      address(item.actor);
    } else if (event === "assigned") {
      address(item.assignee);
    } else if (event === "review_requested") {
      if (isRecord(item.requested_reviewer)) address(item.requested_reviewer);
      else if (isRecord(item.requested_team)) teamReviewRequested = true;
    }
  }
  return {
    actors: [...actors.values()],
    commenters: [...commenters.values()],
    reviewers: [...reviewers.values()],
    addressed: [...addressed],
    teamReviewRequested,
  };
}

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** 自分でも Bot でもない人 */
function others(actors: readonly GithubActor[], me: string): GithubActor[] {
  return actors.filter((actor) => !actor.isBot && !sameLogin(actor.login, me));
}

/** 黄（規則 7）を調べるために Issue・PR の本体を取りに行くか（§3.2: watch の reason・自分のリポジトリ・初めて見たスレッドのときだけ） */
export function wantsIssueInfo(notification: GithubNotification, owners: readonly string[], firstSeen: boolean): boolean {
  return (
    firstSeen &&
    WATCH_REASONS.has(notification.reason) &&
    owners.some((owner) => sameLogin(owner, notification.repoOwner)) &&
    parseSubjectUrl(notification.subjectUrl) !== undefined
  );
}

/** §3.1 の規則を上から順に当て、最初に当たったものを返す。分からないとき（§3.3）は流す側に倒す */
export function classifyNotification(input: ClassifyInput): Classification {
  const { notification, me, timeline } = input;
  const subject = notification.subjectType === "Issue" || notification.subjectType === "PullRequest" ? parseSubjectUrl(notification.subjectUrl) : undefined;
  const known = timeline !== undefined && timeline.actors.length > 0;
  const drop = (rule: Classification["rule"]): Classification => ({
    level: "drop",
    rule,
    label: DROP_LABEL,
    actorLogin: null,
    actorKnown: known,
    subject: subject ?? null,
  });
  // 1. Issue・PR 以外（番号の取れない形を含む）
  if (subject === undefined) return drop(1);
  // 2. 捨てる reason
  if (DROP_REASONS.has(notification.reason)) return drop(2);
  // 3. スレッドの作成者が Bot（本体を取ったときだけ）
  if (input.issue?.author.isBot === true) return drop(3);
  const direct = Object.hasOwn(DIRECT_REASONS, notification.reason) ? DIRECT_REASONS[notification.reason] : undefined;
  const otherActors = known ? others(timeline.actors, me) : [];
  // 窓の中で自分が宛てられた（メンション・レビュー依頼・担当）。宛てる操作は Bot がすることもあるので、自分宛ての reason では規則 4 を当てない
  const addressedToMe = timeline !== undefined && (timeline.addressed.includes(me.toLowerCase()) || timeline.teamReviewRequested);
  // 4. 新しい出来事の人が分かり、自分と Bot しかいない（自分宛ての reason で、窓の中で自分が宛てられていれば当てない）
  if (known && otherActors.length === 0 && !(direct !== undefined && addressedToMe)) return drop(4);
  const firstOther = otherActors[0]?.login ?? null;
  // 5. 自分宛て（人が分からなくても）
  if (direct !== undefined) {
    return { level: "red", rule: 5, label: direct, actorLogin: firstOther, actorKnown: known, subject };
  }
  // 6. 自分のスレッド・自分がコメントしたスレッドに他人の出来事（分からなければ他人がいるとみなす）
  if (THREAD_REASONS.has(notification.reason)) {
    let label: GithubLabel = "コメント";
    if (known && others(timeline.reviewers, me).length > 0) label = "レビュー";
    else if (known && others(timeline.commenters, me).length === 0) label = "状態の変化";
    return { level: "red", rule: 6, label, actorLogin: firstOther, actorKnown: known, subject };
  }
  // 7. 自分のリポジトリの新しい Issue・PR（本体が分からなければ reason・持ち主・初めて見たかだけで）
  if (
    WATCH_REASONS.has(notification.reason) &&
    input.firstSeen &&
    input.owners.some((owner) => sameLogin(owner, notification.repoOwner))
  ) {
    const issue = input.issue;
    const fresh =
      issue === undefined ||
      (!sameLogin(issue.author.login, me) &&
        !issue.author.isBot &&
        input.now.getTime() - Date.parse(issue.createdAt) <= NEW_THREAD_MAX_AGE_MS);
    if (fresh) {
      return {
        level: "yellow",
        rule: 7,
        label: subject.kind === "pull" ? "新しい PR" : "新しい Issue",
        // 黄で添えるのは作成者。本体が分からなければ確かめられなかったとする
        actorLogin: issue?.author.login ?? null,
        actorKnown: issue !== undefined,
        subject,
      };
    }
  }
  // 8. それ以外
  return drop(8);
}
