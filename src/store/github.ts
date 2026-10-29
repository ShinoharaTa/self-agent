import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** red は自分宛て（鳴らす）、yellow は自分のリポジトリの新しい Issue / PR、drop は投稿しない（行は残す） */
export type GithubLevel = "red" | "yellow" | "drop";

/** 通知のスレッド（github_threads）。時刻はすべて ISO */
export type GithubThread = {
  /** GitHub の通知のスレッド ID */
  threadId: string;
  /** owner/repo */
  repo: string;
  /** Issue・PullRequest など（GitHub の subject.type） */
  subjectType: string;
  /** Issue・PR の番号。subject.url から取れなければ null */
  number: number | null;
  /** 最後に見た出来事の updated_at（GitHub の時刻）。次のタイムラインはこれより後だけを見る */
  lastUpdatedAt: string;
  /** 初めて見た時刻（アプリの時刻） */
  firstSeenAt: string;
};

export type ThreadUpdate = {
  threadId: string;
  repo: string;
  subjectType: string;
  number: number | null;
  updatedAt: string;
};

/** 1 件の出来事（github_notifications）。thread_id + updated_at で一意 */
export type GithubNotificationRow = {
  id: number;
  threadId: string;
  updatedAt: string;
  reason: string;
  level: GithubLevel;
  /** 種別の固定の語（classify.ts の GithubLabel） */
  label: string;
  /** 投稿に添える人のログイン。分からなければ null */
  actorLogin: string | null;
  /** 誰の操作か確かめられたか */
  actorKnown: boolean;
  title: string | null;
  url: string | null;
  repoPrivate: boolean;
  /** [対応] を付けてよいか */
  handoffOk: boolean;
  postedAt: string | null;
  messageId: string | null;
  channelId: string | null;
  createdAt: string;
};

export type NewGithubNotification = {
  threadId: string;
  updatedAt: string;
  reason: string;
  level: GithubLevel;
  label: string;
  actorLogin: string | null;
  actorKnown: boolean;
  title: string | null;
  url: string | null;
  repoPrivate: boolean;
  handoffOk: boolean;
};

export type AddNotificationResult = { result: "added"; notification: GithubNotificationRow } | { result: "exists" };

/** ポーリングの状態（github_poll_state の 1 行）。行が無ければ全部 null・baselineDone は false */
export type GithubPollState = {
  /** 最初のページの Last-Modified（次の If-Modified-Since） */
  lastModified: string | null;
  /** 直近の X-Poll-Interval（秒） */
  pollIntervalSec: number | null;
  lastSuccessAt: string | null;
  /** 続いている失敗の種類（auth・rate_limited・network など）。成功したら null */
  errorKind: string | null;
  errorSince: string | null;
  rateRemaining: number | null;
  rateResetAt: string | null;
  /** 最初の起動で今ある未読を「見た」として記録し終えたか */
  baselineDone: boolean;
};

