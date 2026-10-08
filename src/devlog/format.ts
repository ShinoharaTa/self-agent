// dev モードの会話ログ（log.ts の記録）を 1 ターンずつ読みやすい文字列にする（npm run devlog）。純関数だけ
import type { RunContext } from "../agent/runner.ts";
import { truncateText, type DevLogRecord, type DevLogStep } from "./log.ts";

/** steps の tool_use の input と tool_result の content は、この字数まで出す */
export const DEV_LOG_PREVIEW_LIMIT = 300;

/** 表示する記録の絞り込み。last は絞り込んだ後の最後の last 件 */
export type DevLogFilter = { kind?: RunContext["kind"]; channelId?: string; last?: number };

/** jsonl の中身を記録の配列にする。空行は無視し、JSON として読めない行は飛ばして数える */
export function parseDevLog(text: string): { records: DevLogRecord[]; skipped: number } {
  const records: DevLogRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as DevLogRecord);
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

/** kind・channelId が指定されていればそれだけに絞り、last があれば最後の last 件 */
export function selectDevLogRecords(records: readonly DevLogRecord[], filter: DevLogFilter): DevLogRecord[] {
  const selected = records.filter(
    (record) =>
      (filter.kind === undefined || record.kind === filter.kind) &&
      (filter.channelId === undefined || record.channelId === filter.channelId),
  );
  return filter.last === undefined ? selected : selected.slice(-filter.last);
}

/** その時刻の、timeZone での時刻（HH:MM:SS） */
function formatTime(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "??";
  return `${part("hour")}:${part("minute")}:${part("second")}`;
}

/** 所要時間（`<m> 分 <s> 秒`。秒未満は切り捨て） */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** 見出し（時刻・種類・チャンネル ID・所要時間・トークン・ツール回数・成否）。context の無い run の種類・チャンネルは - */
function heading(record: DevLogRecord, timeZone: string): string {
  const { result } = record;
  const tokens = result.ok
    ? `input ${result.usage.inputTokens} / cache read ${result.usage.cacheReadInputTokens} / cache creation ${result.usage.cacheCreationInputTokens}`
    : "input - / cache read - / cache creation -";
  return [
    `=== ${formatTime(record.at, timeZone)} ${record.kind ?? "-"} channel=${record.channelId ?? "-"} ===`,
    `${formatDuration(record.durationMs)} | ${tokens} | ツール ${result.toolCalls} 回 | ${result.ok ? "成功" : "失敗"}`,
  ].join("\n");
}

/** steps の 1 行。tool_result には、同じ id の tool_use があればそのツール名を添える */
function formatStep(step: DevLogStep, toolNames: ReadonlyMap<string, string>): string {
  switch (step.t) {
    case "text":
      return `[text] ${step.text}`;
    case "tool_use": {
      const input = typeof step.input === "string" ? step.input : JSON.stringify(step.input);
      return `[tool_use] ${step.name} ${truncateText(input, DEV_LOG_PREVIEW_LIMIT)}`;
    }
    case "tool_result": {
      const name = toolNames.get(step.id);
      const label = `${name === undefined ? "" : ` ${name}`}${step.isError ? " isError" : ""}`;
      return `[tool_result${label}] ${truncateText(step.content, DEV_LOG_PREVIEW_LIMIT)}`;
    }
    case "compact":
      return `[compact] ${step.trigger}${step.preTokens === null ? "" : `（要約前 ${step.preTokens}）`}`;
  }
}

/**
 * 1 ターン分の表示: 見出し → prompt → steps（tool_use は名前と input の先頭 300 字、tool_result は先頭 300 字と isError、text は全文）
 * → 結果（返答の全文か失敗の理由）
 */
export function formatDevLogRecord(record: DevLogRecord, timeZone: string): string {
  const toolNames = new Map<string, string>();
  for (const step of record.steps) if (step.t === "tool_use") toolNames.set(step.id, step.name);
  const { result } = record;
  return [
    heading(record, timeZone),
    "--- prompt ---",
    record.prompt,
    "--- steps ---",
    ...(record.steps.length === 0 ? ["（なし）"] : record.steps.map((step) => formatStep(step, toolNames))),
    result.ok ? "--- 返答 ---" : "--- 失敗 ---",
    result.ok ? result.text : result.errorMessage,
  ].join("\n");
}
