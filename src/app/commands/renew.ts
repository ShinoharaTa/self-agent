import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import type { InboxRotator } from "../inbox-rotate.ts";
import type { CommandHandler } from "../interactions.ts";
import { type CommandResponse, commandResponse, type PersonaRouter } from "../personas.ts";
import { RENEWED_FRESH_REPLY, renewedText, type SessionRenewDeps } from "../session-renew.ts";
import {
  NO_CONVERSATION_REPLY,
  NOT_RENEWABLE_REPLY,
  RENEW_FAILURE_REPLY,
  RENEW_NOT_SET_UP_REPLY as NOT_SET_UP_REPLY,
  renewChannel,
} from "../session-ops.ts";
import { ALREADY_CLOSED_REPLY } from "./close.ts";

// 文面は session-renew.ts・session-ops.ts に置き（履歴の区切りの行と Web も同じ文を使う）、ここから re-export する（循環 import を避ける）
export { NO_CONVERSATION_REPLY, NOT_RENEWABLE_REPLY, NOT_SET_UP_REPLY, RENEW_FAILURE_REPLY, RENEWED_FRESH_REPLY, renewedText };

export type RenewDeps = SessionRenewDeps & {
  /** #inbox・#tasks・#<NAME> のチャンネル（/setup 済みのサーバーの DB のものだけ） */
  guildSettings: Pick<GuildSettingsStore, "get" | "entryChannel">;
  /** #inbox・#tasks・#<NAME> の切り替え（日次の切り替えと同じ処理を今すぐ行う） */
  inboxRotator: Pick<InboxRotator, "rotateNow">;
  /** チャンネルの持ち主の人格。既定の人格以外のチャンネルの結果は、持ち主の Bot がチャンネルに投稿する。無ければすべて既定の人格 */
  personas?: Pick<PersonaRouter, "ownerOf" | "gatewayFor">;
};

/**
 * `/renew`: 会話を要約して新しい SDK セッションに切り替える（システムプロンプトなどの変更は新しいセッションから反映される）。
 * セッションのチャンネルでは session-renew.ts、#inbox・#tasks と足した人格の #<NAME>（設定にある人格のものだけ）では日次の切り替えと同じ処理（rotateNow）を行う（session-ops.ts の renewChannel）。
 * 受け付けたら公開で保留し、結果をチャンネルに残す（既定の人格以外のチャンネルでは、持ち主の Bot がチャンネルに投稿する）
 */
export function createRenewCommand(deps: RenewDeps): CommandHandler {
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
      // #<NAME> の結果は持ち主の Bot がチャンネルに投稿する（#inbox・#tasks・既定の人格のセッションは今までどおり公開の応答）。
      // 要約のターンは 3 秒を超えるので、受け付けたら保留する
      let response: CommandResponse | undefined;
      const result = await renewChannel(guildId, channelId, deps, () => {
        response = commandResponse(deps.personas, channelId, responder, deps.log);
        return response.defer();
      });
      switch (result.result) {
        case "not_renewable":
          await responder.reply({ text: NOT_RENEWABLE_REPLY, ephemeral: true });
          return;
        case "closed":
          await responder.reply({ text: ALREADY_CLOSED_REPLY, ephemeral: true });
          return;
        case "done":
          if (response === undefined) throw new Error("/renew の結果を保留せずに受け取りました");
          await response.show({ text: result.text });
          return;
      }
    },
  };
}
