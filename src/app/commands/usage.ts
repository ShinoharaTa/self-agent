import { type Config, DEFAULT_PERSONA_ID, type PersonaConfig } from "../../config.ts";
import type { AttachmentStore } from "../../store/attachments.ts";
import { GUEST_PERSONA_ID } from "../../guest/constants.ts";
import type { UsageStore, UsageSummary } from "../../store/usage.ts";
import type { CommandHandler } from "../interactions.ts";
import { DEFAULT_PERSONA_LABEL } from "../personas.ts";
import { formatDate, startOfLocalDay } from "../time.ts";

/** 「直近 7 日」は今日を含めた 7 日（6 日前の 0 時から） */
const RECENT_DAYS = 7;

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export type UsageDeps = {
  usage: Pick<UsageStore, "summarize" | "sumOutputTokens">;
  /**
   * 日付の境界のタイムゾーン（SELF_AGENT_TZ）。personas は足した人格（あれば人格ごとに分けて表示する）。
   * guest（ゲスト利用の簡易モード）なら人格の後にゲストの行を出す
   */
  cfg: Pick<Config, "timeZone"> & Partial<Pick<Config, "personas" | "guest">>;
  /** 保存している添付の合計（あれば最後に 1 行出す） */
  attachments?: Pick<AttachmentStore, "totals">;
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

/** ゲスト（persona guest。API キーの従量課金）の今日の 1 行。入力は input + read + creation、出力は成功したターンの分 */
export function guestUsageLine(usage: UsageDeps["usage"], today: Date): string {
  const n = (value: number): string => NUMBER_FORMAT.format(value);
  const summary = usage.summarize(today, GUEST_PERSONA_ID);
  const input = summary.inputTokens + summary.cacheReadInputTokens + summary.cacheCreationInputTokens;
  return (
    `ゲスト（API キー・今日）: ターン ${n(summary.turns)}（失敗 ${n(summary.failedTurns)}）・` +
    `入力 ${n(input)}・出力 ${n(usage.sumOutputTokens(today, GUEST_PERSONA_ID))}`
  );
}

/**
 * 「今日」と「直近 7 日」（timeZone の日付で区切る）の利用状況。足した人格（personas）があれば、既定の人格 → 足した人格の順に
 * 人格ごとの見出し（表示名）の下に分けて出す。無ければ既定の人格の 1 組だけ（ゲストの行は含めない）。
 * guest なら最後にゲストの今日の 1 行（guestUsageLine）を足す
 */
export function usageText(
  usage: UsageDeps["usage"],
  now: Date,
  timeZone: string,
  personas: readonly Pick<PersonaConfig, "id" | "name">[] = [],
  guest = false,
): string {
  const today = startOfLocalDay(now, timeZone);
  const recent = startOfLocalDay(now, timeZone, RECENT_DAYS - 1);
  const todayLabel = formatDate(today, timeZone);
  const blocks = (persona: string): string[] => [
    summaryBlock(`**今日**（${todayLabel}）`, usage.summarize(today, persona)),
    summaryBlock(`**直近 ${RECENT_DAYS} 日**（${formatDate(recent, timeZone)}〜${todayLabel}）`, usage.summarize(recent, persona)),
  ];
  const text =
    personas.length === 0
      ? blocks(DEFAULT_PERSONA_ID).join("\n\n")
      : [{ id: DEFAULT_PERSONA_ID, name: DEFAULT_PERSONA_LABEL }, ...personas]
          .map((persona) => `__**${persona.name}**__\n${blocks(persona.id).join("\n\n")}`)
          .join("\n\n");
  return guest ? `${text}\n\n${guestUsageLine(usage, today)}` : text;
}

/** 保存している添付の合計の 1 行（大きさは MB で小数 1 桁） */
export function attachmentTotalsLine(totals: { count: number; bytes: number }): string {
  return `保存している添付 ${NUMBER_FORMAT.format(totals.count)} 件（${(totals.bytes / (1024 * 1024)).toFixed(1)} MB）`;
}

/** `/usage`: 今日と直近 7 日のターン数・トークン・キャッシュ・compaction・ツール呼び出しと、保存している添付の合計を本人にだけ表示する */
export function createUsageCommand(deps: UsageDeps): CommandHandler {
  const { usage, cfg, attachments } = deps;
  return {
    def: { name: "usage", description: "今日と直近 7 日の利用状況（ターン数・トークン・キャッシュなど）を表示します" },
    async handle(interaction, responder) {
      const text = usageText(usage, interaction.createdAt, cfg.timeZone, cfg.personas, cfg.guest === true);
      await responder.reply({
        text: attachments === undefined ? text : `${text}\n\n${attachmentTotalsLine(attachments.totals())}`,
        ephemeral: true,
      });
    },
  };
}
