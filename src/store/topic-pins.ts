import type { DatabaseSync } from "node:sqlite";

/** 留められる話題の数（GET /api/topics の pinMax。数えるのは生きている物だけ。見るのは API で、ストアは上限を知らない） */
export const TOPIC_PIN_MAX = 4;

/**
 * 話題のピン留め（topic_pins。v48。#507）。会話（チャンネル）ごとに 1 行で、足した順（position）に並ぶ。
 * 完了・削除で行は消さない（生きている物を選ぶのは web/routes/topics.ts の pinsOfResult）
 */
export class TopicPinStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** 留めた会話の channelId。position の小さい順（同じなら created_at・channel_id の順） */
  all(): string[] {
    const rows = this.db.prepare("SELECT channel_id FROM topic_pins ORDER BY position, created_at, channel_id").all();
    return rows.map((row) => String(row.channel_id));
  }

  /** その会話を留めているか */
  has(channelId: string): boolean {
    return this.db.prepare("SELECT 1 FROM topic_pins WHERE channel_id = ?").get(channelId) !== undefined;
  }

  /** 無ければ末尾（今の最大の position + 1）に足す。在れば何もしない（position も created_at も変えない） */
  add(channelId: string): void {
    this.db
      .prepare(
        "INSERT INTO topic_pins (channel_id, position, created_at) " +
          "SELECT ?, COALESCE(MAX(position), 0) + 1, ? FROM topic_pins WHERE true " +
          "ON CONFLICT(channel_id) DO NOTHING",
      )
      .run(channelId, this.now().toISOString());
  }

  /** 外す。留めていなくても投げない */
  remove(channelId: string): void {
    this.db.prepare("DELETE FROM topic_pins WHERE channel_id = ?").run(channelId);
  }
}
