import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { DEFAULT_PERSONA_ID } from "../config.ts";

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

/** guild_settings に残る列 */
const CHANNEL_COLUMNS: Record<"homeCategoryId" | "systemChannelId", string> = {
  homeCategoryId: "home_category_id",
  systemChannelId: "system_channel_id",
};

/** 入口のチャンネルの種類（persona_channels.kind）。足した人格の #<NAME> は inbox */
type PersonaChannelKind = "inbox" | "tasks";

/** persona_channels（既定の人格の行）に置く入口のチャンネル */
const PERSONA_CHANNEL_KINDS: Record<"inboxChannelId" | "tasksChannelId", PersonaChannelKind> = {
  inboxChannelId: "inbox",
  tasksChannelId: "tasks",
};

// guild_settings の行に、既定の人格の #inbox・#tasks の行（persona_channels）を元の列名で付ける
const SELECT_SETTINGS =
  "SELECT g.*, i.channel_id AS inbox_channel_id, i.rotated_date AS inbox_rotated_date, i.rotated_at AS inbox_rotated_at, " +
  "t.channel_id AS tasks_channel_id, t.rotated_at AS tasks_rotated_at FROM guild_settings g " +
  "LEFT JOIN persona_channels i ON i.guild_id = g.guild_id AND i.persona = ? AND i.kind = 'inbox' " +
  "LEFT JOIN persona_channels t ON t.guild_id = g.guild_id AND t.persona = ? AND t.kind = 'tasks' " +
  "WHERE g.guild_id = ?";

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

/**
 * サーバーごとの設定（guild_settings）と状態カテゴリ（state_categories）。
 * #inbox・#tasks の ID と切り替えの日・時刻は既定の人格の persona_channels の行に読み書きする（guild_settings の行が無ければ /setup 前のまま）
 */
export class GuildSettingsStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** /setup を一度も実行していないサーバーは undefined */
  get(guildId: string): GuildSettings | undefined {
    const row = this.db.prepare(SELECT_SETTINGS).get(DEFAULT_PERSONA_ID, DEFAULT_PERSONA_ID, guildId);
    return row === undefined ? undefined : toSettings(row);
  }

  /** カテゴリ・チャンネルの ID を 1 つ保存する。行が無ければ作る */
  setChannel(guildId: string, field: GuildChannelField, channelId: string): void {
    if (field === "inboxChannelId" || field === "tasksChannelId") {
      this.setPersonaChannel(guildId, PERSONA_CHANNEL_KINDS[field], { channel_id: channelId });
      return;
    }
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
    this.setPersonaChannel(guildId, "inbox", { rotated_date: date, rotated_at: rotatedAt.toISOString() });
  }

  /** #tasks の会話を切り替えた時刻（rotatedAt）を保存する。行が無ければ作る */
  setTasksRotated(guildId: string, rotatedAt: Date): void {
    this.setPersonaChannel(guildId, "tasks", { rotated_at: rotatedAt.toISOString() });
  }

  /**
   * 既定の人格の入口のチャンネルの行（persona_channels）に values の列だけを保存する。どちらの表も行が無ければ作り、
   * guild_settings の updated_at も今にする（guild_settings の行があることが /setup 済みの印なので、今までどおり作る）
   */
  private setPersonaChannel(
    guildId: string,
    kind: PersonaChannelKind,
    values: Partial<Record<"channel_id" | "rotated_date" | "rotated_at", string>>,
  ): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        "INSERT INTO guild_settings (guild_id, created_at, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (guild_id) DO UPDATE SET updated_at = excluded.updated_at",
      )
      .run(guildId, at, at);
    const columns = Object.keys(values);
    const updates = columns.map((column) => `${column} = excluded.${column}`).join(", ");
    this.db
      .prepare(
        `INSERT INTO persona_channels (guild_id, persona, kind, ${columns.join(", ")}, created_at, updated_at) ` +
          `VALUES (?, ?, ?, ${columns.map(() => "?").join(", ")}, ?, ?) ` +
          `ON CONFLICT (guild_id, persona, kind) DO UPDATE SET ${updates}, updated_at = excluded.updated_at`,
      )
      .run(guildId, DEFAULT_PERSONA_ID, kind, ...Object.values(values), at, at);
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
