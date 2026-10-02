import type { DatabaseSync } from "node:sqlite";

/**
 * チャンネルの次のターンの prompt の先頭に付ける文（seed）。SDK セッションが無いチャンネルでだけ使い、ターンが成功したら消す。
 * resume できなくなった会話を要約から再開するときなどに入れる
 */
export class ChannelSeedStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  get(channelId: string): string | undefined {
    const row = this.db.prepare("SELECT text FROM channel_seeds WHERE channel_id = ?").get(channelId);
    return row === undefined ? undefined : String(row.text);
  }

  /** 既にあれば置き換える */
  set(channelId: string, text: string): void {
    this.db
      .prepare(
        "INSERT INTO channel_seeds (channel_id, text, created_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (channel_id) DO UPDATE SET text = excluded.text, created_at = excluded.created_at",
      )
      .run(channelId, text, this.now().toISOString());
  }

  delete(channelId: string): void {
    this.db.prepare("DELETE FROM channel_seeds WHERE channel_id = ?").run(channelId);
  }
}
