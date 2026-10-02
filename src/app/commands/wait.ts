import type { ButtonDef } from "../../discord/gateway.ts";
import type { TopicSessionStore } from "../../store/topic-sessions.ts";
import type { CommandHandler, ComponentHandler } from "../interactions.ts";
import { applySessionEvent, type SessionEventDeps } from "../session-state.ts";
import { ALREADY_CLOSED_REPLY, NOT_SESSION_REPLY } from "./close.ts";

export const WAITED_REPLY = "待ちに移しました";
/** [続ける] を押した後の、待ちに移した知らせの本文 */
export const CONTINUED_TEXT = "進行中に戻しました";

/** ボタンの custom_id の名前空間（`wait:<action>:<channelId>`） */
const NAMESPACE = "wait";

export type WaitDeps = SessionEventDeps & {
  topicSessions: Pick<TopicSessionStore, "get">;
  log: (message: string) => void;
};

/** 待ちのセッションを進行中に戻す [続ける] ボタン（`wait:continue:<channelId>`。待ちに移した知らせに付ける） */
export function continueButton(channelId: string): ButtonDef {
  return { customId: `${NAMESPACE}:continue:${channelId}`, label: "続ける" };
}

/** `/wait`: そのセッションを待ちにして待ちカテゴリへ移す。発言するか [続ける] で進行中に戻る */
export function createWaitCommand(deps: WaitDeps): CommandHandler {
  const { topicSessions, log } = deps;
  return {
    def: { name: "wait", description: "このセッションを「待ち」カテゴリへ移します（発言すると「進行中」に戻ります）" },
    async handle(interaction, responder) {
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で /wait が呼ばれました");
      const session = interaction.channelId === null ? undefined : topicSessions.get(interaction.channelId);
      if (session === undefined || session.guildId !== guildId) {
        await responder.reply({ text: NOT_SESSION_REPLY, ephemeral: true });
        return;
      }
      if (session.state === "done" || session.state === "deleted") {
        await responder.reply({ text: ALREADY_CLOSED_REPLY, ephemeral: true });
        return;
      }
      // 既に待ちなら何も変えない
      if (applySessionEvent(session, "wait", deps).move !== null) {
        log(`/wait でセッションを待ちに移しました（guild=${guildId}）`);
      }
      await responder.reply({ text: WAITED_REPLY, ephemeral: true });
    },
  };
}

/** 待ちに移した知らせの [続ける]（`wait:continue:<channelId>`）。進行中に戻し、知らせのボタンを外す */
export function createWaitComponent(deps: WaitDeps): ComponentHandler {
  const { topicSessions, log } = deps;
  return {
    namespace: NAMESPACE,
    async handle(interaction, responder) {
      const [, action, channelId] = interaction.customId.split(":");
      if (channelId === undefined || channelId === "") throw new Error("wait の custom_id にチャンネルがありません");
      if (interaction.kind !== "button" || action !== "continue") {
        throw new Error(`wait の不明な操作です（${interaction.kind} ${action ?? ""}）`);
      }
      const session = topicSessions.get(channelId);
      if (session === undefined || session.guildId !== interaction.guildId) {
        await responder.reply({ text: NOT_SESSION_REPLY, ephemeral: true });
        return;
      }
      if (session.state === "deleted") {
        await responder.reply({ text: ALREADY_CLOSED_REPLY, ephemeral: true });
        return;
      }
      // 待ち・完了なら進行中に戻す。既に進行中なら表示だけ同じにしてボタンを外す
      if (applySessionEvent(session, "continue", deps).move !== null) {
        log(`[続ける] でセッションを進行中に戻しました（guild=${session.guildId}）`);
      }
      await responder.update({ text: CONTINUED_TEXT, components: [] });
    },
  };
}
