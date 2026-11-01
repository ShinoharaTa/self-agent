import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** 返事の行を残す日数（scheduler の tick で、created_at がこれより前の行を消す。docs/plan/claude-code-sessions.md §9） */
export const CC_REPLY_KEEP_DAYS = 30;

/** posted = Discord に出した、failed = 出せなかった、skipped = 出さなかった（10 秒以内の同じ本文・1 日の上限） */
export type CcReplyRowState = "posted" | "failed" | "skipped";

const STATES: readonly CcReplyRowState[] = ["posted", "failed", "skipped"];

/** cc_replies の 1 行（Stop ごと。本文は持たず sha256 と長さだけ。時刻は ISO） */
export type CcReplyRow = {
  id: number;
  sessionId: string;
  /** Stop を受けた時刻 */
  receivedAt: string;
  /** 返事の本文（last_assistant_message）の sha256（hex）。本文が無ければ空文字列の sha256 */
  textHash: string;
  /** 返事の本文の長さ（コードポイント）。本文が無ければ 0 */
  textLength: number;
  /** その返事が当たった送信（届けた後の最初の Stop）。それ以外は null */
  sendId: number | null;
  /** 出した（出そうとした）チャンネル */
  channelId: string;
  /** 出した最後の 1 通（[追いかけをやめる] の付いたもの） */
  messageId: string | null;
  state: CcReplyRowState;
  createdAt: string;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRow(row: Record<string, SQLOutputValue>): CcReplyRow {
  const state = STATES.find((value) => value === row.state);
  if (state === undefined) throw new Error("cc_replies の行の形が違います");
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    receivedAt: String(row.received_at),
    textHash: String(row.text_hash),
    textLength: Number(row.text_length),
    sendId: row.send_id === null || row.send_id === undefined ? null : Number(row.send_id),
    channelId: String(row.channel_id),
    messageId: nullableString(row.message_id),
    state,
    createdAt: String(row.created_at),
  };
}

/** Claude Code の返事を Discord に戻した記録（cc_replies。docs/plan/claude-code-sessions.md §5.4・§9。CC8）。物理削除は prune（日数）だけ */
export class CcReplyStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** 行を作って返す */
  add(input: {
    sessionId: string;
    receivedAt: Date;
    textHash: string;
    textLength: number;
    sendId: number | null;
    channelId: string;
    state: CcReplyRowState;
  }): CcReplyRow {
    const result = this.db
      .prepare(
        `INSERT INTO cc_replies (session_id, received_at, text_hash, text_length, send_id, channel_id, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.receivedAt.toISOString(),
        input.textHash,
        input.textLength,
        input.sendId,
        input.channelId,
        input.state,
        this.now().toISOString(),
      );
    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number): CcReplyRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_replies WHERE id = ?").get(id);
    return row === undefined ? undefined : toRow(row);
  }

  /** 同じセッション・同じ本文（sha256）で、受けた時刻が since 以後の最新の行（同じ Stop が二重に来たときの判定。§5.4） */
  findRecentSame(sessionId: string, textHash: string, since: Date): CcReplyRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM cc_replies WHERE session_id = ? AND text_hash = ? AND received_at >= ? ORDER BY id DESC LIMIT 1")
      .get(sessionId, textHash, since.toISOString());
    return row === undefined ? undefined : toRow(row);
  }

  /** 状態と、出せたなら最後の 1 通の ID を書く（skipped の行に上限の 1 行を出したときは skipped のまま ID だけ） */
  finish(id: number, state: CcReplyRowState, messageId?: string): void {
    this.db.prepare("UPDATE cc_replies SET state = ?, message_id = COALESCE(?, message_id) WHERE id = ?").run(state, messageId ?? null, id);
  }

  /** created_at が cutoff より前の行を消し、消した数を返す */
  prune(cutoff: Date): number {
    const result = this.db.prepare("DELETE FROM cc_replies WHERE created_at < ?").run(cutoff.toISOString());
    return Number(result.changes);
  }
}
