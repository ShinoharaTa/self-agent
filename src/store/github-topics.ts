import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** github_topics の 1 行 */
export type GithubTopicRow = {
  id: number;
  /** github_notifications の行の番号 */
  notificationId: number;
  threadId: string;
  /** ［対応］で作った話題のチャンネル */
  channelId: string;
  /** 作った時刻（ISO の文字列） */
  createdAt: string;
};

function toRow(row: Record<string, SQLOutputValue>): GithubTopicRow {
  return {
    id: Number(row.id),
    notificationId: Number(row.notification_id),
    threadId: String(row.thread_id),
    channelId: String(row.channel_id),
    createdAt: String(row.created_at),
  };
}

/**
 * GitHub の［対応］で作った話題（github_topics。v46。docs/plan/terminal-handover.md §3.2）。スレッド → 話題のチャンネル。
 * 同じスレッドに行が複数あれば新しい行（id の大きい方）が勝つ。本文・題名・リポジトリ名は置かない
 */
export class GithubTopicStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 行を足して id を返す */
  add(input: { notificationId: number; threadId: string; channelId: string; at: Date }): number {
    const row = this.db
      .prepare("INSERT INTO github_topics (notification_id, thread_id, channel_id, created_at) VALUES (?, ?, ?, ?) RETURNING id")
      .get(input.notificationId, input.threadId, input.channelId, input.at.toISOString());
    return Number(row!.id);
  }

  /** そのスレッドの一番新しい行。無ければ undefined */
  latestForThread(threadId: string): GithubTopicRow | undefined {
    const row = this.db.prepare("SELECT * FROM github_topics WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(threadId);
    return row === undefined ? undefined : toRow(row);
  }
}
