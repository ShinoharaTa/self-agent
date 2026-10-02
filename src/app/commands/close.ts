import type { ComponentRow } from "../../discord/gateway.ts";
import type { TaskStore } from "../../store/tasks.ts";
import {
  CLOSE_SUMMARY_MAX_LENGTH,
  type CloseDraft,
  type TopicSession,
  type TopicSessionStore,
} from "../../store/topic-sessions.ts";
import type { ChannelOpsQueue } from "../channel-ops.ts";
import type { CommandHandler, ComponentHandler } from "../interactions.ts";
import type { KeyedSerialQueue } from "../queue.ts";
import { runChannelTurn, type TurnDeps } from "../turn.ts";

/** /close のターンの prompt。静的に保つ（日時ヘッダも付けない） */
export const CLOSE_PROMPT =
  "このセッションを閉じます。ここまでの内容を 600 字以内で要約し、まだ登録していないやることがあれば task_add は使わずに tasks に入れて、session_report を 1 回だけ呼んでください。";

export const NOT_SESSION_REPLY = "セッションのチャンネルで実行してください";
export const ALREADY_CLOSED_REPLY = "このセッションは閉じています";
export const SUMMARY_FAILURE_REPLY = "要約に失敗しました。もう一度 /close を実行してください";
export const NO_DRAFT_REPLY = "/close をもう一度実行してください";
/** session_report が呼ばれず、返答も空だったときの要約 */
export const EMPTY_SUMMARY = "（要約なし）";

/** ボタン・セレクトの custom_id の名前空間（`close:<action>:<channelId>`） */
const NAMESPACE = "close";
/** セレクトの選択肢のラベルと、確認メッセージのタスクの表示の上限（Discord の選択肢のラベルは 100 字まで） */
const TASK_LABEL_MAX_LENGTH = 100;

