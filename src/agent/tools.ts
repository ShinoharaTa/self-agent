// タスクツール。ハンドラは SDK に依存せず TaskStore だけを使う。末尾の createTaskMcpServer が SDK への薄いアダプタ
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import * as z from "zod";
import type { Task, TaskStatus, TaskStore } from "../store/tasks.ts";

export const MCP_SERVER_NAME = "selfagent";

const DEFAULT_LIST_LIMIT = 20;

/** MCP の CallToolResult（text 1 個） */
export type TextToolResult = { content: [{ type: "text"; text: string }] };

export type TaskAddArgs = { title: string; due?: string };
export type TaskListArgs = { status?: TaskStatus; limit?: number };
export type TaskCompleteArgs = { id: number };

function textResult(value: unknown): TextToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function summary(task: Task): { id: number; title: string; due: string | null } {
  return { id: task.id, title: task.title, due: task.due };
}

export function createTaskToolHandlers(store: TaskStore) {
  return {
    taskAdd(args: TaskAddArgs): TextToolResult {
      return textResult(summary(store.add({ title: args.title, due: args.due })));
    },
    taskList(args: TaskListArgs): TextToolResult {
      const tasks = store.list({ status: args.status ?? "open", limit: args.limit ?? DEFAULT_LIST_LIMIT });
      return textResult(tasks.map(summary));
    },
    taskComplete(args: TaskCompleteArgs): TextToolResult {
      const outcome = store.complete(args.id);
      if (outcome.result === "not_found") {
        return textResult({ result: "not_found", id: args.id });
      }
      return textResult({ result: outcome.result, ...summary(outcome.task) });
    },
  };
}

const TASK_ADD_DESCRIPTION =
  "オーナーのやることをタスクとして登録する。会話の中でやること・予定・忘れたくないことが出てきたときに使う。" +
  "期限が分かるときは due に YYYY-MM-DD で渡す。登録したタスクの id・title・due を返す。";
const TASK_LIST_DESCRIPTION =
  "登録済みのタスクを期限の早い順（期限なしは最後）に返す。タスクの一覧や残っていることを聞かれたとき、" +
  "完了にするタスクの id を確かめたいときに使う。";
const TASK_COMPLETE_DESCRIPTION =
  "タスクを完了にする。オーナーが何かを終えたと言ったときに使う。" +
  "存在しない id や既に完了しているタスクなら、その旨（not_found / already_done）を返す。";

export function createTaskMcpServer(store: TaskStore): McpSdkServerConfigWithInstance {
  const handlers = createTaskToolHandlers(store);
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    alwaysLoad: true,
    tools: [
      tool(
        "task_add",
        TASK_ADD_DESCRIPTION,
        {
          title: z.string().min(1).max(200).describe("タスクの内容"),
          due: z.iso.date().optional().describe("期限（YYYY-MM-DD）。期限が無ければ省略"),
        },
        async (args) => handlers.taskAdd(args),
      ),
      tool(
        "task_list",
        TASK_LIST_DESCRIPTION,
        {
          status: z.enum(["open", "done"]).optional().describe("open（未完了、既定）または done（完了済み）"),
          limit: z.number().int().min(1).max(50).optional().describe(`最大件数（既定 ${DEFAULT_LIST_LIMIT}）`),
        },
        async (args) => handlers.taskList(args),
      ),
      tool(
        "task_complete",
        TASK_COMPLETE_DESCRIPTION,
        {
          id: z.number().int().describe("完了にするタスクの id"),
        },
        async (args) => handlers.taskComplete(args),
      ),
    ],
  });
}
