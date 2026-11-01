import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** 送信の行を残す日数（scheduler の tick で、created_at がこれより前の終わった行を消す。docs/plan/claude-code-sessions.md §9） */
export const CC_SEND_KEEP_DAYS = 30;

/** 送信の出所（web = Web の composer、github = #github・Web の GitHub の [対応]（CC6）、start = 起動の最初の指示（CC4）。tool は後の段） */
export type CcSendOrigin = "web" | "tool" | "github" | "start";

/**
 * 送信の状態（§3.2）。awaiting_confirm = Discord の確認待ち（CC7）、queued = 入力待ちを待っている、delivering = 貼っている途中、
 * delivered = 届けた、unconfirmed = 貼れたか・送信できたかを確かめられなかった（やり直さない）、failed = 送れない（送り先が無い・claude でない）、
 * gave_up = 待ちの上限を過ぎた、cancelled = 取り消した
 */
export type CcSendState = "awaiting_confirm" | "queued" | "delivering" | "delivered" | "unconfirmed" | "failed" | "gave_up" | "cancelled";

/** まだ終わっていない状態（1 セッションに 1 件だけ） */
export const CC_SEND_ACTIVE_STATES: readonly CcSendState[] = ["awaiting_confirm", "queued", "delivering"];

const STATES: readonly CcSendState[] = ["awaiting_confirm", "queued", "delivering", "delivered", "unconfirmed", "failed", "gave_up", "cancelled"];
const ORIGINS: readonly CcSendOrigin[] = ["web", "tool", "github", "start"];

