import type { ButtonDef, ComponentRow, InteractionResponder } from "../../discord/gateway.ts";
import type { HistoryStore } from "../../store/history.ts";
import type { ProjectStore } from "../../store/projects.ts";
import type { TaskStore } from "../../store/tasks.ts";
import type { CloseDraft, TopicSessionStore } from "../../store/topic-sessions.ts";
import type { ChannelOpsQueue } from "../channel-ops.ts";
import type { CommandHandler, ComponentHandler } from "../interactions.ts";
import { type CommandResponse, commandResponse, type PersonaRouter } from "../personas.ts";
import type { KeyedSerialQueue } from "../queue.ts";
import { closable, closeSession, confirmClose, removeClosedNodeModules } from "../session-ops.ts";
import { clip } from "../summary.ts";
import type { TurnDeps } from "../turn.ts";
import {
  ALREADY_CLOSED_REPLY,
  CLOSE_NAMESPACE,
  CLOSE_PROMPT,
  closeCustomId,
  closedText,
  confirmButtons,
  confirmText,
  TASK_LABEL_MAX_LENGTH,
} from "./close-text.ts";

// 文面と確認のボタンは close-text.ts に置き（session-ops.ts も使う）、ここから re-export する（循環 import を避ける）
export { ALREADY_CLOSED_REPLY, CLOSE_PROMPT, closedText, confirmButtons, confirmText };

export const NOT_SESSION_REPLY = "セッションのチャンネルで実行してください";
export const SUMMARY_FAILURE_REPLY = "要約に失敗しました。もう一度 /close を実行してください";
export const NO_DRAFT_REPLY = "/close をもう一度実行してください";

