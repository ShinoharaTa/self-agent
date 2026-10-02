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

  set(key: string, sessionId: string): void {
    this.db
      .prepare(
        "INSERT INTO channel_sessions (key, session_id, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at",
      )
      .run(key, sessionId, this.now().toISOString());
  }

  /** resume できなくなった SDK セッションを捨てる。次のターンは新しいセッションになる */
  delete(key: string): void {
    this.db.prepare("DELETE FROM channel_sessions WHERE key = ?").run(key);
  }
}
