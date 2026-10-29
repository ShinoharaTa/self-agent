// GET /api/tasks・POST /api/tasks/<id>/complete・/reopen（docs/plan/web-ui.md §3.4）。タスクの一覧（1 つの状態の一覧と状態ごとの件数）と [完了]、トーストの [取り消す]（open に戻す）。
// 追加・編集は Discord（task_add・task_update）だけ。log に題名は出さない
import type { ReminderStore } from "../../store/reminders.ts";
import type { Task, TaskStatus, TaskStore } from "../../store/tasks.ts";
import type { Route, RouteResult } from "../server.ts";

/** 一覧に出す件数の上限（状態ごと） */
export const WEB_TASK_LIST_LIMIT = 200;

const TASK_STATUSES: readonly TaskStatus[] = ["open", "done", "dropped"];

export type TaskRouteDeps = {
  tasks: Pick<TaskStore, "list" | "counts" | "complete" | "update">;
  /** open のタスクに紐づけた active のリマインドの次の時刻 */
  reminders: Pick<ReminderStore, "nextForTasks">;
  log: (message: string) => void;
};

const BAD_REQUEST: RouteResult = { status: 400, json: { error: "bad_request" } };
const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };

/** 応答の 1 件。remind は次に知らせる時刻（ISO。表示は画面）で、open でなければ null */
function taskOf(task: Task, remind: string | null = null) {
  return { id: task.id, title: task.title, due: task.due, status: task.status, completedAt: task.completedAt, remind };
}

export function taskRoutes(deps: TaskRouteDeps): Route[] {
  const { tasks, reminders, log } = deps;
  return [
    {
      method: "GET",
      pattern: /^\/api\/tasks$/,
      handle: async ({ query }) => {
        // 省略・空は open
        const raw = query.get("status") || "open";
        const status = TASK_STATUSES.find((candidate) => candidate === raw);
        if (status === undefined) return BAD_REQUEST;
        const list = tasks.list({ status, limit: WEB_TASK_LIST_LIMIT });
        const next = status === "open" ? reminders.nextForTasks(list.map((task) => task.id)) : new Map<number, string>();
        return {
          status: 200,
          json: { tasks: list.map((task) => taskOf(task, next.get(task.id) ?? null)), counts: tasks.counts() },
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/tasks\/(\d{1,15})\/complete$/,
      handle: async ({ params }) => {
        const id = Number(params[0]);
        const result = tasks.complete(id);
        switch (result.result) {
          case "not_found":
            return NOT_FOUND;
          case "already_done":
            return { status: 409, json: { error: "already_done" } };
          case "completed":
            log(`Web でタスクを完了にしました（#${id}）`);
            return { status: 200, json: { task: taskOf(result.task) } };
        }
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/tasks\/(\d{1,15})\/reopen$/,
      handle: async ({ params }) => {
        const id = Number(params[0]);
        const result = tasks.update(id, { status: "open" });
        switch (result.result) {
          case "not_found":
            return NOT_FOUND;
          case "no_change":
            return { status: 409, json: { error: "no_change" } };
          case "updated":
            log(`Web でタスクを未完了に戻しました（#${id}）`);
            return { status: 200, json: { task: taskOf(result.after) } };
        }
      },
    },
  ];
}
