// dev モード（SELF_AGENT_DEV_MODE=1）の会話ログ。run ごとに 1 行の JSON を `<dataDir>/devlog/<YYYY-MM-DD>.jsonl` に追記し、古い日のファイルを消す。
// Agent SDK に依存しない（SDK のメッセージから steps を作るのは sdk-runner.ts）。
// console のログと違い、このファイルには本文・チャンネル ID を含む（ローカルのファイル。リポジトリには入れない）
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Compaction, RunContext, RunResult, TurnUsage } from "../agent/runner.ts";
import { clip } from "../app/summary.ts";
import { formatDate, startOfLocalDay } from "../app/time.ts";
import type { Config } from "../config.ts";

/** これより長い文字列は切る（prompt と result.text は切らない） */
export const DEV_LOG_TEXT_LIMIT = 2000;

/** run の中で起きたこと 1 つ。thinking の中身は残さない */
export type DevLogStep =
  | { t: "text"; text: string }
  /** input は JSON の値。文字列化して DEV_LOG_TEXT_LIMIT を超えるなら、文字列化したものを切った文字列 */
  | { t: "tool_use"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; isError: boolean; content: string }
  | { t: "compact"; trigger: string; preTokens: number | null };

/** RunResult から durationMs を除いたもの（所要時間は記録の durationMs） */
export type DevLogResult =
  | {
      ok: true;
      text: string;
      sessionId: string;
      usage: TurnUsage;
      toolCalls: number;
      contextTokens: number;
      compacted?: Compaction;
    }
  | { ok: false; errorMessage: string; sessionId?: string; sessionRecorded: boolean; toolCalls: number };

/** 1 run の記録（ファイルの 1 行） */
export type DevLogRecord = {
  /** 開始時刻（ISO）。ファイルの日付はこれの SELF_AGENT_TZ の日付 */
  at: string;
  durationMs: number;
  /** context が無い run（#inbox・#tasks の要約）は null */
  guildId: string | null;
  channelId: string | null;
  kind: RunContext["kind"] | null;
  model: string;
  effort: string | null;
  maxTurns: number;
  /** resume した SDK の session_id */
  resume: string | null;
  /** SDK に渡した文字列そのまま（ヘッダ・記憶のブロック・seed を含む） */
  prompt: string;
  /** 起きた順 */
  steps: DevLogStep[];
  result: DevLogResult;
};

/** 記録の受け口。sdk-runner は run の終わりに 1 回 write する（投げたら run 側で log に出して続ける） */
export interface DevLogSink {
  write(record: DevLogRecord): void;
}

/** `<dataDir>/devlog` */
export function devLogDir(dataDir: string): string {
  return join(dataDir, "devlog");
}

/** limit を超えたら先頭 limit 字 + `…（N 字を省略）`。サロゲートペアの途中で切れたら前半も落とす */
export function truncateText(text: string, limit: number = DEV_LOG_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const head = clip(text, limit);
  return `${head}…（${text.length - head.length} 字を省略）`;
}

/** tool_use の input。文字列化して DEV_LOG_TEXT_LIMIT を超えるなら、文字列化したものを切って文字列で返す */
export function devLogToolInput(input: unknown): unknown {
  const text = JSON.stringify(input) ?? "null";
  return text.length > DEV_LOG_TEXT_LIMIT ? truncateText(text) : (input ?? null);
}

/** 記録の result（RunResult から durationMs を除く。失敗の理由も長ければ切る） */
export function devLogResult(result: RunResult): DevLogResult {
  if (result.ok) {
    const { text, sessionId, usage, toolCalls, contextTokens, compacted } = result;
    return { ok: true, text, sessionId, usage, toolCalls, contextTokens, ...(compacted === undefined ? {} : { compacted }) };
  }
  return {
    ok: false,
    errorMessage: truncateText(result.errorMessage),
    ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    sessionRecorded: result.sessionRecorded,
    toolCalls: result.toolCalls,
  };
}

/**
 * dev モードならファイルに追記する受け口、そうでなければ undefined（ファイルもディレクトリも作らない）。
 * ファイルは記録の開始時刻の timeZone の日付で分ける。ディレクトリは 700、ファイルは 600 で作る
 */
export function createDevLogSink(cfg: Pick<Config, "devMode" | "dataDir" | "timeZone">): DevLogSink | undefined {
  if (!cfg.devMode) return undefined;
  const dir = devLogDir(cfg.dataDir);
  return {
    write(record) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${formatDate(new Date(record.at), cfg.timeZone)}.jsonl`);
      appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    },
  };
}

/** devlog/ の中で消す対象にするファイルの名前 */
const DEV_LOG_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * dir の `YYYY-MM-DD.jsonl` のうち、日付が今日（timeZone）から days 日より前のものを消す。
 * 名前が違うファイルは触らない。dir が無ければ何もしない（作らない）
 */
export function pruneDevLogs(dir: string, now: Date, timeZone: string, days: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const oldestKept = formatDate(startOfLocalDay(now, timeZone, days), timeZone);
  for (const name of names) {
    const match = DEV_LOG_FILE_PATTERN.exec(name);
    if (match === null || match[1]! >= oldestKept) continue;
    unlinkSync(join(dir, name));
  }
}
