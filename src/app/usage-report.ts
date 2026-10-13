// ターンのトークン使用量の表示（ターンごとの console の 1 行と、npm run usage の行）。純関数だけ。
// プロンプトキャッシュが効いているか（読み・書き）を見るためのもの。チャンネル ID・key・session_id は出さない
import type { RunResult, StepUsage } from "../agent/runner.ts";
import type { UsageEntry } from "../store/usage.ts";

/** npm run usage の行で種類を揃える幅（いちばん長い session-scheduled に合わせる） */
export const USAGE_KIND_WIDTH = 17;

/** 桁区切り（カンマ）の数 */
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** 無い値（null・undefined）は - */
function formatMaybe(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : formatCount(value);
}

/** キャッシュ率（read / total を四捨五入した %）。total が 0 なら - */
export function cacheRate(read: number, total: number): string {
  return total === 0 ? "-" : `${Math.round((read / total) * 100)}%`;
}

/**
 * ターンのトークンの console の 1 行。kind はターンの種類のラベル（inbox・session-renew など）。
 * 入力は input + read + creation、キャッシュ率は読みの割合。出力は成功したターンだけ（無ければ -）。失敗で usage が無ければ「記録なし」
 */
export function formatTurnUsageLog(kind: string, result: RunResult): string {
  const label = `トークン（${kind}・${result.ok ? "成功" : "失敗"}）`;
  const usage = result.usage;
  if (usage === undefined) return `${label}: 記録なし`;
  const total = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  const first = usage.steps[0];
  const firstStep =
    first === undefined
      ? "読み -・書き -"
      : `読み ${formatCount(first.cacheReadInputTokens)}・書き ${formatCount(first.cacheCreationInputTokens)}`;
  return (
    `${label}: ステップ ${usage.steps.length}、入力 ${formatCount(total)}` +
    `（読み ${formatCount(usage.cacheReadInputTokens)}・書き ${formatCount(usage.cacheCreationInputTokens)}` +
    `（1 時間 ${formatCount(usage.cacheCreation1hInputTokens)}）・なし ${formatCount(usage.inputTokens)}）、` +
    `出力 ${formatMaybe(usage.outputTokens)}、キャッシュ率 ${cacheRate(usage.cacheReadInputTokens, total)}、1 ステップ目 ${firstStep}`
  );
}

/**
 * 記録 1 行のトークン。入力側は合計の列があればそれ、無ければ（失敗したターン）steps の合計、どちらも無ければ null。
 * 出力は列だけ（steps に出力は無い。失敗したターンと v17 より前の行は null）
 */
export type EntryTokens = {
  input: number | null;
  read: number | null;
  creation: number | null;
  creation1h: number | null;
  output: number | null;
};

export function entryTokens(entry: UsageEntry): EntryTokens {
  const { steps } = entry;
  const fromSteps = (pick: (step: StepUsage) => number): number | null =>
    steps === null ? null : steps.reduce((sum, step) => sum + pick(step), 0);
  return {
    input: entry.inputTokens ?? fromSteps((step) => step.inputTokens),
    read: entry.cacheReadInputTokens ?? fromSteps((step) => step.cacheReadInputTokens),
    creation: entry.cacheCreationInputTokens ?? fromSteps((step) => step.cacheCreationInputTokens),
    creation1h: entry.cacheCreation1hInputTokens ?? fromSteps((step) => step.cacheCreation1hInputTokens),
    output: entry.outputTokens,
  };
}

/** その時刻の、timeZone での時刻（HH:MM:SS） */
function formatClock(at: string, timeZone: string): string {
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

/**
 * npm run usage の 1 ターンの行。v17 より前の行（種類・steps が無い）や失敗したターン（所要時間・ctx が無い）の無い値は -。
 * key・session_id は出さない
 */
export function formatUsageEntry(entry: UsageEntry, timeZone: string): string {
  const tokens = entryTokens(entry);
  const total =
    tokens.input === null || tokens.read === null || tokens.creation === null
      ? null
      : tokens.input + tokens.read + tokens.creation;
  const rate = total === null || tokens.read === null ? "-" : cacheRate(tokens.read, total);
  const duration = entry.durationMs === null ? "-" : `${(entry.durationMs / 1000).toFixed(1)}s`;
  return [
    formatClock(entry.at, timeZone),
    (entry.kind ?? "-").padEnd(USAGE_KIND_WIDTH),
    entry.ok ? "ok" : "NG",
    `steps ${entry.steps === null ? "-" : entry.steps.length}`,
    `入力 ${formatMaybe(total)}`,
    `読み ${formatMaybe(tokens.read)}`,
    `書き ${formatMaybe(tokens.creation)}(1h ${formatMaybe(tokens.creation1h)})`,
    `なし ${formatMaybe(tokens.input)}`,
    `出力 ${formatMaybe(tokens.output)}`,
    `率 ${rate}`,
    // 失敗したターンは最後のステップの入力を記録していない
    `ctx ${entry.ok ? formatCount(entry.contextTokens) : "-"}`,
    duration,
  ].join(" ");
}

/** npm run usage --steps の、ターンの下に出すステップごとの行（1 から数える。入力側だけ） */
export function formatUsageSteps(steps: readonly StepUsage[]): string[] {
  return steps.map(
    (step, index) =>
      `  ${index + 1}: 読み ${formatCount(step.cacheReadInputTokens)} 書き ${formatCount(step.cacheCreationInputTokens)}` +
      `(1h ${formatCount(step.cacheCreation1hInputTokens)}) なし ${formatCount(step.inputTokens)}`,
  );
}

/** npm run usage の最後の行（出した行の合計）。無い値は 0 として足す */
export function formatUsageTotals(entries: readonly UsageEntry[]): string {
  let read = 0;
  let creation = 0;
  let input = 0;
  let output = 0;
  for (const entry of entries) {
    const tokens = entryTokens(entry);
    read += tokens.read ?? 0;
    creation += tokens.creation ?? 0;
    input += tokens.input ?? 0;
    output += tokens.output ?? 0;
  }
  return (
    `合計: ターン ${entries.length} 読み ${formatCount(read)} 書き ${formatCount(creation)} なし ${formatCount(input)} ` +
    `出力 ${formatCount(output)} 率 ${cacheRate(read, read + creation + input)}`
  );
}
