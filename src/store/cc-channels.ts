import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** 削除済みのチャンネルの行を残す日数（scheduler の tick で、deleted_at がこれより前の行を消す） */
export const CC_CHANNEL_KEEP_DAYS = 30;

/** open = カテゴリ「Claude Code」、resuming = [起動して続ける] の間（CC13）、ended = セッションが終わった（完了カテゴリ）、deleted = 消えた */
export type CcChannelState = "open" | "resuming" | "ended" | "deleted";

/** 作ったきっかけ（docs/plan/claude-code-channels.md §3.1）。web・command は手動の口 */
export type CcChannelOrigin = "web" | "command" | "web_send" | "web_start" | "permission" | "tool_send" | "tool_start" | "github";

const STATES: readonly CcChannelState[] = ["open", "resuming", "ended", "deleted"];
const ORIGINS: readonly CcChannelOrigin[] = ["web", "command", "web_send", "web_start", "permission", "tool_send", "tool_start", "github"];

/** cc_channels の 1 行（時刻は ISO） */
export type CcChannelRow = {
  channelId: string;
  guildId: string;
  sessionId: string;
  /** 付け替え（rebind。CC13）の前の session_id */
  previousSessionId: string | null;
  /** 作ったときのチャンネル名（`cc-<セッション名>`。同じ名前を避けるのに使う。ローカルの DB だけ） */
  name: string;
  cwd: string | null;
  state: CcChannelState;
  origin: CcChannelOrigin;
  createdAt: string;
  /** 終わった（ended にした）時刻。開き直したら null */
  endedAt: string | null;
  /** 削除の確認（CC13）のメッセージ */
  deletePromptMessageId: string | null;
  deletedAt: string | null;
  updatedAt: string;
};