const EMPTY_POLL_STATE: GithubPollState = {
  lastModified: null,
  pollIntervalSec: null,
  lastSuccessAt: null,
  errorKind: null,
  errorSince: null,
  rateRemaining: null,
  rateResetAt: null,
  baselineDone: false,
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: SQLOutputValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toLevel(value: SQLOutputValue | undefined): GithubLevel {
  return value === "red" || value === "yellow" ? value : "drop";
}

function toThread(row: Record<string, SQLOutputValue>): GithubThread {
  return {
    threadId: String(row.thread_id),
    repo: String(row.repo),
    subjectType: String(row.subject_type),
    number: nullableNumber(row.number),
    lastUpdatedAt: String(row.last_updated_at),
    firstSeenAt: String(row.first_seen_at),
  };
}

function toNotification(row: Record<string, SQLOutputValue>): GithubNotificationRow {
  return {
    id: Number(row.id),
    threadId: String(row.thread_id),
    updatedAt: String(row.updated_at),
    reason: String(row.reason),
    level: toLevel(row.level),
    label: String(row.label),
    actorLogin: nullableString(row.actor_login),
    actorKnown: Number(row.actor_known) === 1,
    title: nullableString(row.title),
    url: nullableString(row.url),
    repoPrivate: Number(row.repo_private) === 1,
    handoffOk: Number(row.handoff_ok) === 1,
    postedAt: nullableString(row.posted_at),
    messageId: nullableString(row.message_id),
    channelId: nullableString(row.channel_id),
    createdAt: String(row.created_at),
  };
}

function toPollState(row: Record<string, SQLOutputValue>): GithubPollState {
  return {
    lastModified: nullableString(row.last_modified),
    pollIntervalSec: nullableNumber(row.poll_interval_sec),
    lastSuccessAt: nullableString(row.last_success_at),
    errorKind: nullableString(row.error_kind),
    errorSince: nullableString(row.error_since),
    rateRemaining: nullableNumber(row.rate_remaining),
    rateResetAt: nullableString(row.rate_reset_at),
    baselineDone: Number(row.baseline_done) === 1,
  };
}

/** savePollState の列の対応 */
const POLL_STATE_COLUMNS: Readonly<Record<keyof GithubPollState, string>> = {
  lastModified: "last_modified",
  pollIntervalSec: "poll_interval_sec",
  lastSuccessAt: "last_success_at",
  errorKind: "error_kind",
  errorSince: "error_since",
  rateRemaining: "rate_remaining",
  rateResetAt: "rate_reset_at",
  baselineDone: "baseline_done",
};

/**
 * GitHub の通知のスレッド・出来事・ポーリングの状態（docs/plan/github-notifications.md §2.2・§12）。
 * 送り込み（github_handoffs）の読み書きは段 2 で足す。ここでは古い行を消すときに、積んでいる送り込みの通知を残すためだけに見る
 */
export class GithubStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  getThread(threadId: string): GithubThread | undefined {
    const row = this.db.prepare("SELECT * FROM github_threads WHERE thread_id = ?").get(threadId);
    return row === undefined ? undefined : toThread(row);
  }

  /**
   * 最後に見た updated_at を記録する。無ければ初めて見た時刻を今にして作る。既にあれば repo・種類・番号を書き換え、
   * updated_at は今より新しいときだけ進める（戻さない）。first_seen_at は変えない
   */
  recordThread(update: ThreadUpdate): GithubThread {
    const row = this.db
      .prepare(
        "INSERT INTO github_threads (thread_id, repo, subject_type, number, last_updated_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (thread_id) DO UPDATE SET repo = excluded.repo, subject_type = excluded.subject_type, number = excluded.number, " +
          "last_updated_at = CASE WHEN julianday(excluded.last_updated_at) > julianday(last_updated_at) " +
          "THEN excluded.last_updated_at ELSE last_updated_at END RETURNING *",
      )
      .get(update.threadId, update.repo, update.subjectType, update.number, update.updatedAt, this.now().toISOString());
    return toThread(row!);
  }

  /** 出来事を足す。同じ thread_id + updated_at が既にあれば何もせず exists */
  addNotification(notification: NewGithubNotification): AddNotificationResult {
    const row = this.db
      .prepare(
        "INSERT INTO github_notifications (thread_id, updated_at, reason, level, label, actor_login, actor_known, title, url, " +
          "repo_private, handoff_ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (thread_id, updated_at) DO NOTHING RETURNING *",
      )
      .get(
        notification.threadId,
        notification.updatedAt,
        notification.reason,
        notification.level,
        notification.label,
        notification.actorLogin,
        notification.actorKnown ? 1 : 0,
        notification.title,
        notification.url,
        notification.repoPrivate ? 1 : 0,
        notification.handoffOk ? 1 : 0,
        this.now().toISOString(),
      );
    return row === undefined ? { result: "exists" } : { result: "added", notification: toNotification(row) };
  }

  getNotification(id: number): GithubNotificationRow | undefined {
    const row = this.db.prepare("SELECT * FROM github_notifications WHERE id = ?").get(id);
    return row === undefined ? undefined : toNotification(row);
  }

  /** まだ投稿していない赤・黄を古い順に（投稿に失敗したものも次の回にここから出し直す） */
  listUnposted(limit: number): GithubNotificationRow[] {
    return this.db
      .prepare("SELECT * FROM github_notifications WHERE level <> 'drop' AND posted_at IS NULL ORDER BY id LIMIT ?")
      .all(Math.max(0, Math.floor(limit)))
      .map(toNotification);
  }

  /**
   * 投稿した（posted_at のある。投稿せずに済ませたものも含む）出来事を updated_at の新しい順に limit 件（Web UI の GitHub。docs/plan/web-ui.md §7.2）。
   * 白は posted_at を書かないので出ない
   */
  listPosted(limit: number): GithubNotificationRow[] {
    return this.db
      .prepare("SELECT * FROM github_notifications WHERE posted_at IS NOT NULL ORDER BY julianday(updated_at) DESC, id DESC LIMIT ?")
      .all(Math.max(0, Math.floor(limit)))
      .map(toNotification);
  }

  /** 投稿したことを記録する。無い・既に投稿済みなら何もせず false */
  markPosted(id: number, channelId: string, messageId: string): boolean {
    const result = this.db
      .prepare("UPDATE github_notifications SET posted_at = ?, channel_id = ?, message_id = ? WHERE id = ? AND posted_at IS NULL")
      .run(this.now().toISOString(), channelId, messageId, id);
    return Number(result.changes) > 0;
  }

  /** 投稿せずに済ませたことを記録する（最初の起動の未読・上限を超えてまとめた分）。無い・既に投稿済みなら何もせず false */
  markSkipped(id: number): boolean {
    const result = this.db
      .prepare("UPDATE github_notifications SET posted_at = ? WHERE id = ? AND posted_at IS NULL")
      .run(this.now().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /**
   * cutoff より前に作った出来事と、cutoff より前から更新の無いスレッドを消す（§2.2 の 30 日）。
   * 積んでいる（queued）送り込みの通知は残す。消した出来事の数を返す
   */
  prune(cutoff: Date): number {
    const iso = cutoff.toISOString();
    const result = this.db
      .prepare(
        "DELETE FROM github_notifications WHERE created_at < ? AND NOT EXISTS " +
          "(SELECT 1 FROM github_handoffs h WHERE h.notification_id = github_notifications.id AND h.state = 'queued')",
      )
      .run(iso);
    // last_updated_at は GitHub の形（ミリ秒なし）なので、文字列ではなく時刻で比べる
    this.db.prepare("DELETE FROM github_threads WHERE julianday(last_updated_at) < julianday(?)").run(iso);
    return Number(result.changes);
  }

  getPollState(): GithubPollState {
    const row = this.db.prepare("SELECT * FROM github_poll_state WHERE id = 1").get();
    return row === undefined ? { ...EMPTY_POLL_STATE } : toPollState(row);
  }

  /** 渡した項目だけを書き換える（行が無ければ作る）。書き換えた後の状態を返す */
  savePollState(changes: Partial<GithubPollState>): GithubPollState {
    const keys = (Object.keys(changes) as (keyof GithubPollState)[]).filter((key) => Object.hasOwn(POLL_STATE_COLUMNS, key));
    this.db.prepare("INSERT INTO github_poll_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING").run();
    if (keys.length > 0) {
      const sets = keys.map((key) => `${POLL_STATE_COLUMNS[key]} = ?`).join(", ");
      const values = keys.map((key) => {
        const value = changes[key];
        if (typeof value === "boolean") return value ? 1 : 0;
        return value ?? null;
      });
      this.db.prepare(`UPDATE github_poll_state SET ${sets} WHERE id = 1`).run(...values);
    }
    return this.getPollState();
  }
}
