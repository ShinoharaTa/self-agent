import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** #inbox の会話を切り替えたときに残した要約（inbox_summaries） */
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

/** サーバーごとの #inbox の要約。切り替えるたびに 1 行足し、消さない */
export class InboxSummaryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  add(guildId: string, date: string, summary: string): void {
    this.db
      .prepare("INSERT INTO inbox_summaries (guild_id, date, summary, created_at) VALUES (?, ?, ?, ?)")
      .run(guildId, date, summary, this.now().toISOString());
  }

  /** そのサーバーで最後に残した要約。まだ無ければ undefined */
  latest(guildId: string): InboxSummary | undefined {
    const row = this.db
      .prepare("SELECT * FROM inbox_summaries WHERE guild_id = ? ORDER BY id DESC LIMIT 1")
      .get(guildId);
    return row === undefined ? undefined : toSummary(row);
  }
}
