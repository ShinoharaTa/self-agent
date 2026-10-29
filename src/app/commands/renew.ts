import { DEFAULT_PERSONA_ID } from "../../config.ts";
import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import type { SummaryChannelKind } from "../../store/inbox-summaries.ts";
import { type InboxRotator, ROTATED_NOTICE, ROTATED_NOTICE_FRESH, type RotateNowResult } from "../inbox-rotate.ts";
import type { CommandHandler } from "../interactions.ts";
import { commandResponse, type PersonaRouter } from "../personas.ts";
import { RENEWED_FRESH_REPLY, type RenewOutcome, renewedText, renewSession, type SessionRenewDeps } from "../session-renew.ts";
import { ALREADY_CLOSED_REPLY } from "./close.ts";

// 文面は session-renew.ts に置き（履歴の区切りの行も同じ文を使う）、ここから re-export する（循環 import を避ける）
export { RENEWED_FRESH_REPLY, renewedText };

export const NOT_RENEWABLE_REPLY = "セッションのチャンネルか #inbox・#tasks で実行してください";
export const NO_CONVERSATION_REPLY = "新しい会話はまだ始まっていません。次の発言から新しい会話で始まります";
export const NOT_SET_UP_REPLY = "/setup を実行してください";
export const RENEW_FAILURE_REPLY = "失敗しました。もう一度 /renew を実行してください";

export type RenewDeps = SessionRenewDeps & {
  /** #inbox・#tasks・#<NAME> のチャンネル（/setup 済みのサーバーの DB のものだけ） */
  guildSettings: Pick<GuildSettingsStore, "get" | "entryChannel">;
  /** #inbox・#tasks・#<NAME> の切り替え（日次の切り替えと同じ処理を今すぐ行う） */
  inboxRotator: Pick<InboxRotator, "rotateNow">;
  /** チャンネルの持ち主の人格。既定の人格以外のチャンネルの結果は、持ち主の Bot がチャンネルに投稿する。無ければすべて既定の人格 */
  personas?: Pick<PersonaRouter, "ownerOf" | "gatewayFor">;
};

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
 * セッションのチャンネルでは session-renew.ts、#inbox・#tasks と足した人格の #<NAME>（設定にある人格のものだけ）では日次の切り替えと同じ処理（rotateNow）を行う。
 * 受け付けたら公開で保留し、結果をチャンネルに残す（既定の人格以外のチャンネルでは、持ち主の Bot がチャンネルに投稿する）
 */
export function createRenewCommand(deps: RenewDeps): CommandHandler {
  const { guildSettings, topicSessions, inboxRotator } = deps;
  return {
    def: { name: "renew", description: "会話を要約して新しくします（長くなった会話を仕切り直します）" },
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
      let persona = DEFAULT_PERSONA_ID;
      if (settings?.inboxChannelId === channelId) channelKind = "inbox";
      else if (settings?.tasksChannelId === channelId) channelKind = "tasks";
      else if (settings !== undefined && deps.personas !== undefined) {
        // 足した人格の #<NAME>: 持ち主がその人格のまま（設定から外していない）ときだけ
        const entry = guildSettings.entryChannel(channelId);
        if (
          entry !== undefined &&
          entry.guildId === guildId &&
          entry.kind === "inbox" &&
          entry.persona !== DEFAULT_PERSONA_ID &&
          deps.personas.ownerOf(channelId) === entry.persona
        ) {
          channelKind = "inbox";
          persona = entry.persona;
        }
      }
      if (channelKind !== undefined) {
        // #<NAME> の結果は持ち主の Bot がチャンネルに投稿する（#inbox・#tasks は今までどおり公開の応答）
        const response = commandResponse(deps.personas, channelId, responder, deps.log);
        await response.defer();
        const result = await inboxRotator.rotateNow(guildId, channelKind, persona);
        await response.show({ text: rotateReply(result) });
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
      const response = commandResponse(deps.personas, channelId, responder, deps.log);
      await response.defer();
      const outcome = await renewSession(deps, guildId, channelId);
      await response.show({ text: sessionReply(outcome) });
    },
  };
}
