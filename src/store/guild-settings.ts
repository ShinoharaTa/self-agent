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
export type PersonaChannelKind = "inbox" | "tasks";

/** 入口のチャンネル（persona_channels の行）がどのサーバー・人格・種類のものか */
export type EntryChannel = { guildId: string; persona: string; kind: PersonaChannelKind };

/** 足した人格の #<NAME>（persona_channels の kind 'inbox' の行）と、その切り替えの日・時刻 */
export type PersonaInbox = {
  /** まだ作っていなければ null */
  channelId: string | null;
  /** 最後に切り替えた日（SELF_AGENT_TZ の日付、YYYY-MM-DD）。まだ切り替えていなければ null */
  rotatedDate: string | null;
  /** 最後に切り替えた時刻（ISO）。まだ切り替えていなければ null */
  rotatedAt: string | null;
};

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
 * #inbox・#tasks の ID と切り替えの日・時刻は既定の人格の persona_channels の行に、足した人格の #<NAME> はその人格の行（kind inbox）に読み書きする
 * （guild_settings の行が無ければ /setup 前のまま）
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

  /** その入口のチャンネル（persona_channels の行）のサーバー・人格・種類。入口のチャンネルでなければ undefined */
  entryChannel(channelId: string): EntryChannel | undefined {
    const row = this.db.prepare("SELECT guild_id, persona, kind FROM persona_channels WHERE channel_id = ?").get(channelId);
    if (row === undefined) return undefined;
    return { guildId: String(row.guild_id), persona: String(row.persona), kind: row.kind === "tasks" ? "tasks" : "inbox" };
  }

  /** そのサーバーのその人格の #inbox（足した人格は #<NAME>）の行。まだ無ければ undefined */
  personaInbox(guildId: string, persona: string): PersonaInbox | undefined {
    const row = this.db
      .prepare("SELECT channel_id, rotated_date, rotated_at FROM persona_channels WHERE guild_id = ? AND persona = ? AND kind = 'inbox'")
      .get(guildId, persona);
    if (row === undefined) return undefined;
    return {
      channelId: nullableString(row.channel_id),
      rotatedDate: nullableString(row.rotated_date),
      rotatedAt: nullableString(row.rotated_at),
    };
  }

  /** 足した人格の #<NAME> のチャンネルの ID を保存する（/setup）。行が無ければ作る */
  setPersonaInbox(guildId: string, persona: string, channelId: string): void {
    this.setPersonaChannel(guildId, "inbox", { channel_id: channelId }, persona);
  }

  /** その入口のチャンネル（persona_channels の行）の持ち主の人格の id。入口のチャンネルでなければ undefined */
  personaOfChannel(channelId: string): string | undefined {
    const row = this.db.prepare("SELECT persona FROM persona_channels WHERE channel_id = ?").get(channelId);
    return row === undefined ? undefined : String(row.persona);
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

  /** #inbox（persona が足した人格なら #<NAME>）の会話を切り替えた日（YYYY-MM-DD）と時刻（rotatedAt）を保存する。行が無ければ作る */
  setInboxRotated(guildId: string, date: string, rotatedAt: Date, persona: string = DEFAULT_PERSONA_ID): void {
    this.setPersonaChannel(guildId, "inbox", { rotated_date: date, rotated_at: rotatedAt.toISOString() }, persona);
  }

  /** #tasks の会話を切り替えた時刻（rotatedAt）を保存する。行が無ければ作る */
  setTasksRotated(guildId: string, rotatedAt: Date): void {
    this.setPersonaChannel(guildId, "tasks", { rotated_at: rotatedAt.toISOString() });
  }

  /**
   * 入口のチャンネルの行（persona_channels。persona を省略したら既定の人格）に values の列だけを保存する。どちらの表も行が無ければ作り、
   * guild_settings の updated_at も今にする（guild_settings の行があることが /setup 済みの印なので、今までどおり作る）
   */
  private setPersonaChannel(
    guildId: string,
    kind: PersonaChannelKind,
    values: Partial<Record<"channel_id" | "rotated_date" | "rotated_at", string>>,
    persona: string = DEFAULT_PERSONA_ID,
  ): void {
    const at = this.now().toISOString();
    const columns = Object.keys(values);
    const updates = columns.map((column) => `${column} = excluded.${column}`).join(", ");
    // 2 つの表を 1 つのトランザクションで書く（片方だけ書かれた状態を残さない）
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO guild_settings (guild_id, created_at, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT (guild_id) DO UPDATE SET updated_at = excluded.updated_at",
        )
        .run(guildId, at, at);
      this.db
        .prepare(
          `INSERT INTO persona_channels (guild_id, persona, kind, ${columns.join(", ")}, created_at, updated_at) ` +
            `VALUES (?, ?, ?, ${columns.map(() => "?").join(", ")}, ?, ?) ` +
            `ON CONFLICT (guild_id, persona, kind) DO UPDATE SET ${updates}, updated_at = excluded.updated_at`,
        )
        .run(guildId, persona, kind, ...Object.values(values), at, at);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
