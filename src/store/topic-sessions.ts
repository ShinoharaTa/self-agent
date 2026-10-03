import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** セッションの状態。deleted はチャンネルを消した後も要約を残すための行 */
export type TopicSessionState = "active" | "waiting" | "done" | "deleted";

/** セッションの作られ方。command は /new・ホームパネル、inbox は #inbox での session_open */
export type TopicSessionOrigin = "command" | "inbox";

/** /new（ホームパネルを含む）や #inbox の session_open で作ったセッション（sessions）。会話の SDK session_id は SdkSessionStore（channel_sessions）が持つ */
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
  origin: TopicSessionOrigin;
  /** #system に投稿した削除の確認のメッセージ。投稿前・[残す] の後は null */
  deletePromptMessageId: string | null;
  /** チャンネルを削除した時刻。削除前は null */
  deletedAt: string | null;
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
  /** 省略すれば command */
  origin?: TopicSessionOrigin;
};

const STATES: readonly TopicSessionState[] = ["active", "waiting", "done", "deleted"];
const ORIGINS: readonly TopicSessionOrigin[] = ["command", "inbox"];

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toState(value: SQLOutputValue | undefined): TopicSessionState {
  const state = STATES.find((candidate) => candidate === value);
  if (state === undefined) throw new Error(`sessions.state が不正です: ${String(value)}`);
  return state;
}