export type CcChannelCreate = {
  channelId: string;
  guildId: string;
  sessionId: string;
  name: string;
  cwd: string | null;
  origin: CcChannelOrigin;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRow(row: Record<string, SQLOutputValue>): CcChannelRow {
  return {
    channelId: String(row.channel_id),
    guildId: String(row.guild_id),
    sessionId: String(row.session_id),
    previousSessionId: nullableString(row.previous_session_id),
    name: String(row.name),
    cwd: nullableString(row.cwd),
    state: STATES.find((state) => state === row.state) ?? "deleted",
    origin: ORIGINS.find((origin) => origin === row.origin) ?? "web",
    createdAt: String(row.created_at),
    endedAt: nullableString(row.ended_at),
    deletePromptMessageId: nullableString(row.delete_prompt_message_id),
    deletedAt: nullableString(row.deleted_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Claude Code のセッションに結びつけた Discord のチャンネル（cc_channels。docs/plan/claude-code-channels.md §4）。
 * 1 セッションに削除されていないチャンネルは 1 つ（一意の部分索引。2 つ目の create は例外）。物理削除は prune（deleted_at から日数）だけ
 */
export class CcChannelStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** 開いた（open の）チャンネルの行を作る。同じセッションに削除されていない行があれば一意の索引で例外 */
  create(input: CcChannelCreate): CcChannelRow {
    const at = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO cc_channels (channel_id, guild_id, session_id, name, cwd, state, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(input.channelId, input.guildId, input.sessionId, input.name, input.cwd, input.origin, at, at);
    return this.get(input.channelId)!;
  }

  get(channelId: string): CcChannelRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_channels WHERE channel_id = ?").get(channelId);
    return row === undefined ? undefined : toRow(row);
  }

  /** そのセッションの開いている（open の）チャンネル */
  openFor(sessionId: string): CcChannelRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_channels WHERE session_id = ? AND state = 'open'").get(sessionId);
    return row === undefined ? undefined : toRow(row);
  }

  /** そのセッションの削除されていないチャンネル（多くて 1 つ） */
  anyFor(sessionId: string): CcChannelRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_channels WHERE session_id = ? AND state <> 'deleted'").get(sessionId);
    return row === undefined ? undefined : toRow(row);
  }

  /** そのサーバーの削除されていないチャンネル（作った順） */
  listUndeleted(guildId: string): CcChannelRow[] {
    return this.db
      .prepare("SELECT * FROM cc_channels WHERE guild_id = ? AND state <> 'deleted' ORDER BY created_at, channel_id")
      .all(guildId)
      .map(toRow);
  }

  /**
   * 状態を移す（deleted へは markDeleted）。from を渡せば今の状態がそのどれかのときだけ移す（compare-and-set。resuming への移動に使う）。
   * ended にすると ended_at を今に、open に戻すと ended_at を NULL にする。削除済み・行が無い・from に合わなければ false
   */
  setState(channelId: string, to: Exclude<CcChannelState, "deleted">, from?: readonly Exclude<CcChannelState, "deleted">[]): boolean {
    const at = this.now().toISOString();
    const allowed = from ?? ["open", "resuming", "ended"];
    if (allowed.length === 0) return false;
    // ended は今、open は NULL、resuming は今の値のまま
    const endedAt = to === "ended" ? at : null;
    const keepEndedAt = to === "resuming" ? 1 : 0;
    const result = this.db
      .prepare(
        `UPDATE cc_channels SET state = ?, ended_at = CASE WHEN ? = 1 THEN ended_at ELSE ? END, updated_at = ?
         WHERE channel_id = ? AND state IN (${allowed.map(() => "?").join(", ")})`,
      )
      .run(to, keepEndedAt, endedAt, at, channelId, ...allowed);
    return Number(result.changes) > 0;
  }

  /** 再起動で resuming のまま残った行を ended に戻し（ended_at はそのまま）、戻した数を返す（起動時。CC13） */
  resetResuming(): number {
    const result = this.db
      .prepare("UPDATE cc_channels SET state = 'ended', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE state = 'resuming'")
      .run(this.now().toISOString(), this.now().toISOString());
    return Number(result.changes);
  }

  /** セッションを付け替える（CC13 の [起動して続ける]。前の id を previous_session_id に残す）。削除済み・行が無ければ false */
  rebind(channelId: string, sessionId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE cc_channels SET previous_session_id = session_id, session_id = ?, updated_at = ?
         WHERE channel_id = ? AND state <> 'deleted'`,
      )
      .run(sessionId, this.now().toISOString(), channelId);
    return Number(result.changes) > 0;
  }

  /** 終わってから cutoff までに ended にして、まだ削除の確認を出していないチャンネル（終わった古い順。CC13） */
  listDeleteDue(guildId: string, cutoff: Date, limit: number): CcChannelRow[] {
    return this.db
      .prepare(
        `SELECT * FROM cc_channels WHERE guild_id = ? AND state = 'ended' AND ended_at IS NOT NULL AND ended_at <= ?
           AND delete_prompt_message_id IS NULL ORDER BY ended_at, channel_id LIMIT ?`,
      )
      .all(guildId, cutoff.toISOString(), limit)
      .map(toRow);
  }

  /** 削除の確認のメッセージを残す（CC13）。行が無い・削除済みなら false */
  setDeletePrompt(channelId: string, messageId: string): boolean {
    const result = this.db
      .prepare("UPDATE cc_channels SET delete_prompt_message_id = ?, updated_at = ? WHERE channel_id = ? AND state <> 'deleted'")
      .run(messageId, this.now().toISOString(), channelId);
    return Number(result.changes) > 0;
  }

  /** 削除の確認の [残す]（CC13）: ended のままなら ended_at を今にして確認を外す。それ以外は false */
  touchEnded(channelId: string): boolean {
    const at = this.now().toISOString();
    const result = this.db
      .prepare(
        "UPDATE cc_channels SET ended_at = ?, delete_prompt_message_id = NULL, updated_at = ? WHERE channel_id = ? AND state = 'ended'",
      )
      .run(at, at, channelId);
    return Number(result.changes) > 0;
  }

  /** 削除済みにする（Discord 上に無い・[削除する]）。既に削除済み・行が無ければ false */
  markDeleted(channelId: string): boolean {
    const at = this.now().toISOString();
    const result = this.db
      .prepare("UPDATE cc_channels SET state = 'deleted', deleted_at = ?, updated_at = ? WHERE channel_id = ? AND state <> 'deleted'")
      .run(at, at, channelId);
    return Number(result.changes) > 0;
  }

  /** deleted_at が cutoff より前の行を消し、消した数を返す */
  prune(cutoff: Date): number {
    const result = this.db
      .prepare("DELETE FROM cc_channels WHERE state = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < ?")
      .run(cutoff.toISOString());
    return Number(result.changes);
  }
}
