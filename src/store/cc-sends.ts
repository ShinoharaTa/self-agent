import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** 送信の行を残す日数（scheduler の tick で、created_at がこれより前の終わった行を消す。docs/plan/claude-code-sessions.md §9） */
export const CC_SEND_KEEP_DAYS = 30;

/**
 * 送信の出所（web = Web の composer、tool = SDK のツール cc_send（CC7）、github = #github・Web の GitHub の [対応]（CC6）、start = 起動の最初の指示（CC4）、
 * discord = Claude Code のチャンネルへのオーナーの発言（v37。docs/plan/claude-code-channels.md §3.3。CC11））
 */
export type CcSendOrigin = "web" | "tool" | "github" | "start" | "discord";

/**
 * 送信の状態（§3.2）。awaiting_confirm = Discord の確認待ち（CC7）、queued = 入力待ちを待っている、delivering = 貼っている途中、
 * delivered = 届けた、unconfirmed = 貼れたか・送信できたかを確かめられなかった（やり直さない）、failed = 送れない（送り先が無い・claude でない）、
 * gave_up = 待ちの上限を過ぎた、cancelled = 取り消した
 */
export type CcSendState = "awaiting_confirm" | "queued" | "delivering" | "delivered" | "unconfirmed" | "failed" | "gave_up" | "cancelled";

/** まだ終わっていない状態（1 セッションに 1 件だけ） */
export const CC_SEND_ACTIVE_STATES: readonly CcSendState[] = ["awaiting_confirm", "queued", "delivering"];

/**
 * 送信に返事が来たかの印（§5.4。CC8）。waiting = 届けて返事（Stop）を待っている、posted = 届けた後の最初の Stop が来た、
 * unreadable = その Stop に返事の本文が無かった、timed_out = 24 時間来なかった（Esc の中断では Stop が来ない）。届けていない送信は null
 */
export type CcReplyState = "waiting" | "posted" | "timed_out" | "unreadable";

const REPLY_STATES: readonly CcReplyState[] = ["waiting", "posted", "timed_out", "unreadable"];