/** cc_sends の 1 行（時刻は ISO） */
export type CcSendRow = {
  id: number;
  sessionId: string | null;
  /** 届けたときのペイン（%N）。起動の最初の指示（origin start）は起動したペインで、session_id は一覧に現れたら埋める */
  paneId: string | null;
  text: string;
  origin: CcSendOrigin;
  state: CcSendState;
  /** 起動の最初の指示（origin start）の起動したディレクトリ。この cwd の claude にだけ結びつける（v29） */
  startDir: string | null;
  /** 最後に見たペインの状態か、送れなかった理由 */
  lastPaneState: string | null;
  /** 試した回数 */
  attempts: number;
  deliveredAt: string | null;
  /** [対応] を押した通知（github_notifications.id。origin github だけ。CC6） */
  notificationId: number | null;
  createdAt: string;
  updatedAt: string;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: SQLOutputValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toRow(row: Record<string, SQLOutputValue>): CcSendRow {
  const state = STATES.find((value) => value === row.state);
  const origin = ORIGINS.find((value) => value === row.origin);
  if (state === undefined || origin === undefined) throw new Error("cc_sends の行の形が違います");
  return {
    id: Number(row.id),
    sessionId: nullableString(row.session_id),
    paneId: nullableString(row.pane_id),
    startDir: nullableString(row.start_dir),
    text: String(row.text),
    origin,
    state,
    lastPaneState: nullableString(row.last_pane_state),
    attempts: Number(row.attempts),
    deliveredAt: nullableString(row.delivered_at),
    notificationId: nullableNumber(row.notification_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const ACTIVE_SQL = CC_SEND_ACTIVE_STATES.map((state) => `'${state}'`).join(", ");

/** Claude Code のセッションへの送信（cc_sends。docs/plan/claude-code-sessions.md §3.2・§9）。物理削除は prune（日数）だけ */
export class CcSendStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** 行を作って返す。paneId・startDir はペイン宛て（起動の最初の指示。sessionId は null）のときだけ、notificationId は GitHub の [対応] のときだけ */
  add(input: {
    sessionId: string | null;
    paneId?: string;
    startDir?: string;
    text: string;
    origin: CcSendOrigin;
    state: CcSendState;
    notificationId?: number;
  }): CcSendRow {
    const at = this.now().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO cc_sends (session_id, pane_id, start_dir, text, origin, state, notification_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(input.sessionId, input.paneId ?? null, input.startDir ?? null, input.text, input.origin, input.state, input.notificationId ?? null, at, at);
    return this.get(Number(result.lastInsertRowid))!;
  }

  /** ペイン宛ての行（session_id が NULL）にセッションを結びつける（§4.2）。結びつけたら true */
  bindSession(id: number, sessionId: string): boolean {
    const result = this.db
      .prepare("UPDATE cc_sends SET session_id = ?, updated_at = ? WHERE id = ? AND session_id IS NULL")
      .run(sessionId, this.now().toISOString(), id);
    return Number(result.changes) > 0;
  }

  get(id: number): CcSendRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_sends WHERE id = ?").get(id);
    return row === undefined ? undefined : toRow(row);
  }

  /**
   * 同じセッション・同じ本文で since 以後に作った最新の行（二重送信の判定。§3.2）。取り消した・送れなかった・諦めた行は返さない
   * （送り直しを前の送信と取り違えない）
   */
  findRecentSame(sessionId: string, text: string, since: Date): CcSendRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM cc_sends WHERE session_id = ? AND text = ? AND created_at >= ?
           AND state NOT IN ('cancelled', 'failed', 'gave_up') ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId, text, since.toISOString());
    return row === undefined ? undefined : toRow(row);
  }

  /** そのセッションのまだ終わっていない行（awaiting_confirm・queued・delivering）の最新 */
  activeFor(sessionId: string): CcSendRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM cc_sends WHERE session_id = ? AND state IN (${ACTIVE_SQL}) ORDER BY id DESC LIMIT 1`)
      .get(sessionId);
    return row === undefined ? undefined : toRow(row);
  }

  /**
   * 同じ GitHub のスレッドの通知（github_notifications の thread_id）から積んだ送信の最新の行（[対応] の二重の押下の判定。CC6）。
   * 取り消した・送れなかった・諦めた行は返さない（押し直しを妨げない）
   */
  latestForThread(threadId: string): CcSendRow | undefined {
    const row = this.db
      .prepare(
        `SELECT s.* FROM cc_sends s JOIN github_notifications n ON n.id = s.notification_id
           WHERE n.thread_id = ? AND s.state NOT IN ('cancelled', 'failed', 'gave_up') ORDER BY s.id DESC LIMIT 1`,
      )
      .get(threadId);
    return row === undefined ? undefined : toRow(row);
  }

  /** セッションごとの最新の行のうち、まだ終わっていないものか since 以後に変わったもの（一覧の送信の印） */
  latestPerSession(since: Date): CcSendRow[] {
    return this.db
      .prepare(
        `SELECT * FROM cc_sends WHERE id IN (SELECT MAX(id) FROM cc_sends WHERE session_id IS NOT NULL GROUP BY session_id)
           AND (state IN (${ACTIVE_SQL}) OR updated_at >= ?) ORDER BY id`,
      )
      .all(since.toISOString())
      .map(toRow);
  }

  /** queued の行を古い順に */
  listQueued(): CcSendRow[] {
    return this.db.prepare("SELECT * FROM cc_sends WHERE state = 'queued' ORDER BY id").all().map(toRow);
  }

  /** まだ終わっていない行の数（awaiting_confirm を含む） */
  countActive(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM cc_sends WHERE state IN (${ACTIVE_SQL})`).get();
    return Number(row?.n ?? 0);
  }

  /**
   * 今の状態が from のどれかのときだけ to に移す（compare-and-set）。fields があれば同じ更新で書く（undefined の項目は変えない）。
   * to が delivered なら delivered_at を今にする。移したら true
   */
  transition(
    id: number,
    from: readonly CcSendState[],
    to: CcSendState,
    fields: { paneId?: string; lastPaneState?: string } = {},
  ): boolean {
    const at = this.now().toISOString();
    const placeholders = from.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE cc_sends SET state = ?, updated_at = ?, pane_id = COALESCE(?, pane_id), last_pane_state = COALESCE(?, last_pane_state),
           delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
         WHERE id = ? AND state IN (${placeholders})`,
      )
      .run(to, at, fields.paneId ?? null, fields.lastPaneState ?? null, to, at, id, ...from);
    return Number(result.changes) > 0;
  }

  /** queued の行に、試した回数を 1 増やして最後に見たペインの状態を書く（queued でなければ何もしない） */
  noteAttempt(id: number, lastPaneState: string): void {
    this.db
      .prepare("UPDATE cc_sends SET attempts = attempts + 1, last_pane_state = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
      .run(lastPaneState, this.now().toISOString(), id);
  }

  /** 再起動の後: delivering のまま残った行を unconfirmed にし（貼ったかもしれないので、やり直さない。§3.2）、その数を返す */
  recoverDelivering(): number {
    const result = this.db
      .prepare("UPDATE cc_sends SET state = 'unconfirmed', last_pane_state = 'restarted', updated_at = ? WHERE state = 'delivering'")
      .run(this.now().toISOString());
    return Number(result.changes);
  }

  /** created_at が cutoff より前の queued を gave_up にし、その id を返す */
  giveUpOlderThan(cutoff: Date): number[] {
    const ids = this.db
      .prepare("SELECT id FROM cc_sends WHERE state = 'queued' AND created_at < ? ORDER BY id")
      .all(cutoff.toISOString())
      .map((row) => Number(row.id));
    return ids.filter((id) => this.transition(id, ["queued"], "gave_up"));
  }

  /** created_at が cutoff より前の終わった行を消し、消した数を返す（まだ終わっていない行は消さない） */
  prune(cutoff: Date): number {
    const result = this.db
      .prepare(`DELETE FROM cc_sends WHERE created_at < ? AND state NOT IN (${ACTIVE_SQL})`)
      .run(cutoff.toISOString());
    return Number(result.changes);
  }
}