function toOrigin(value: SQLOutputValue | undefined): TopicSessionOrigin {
  const origin = ORIGINS.find((candidate) => candidate === value);
  if (origin === undefined) throw new Error(`sessions.origin が不正です: ${String(value)}`);
  return origin;
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
    origin: toOrigin(row.origin),
    deletePromptMessageId: nullableString(row.delete_prompt_message_id),
    deletedAt: nullableString(row.deleted_at),
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

/** セッション用チャンネルの一覧（sessions）。src/store/sdk-sessions.ts の channel_sessions とは別 */
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
        "INSERT INTO sessions (channel_id, guild_id, title, state, category_id, created_at, last_activity_at, origin) " +
          "VALUES (?, ?, ?, 'active', ?, ?, ?, ?) RETURNING *",
      )
      .get(session.channelId, session.guildId, session.title, session.categoryId, at, at, session.origin ?? "command");
    return toSession(row!);
  }

  /** 最終発言の時刻を今にする。行が無ければ undefined */
  touch(channelId: string): TopicSession | undefined {
    const row = this.db
      .prepare("UPDATE sessions SET last_activity_at = ? WHERE channel_id = ? RETURNING *")
      .get(this.now().toISOString(), channelId);
    return row === undefined ? undefined : toSession(row);
  }

  /** 待ちにする: state を waiting にして waiting_since を今にする。行が無ければ undefined */
  setWaiting(channelId: string): TopicSession | undefined {
    const row = this.db
      .prepare("UPDATE sessions SET state = 'waiting', waiting_since = ? WHERE channel_id = ? RETURNING *")
      .get(this.now().toISOString(), channelId);
    return row === undefined ? undefined : toSession(row);
  }

  /**
   * 進行中に戻す: state を active にして waiting_since と closed_at、削除の確認の記録を消す（要約は残す。投稿済みの確認は以後効かない）。
   * 行が無ければ undefined
   */
  setActive(channelId: string): TopicSession | undefined {
    const row = this.db
      .prepare(
        "UPDATE sessions SET state = 'active', waiting_since = NULL, closed_at = NULL, delete_prompt_message_id = NULL " +
          "WHERE channel_id = ? RETURNING *",
      )
      .get(channelId);
    return row === undefined ? undefined : toSession(row);
  }

  /** 進行中で、最終発言の時刻が before 以前（ちょうどを含む）のセッションを、最終発言の古い順に limit 件まで */
  listIdle(before: Date, limit: number): TopicSession[] {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE state = 'active' AND last_activity_at <= ? " +
          "ORDER BY last_activity_at, channel_id LIMIT ?",
      )
      .all(before.toISOString(), limit)
      .map(toSession);
  }

  /**
   * そのサーバーのその状態のセッションを新しい順に limit 件まで（/sessions）。
   * 進行中・待ちは最終発言の時刻、完了は閉じた時刻の新しい順。削除済みは対象外
   */
  listByState(guildId: string, state: "active" | "waiting" | "done", limit: number): TopicSession[] {
    const orderBy = state === "done" ? "closed_at DESC" : "last_activity_at DESC";
    return this.db
      .prepare(`SELECT * FROM sessions WHERE guild_id = ? AND state = ? ORDER BY ${orderBy}, channel_id LIMIT ?`)
      .all(guildId, state, limit)
      .map(toSession);
  }

  /** そのサーバーの進行中・待ちのセッションを最終発言の新しい順に（session_open の同じ題名の確認） */
  listOpen(guildId: string): TopicSession[] {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE guild_id = ? AND state IN ('active', 'waiting') " +
          "ORDER BY last_activity_at DESC, channel_id",
      )
      .all(guildId)
      .map(toSession);
  }

  /** そのサーバーの削除済みでない（進行中・待ち・完了の）セッションを最終発言の新しい順に（カテゴリの再同期） */
  listUndeleted(guildId: string): TopicSession[] {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE guild_id = ? AND state IN ('active', 'waiting', 'done') " +
          "ORDER BY last_activity_at DESC, channel_id",
      )
      .all(guildId)
      .map(toSession);
  }

  /** その作られ方で since 以降（ちょうどを含む）に作ったセッションの数。全サーバー・削除済みを含めて数える */
  countCreatedSince(origin: TopicSessionOrigin, since: Date): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE origin = ? AND created_at >= ?")
      .get(origin, since.toISOString());
    return Number(row?.n ?? 0);
  }

  /** その作られ方で最後にセッションを作った時刻（全サーバー・削除済みを含む）。無ければ undefined */
  lastCreatedAt(origin: TopicSessionOrigin): Date | undefined {
    const row = this.db.prepare("SELECT MAX(created_at) AS at FROM sessions WHERE origin = ?").get(origin);
    const at = nullableString(row?.at);
    return at === null ? undefined : new Date(at);
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

  /**
   * 完了で、閉じた時刻が before 以前（ちょうどを含む）で、削除の確認をまだ投稿していないセッションを、閉じた時刻の古い順に limit 件まで
   */
  listDeleteDue(before: Date, limit: number): TopicSession[] {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE state = 'done' AND closed_at <= ? AND delete_prompt_message_id IS NULL " +
          "ORDER BY closed_at, channel_id LIMIT ?",
      )
      .all(before.toISOString(), limit)
      .map(toSession);
  }

  /** #system に投稿した削除の確認のメッセージを記録する（記録したセッションには投稿し直さない） */
  setDeletePrompt(channelId: string, messageId: string): void {
    this.db.prepare("UPDATE sessions SET delete_prompt_message_id = ? WHERE channel_id = ?").run(messageId, channelId);
  }

  /** [残す]: 閉じた時刻を今にして削除の確認の記録を消す（SELF_AGENT_DELETE_AFTER_DAYS 日後にもう一度確認する）。行が無ければ undefined */
  postponeDelete(channelId: string): TopicSession | undefined {
    const row = this.db
      .prepare("UPDATE sessions SET closed_at = ?, delete_prompt_message_id = NULL WHERE channel_id = ? RETURNING *")
      .get(this.now().toISOString(), channelId);
    return row === undefined ? undefined : toSession(row);
  }

  /** チャンネルを削除した: 削除済みにして削除した時刻を残す（要約は残す）。行が無ければ undefined */
  markDeleted(channelId: string): TopicSession | undefined {
    const row = this.db
      .prepare("UPDATE sessions SET state = 'deleted', deleted_at = ? WHERE channel_id = ? RETURNING *")
      .get(this.now().toISOString(), channelId);
    return row === undefined ? undefined : toSession(row);
  }
}