const STATES: readonly CcSendState[] = ["awaiting_confirm", "queued", "delivering", "delivered", "unconfirmed", "failed", "gave_up", "cancelled"];
const ORIGINS: readonly CcSendOrigin[] = ["web", "tool", "github", "start", "discord"];

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
  /**
   * 確認を投稿したチャンネル（Discord から頼んだ送信。CC7）、オーナーが発言した Claude Code のチャンネル（origin discord）、
   * 写しを投稿した Claude Code のチャンネル（CC11）
   */
  channelId: string | null;
  /** 確認のメッセージ（CC7）・オーナーの発言（origin discord）・写しの投稿（CC11）。印と返事の返信先 */
  messageId: string | null;
  /** 返事が来たかの印（CC8）。届けていなければ null */
  replyState: CcReplyState | null;
  /** 返事の印を posted・unreadable にした時刻 */
  replyPostedAt: string | null;
  /** 作った時刻。Discord の確認待ちの行は [送る] を押した時刻に進める（待ちの上限はそこから数える） */
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
    channelId: nullableString(row.channel_id),
    messageId: nullableString(row.message_id),
    replyState: REPLY_STATES.find((value) => value === row.reply_state) ?? null,
    replyPostedAt: nullableString(row.reply_posted_at),
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

  /**
   * 行を作って返す。paneId・startDir はペイン宛て（起動の最初の指示。sessionId は null）のときだけ、notificationId は GitHub の [対応] のときだけ、
   * channelId は Discord から頼んだ送信のときだけ、messageId はオーナーの発言（origin discord）のときだけ
   */
  add(input: {
    sessionId: string | null;
    paneId?: string;
    startDir?: string;
    text: string;
    origin: CcSendOrigin;
    state: CcSendState;
    notificationId?: number;
    channelId?: string;
    messageId?: string;
  }): CcSendRow {
    const at = this.now().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO cc_sends (session_id, pane_id, start_dir, text, origin, state, notification_id, channel_id, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.sessionId,
        input.paneId ?? null,
        input.startDir ?? null,
        input.text,
        input.origin,
        input.state,
        input.notificationId ?? null,
        input.channelId ?? null,
        input.messageId ?? null,
        at,
        at,
      );
    return this.get(Number(result.lastInsertRowid))!;
  }

  /** 確認のメッセージを書く（CC7） */
  setMessageId(id: number, messageId: string): void {
    this.db.prepare("UPDATE cc_sends SET message_id = ?, updated_at = ? WHERE id = ?").run(messageId, this.now().toISOString(), id);
  }

  /**
   * Claude Code のチャンネルへの写しの投稿を、印と返事の返信先にする（CC11）。まだ届けていない（queued・delivering）ときだけ書き、書いたら true
   * （届けた後の写しは返信先に使わない）
   */
  setMirror(id: number, channelId: string, messageId: string): boolean {
    const result = this.db
      .prepare("UPDATE cc_sends SET channel_id = ?, message_id = ?, updated_at = ? WHERE id = ? AND state IN ('queued', 'delivering')")
      .run(channelId, messageId, this.now().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /** そのセッションのオーナーの発言（origin discord）の queued の数（チャンネルの列。CC_CHANNEL_QUEUE_MAX） */
  countQueuedDiscord(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM cc_sends WHERE session_id = ? AND origin = 'discord' AND state = 'queued'")
      .get(sessionId);
    return Number(row?.n ?? 0);
  }

  /** そのセッションの貼っている途中（delivering）の行（多くて 1 つ。返事の Stop を送信が終わるまで待たせるか。CC8） */
  deliveringFor(sessionId: string): CcSendRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_sends WHERE session_id = ? AND state = 'delivering' ORDER BY id DESC LIMIT 1").get(sessionId);
    return row === undefined ? undefined : toRow(row);
  }

  /** そのセッションの、since 以後に unconfirmed にした行を新しい順に（UserPromptSubmit で届いたと分かったら delivered に直す。docs/plan/claude-code-channels.md §3.3） */
  listUnconfirmedSince(sessionId: string, since: Date): CcSendRow[] {
    return this.db
      .prepare("SELECT * FROM cc_sends WHERE session_id = ? AND state = 'unconfirmed' AND updated_at >= ? ORDER BY id DESC")
      .all(sessionId, since.toISOString())
      .map(toRow);
  }

  /**
   * unconfirmed の行を delivered に直す（UserPromptSubmit の本文が同じだった）。delivered_at は unconfirmed にした時刻、返事の印は変えない
   * （既に返事が来ていれば、それを返事待ちに戻さない）。直したら true
   */
  confirmUnconfirmed(id: number, lastPaneState: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE cc_sends SET state = 'delivered', delivered_at = COALESCE(delivered_at, updated_at), updated_at = ?, last_pane_state = ?
           WHERE id = ? AND state = 'unconfirmed'`,
      )
      .run(this.now().toISOString(), lastPaneState, id);
    return Number(result.changes) > 0;
  }

  /** そのセッションの queued の行を古い順に（/cc cancel） */
  listQueuedFor(sessionId: string): CcSendRow[] {
    return this.db.prepare("SELECT * FROM cc_sends WHERE session_id = ? AND state = 'queued' ORDER BY id").all(sessionId).map(toRow);
  }

  /**
   * そのセッションの、貼っている途中（delivering）か since 以後に届けた（delivered・unconfirmed）送信（端末の指示の写しで、self-agent が届けたものを
   * 見分ける。docs/plan/claude-code-channels.md §3.5。CC12）
   */
  listRecentDelivered(sessionId: string, since: Date): CcSendRow[] {
    return this.db
      .prepare(
        `SELECT * FROM cc_sends WHERE session_id = ? AND (state = 'delivering'
           OR (state IN ('delivered', 'unconfirmed') AND COALESCE(delivered_at, updated_at) >= ?)) ORDER BY id`,
      )
      .all(sessionId, since.toISOString())
      .map(toRow);
  }

  /** delivering の行（再起動の後に unconfirmed にする前に、印を付け直す行を覚える） */
  listDelivering(): CcSendRow[] {
    return this.db.prepare("SELECT * FROM cc_sends WHERE state = 'delivering' ORDER BY id").all().map(toRow);
  }

  /**
   * Discord の確認待ち（awaiting_confirm）を queued にする（[送る]。§5.3）。created_at も今にして、送信の待ちの上限を [送る] から数える。
   * 確認待ちでなければ何もせず false
   */
  confirm(id: number): boolean {
    const at = this.now().toISOString();
    const result = this.db
      .prepare("UPDATE cc_sends SET state = 'queued', created_at = ?, updated_at = ? WHERE id = ? AND state = 'awaiting_confirm'")
      .run(at, at, id);
    return Number(result.changes) > 0;
  }

  /** created_at が cutoff 以前の確認待ち（awaiting_confirm）を古い順に（10 分の失効。§5.3） */
  listAwaitingConfirmBefore(cutoff: Date): CcSendRow[] {
    return this.db
      .prepare("SELECT * FROM cc_sends WHERE state = 'awaiting_confirm' AND created_at <= ? ORDER BY id")
      .all(cutoff.toISOString())
      .map(toRow);
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
   * 同じセッション・同じ本文で since 以後に作った最新の行（二重送信の判定。§3.2）。取り消した・送れなかった・諦めた行と、Discord の確認待ちの行は返さない
   * （送り直しを前の送信と取り違えない。確認待ちは送るかどうか決まっていない）
   */
  findRecentSame(sessionId: string, text: string, since: Date): CcSendRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM cc_sends WHERE session_id = ? AND text = ? AND created_at >= ?
           AND state NOT IN ('cancelled', 'failed', 'gave_up', 'awaiting_confirm') ORDER BY id DESC LIMIT 1`,
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
   * to が delivered なら delivered_at を今にし、返事の印を waiting にする（§5.4）。unconfirmed も返事の印を waiting にする（届いていれば最初の返事を
   * その送信の message_id への返信にする。docs/plan/claude-code-channels.md §3.4）。移したら true
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
           delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
           reply_state = CASE WHEN ? IN ('delivered', 'unconfirmed') THEN 'waiting' ELSE reply_state END
         WHERE id = ? AND state IN (${placeholders})`,
      )
      .run(to, at, fields.paneId ?? null, fields.lastPaneState ?? null, to, at, to, id, ...from);
    return Number(result.changes) > 0;
  }

  /**
   * そのセッションの返事を待っている（reply_state が waiting の）最新の送信に、来た返事の印（posted・unreadable）を付けて、付ける前の行を返す（§5.4。
   * 届けた後の最初の Stop）。それより前の返事待ちは、もう返事が来ない（Esc で中断された）ので timed_out にする。返事待ちが無ければ undefined
   */
  takeReplyWaiting(sessionId: string, state: "posted" | "unreadable"): CcSendRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM cc_sends WHERE session_id = ? AND reply_state = 'waiting' ORDER BY id DESC LIMIT 1")
      .get(sessionId);
    if (row === undefined) return undefined;
    const found = toRow(row);
    const at = this.now().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE cc_sends SET reply_state = ?, reply_posted_at = ?, updated_at = ? WHERE id = ? AND reply_state = 'waiting'")
        .run(state, at, at, found.id);
      this.db
        .prepare("UPDATE cc_sends SET reply_state = 'timed_out', updated_at = ? WHERE session_id = ? AND reply_state = 'waiting' AND id < ?")
        .run(at, sessionId, found.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return found;
  }

  /** delivered_at（unconfirmed は終わった時刻）が cutoff より前の返事待ちを timed_out にし、その id を返す（24 時間。§5.4） */
  timeOutReplies(cutoff: Date): number[] {
    const ids = this.db
      .prepare("SELECT id FROM cc_sends WHERE reply_state = 'waiting' AND COALESCE(delivered_at, updated_at) < ? ORDER BY id")
      .all(cutoff.toISOString())
      .map((row) => Number(row.id));
    const statement = this.db.prepare("UPDATE cc_sends SET reply_state = 'timed_out', updated_at = ? WHERE id = ? AND reply_state = 'waiting'");
    const at = this.now().toISOString();
    return ids.filter((id) => Number(statement.run(at, id).changes) > 0);
  }

  /** 一覧から消えた（cc_sessions.gone_at のある）セッションの返事待ちを timed_out にし、その id を返す（もう返事は来ない） */
  timeOutGoneReplies(): number[] {
    const ids = this.db
      .prepare(
        `SELECT id FROM cc_sends WHERE reply_state = 'waiting'
           AND session_id IN (SELECT session_id FROM cc_sessions WHERE gone_at IS NOT NULL) ORDER BY id`,
      )
      .all()
      .map((row) => Number(row.id));
    const statement = this.db.prepare("UPDATE cc_sends SET reply_state = 'timed_out', updated_at = ? WHERE id = ? AND reply_state = 'waiting'");
    const at = this.now().toISOString();
    return ids.filter((id) => Number(statement.run(at, id).changes) > 0);
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
