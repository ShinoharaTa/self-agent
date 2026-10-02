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
  /** そのターンのツール呼び出しの回数（失敗した呼び出しを含む）。省略は 0 */
  toolCalls?: number;
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
  toolCalls: number;
};

/** ある時刻以降のターンの合計（/usage）。トークンは成功したターンの分だけ（失敗したターンは記録していない） */
export type UsageSummary = {
  turns: number;
  okTurns: number;
  failedTurns: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** compaction が起きたターンの数 */
  compactions: number;
  toolCalls: number;
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
    toolCalls: Number(row.tool_calls),
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
        "INSERT INTO usage_log (at, key, session_id, ok, duration_ms, input_tokens, cache_read_input_tokens, cache_creation_input_tokens, compacted, tool_calls) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        record.toolCalls ?? 0,
      );
  }

  /** 新しい順 */
  recent(limit: number): UsageEntry[] {
    return this.db.prepare("SELECT * FROM usage_log ORDER BY id DESC LIMIT ?").all(limit).map(toEntry);
  }

  /** since 以降（ちょうどを含む）に記録したターンを合計する */
  summarize(since: Date): UsageSummary {
    // at は toISOString（UTC・同じ桁数）で保存しているので、文字列の比較で時刻の前後を比べられる
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS turns, " +
          "COALESCE(SUM(ok), 0) AS ok_turns, " +
          "COALESCE(SUM(1 - ok), 0) AS failed_turns, " +
          "COALESCE(SUM(input_tokens), 0) AS input_tokens, " +
          "COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens, " +
          "COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens, " +
          "COALESCE(SUM(compacted), 0) AS compactions, " +
          "COALESCE(SUM(tool_calls), 0) AS tool_calls " +
          "FROM usage_log WHERE at >= ?",
      )
      .get(since.toISOString());
    return {
      turns: Number(row?.turns ?? 0),
      okTurns: Number(row?.ok_turns ?? 0),
      failedTurns: Number(row?.failed_turns ?? 0),
      inputTokens: Number(row?.input_tokens ?? 0),
      cacheReadInputTokens: Number(row?.cache_read_input_tokens ?? 0),
      cacheCreationInputTokens: Number(row?.cache_creation_input_tokens ?? 0),
      compactions: Number(row?.compactions ?? 0),
      toolCalls: Number(row?.tool_calls ?? 0),
    };
  }
}
