import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** 起動の確認の行を残す日数（scheduler の tick で、created_at がこれより前の終わった行を消す。cc_sends と同じ） */
export const CC_START_KEEP_DAYS = 30;

/**
 * cc_start の起動の確認の状態（docs/plan/claude-code-sessions.md §5.3・§9）。awaiting_confirm = Discord の確認待ち、
 * started = [起動する] を受けた（起動する途中を含む）、failed = 起動できなかった、cancelled = [やめる]・10 分の放置
 */
export type CcStartState = "awaiting_confirm" | "started" | "cancelled" | "failed";

const STATES: readonly CcStartState[] = ["awaiting_confirm", "started", "cancelled", "failed"];

/** cc_starts の 1 行（時刻は ISO） */
export type CcStartRow = {
  id: number;
  /** SELF_AGENT_WORKSPACE_DIR の直下の名前 */
  project: string;
  title: string;
  /** 最初の指示（無ければ null） */
  text: string | null;
  permissionMode: string | null;
  /** 確認を投稿したチャンネル */
  channelId: string;
  messageId: string | null;
  state: CcStartState;
  /** 起動した tmux のセッション名（表示用） */
  tmuxSession: string | null;
  /** 起動したペイン（%N） */
  paneId: string | null;
  /** 最初の指示の送信（cc_sends の id） */
  sendId: number | null;
  createdAt: string;
  updatedAt: string;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRow(row: Record<string, SQLOutputValue>): CcStartRow {
  const state = STATES.find((value) => value === row.state);
  if (state === undefined) throw new Error("cc_starts の行の形が違います");
  return {
    id: Number(row.id),
    project: String(row.project),
    title: String(row.title),
    text: nullableString(row.text),
    permissionMode: nullableString(row.permission_mode),
    channelId: String(row.channel_id),
    messageId: nullableString(row.message_id),
    state,
    tmuxSession: nullableString(row.tmux_session),
    paneId: nullableString(row.pane_id),
    sendId: row.send_id === null || row.send_id === undefined ? null : Number(row.send_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Claude Code の新しいセッションの起動の確認（cc_starts。docs/plan/claude-code-sessions.md §5.3・§9。CC7）。物理削除は prune（日数）だけ */
export class CcStartStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** 確認待ち（awaiting_confirm）の行を作って返す */
  add(input: { project: string; title: string; text?: string; permissionMode?: string; channelId: string }): CcStartRow {
    const at = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO cc_starts (project, title, text, permission_mode, channel_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'awaiting_confirm', ?, ?)`,
      )
      .run(input.project, input.title, input.text ?? null, input.permissionMode ?? null, input.channelId, at, at);
    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number): CcStartRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_starts WHERE id = ?").get(id);
    return row === undefined ? undefined : toRow(row);
  }

  /** 確認のメッセージを書く */
  setMessageId(id: number, messageId: string): void {
    this.db.prepare("UPDATE cc_starts SET message_id = ?, updated_at = ? WHERE id = ?").run(messageId, this.now().toISOString(), id);
  }

  /**
   * 今の状態が from のどれかのときだけ to に移す（compare-and-set）。fields があれば同じ更新で書く（undefined の項目は変えない）。移したら true
   */
  transition(
    id: number,
    from: readonly CcStartState[],
    to: CcStartState,
    fields: { tmuxSession?: string; paneId?: string; sendId?: number } = {},
  ): boolean {
    const placeholders = from.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE cc_starts SET state = ?, updated_at = ?, tmux_session = COALESCE(?, tmux_session), pane_id = COALESCE(?, pane_id),
           send_id = COALESCE(?, send_id)
         WHERE id = ? AND state IN (${placeholders})`,
      )
      .run(to, this.now().toISOString(), fields.tmuxSession ?? null, fields.paneId ?? null, fields.sendId ?? null, id, ...from);
    return Number(result.changes) > 0;
  }

  /** created_at が cutoff 以前の確認待ち（awaiting_confirm）を古い順に（10 分の失効。§5.3） */
  listAwaitingConfirmBefore(cutoff: Date): CcStartRow[] {
    return this.db
      .prepare("SELECT * FROM cc_starts WHERE state = 'awaiting_confirm' AND created_at <= ? ORDER BY id")
      .all(cutoff.toISOString())
      .map(toRow);
  }

  /** created_at が cutoff より前の終わった行を消し、消した数を返す（確認待ちの行は消さない） */
  prune(cutoff: Date): number {
    const result = this.db
      .prepare("DELETE FROM cc_starts WHERE created_at < ? AND state <> 'awaiting_confirm'")
      .run(cutoff.toISOString());
    return Number(result.changes);
  }
}
