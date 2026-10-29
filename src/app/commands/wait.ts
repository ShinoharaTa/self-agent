import type { ButtonDef } from "../../discord/gateway.ts";
import type { HistoryStore } from "../../store/history.ts";
import type { TopicSessionStore } from "../../store/topic-sessions.ts";
import type { CommandHandler, ComponentHandler } from "../interactions.ts";
import type { PersonaRouter } from "../personas.ts";
import { CONTINUED_TEXT, continueSession, WAITED_REPLY, waitSession } from "../session-ops.ts";
import type { SessionEventDeps } from "../session-state.ts";
import { ALREADY_CLOSED_REPLY, NOT_SESSION_REPLY } from "./close.ts";

// 文面は session-ops.ts に置き（履歴の知らせの行も同じ文を使う）、ここから re-export する（循環 import を避ける）
export { CONTINUED_TEXT, WAITED_REPLY };

/** ボタンの custom_id の名前空間（`wait:<action>:<channelId>`） */
const NAMESPACE = "wait";

export type WaitDeps = SessionEventDeps & {
  topicSessions: Pick<TopicSessionStore, "get">;
  /** history の知らせの行の人格（チャンネルの持ち主）。無ければ既定の人格 */
  personas?: Pick<PersonaRouter, "ownerOf">;
  /** Web UI のためのターンの記録（Web UI が有効なときだけ渡す）。待ちに移した・進行中に戻したら知らせの行を書く。無ければ書かない */
  history?: Pick<HistoryStore, "add">;
  log: (message: string) => void;
};

/** 待ちのセッションを進行中に戻す [続ける] ボタン（`wait:continue:<channelId>`。待ちに移した知らせに付ける） */
export function continueButton(channelId: string): ButtonDef {
  return { customId: `${NAMESPACE}:continue:${channelId}`, label: "続ける" };
}

/** `/wait`: そのセッションを待ちにして待ちカテゴリへ移す。発言するか [続ける] で進行中に戻る */
export function createWaitCommand(deps: WaitDeps): CommandHandler {
  return {
    def: { name: "wait", description: "このセッションを「待ち」カテゴリへ移します（発言すると「進行中」に戻ります）" },
    async handle(interaction, responder) {
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で /wait が呼ばれました");
      // 既に待ちなら何も変えない（unchanged）が、応答は同じ
      const result = interaction.channelId === null ? "not_session" : waitSession(guildId, interaction.channelId, deps);
      if (result === "not_session") {
        await responder.reply({ text: NOT_SESSION_REPLY, ephemeral: true });
        return;
      }
      if (result === "closed") {
        await responder.reply({ text: ALREADY_CLOSED_REPLY, ephemeral: true });
        return;
      }
      await responder.reply({ text: WAITED_REPLY, ephemeral: true });
    },
  };
}

/** 待ちに移した知らせの [続ける]（`wait:continue:<channelId>`）。進行中に戻し、知らせのボタンを外す */
export function createWaitComponent(deps: WaitDeps): ComponentHandler {
  return {
    namespace: NAMESPACE,
    async handle(interaction, responder) {
      const [, action, channelId] = interaction.customId.split(":");
      if (channelId === undefined || channelId === "") throw new Error("wait の custom_id にチャンネルがありません");
      if (interaction.kind !== "button" || action !== "continue") {
        throw new Error(`wait の不明な操作です（${interaction.kind} ${action ?? ""}）`);
      }
      // 待ち・完了なら進行中に戻す。既に進行中なら（unchanged）表示だけ同じにしてボタンを外す
      const result = interaction.guildId === null ? "not_session" : continueSession(interaction.guildId, channelId, deps);
      if (result === "not_session") {
        await responder.reply({ text: NOT_SESSION_REPLY, ephemeral: true });
        return;
      }
      if (result === "deleted") {
        await responder.reply({ text: ALREADY_CLOSED_REPLY, ephemeral: true });
        return;
      }
      await responder.update({ text: CONTINUED_TEXT, components: [] });
    },
  };
}
