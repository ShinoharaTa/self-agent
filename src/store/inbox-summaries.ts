import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { DEFAULT_PERSONA_ID } from "../config.ts";

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

/**
 * サーバーごと・人格ごと・チャンネル（#inbox / #tasks）ごとの要約。切り替えるたびに 1 行足し、消さない。
 * channelKind を省略したら #inbox、persona を省略したら既定の人格
 */
export class InboxSummaryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  add(
    guildId: string,
    date: string,
    summary: string,
    channelKind: SummaryChannelKind = "inbox",
    persona: string = DEFAULT_PERSONA_ID,
  ): void {
    this.db
      .prepare(
        "INSERT INTO inbox_summaries (guild_id, date, summary, created_at, channel_kind, persona) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(guildId, date, summary, this.now().toISOString(), channelKind, persona);
  }

  /** そのサーバーのその人格のそのチャンネルで最後に残した要約。まだ無ければ undefined */
  latest(guildId: string, channelKind: SummaryChannelKind = "inbox", persona: string = DEFAULT_PERSONA_ID): InboxSummary | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM inbox_summaries WHERE guild_id = ? AND channel_kind = ? AND persona = ? ORDER BY id DESC LIMIT 1",
      )
      .get(guildId, channelKind, persona);
    return row === undefined ? undefined : toSummary(row);
  }
}
