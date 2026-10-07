import type { OutgoingMessage } from "../../discord/gateway.ts";
import type { Task, TaskStore } from "../../store/tasks.ts";
import type { CommandHandler, ComponentHandler } from "../interactions.ts";
import { fitItems, omittedText } from "./sessions.ts";

export const NO_OPEN_TASKS_TEXT = "未完了のタスクはありません";

/** 一覧に出す未完了のタスクの件数の上限（セレクトの選択肢の上限 25 以下） */
export const TASK_LIST_LIMIT = 20;

/** セレクトの custom_id の名前空間（`tasks:done`） */
const NAMESPACE = "tasks";
const DONE_SELECT_ID = `${NAMESPACE}:done`;
/** セレクトの選択肢のラベルの上限（Discord は 100 字まで） */
const OPTION_LABEL_MAX_LENGTH = 100;

export type TasksDeps = {
  tasks: Pick<TaskStore, "list" | "complete">;
  log: (message: string) => void;
};

/** UTF-16 の単位で max までに切り、切ったら末尾を … にする。サロゲートペアの途中で切れたら前半も落とす */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** 一覧の 1 行: `#id 題名（期限 YYYY-MM-DD）`。期限なしは括弧を付けない */
export function taskLine(task: Task): string {
  return task.due === null ? `#${task.id} ${task.title}` : `#${task.id} ${task.title}（期限 ${task.due}）`;
}

/**
 * 未完了のタスクの一覧（期限順、期限なしは後ろ。最大 20 件）と、完了にするものを選ぶセレクト（`tasks:done`、選択肢は表示した分）。
 * 2000 字を超えるなら末尾から削って「ほか n 件」を足す。0 件なら「未完了のタスクはありません」だけ（/tasks、ホームパネルの [タスク一覧]）
 */
export function taskListMessage(tasks: TasksDeps["tasks"]): OutgoingMessage {
  const open = tasks.list({ status: "open", limit: TASK_LIST_LIMIT });
  if (open.length === 0) return { text: NO_OPEN_TASKS_TEXT, components: [] };
  const { text, shown } = fitItems(open, (list, omitted) =>
    [...list.map(taskLine), ...(omitted > 0 ? [omittedText(omitted)] : [])].join("\n"),
  );
  return {
    text,
    components: [
      {
        kind: "select",
        select: {
          customId: DONE_SELECT_ID,
          placeholder: "完了にするタスクを選んでください",
          minValues: 1,
          maxValues: shown.length,
          options: shown.map((task) => ({
            label: clip(`#${task.id} ${task.title}`, OPTION_LABEL_MAX_LENGTH),
            value: String(task.id),
            ...(task.due === null ? {} : { description: `期限 ${task.due}` }),
          })),
        },
      },
    ],
  };
}

/** `/tasks`: 未完了のタスクの一覧を本人にだけ表示し、セレクトで完了にできるようにする */
export function createTasksCommand(deps: TasksDeps): CommandHandler {
  const { tasks } = deps;
  return {
    def: { name: "tasks", description: "未完了のタスクの一覧を表示します（選んで完了にできます）" },
    async handle(_interaction, responder) {
      await responder.reply({ ...taskListMessage(tasks), ephemeral: true });
    },
  };
}

/** 一覧のセレクト（`tasks:done`）。選んだタスクを完了にし、一覧を書き換える（完了にしたものは消える） */
export function createTasksComponent(deps: TasksDeps): ComponentHandler {
  const { tasks, log } = deps;
  return {
    namespace: NAMESPACE,
    async handle(interaction, responder) {
      if (interaction.kind !== "select" || interaction.customId !== DONE_SELECT_ID) {
        throw new Error(`tasks の不明な操作です（${interaction.kind}）`);
      }
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外でタスクの一覧が操作されました");
      let completed = 0;
      for (const id of new Set(interaction.values.map(Number))) {
        if (!Number.isSafeInteger(id)) continue;
        // 既に完了・見つからないものは数えない（別の一覧やツールで先に完了にされた）
        if (tasks.complete(id).result === "completed") completed++;
      }
      log(`/tasks でタスクを ${completed} 件完了にしました（guild=${guildId}）`);
      await responder.update(taskListMessage(tasks));
    },
  };
}
