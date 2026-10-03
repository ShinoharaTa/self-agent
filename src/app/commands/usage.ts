import type { Config } from "../../config.ts";
import type { UsageStore, UsageSummary } from "../../store/usage.ts";
import type { CommandHandler } from "../interactions.ts";
import { formatDate, startOfLocalDay } from "../time.ts";

/** 「直近 7 日」は今日を含めた 7 日（6 日前の 0 時から） */
const RECENT_DAYS = 7;

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export type UsageDeps = {
  usage: Pick<UsageStore, "summarize">;
  /** 日付の境界のタイムゾーン（SELF_AGENT_TZ） */
  cfg: Pick<Config, "timeZone">;
};

/** キャッシュ読み取り率 = read / (input + read + creation)。分母が 0 なら「-」 */
export function cacheReadRate(summary: UsageSummary): string {
  const total = summary.inputTokens + summary.cacheReadInputTokens + summary.cacheCreationInputTokens;
  return total === 0 ? "-" : `${((summary.cacheReadInputTokens / total) * 100).toFixed(1)}%`;
}

function summaryBlock(heading: string, summary: UsageSummary): string {
  const n = (value: number): string => NUMBER_FORMAT.format(value);
  return [
    heading,
    `ターン ${n(summary.turns)}（成功 ${n(summary.okTurns)} / 失敗 ${n(summary.failedTurns)}）`,
    `入力トークン ${n(summary.inputTokens)}`,
    `キャッシュ 読み取り ${n(summary.cacheReadInputTokens)} / 作成 ${n(summary.cacheCreationInputTokens)}（読み取り率 ${cacheReadRate(summary)}）`,
    `compaction ${n(summary.compactions)} 回`,
    `ツール呼び出し ${n(summary.toolCalls)} 回`,
  ].join("\n");
}

/** 「今日」と「直近 7 日」（timeZone の日付で区切る）の利用状況 */
export function usageText(usage: UsageDeps["usage"], now: Date, timeZone: string): string {
  const today = startOfLocalDay(now, timeZone);
  const recent = startOfLocalDay(now, timeZone, RECENT_DAYS - 1);
  const todayLabel = formatDate(today, timeZone);
  return [
    summaryBlock(`**今日**（${todayLabel}）`, usage.summarize(today)),
    summaryBlock(`**直近 ${RECENT_DAYS} 日**（${formatDate(recent, timeZone)}〜${todayLabel}）`, usage.summarize(recent)),
  ].join("\n\n");
}

/** `/usage`: 今日と直近 7 日のターン数・トークン・キャッシュ・compaction・ツール呼び出しを本人にだけ表示する */
export function createUsageCommand(deps: UsageDeps): CommandHandler {
  const { usage, cfg } = deps;
  return {
    def: { name: "usage", description: "今日と直近 7 日の利用状況（ターン数・トークン・キャッシュなど）を表示します" },
    async handle(interaction, responder) {
      await responder.reply({ text: usageText(usage, interaction.createdAt, cfg.timeZone), ephemeral: true });
    },
  };
}
