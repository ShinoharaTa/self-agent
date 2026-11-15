import type { DatabaseSync } from "node:sqlite";

/**
 * 既読（topic_reads。v44。docs/plan/web-ui-v3.md §3.3）。会話（チャンネル）ごとに、読んだ最後の history.id を 1 行。
 * 値は上がるだけ（advance は大きいときだけ書き換える）。行が無ければ 0（何も読んでいない）
 */
export class TopicReadStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** その会話の既読。行が無ければ 0 */
  get(channelId: string): number {
    const row = this.db.prepare("SELECT last_read_id FROM topic_reads WHERE channel_id = ?").get(channelId);
    return row === undefined ? 0 : Number(row.last_read_id);
  }

  /** 全部の行（key は channelId） */
  all(): Map<string, number> {
    const rows = this.db.prepare("SELECT channel_id, last_read_id FROM topic_reads").all();
    return new Map(rows.map((row) => [String(row.channel_id), Number(row.last_read_id)]));
  }

  /**
   * 既読を lastId まで進め、書いた後の値を返す。無ければ足し、あれば大きいときだけ書き換える（進まなければ updated_at も変えない）。
   * lastId が 1 以上の安全な整数でなければ RangeError
   */
  advance(channelId: string, lastId: number): number {
    if (!Number.isSafeInteger(lastId) || lastId < 1) throw new RangeError("lastId は 1 以上の整数にしてください");
    this.db
      .prepare(
        "INSERT INTO topic_reads (channel_id, last_read_id, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(channel_id) DO UPDATE SET last_read_id = excluded.last_read_id, updated_at = excluded.updated_at " +
          "WHERE excluded.last_read_id > topic_reads.last_read_id",
      )
      .run(channelId, lastId, this.now().toISOString());
    return this.get(channelId);
  }
}
