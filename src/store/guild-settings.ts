import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** 状態カテゴリの種類（進行中 / 待ち / 完了） */
export type SessionState = "active" | "waiting" | "done";

/** /setup が self-agent カテゴリまわりで作るもの。null はまだ作っていない（途中で失敗した） */
export type GuildSettings = {
  guildId: string;
  homeCategoryId: string | null;
  inboxChannelId: string | null;
  tasksChannelId: string | null;
  systemChannelId: string | null;
  /** #inbox に投稿してピン留めしたホームパネルのメッセージ */
  homePanelMessageId: string | null;
  /** #inbox の会話を最後に切り替えた日（SELF_AGENT_TZ の日付、YYYY-MM-DD）。まだ切り替えていなければ null */
  inboxRotatedDate: string | null;
  /** #inbox の会話を最後に切り替えた時刻（ISO）。まだ切り替えていなければ（v11 より前に切り替えた分も）null */
  inboxRotatedAt: string | null;
  /** #tasks の会話を最後に切り替えた時刻（ISO。日付はこの時刻から SELF_AGENT_TZ で求める）。まだ切り替えていなければ null */
  tasksRotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GuildChannelField = "homeCategoryId" | "inboxChannelId" | "tasksChannelId" | "systemChannelId";

const CHANNEL_COLUMNS: Record<GuildChannelField, string> = {
  homeCategoryId: "home_category_id",
  inboxChannelId: "inbox_channel_id",
  tasksChannelId: "tasks_channel_id",
  systemChannelId: "system_channel_id",
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toSettings(row: Record<string, SQLOutputValue>): GuildSettings {
  return {
    guildId: String(row.guild_id),
    homeCategoryId: nullableString(row.home_category_id),
    inboxChannelId: nullableString(row.inbox_channel_id),
    tasksChannelId: nullableString(row.tasks_channel_id),
    systemChannelId: nullableString(row.system_channel_id),
    homePanelMessageId: nullableString(row.home_panel_message_id),
    inboxRotatedDate: nullableString(row.inbox_rotated_date),
    inboxRotatedAt: nullableString(row.inbox_rotated_at),
    tasksRotatedAt: nullableString(row.tasks_rotated_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** サーバーごとの設定（guild_settings）と状態カテゴリ（state_categories） */
export class GuildSettingsStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** /setup を一度も実行していないサーバーは undefined */
  get(guildId: string): GuildSettings | undefined {
    const row = this.db.prepare("SELECT * FROM guild_settings WHERE guild_id = ?").get(guildId);
    return row === undefined ? undefined : toSettings(row);
  }

  /** カテゴリ・チャンネルの ID を 1 つ保存する。行が無ければ作る */
  setChannel(guildId: string, field: GuildChannelField, channelId: string): void {
    const column = CHANNEL_COLUMNS[field];
    const at = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, ${column}, created_at, updated_at) VALUES (?, ?, ?, ?) ` +
          `ON CONFLICT (guild_id) DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at`,
      )
      .run(guildId, channelId, at, at);
  }

  /** ホームパネルのメッセージ ID を保存する。行が無ければ作る */
  setHomePanelMessageId(guildId: string, messageId: string): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        "INSERT INTO guild_settings (guild_id, home_panel_message_id, created_at, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (guild_id) DO UPDATE SET home_panel_message_id = excluded.home_panel_message_id, updated_at = excluded.updated_at",
      )
      .run(guildId, messageId, at, at);
  }

  /** #inbox の会話を切り替えた日（YYYY-MM-DD）と時刻（rotatedAt）を保存する。行が無ければ作る */
  setInboxRotated(guildId: string, date: string, rotatedAt: Date): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        "INSERT INTO guild_settings (guild_id, inbox_rotated_date, inbox_rotated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT (guild_id) DO UPDATE SET inbox_rotated_date = excluded.inbox_rotated_date, " +
          "inbox_rotated_at = excluded.inbox_rotated_at, updated_at = excluded.updated_at",
      )
      .run(guildId, date, rotatedAt.toISOString(), at, at);
  }

  /** #tasks の会話を切り替えた時刻（rotatedAt）を保存する。行が無ければ作る */
  setTasksRotated(guildId: string, rotatedAt: Date): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        "INSERT INTO guild_settings (guild_id, tasks_rotated_at, created_at, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (guild_id) DO UPDATE SET tasks_rotated_at = excluded.tasks_rotated_at, updated_at = excluded.updated_at",
      )
      .run(guildId, rotatedAt.toISOString(), at, at);
  }

  getStateCategory(guildId: string, state: SessionState, ordinal: number): string | undefined {
    const row = this.db
      .prepare("SELECT category_id FROM state_categories WHERE guild_id = ? AND state = ? AND ordinal = ?")
      .get(guildId, state, ordinal);
    return row === undefined ? undefined : String(row.category_id);
  }

  /** その状態のカテゴリを ordinal の昇順で返す */
  listStateCategories(guildId: string, state: SessionState): Array<{ ordinal: number; categoryId: string }> {
    return this.db
      .prepare("SELECT ordinal, category_id FROM state_categories WHERE guild_id = ? AND state = ? ORDER BY ordinal")
      .all(guildId, state)
      .map((row) => ({ ordinal: Number(row.ordinal), categoryId: String(row.category_id) }));
  }

  /** 状態カテゴリの ID を保存する。同じ (state, ordinal) があれば作り直したカテゴリで置き換える */
  setStateCategory(guildId: string, state: SessionState, ordinal: number, categoryId: string): void {
    this.db
      .prepare(
        "INSERT INTO state_categories (guild_id, state, ordinal, category_id, created_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT (guild_id, state, ordinal) DO UPDATE SET category_id = excluded.category_id, created_at = excluded.created_at",
      )
      .run(guildId, state, ordinal, categoryId, this.now().toISOString());
  }
}
