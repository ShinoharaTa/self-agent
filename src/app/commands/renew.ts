import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import type { SummaryChannelKind } from "../../store/inbox-summaries.ts";
import { type InboxRotator, ROTATED_NOTICE, ROTATED_NOTICE_FRESH, type RotateNowResult } from "../inbox-rotate.ts";
import type { CommandHandler } from "../interactions.ts";
import { type RenewOutcome, renewSession, type SessionRenewDeps } from "../session-renew.ts";
import { ALREADY_CLOSED_REPLY } from "./close.ts";

export const NOT_RENEWABLE_REPLY = "セッションのチャンネルか #inbox・#tasks で実行してください";
export const RENEWED_FRESH_REPLY = "前の会話の記録が見つからないため、要約せずに新しくしました。次の発言から新しい設定で続けます";
export const NO_CONVERSATION_REPLY = "新しい会話はまだ始まっていません。次の発言から新しい設定で始まります";
export const NOT_SET_UP_REPLY = "/setup を実行してください";
export const RENEW_FAILURE_REPLY = "失敗しました。もう一度 /renew を実行してください";

export type RenewDeps = SessionRenewDeps & {
  /** #inbox・#tasks のチャンネル（/setup 済みのサーバーの DB のものだけ） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  /** #inbox・#tasks の切り替え（日次の切り替えと同じ処理を今すぐ行う） */
  inboxRotator: Pick<InboxRotator, "rotateNow">;
};

/** セッションの会話を新しくした返信（要約を添える） */
export function renewedText(summary: string): string {
  return `会話を新しくしました。次の発言から新しい設定で続けます。\n\n**要約**\n${summary}`;
}

function sessionReply(outcome: RenewOutcome): string {
  switch (outcome.result) {
    case "renewed":
      return renewedText(outcome.summary);
    case "renewed_fresh":
      return RENEWED_FRESH_REPLY;
    case "no_conversation":
      return NO_CONVERSATION_REPLY;
    case "not_session":
      return NOT_RENEWABLE_REPLY;
    case "closed":
      return ALREADY_CLOSED_REPLY;
    case "failed":
      return RENEW_FAILURE_REPLY;
  }
}

function rotateReply(result: RotateNowResult): string {
  switch (result) {
    case "rotated":
      return ROTATED_NOTICE;
    case "rotated_fresh":
      return ROTATED_NOTICE_FRESH;
    case "no_conversation":
      return NO_CONVERSATION_REPLY;
    case "not_set_up":
      return NOT_SET_UP_REPLY;
    case "failed":
      return RENEW_FAILURE_REPLY;
  }
}

/**
 * `/renew`: 会話を要約して新しい SDK セッションに切り替える（システムプロンプトなどの変更は新しいセッションから反映される）。
 * セッションのチャンネルでは session-renew.ts、#inbox・#tasks では日次の切り替えと同じ処理（rotateNow）を行う。
 * 受け付けたら公開で保留し、結果をチャンネルに残す
 */
export function createRenewCommand(deps: RenewDeps): CommandHandler {
  const { guildSettings, topicSessions, inboxRotator } = deps;
  return {
    def: { name: "renew", description: "会話を要約して新しくします（新しい設定で続けます）" },
    async handle(interaction, responder) {
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で /renew が呼ばれました");
      const channelId = interaction.channelId;
      if (channelId === null) {
        await responder.reply({ text: NOT_RENEWABLE_REPLY, ephemeral: true });
        return;
      }
      // #inbox・#tasks は /setup 済みのサーバーの DB のものだけ（/setup 前の env の #inbox は対象外）
      const settings = guildSettings.get(guildId);
      let channelKind: SummaryChannelKind | undefined;
      if (settings?.inboxChannelId === channelId) channelKind = "inbox";
      else if (settings?.tasksChannelId === channelId) channelKind = "tasks";
      if (channelKind !== undefined) {
        await responder.defer(false);
        const result = await inboxRotator.rotateNow(guildId, channelKind);
        await responder.reply({ text: rotateReply(result) });
        return;
      }

      const session = topicSessions.get(channelId);
      if (session === undefined || session.guildId !== guildId) {
        await responder.reply({ text: NOT_RENEWABLE_REPLY, ephemeral: true });
        return;
      }
      if (session.state === "done" || session.state === "deleted") {
        await responder.reply({ text: ALREADY_CLOSED_REPLY, ephemeral: true });
        return;
      }
      // 要約のターンは 3 秒を超えるので保留する
      await responder.defer(false);
      const outcome = await renewSession(deps, guildId, channelId);
      await responder.reply({ text: sessionReply(outcome) });
    },
  };
}
