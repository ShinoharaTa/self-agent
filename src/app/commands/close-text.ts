// /close の prompt・文と確認のボタン。close.ts（Discord の応答）と session-ops.ts（閉じる処理の本体）の両方が使うので、循環 import を避けてここに置く
import type { ComponentRow } from "../../discord/gateway.ts";
import { CLOSE_SUMMARY_MAX_LENGTH, type CloseDraft } from "../../store/topic-sessions.ts";
import { clip } from "../summary.ts";

/** /close のターンの prompt。静的に保つ（日時ヘッダも付けない。字数は session_report の summary の上限と揃える） */
export const CLOSE_PROMPT =
  `このセッションを閉じます。ここまでの内容を ${CLOSE_SUMMARY_MAX_LENGTH} 字以内で要約し、まだ登録していないやることがあれば task_add は使わずに tasks に入れて、session_report を 1 回だけ呼んでください。`;

export const ALREADY_CLOSED_REPLY = "このセッションは閉じています";

/** ボタン・セレクトの custom_id の名前空間（`close:<action>:<channelId>`） */
export const CLOSE_NAMESPACE = "close";
/** セレクトの選択肢のラベルと、確認メッセージのタスクの表示の上限（Discord の選択肢のラベルは 100 字まで） */
export const TASK_LABEL_MAX_LENGTH = 100;

export function closeCustomId(action: "all" | "pick" | "none" | "sel" | "start", channelId: string): string {
  return `${CLOSE_NAMESPACE}:${action}:${channelId}`;
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

/** 確認メッセージの [全部登録][選ぶ][登録しない] */
export function confirmButtons(channelId: string): ComponentRow {
  return {
    kind: "buttons",
    buttons: [
      { customId: closeCustomId("all", channelId), label: "全部登録", style: "primary" },
      { customId: closeCustomId("pick", channelId), label: "選ぶ" },
      { customId: closeCustomId("none", channelId), label: "登録しない" },
    ],
  };
}
