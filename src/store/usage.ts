import type { DatabaseSync, SQLOutputValue, SQLInputValue } from "node:sqlite";
import type { StepUsage } from "../agent/runner.ts";
import { formatDate } from "../app/time.ts";
import { DEFAULT_PERSONA_ID, type Engine } from "../config.ts";

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
  /** そのターンの最後のステップの入力（input + cache read + cache creation）。省略は 0 */
  contextTokens?: number;
  /** ターンの種類（inbox・session-renew など、ログ用のラベル。ID は入れない）。省略は NULL */
  kind?: string;
  /** そのターンのメインループの出力の合計（成功したターンだけ）。省略は NULL */
  outputTokens?: number;
  /** cacheCreationInputTokens のうち 1 時間のキャッシュの分 */
  cacheCreation1hInputTokens?: number;
  /** メインループのステップごとの入力側のトークン（起きた順）。省略・null は NULL */
  steps?: readonly StepUsage[] | null;
  /** ターンを動かした人格の id。省略は既定の人格 */
  persona?: string;
  /** ターンを動かしたエンジン。省略は claude */
  engine?: Engine;
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
  contextTokens: number;
  /** v17 より前の行は null（以下 3 つも同じ） */
  kind: string | null;
  /** 失敗したターンも null */
  outputTokens: number | null;
  cacheCreation1hInputTokens: number | null;
  /** JSON として読めない・形が違うときも null */
  steps: StepUsage[] | null;
};

/** listRecent の範囲。since はちょうどを含み、until はちょうどを含まない。kind は完全一致 */
export type UsageListOptions = { since?: Date; until?: Date; kind?: string; limit: number };

/** 日付（timeZone）ごとのターン数と入力の合計（listDays） */
export type UsageDay = { date: string; turns: number; inputTokens: number };

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

/** steps 列の 1 要素（input・read・creation・creation 1h）。出力は持たない */
type StoredStep = { i: number; r: number; w: number; w1h: number };

function stepsToJson(steps: readonly StepUsage[]): string {
  return JSON.stringify(
    steps.map(
      (step): StoredStep => ({
        i: step.inputTokens,
        r: step.cacheReadInputTokens,
        w: step.cacheCreationInputTokens,
        w1h: step.cacheCreation1hInputTokens,
      }),
    ),
  );
}

