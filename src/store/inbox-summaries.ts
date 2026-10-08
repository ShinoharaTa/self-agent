import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** 会話を切り替えて要約を残すチャンネルの種類（/setup 済みのサーバーの #inbox と #tasks。inbox_summaries.channel_kind） */
export type SummaryChannelKind = "inbox" | "tasks";

/** #inbox・#tasks の会話を切り替えたときに残した要約（inbox_summaries） */
export type InboxSummary = {
  id: number;
  guildId: string;
  /** 切り替えた日（SELF_AGENT_TZ の日付、YYYY-MM-DD） */
  date: string;
  summary: string;
  createdAt: string;
};

function toSummary(row: Record<string, SQLOutputValue>): InboxSummary {
  return {
    id: Number(row.id),
    guildId: String(row.guild_id),
    date: String(row.date),
    summary: String(row.summary),
    createdAt: String(row.created_at),
  };
}

/** サーバーごと・チャンネル（#inbox / #tasks）ごとの要約。切り替えるたびに 1 行足し、消さない。channelKind を省略したら #inbox */
export class InboxSummaryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  add(guildId: string, date: string, summary: string, channelKind: SummaryChannelKind = "inbox"): void {
    this.db
      .prepare("INSERT INTO inbox_summaries (guild_id, date, summary, created_at, channel_kind) VALUES (?, ?, ?, ?, ?)")
      .run(guildId, date, summary, this.now().toISOString(), channelKind);
  }

  /** そのサーバーのそのチャンネルで最後に残した要約。まだ無ければ undefined */
  latest(guildId: string, channelKind: SummaryChannelKind = "inbox"): InboxSummary | undefined {
    const row = this.db
      .prepare("SELECT * FROM inbox_summaries WHERE guild_id = ? AND channel_kind = ? ORDER BY id DESC LIMIT 1")
      .get(guildId, channelKind);
    return row === undefined ? undefined : toSummary(row);
  }
}
