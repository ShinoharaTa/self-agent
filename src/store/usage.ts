import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

export type UsageRecord = {
  key: string;
  sessionId?: string;
  ok: boolean;
  durationMs?: number;
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** そのターンで compaction が起きたか。省略は false */
  compacted?: boolean;
};

export type UsageEntry = {
  id: number;
  at: string;
  key: string;
  sessionId: string | null;
  ok: boolean;
  durationMs: number | null;
  inputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  compacted: boolean;
};

function nullableNumber(value: SQLOutputValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toEntry(row: Record<string, SQLOutputValue>): UsageEntry {
  return {
    id: Number(row.id),
    at: String(row.at),
    key: String(row.key),
    sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    ok: Number(row.ok) === 1,
    durationMs: nullableNumber(row.duration_ms),
    inputTokens: nullableNumber(row.input_tokens),
    cacheReadInputTokens: nullableNumber(row.cache_read_input_tokens),
    cacheCreationInputTokens: nullableNumber(row.cache_creation_input_tokens),
    compacted: Number(row.compacted) === 1,
  };
}

/** ターンごとの所要時間とトークン使用量 */
export class UsageStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  record(record: UsageRecord): void {
    this.db
      .prepare(
        "INSERT INTO usage_log (at, key, session_id, ok, duration_ms, input_tokens, cache_read_input_tokens, cache_creation_input_tokens, compacted) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.now().toISOString(),
        record.key,
        record.sessionId ?? null,
        record.ok ? 1 : 0,
        record.durationMs ?? null,
        record.inputTokens ?? null,
        record.cacheReadInputTokens ?? null,
        record.cacheCreationInputTokens ?? null,
        record.compacted === true ? 1 : 0,
      );
  }

  /** 新しい順 */
  recent(limit: number): UsageEntry[] {
    return this.db.prepare("SELECT * FROM usage_log ORDER BY id DESC LIMIT ?").all(limit).map(toEntry);
  }
}