export type CloseDeps = {
  topicSessions: TopicSessionStore;
  tasks: Pick<TaskStore, "add">;
  /** 閉じたセッションを完了カテゴリへ移す */
  channelOps: Pick<ChannelOpsQueue, "enqueueMove">;
  /** 発言のターンと同じキュー（key は channelId）。/close のターンが発言のターンと重ならないようにする */
  turnQueue: KeyedSerialQueue;
  turn: TurnDeps;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** UTF-16 の単位で max までに切る。サロゲートペアの途中で切れたら前半も落とす */
function clip(text: string, max: number, ellipsis: string = ""): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - ellipsis.length);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}${ellipsis}`;
}

function customId(action: "all" | "pick" | "none" | "sel", channelId: string): string {
  return `${NAMESPACE}:${action}:${channelId}`;
}

/** /close を受け付けられるセッションか（行が無い・サーバーが違えば「セッションでない」、完了・削除済みは「閉じている」） */
function closable(session: TopicSession | undefined, guildId: string): "ok" | "not_session" | "closed" {
  if (session === undefined || session.guildId !== guildId) return "not_session";
  return session.state === "done" || session.state === "deleted" ? "closed" : "ok";
}

/** session_report が呼ばれなかったときの要約（返答本文の先頭 600 字） */
function fallbackSummary(text: string): string {
  const summary = clip(text.trim(), CLOSE_SUMMARY_MAX_LENGTH);
  return summary === "" ? EMPTY_SUMMARY : summary;
}

/** 要約とやることの候補（番号付き）。ボタンを押す前の確認メッセージ */
export function confirmText(draft: CloseDraft): string {
  const lines = ["**要約**", draft.summary, "", "**やることの候補**"];
  draft.tasks.forEach((task, index) => {
    const due = task.due === undefined ? "" : `（期限 ${task.due}）`;
    lines.push(`${index + 1}. ${clip(task.title, TASK_LABEL_MAX_LENGTH, "…")}${due}`);
  });
  lines.push("", "タスクとして登録するものを選んでください。");
  return lines.join("\n");
}

export function closedText(summary: string, registered: number): string {
  return ["**要約**", summary, "", `閉じました（登録 ${registered} 件）`].join("\n");
}

function confirmButtons(channelId: string): ComponentRow {
  return {
    kind: "buttons",
    buttons: [
      { customId: customId("all", channelId), label: "全部登録", style: "primary" },
      { customId: customId("pick", channelId), label: "選ぶ" },
      { customId: customId("none", channelId), label: "登録しない" },
    ],
  };
}

function pickSelect(channelId: string, draft: CloseDraft): ComponentRow {
  return {
    kind: "select",
    select: {
      customId: customId("sel", channelId),
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

/**
 * 閉じる: 選んだタスク（draft.tasks の添字）を登録 → 完了にして要約を残し下書きを消す → 完了カテゴリへの移動を列に入れる。
 * DB の更新は await を挟まずに行う（同じ下書きで 2 回登録しない）。登録した件数を返す
 */
function finalizeClose(
  session: TopicSession,
  draft: CloseDraft,
  selected: readonly number[],
  deps: Pick<CloseDeps, "topicSessions" | "tasks" | "channelOps" | "log">,
): number {
  const { topicSessions, tasks, channelOps, log } = deps;
  // 選んだ順ではなく候補の順に登録する
  const chosen = [...new Set(selected)]
    .sort((a, b) => a - b)
    .flatMap((index) => {
      const task = draft.tasks[index];
      return task === undefined ? [] : [task];
    });
  for (const task of chosen) tasks.add({ title: task.title, due: task.due });
  topicSessions.close(session.channelId, draft.summary);
  channelOps.enqueueMove(session.channelId, { kind: "state", guildId: session.guildId, state: "done" });
  log(`/close でセッションを閉じました（guild=${session.guildId}、登録 ${chosen.length} 件）`);
  return chosen.length;
}

type CloseTurnOutcome =
  | { result: "closed" }
  | { result: "failed"; errorMessage: string }
  | { result: "finalized"; summary: string }
  | { result: "confirm"; draft: CloseDraft };

/** `/close`: そのセッションの会話で要約とやることの候補を作らせ、候補があれば確認のボタンを出す */
export function createCloseCommand(deps: CloseDeps): CommandHandler {
  const { topicSessions, turnQueue, turn, log } = deps;

  /** 発言のターンと同じキューの中で行う（状態はキュー待ちの間に変わりうるので、ここでも確かめる） */
  const closeTurn = async (guildId: string, channelId: string): Promise<CloseTurnOutcome> => {
    const session = topicSessions.get(channelId);
    if (session === undefined || closable(session, guildId) !== "ok") return { result: "closed" };
    // 前の /close や通常のターンで残った下書きは使わない
    topicSessions.clearCloseDraft(channelId);
    const result = await runChannelTurn(turn, { guildId, channelId, prompt: CLOSE_PROMPT });
    if (!result.ok) return { result: "failed", errorMessage: result.errorMessage };
    const draft = topicSessions.getCloseDraft(channelId) ?? { summary: fallbackSummary(result.text), tasks: [] };
    if (draft.tasks.length > 0) return { result: "confirm", draft };
    finalizeClose(session, draft, [], deps);
    return { result: "finalized", summary: draft.summary };
  };

  return {
    def: { name: "close", description: "このセッションを閉じます（要約を残し、やることの候補を確認して登録します）" },
    async handle(interaction, responder) {
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で /close が呼ばれました");
      const channelId = interaction.channelId;
      const check = channelId === null ? "not_session" : closable(topicSessions.get(channelId), guildId);
      if (channelId === null || check === "not_session") {
        await responder.reply({ text: NOT_SESSION_REPLY, ephemeral: true });
        return;
      }
      if (check === "closed") {
        await responder.reply({ text: ALREADY_CLOSED_REPLY, ephemeral: true });
        return;
      }
      // LLM のターンは 3 秒を超えるので先に保留する。要約と確認はチャンネルに残す
      await responder.defer(false);
      const outcome = await turnQueue.run(channelId, () => closeTurn(guildId, channelId));
      switch (outcome.result) {
        case "closed":
          await responder.reply({ text: ALREADY_CLOSED_REPLY });
          return;
        case "failed":
          log(`/close のターンが失敗しました: ${outcome.errorMessage}`);
          await responder.reply({ text: SUMMARY_FAILURE_REPLY });
          return;
        case "finalized":
          await responder.reply({ text: closedText(outcome.summary, 0) });
          return;
        case "confirm":
          await responder.reply({ text: confirmText(outcome.draft), components: [confirmButtons(channelId)] });
          return;
      }
    },
  };
}

/**
 * /close の確認のボタン（`close:all|pick|none:<channelId>`）とセレクト（`close:sel:<channelId>`）。
 * DB の下書きで動くので、再起動の後でも押せる。下書きが無ければ /close のやり直しを案内する
 */
export function createCloseComponent(deps: Pick<CloseDeps, "topicSessions" | "tasks" | "channelOps" | "log">): ComponentHandler {
  const { topicSessions } = deps;
  return {
    namespace: NAMESPACE,
    async handle(interaction, responder) {
      const [, action, channelId] = interaction.customId.split(":");
      if (channelId === undefined || channelId === "") throw new Error("close の custom_id にチャンネルがありません");
      const session = topicSessions.get(channelId);
      const draft = topicSessions.getCloseDraft(channelId);
      if (
        session === undefined ||
        draft === undefined ||
        interaction.guildId === null ||
        closable(session, interaction.guildId) !== "ok"
      ) {
        await responder.reply({ text: NO_DRAFT_REPLY, ephemeral: true });
        return;
      }

      let selected: number[];
      if (interaction.kind === "button" && action === "pick" && draft.tasks.length > 0) {
        // ボタンは残したまま、同じメッセージにセレクトを足す
        await responder.update({
          text: confirmText(draft),
          components: [confirmButtons(channelId), pickSelect(channelId, draft)],
        });
        return;
      } else if (interaction.kind === "button" && action === "all") {
        selected = draft.tasks.map((_task, index) => index);
      } else if (interaction.kind === "button" && (action === "none" || action === "pick")) {
        // 候補が無い下書きの [選ぶ] は [登録しない] と同じ
        selected = [];
      } else if (interaction.kind === "select" && action === "sel") {
        selected = interaction.values.map(Number).filter((index) => Number.isInteger(index));
      } else {
        throw new Error(`close の不明な操作です（${interaction.kind} ${action ?? ""}）`);
      }

      const registered = finalizeClose(session, draft, selected, deps);
      try {
        await responder.update({ text: closedText(draft.summary, registered), components: [] });
      } catch (error) {
        // 閉じる処理は済んでいるので、失敗の返信にはしない
        deps.log(`/close の確認メッセージの更新に失敗しました: ${describeError(error)}`);
      }
    },
  };
}
