import type { Config } from "../../config.ts";
import type { Gateway, InteractionResponder, OutgoingMessage } from "../../discord/gateway.ts";
import type { ChannelSeedStore } from "../../store/channel-seeds.ts";
import type { SdkSessionStore } from "../../store/sdk-sessions.ts";
import type { TopicSession, TopicSessionStore } from "../../store/topic-sessions.ts";
import type { ChannelOpsQueue } from "../channel-ops.ts";
import type { ComponentHandler } from "../interactions.ts";

/** 削除済み・行が無いセッションの確認のボタンを押したときの、確認メッセージの本文 */
export const ALREADY_HANDLED_TEXT = "すでに処理済みです";
/**
 * 押された確認が今の確認でない（記録した確認のメッセージと違う・記録が無い）か、セッションがもう完了でない
 * （発言・[続ける] で進行中に戻った等）ときの、確認メッセージの本文
 */
export const STALE_TEXT = "この確認は古くなっています";

/** ボタンの custom_id の名前空間（`del:<action>:<channelId>`） */
const NAMESPACE = "del";

export type DeleteDeps = {
  cfg: Pick<Config, "deleteAfterDays">;
  topicSessions: Pick<TopicSessionStore, "get" | "postponeDelete" | "markDeleted">;
  /** 削除したチャンネルの SDK セッション（channel_sessions）を消す */
  sessions: Pick<SdkSessionStore, "delete">;
  /** 削除したチャンネルの seed（channel_seeds）を消す */
  seeds: Pick<ChannelSeedStore, "delete">;
  gateway: Pick<Gateway, "deleteChannel">;
  /** 削除したチャンネルの未実行の移動を捨てる */
  channelOps: Pick<ChannelOpsQueue, "cancel">;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 完了から deleteAfterDays 日経ったセッションについて #system に投稿する確認（scheduler.ts）。
 * [削除する]（`del:yes:<channelId>`）でチャンネルを削除し、[残す]（`del:keep:<channelId>`）で deleteAfterDays 日後にもう一度確認する
 */
export function deletePrompt(
  session: Pick<TopicSession, "channelId" | "title">,
  deleteAfterDays: number,
): OutgoingMessage {
  const { channelId, title } = session;
  return {
    text: `<#${channelId}>（${title}）は完了から ${deleteAfterDays} 日経ちました。チャンネルを削除しますか？要約は残ります。`,
    components: [
      {
        kind: "buttons",
        buttons: [
          { customId: `${NAMESPACE}:yes:${channelId}`, label: "削除する", style: "danger" },
          { customId: `${NAMESPACE}:keep:${channelId}`, label: "残す" },
        ],
      },
    ],
  };
}

export function deletedText(title: string): string {
  return `${title} を削除しました（要約は残っています）`;
}

export function keptText(title: string, deleteAfterDays: number): string {
  return `${title} を残しました。${deleteAfterDays} 日後にもう一度確認します`;
}

type PromptCheck = { result: "handled" } | { result: "stale" } | { result: "ok"; session: TopicSession };

/**
 * 押された確認がまだ有効か。削除済み・行が無い（別サーバーのものを含む）なら handled、
 * 完了でない・押されたメッセージが記録した確認と違う（記録が無いを含む）なら stale
 */
function checkPrompt(
  topicSessions: DeleteDeps["topicSessions"],
  channelId: string,
  guildId: string | null,
  messageId: string | undefined,
): PromptCheck {
  const session = topicSessions.get(channelId);
  if (session === undefined || session.state === "deleted" || session.guildId !== guildId) return { result: "handled" };
  if (session.state !== "done" || messageId === undefined || session.deletePromptMessageId !== messageId) {
    return { result: "stale" };
  }
  return { result: "ok", session };
}

/**
 * 削除の確認の [削除する]（`del:yes:<channelId>`）と [残す]（`del:keep:<channelId>`）。どちらも確認メッセージを書き換えてボタンを外す。
 * 記録した今の確認（delete_prompt_message_id）のボタンで、セッションが完了のときだけ処理する。それ以外は DB を変えずに「古くなっています」にする。
 * DB の状態で動くので、再起動の後でも押せる
 */
export function createDeleteComponent(deps: DeleteDeps): ComponentHandler {
  const { cfg, topicSessions, sessions, seeds, gateway, channelOps, log } = deps;

  /** 状態を変えた後の書き換え。失敗しても処理は済んでいるので、失敗の返信にはしない */
  const show = async (responder: InteractionResponder, text: string): Promise<void> => {
    try {
      await responder.update({ text, components: [] });
    } catch (error) {
      log(`削除の確認メッセージの更新に失敗しました: ${describeError(error)}`);
    }
  };

  return {
    namespace: NAMESPACE,
    async handle(interaction, responder) {
      const [, action, channelId] = interaction.customId.split(":");
      if (channelId === undefined || channelId === "") throw new Error("del の custom_id にチャンネルがありません");
      if (interaction.kind !== "button" || (action !== "yes" && action !== "keep")) {
        throw new Error(`del の不明な操作です（${interaction.kind} ${action ?? ""}）`);
      }
      // 処理しない確認は、DB を変えずに確認メッセージを書き換えてボタンを外す
      const check = (): PromptCheck => checkPrompt(topicSessions, channelId, interaction.guildId, interaction.messageId);
      const dismiss = (result: "handled" | "stale"): Promise<void> =>
        responder.update({ text: result === "handled" ? ALREADY_HANDLED_TEXT : STALE_TEXT, components: [] });

      const first = check();
      if (first.result !== "ok") {
        await dismiss(first.result);
        return;
      }
      const session = first.session;

      if (action === "keep") {
        topicSessions.postponeDelete(channelId);
        log(`[残す] でセッションのチャンネルを残しました（guild=${session.guildId}）`);
        await show(responder, keptText(session.title, cfg.deleteAfterDays));
        return;
      }

      // チャンネルの削除は Discord に問い合わせるので先に保留する（確認メッセージはまだ変えない）
      await responder.deferUpdate();
      // 保留の間に変わっていることがあるので読み直す
      const second = check();
      if (second.result !== "ok") {
        await dismiss(second.result);
        return;
      }
      const current = second.session;
      // 失敗したら（権限など）何も変えずに投げる。確認メッセージのボタンは残るので、押し直せる
      await gateway.deleteChannel(channelId);
      // 削除できたら DB を更新する（await を挟まない）。要約は sessions に残す
      topicSessions.markDeleted(channelId);
      sessions.delete(channelId);
      seeds.delete(channelId);
      channelOps.cancel(channelId);
      log(`セッションのチャンネルを削除しました（guild=${current.guildId}）`);
      await show(responder, deletedText(current.title));
    },
  };
}