export type CloseDeps = {
  topicSessions: TopicSessionStore;
  tasks: Pick<TaskStore, "add">;
  /** 閉じたセッションを完了カテゴリへ移す */
  channelOps: Pick<ChannelOpsQueue, "enqueueMove">;
  /** 発言のターンと同じキュー（key は channelId）。/close のターンが発言のターンと重ならないようにする */
  turnQueue: KeyedSerialQueue;
  turn: TurnDeps;
  /** チャンネルの持ち主の人格。既定の人格以外のチャンネルの /close の結果は、持ち主の Bot がチャンネルに投稿する。無ければすべて既定の人格 */
  personas?: Pick<PersonaRouter, "ownerOf" | "gatewayFor">;
  /** 閉じたセッションのプロジェクトの node_modules を消す（プロジェクトのディレクトリは `<projectsDir>/<slug>`） */
  projects: Pick<ProjectStore, "getByChannel">;
  projectsDir: string;
  /** Web UI のためのターンの記録（Web UI が有効なときだけ渡す）。閉じたら区切りの行を書く。無ければ書かない */
  history?: Pick<HistoryStore, "add">;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** /close と同じ流れを始める [閉じる] ボタン（`close:start:<channelId>`。待ちに移した知らせに付ける） */
export function closeStartButton(channelId: string): ButtonDef {
  return { customId: closeCustomId("start", channelId), label: "閉じる" };
}

function pickSelect(channelId: string, draft: CloseDraft): ComponentRow {
  return {
    kind: "select",
    select: {
      customId: closeCustomId("sel", channelId),
      placeholder: "登録するものを選んでください",
      minValues: 1,
      maxValues: draft.tasks.length,
      options: draft.tasks.map((task, index) => ({
        label: clip(`${index + 1}. ${task.title}`, TASK_LABEL_MAX_LENGTH, "…"),
        value: String(index),
        ...(task.due === undefined ? {} : { description: `期限 ${task.due}` }),
      })),
    },
  };
}

/** /close の流れの応答のしかた（/close と [閉じる] ボタンで違う）。show はターンの結果（要約と確認のボタン、閉じた旨、失敗）を出す */
type CloseResponse = CommandResponse;

/**
 * /close の流れ: 閉じられるか確かめる（だめなら ephemeral で断る）→ 保留 → そのセッションの会話で要約とやることの候補を作らせ →
 * 候補があれば確認のボタンを、無ければ閉じた旨を出す（閉じたらプロジェクトの node_modules を消す）。/close と [閉じる] ボタンで共通
 */
async function runClose(
  deps: CloseDeps,
  guildId: string,
  channelId: string | null,
  responder: InteractionResponder,
  response: CloseResponse,
): Promise<void> {
  if (channelId === null) {
    await responder.reply({ text: NOT_SESSION_REPLY, ephemeral: true });
    return;
  }
  let accepted = false;
  const outcome = await closeSession(guildId, channelId, deps, async () => {
    accepted = true;
    await response.defer();
  });
  // 受け付ける前に断ったもの（保留していない）
  if (!accepted) {
    const text = outcome.result === "not_session" ? NOT_SESSION_REPLY : ALREADY_CLOSED_REPLY;
    await responder.reply({ text, ephemeral: true });
    return;
  }
  switch (outcome.result) {
    case "not_session":
    case "closed":
      await response.show({ text: ALREADY_CLOSED_REPLY });
      return;
    case "failed":
      await response.show({ text: SUMMARY_FAILURE_REPLY });
      return;
    case "finalized":
      try {
        await response.show({ text: closedText(outcome.summary, 0) });
      } finally {
        await removeClosedNodeModules(deps, channelId);
      }
      return;
    case "confirm":
      await response.show({ text: confirmText(outcome.draft), components: [confirmButtons(channelId)] });
      return;
  }
}

/** `/close`: そのセッションの会話で要約とやることの候補を作らせ、候補があれば確認のボタンを出す */
export function createCloseCommand(deps: CloseDeps): CommandHandler {
  return {
    def: { name: "close", description: "このセッションを閉じます（要約を残し、やることの候補を確認して登録します）" },
    async handle(interaction, responder) {
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で /close が呼ばれました");
      // 公開で保留する。要約と確認はチャンネルに残す（既定の人格以外のチャンネルでは、持ち主の Bot がチャンネルに投稿する）
      await runClose(
        deps,
        guildId,
        interaction.channelId,
        responder,
        commandResponse(deps.personas, interaction.channelId, responder, deps.log),
      );
    },
  };
}

/**
 * /close の確認のボタン（`close:all|pick|none:<channelId>`）とセレクト（`close:sel:<channelId>`）、/close と同じ流れを始める [閉じる]（`close:start:<channelId>`）。
 * 確認のボタンは DB の下書きで動くので、再起動の後でも押せる。下書きが無ければ /close のやり直しを案内する。閉じたらプロジェクトの node_modules を消す
 */
export function createCloseComponent(deps: CloseDeps): ComponentHandler {
  const { topicSessions } = deps;
  return {
    namespace: CLOSE_NAMESPACE,
    async handle(interaction, responder) {
      const [, action, channelId] = interaction.customId.split(":");
      if (channelId === undefined || channelId === "") throw new Error("close の custom_id にチャンネルがありません");
      if (interaction.kind === "button" && action === "start") {
        // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
        const guildId = interaction.guildId;
        if (guildId === null) throw new Error("サーバー外で [閉じる] が押されました");
        // 元メッセージ（待ちに移した知らせ）は変えずに保留し、結果でそのメッセージを書き換える（[続ける][閉じる] は外れる）
        await runClose(deps, guildId, channelId, responder, {
          defer: () => responder.deferUpdate(),
          show: (message) => responder.update({ ...message, components: message.components ?? [] }),
        });
        return;
      }
      const guildId = interaction.guildId;
      const session = topicSessions.get(channelId);
      const draft = topicSessions.getCloseDraft(channelId);
      if (session === undefined || draft === undefined || guildId === null || closable(session, guildId) !== "ok") {
        await responder.reply({ text: NO_DRAFT_REPLY, ephemeral: true });
        return;
      }

      let selected: number[] | "all" | "none";
      if (interaction.kind === "button" && action === "pick" && draft.tasks.length > 0) {
        // ボタンは残したまま、同じメッセージにセレクトを足す
        await responder.update({
          text: confirmText(draft),
          components: [confirmButtons(channelId), pickSelect(channelId, draft)],
        });
        return;
      } else if (interaction.kind === "button" && action === "all") {
        selected = "all";
      } else if (interaction.kind === "button" && (action === "none" || action === "pick")) {
        // 候補が無い下書きの [選ぶ] は [登録しない] と同じ
        selected = "none";
      } else if (interaction.kind === "select" && action === "sel") {
        selected = interaction.values.map(Number).filter((index) => Number.isInteger(index));
      } else {
        throw new Error(`close の不明な操作です（${interaction.kind} ${action ?? ""}）`);
      }

      const closed = confirmClose(guildId, channelId, selected, deps);
      if (closed.result === "no_draft") {
        await responder.reply({ text: NO_DRAFT_REPLY, ephemeral: true });
        return;
      }
      try {
        await responder.update({ text: closedText(closed.summary, closed.registered), components: [] });
      } catch (error) {
        // 閉じる処理は済んでいるので、失敗の返信にはしない
        deps.log(`/close の確認メッセージの更新に失敗しました: ${describeError(error)}`);
      }
      await removeClosedNodeModules(deps, channelId);
    },
  };
}
