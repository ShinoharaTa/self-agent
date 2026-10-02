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
  /** /close で残した要約。閉じる前は null */
  summary: string | null;
};

/** session_report の summary の文字数の上限 */
export const CLOSE_SUMMARY_MAX_LENGTH = 600;
/** session_report の tasks の件数の上限 */
export const CLOSE_TASKS_MAX = 10;

/** /close の確認待ちの下書き（session_report で受け取った要約とやることの候補）。sessions.close_draft に JSON で保存する */
export type CloseDraft = {
  summary: string;
  tasks: Array<{ title: string; due?: string }>;
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
    summary: nullableString(row.summary),
  };
}

function toCloseDraft(json: string): CloseDraft {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || !("summary" in value) || !("tasks" in value)) {
    throw new Error("sessions.close_draft が不正です");
  }
  const { summary, tasks } = value;
  if (typeof summary !== "string" || !Array.isArray(tasks)) throw new Error("sessions.close_draft が不正です");
  return {
    summary,
    tasks: tasks.map((task: unknown) => {
      if (typeof task !== "object" || task === null || !("title" in task) || typeof task.title !== "string") {
        throw new Error("sessions.close_draft が不正です");
      }
      return "due" in task && typeof task.due === "string" ? { title: task.title, due: task.due } : { title: task.title };
    }),
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

  /** 今置いているカテゴリを記録する。行が無ければ（セッション以外のチャンネルなら）何もしない */
  setCategory(channelId: string, categoryId: string): void {
    this.db.prepare("UPDATE sessions SET category_id = ? WHERE channel_id = ?").run(categoryId, channelId);
  }

  /** /close の確認待ちの下書きを保存する（前のものは置き換える）。行が無ければ false */
  saveCloseDraft(channelId: string, draft: CloseDraft): boolean {
    const result = this.db
      .prepare("UPDATE sessions SET close_draft = ? WHERE channel_id = ?")
      .run(JSON.stringify(draft), channelId);
    return Number(result.changes) > 0;
  }

  /** 確認待ちの下書き。無ければ undefined */
  getCloseDraft(channelId: string): CloseDraft | undefined {
    const row = this.db.prepare("SELECT close_draft FROM sessions WHERE channel_id = ?").get(channelId);
    const json = nullableString(row?.close_draft);
    return json === null ? undefined : toCloseDraft(json);
  }

  clearCloseDraft(channelId: string): void {
    this.db.prepare("UPDATE sessions SET close_draft = NULL WHERE channel_id = ?").run(channelId);
  }

  /** 閉じる: 完了にして閉じた時刻と要約を残し、下書きを消す。行が無ければ undefined */
  close(channelId: string, summary: string): TopicSession | undefined {
    const row = this.db
      .prepare(
        "UPDATE sessions SET state = 'done', closed_at = ?, summary = ?, close_draft = NULL WHERE channel_id = ? RETURNING *",
      )
      .get(this.now().toISOString(), summary, channelId);
    return row === undefined ? undefined : toSession(row);
  }
}