/** steps 列を読む。NULL・JSON として読めない・形が違う（i・r・w・w1h に数でない値がある）なら null。それ以外の項目（以前書いた o など）は無視する */
function stepsFromJson(value: SQLOutputValue | undefined): StepUsage[] | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const steps: StepUsage[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return null;
    const { i, r, w, w1h } = item as Record<string, unknown>;
    if (![i, r, w, w1h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    steps.push({
      inputTokens: i as number,
      cacheReadInputTokens: r as number,
      cacheCreationInputTokens: w as number,
      cacheCreation1hInputTokens: w1h as number,
    });
  }
  return steps;
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
    contextTokens: Number(row.context_tokens),
    kind: row.kind === null || row.kind === undefined ? null : String(row.kind),
    outputTokens: nullableNumber(row.output_tokens),
    cacheCreation1hInputTokens: nullableNumber(row.cache_creation_1h_tokens),
    steps: stepsFromJson(row.steps),
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
        "INSERT INTO usage_log (at, key, session_id, ok, duration_ms, input_tokens, cache_read_input_tokens, cache_creation_input_tokens, compacted, tool_calls, context_tokens, " +
          "kind, output_tokens, cache_creation_1h_tokens, steps, persona, engine) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        record.contextTokens ?? 0,
        record.kind ?? null,
        record.outputTokens ?? null,
        record.cacheCreation1hInputTokens ?? null,
        record.steps === undefined || record.steps === null ? null : stepsToJson(record.steps),
        record.persona ?? DEFAULT_PERSONA_ID,
        record.engine ?? "claude",
      );
  }

  /** 新しい順 */
  recent(limit: number): UsageEntry[] {
    return this.db.prepare("SELECT * FROM usage_log ORDER BY id DESC LIMIT ?").all(limit).map(toEntry);
  }

  /** 範囲（記録した時刻 at）の中の新しい limit 件を、古い順に返す */
  listRecent(options: UsageListOptions): UsageEntry[] {
    // at は toISOString（UTC・同じ桁数）なので文字列で比べる。同じ時刻は id で並べる
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.since !== undefined) {
      conditions.push("at >= ?");
      params.push(options.since.toISOString());
    }
    if (options.until !== undefined) {
      conditions.push("at < ?");
      params.push(options.until.toISOString());
    }
    if (options.kind !== undefined) {
      conditions.push("kind = ?");
      params.push(options.kind);
    }
    const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
    return this.db
      .prepare(`SELECT * FROM usage_log${where} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...params, options.limit)
      .map(toEntry)
      .reverse();
  }

  /** その key のターン（成否を問わない）のうち、after より後（ちょうどは含まない）に記録した数。after が無ければすべて数える */
  countAfter(key: string, after: Date | undefined): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS turns FROM usage_log WHERE key = ? AND at > ?")
      .get(key, after === undefined ? "" : after.toISOString());
    return Number(row?.turns ?? 0);
  }

  /** その key の成功したターンのうち、after より後（ちょうどは含まない）に記録した最新のもの。after が無ければすべてから選ぶ */
  latestOkAfter(key: string, after: Date | undefined): UsageEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM usage_log WHERE key = ? AND ok = 1 AND at > ? ORDER BY id DESC LIMIT 1")
      .get(key, after === undefined ? "" : after.toISOString());
    return row === undefined ? undefined : toEntry(row);
  }

  /**
   * since 以降（ちょうどを含む）に記録したその人格のターンの出力の合計（成功したターンだけ。/usage のゲストの行）。
   * until を渡せばその前（ちょうどは含まない）まで（Web UI の日付ごとの合計）
   */
  sumOutputTokens(since: Date, persona: string, until?: Date): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(output_tokens), 0) AS output_tokens FROM usage_log WHERE at >= ? AND persona = ?" +
          (until === undefined ? "" : " AND at < ?"),
      )
      .get(since.toISOString(), persona, ...(until === undefined ? [] : [until.toISOString()]));
    return Number(row?.output_tokens ?? 0);
  }

  /**
   * since 以降（ちょうどを含む）に記録したターンを合計する。persona を渡せばその人格のターンだけ。
   * until を渡せばその前（ちょうどは含まない）まで（Web UI の日付ごとの合計）
   */
  summarize(since: Date, persona?: string, until?: Date): UsageSummary {
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
          `FROM usage_log WHERE at >= ?${persona === undefined ? "" : " AND persona = ?"}${until === undefined ? "" : " AND at < ?"}`,
      )
      .get(
        since.toISOString(),
        ...(persona === undefined ? [] : [persona]),
        ...(until === undefined ? [] : [until.toISOString()]),
      );
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

  /**
   * since 以降（ちょうどを含む）のターンを、記録した時刻の timeZone の日付ごとに数える（Web UI の使用量の日ごとの表）。
   * 入力は input + cache read + cache creation（失敗したターンは 0）。記録のある日だけを日付の古い順に返す
   */
  listDays(since: Date, timeZone: string): UsageDay[] {
    const rows = this.db
      .prepare(
        "SELECT at, COALESCE(input_tokens, 0) + COALESCE(cache_read_input_tokens, 0) + COALESCE(cache_creation_input_tokens, 0) AS input " +
          "FROM usage_log WHERE at >= ? ORDER BY at, id",
      )
      .all(since.toISOString());
    const days = new Map<string, UsageDay>();
    for (const row of rows) {
      const date = formatDate(new Date(String(row.at)), timeZone);
      const day = days.get(date) ?? { date, turns: 0, inputTokens: 0 };
      day.turns++;
      day.inputTokens += Number(row.input);
      days.set(date, day);
    }
    return [...days.values()];
  }
}
