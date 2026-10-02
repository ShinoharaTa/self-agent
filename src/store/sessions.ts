import type { DatabaseSync } from "node:sqlite";

/** 会話の単位（P1 はチャンネル ID、P2 からスレッド ID）→ Agent SDK の session_id */
export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  get(key: string): string | undefined {
    const row = this.db.prepare("SELECT session_id FROM channel_sessions WHERE key = ?").get(key);
    return row === undefined ? undefined : String(row.session_id);
  }

  /** 保存する（置き換える）。連続失敗の回数は 0 に戻す */
  set(key: string, sessionId: string): void {
    this.db
      .prepare(
        "INSERT INTO channel_sessions (key, session_id, updated_at, failure_count) VALUES (?, ?, ?, 0) " +
          "ON CONFLICT (key) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at, failure_count = 0",
      )
      .run(key, sessionId, this.now().toISOString());
  }

  /** 保存している SDK セッションでの連続失敗を 1 つ数え、数えた後の回数を返す。行が無ければ 0 */
  recordFailure(key: string): number {
    const row = this.db
      .prepare("UPDATE channel_sessions SET failure_count = failure_count + 1 WHERE key = ? RETURNING failure_count")
      .get(key);
    return row === undefined ? 0 : Number(row.failure_count);
  }

  /** 保存している SDK セッションでの連続失敗の回数。行が無ければ 0 */
  failureCount(key: string): number {
    const row = this.db.prepare("SELECT failure_count FROM channel_sessions WHERE key = ?").get(key);
    return row === undefined ? 0 : Number(row.failure_count);
  }

  /** resume できなくなった SDK セッションを捨てる。次のターンは新しいセッションになる */
  delete(key: string): void {
    this.db.prepare("DELETE FROM channel_sessions WHERE key = ?").run(key);
  }
}
