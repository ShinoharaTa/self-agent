import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** セッションの状態。deleted はチャンネルを消した後も要約を残すための行 */
export type TopicSessionState = "active" | "waiting" | "done" | "deleted";

/** /new で作ったセッション（sessions）。会話の SDK session_id は SessionStore（channel_sessions）が持つ */
export type TopicSession = {
  channelId: string;
  guildId: string;
  /** /new で付けた元の題名（チャンネル名は正規化したもの） */
  title: string;
  state: TopicSessionState;
  /** 今置いているカテゴリ */
  categoryId: string;
  createdAt: string;
  /** オーナーが最後に発言した時刻 */
  lastActivityAt: string;
  waitingSince: string | null;
  closedAt: string | null;
};

export type NewTopicSession = {
  channelId: string;
  guildId: string;
  title: string;
  categoryId: string;
};

const STATES: readonly TopicSessionState[] = ["active", "waiting", "done", "deleted"];

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toState(value: SQLOutputValue | undefined): TopicSessionState {
  const state = STATES.find((candidate) => candidate === value);
  if (state === undefined) throw new Error(`sessions.state が不正です: ${String(value)}`);
  return state;
}

function toSession(row: Record<string, SQLOutputValue>): TopicSession {
  return {
    channelId: String(row.channel_id),
    guildId: String(row.guild_id),
    title: String(row.title),
    state: toState(row.state),
    categoryId: String(row.category_id),
    createdAt: String(row.created_at),
    lastActivityAt: String(row.last_activity_at),
    waitingSince: nullableString(row.waiting_since),
    closedAt: nullableString(row.closed_at),
  };
}

/** セッション用チャンネルの一覧（sessions）。src/store/sessions.ts の channel_sessions とは別 */
export class TopicSessionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  get(channelId: string): TopicSession | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE channel_id = ?").get(channelId);
    return row === undefined ? undefined : toSession(row);
  }

  /** 進行中のセッションとして保存する。最終発言の時刻は作成時刻にする */
  create(session: NewTopicSession): TopicSession {
    const at = this.now().toISOString();
    const row = this.db
      .prepare(
        "INSERT INTO sessions (channel_id, guild_id, title, state, category_id, created_at, last_activity_at) " +
          "VALUES (?, ?, ?, 'active', ?, ?, ?) RETURNING *",
      )
      .get(session.channelId, session.guildId, session.title, session.categoryId, at, at);
    return toSession(row!);
  }

  /** 最終発言の時刻を今にする。行が無ければ undefined */
  touch(channelId: string): TopicSession | undefined {
    const row = this.db
      .prepare("UPDATE sessions SET last_activity_at = ? WHERE channel_id = ? RETURNING *")
      .get(this.now().toISOString(), channelId);
    return row === undefined ? undefined : toSession(row);
  }
}
