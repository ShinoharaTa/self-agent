// タスクツールとセッションのツール。ハンドラは SDK に依存せずストアだけを使う。末尾の createTaskMcpServer が SDK への薄いアダプタ
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import * as z from "zod";
import type { Task, TaskStatus, TaskStore } from "../store/tasks.ts";
import {
  CLOSE_SUMMARY_MAX_LENGTH,
  CLOSE_TASKS_MAX,
  type CloseDraft,
  type TopicSessionStore,
} from "../store/topic-sessions.ts";
import type { RunContext } from "./runner.ts";

export const MCP_SERVER_NAME = "selfagent";

const DEFAULT_LIST_LIMIT = 20;

/** MCP の CallToolResult（text 1 個） */
export type TextToolResult = { content: [{ type: "text"; text: string }] };

export type TaskAddArgs = { title: string; due?: string };
export type TaskListArgs = { status?: TaskStatus; limit?: number };
export type TaskCompleteArgs = { id: number };
export type SessionReportArgs = { summary: string; tasks?: CloseDraft["tasks"] };

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

/**
 * セッションのツール。context はこの run のチャンネル（ツール定義は固定のまま、ハンドラが見るチャンネルだけが run ごとに変わる）。
 * セッション（sessions に行があり、削除済みでない）以外では not_available を返す（エラーにはしない）
 */
export function createSessionToolHandlers(
  topicSessions: Pick<TopicSessionStore, "get" | "saveCloseDraft">,
  context: RunContext | undefined,
) {
  return {
    sessionReport(args: SessionReportArgs): TextToolResult {
      const session = context === undefined ? undefined : topicSessions.get(context.channelId);
      if (session === undefined || session.state === "deleted" || session.guildId !== context?.guildId) {
        return textResult({ result: "not_available" });
      }
      topicSessions.saveCloseDraft(session.channelId, { summary: args.summary, tasks: args.tasks ?? [] });
      return textResult({ ok: true });
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
const SESSION_REPORT_DESCRIPTION =
  "セッション（/new で作ったチャンネル）を閉じるときに、ここまでの要約と、まだ登録していないやることの候補を報告する。" +
  "/close で頼まれたときだけ、1 回だけ使う。tasks はオーナーが確認してから登録するので、ここに入れたものを task_add で登録しない。" +
  "セッション以外のチャンネルでは not_available を返す。";

export function createTaskMcpServer(
  store: TaskStore,
  topicSessions: Pick<TopicSessionStore, "get" | "saveCloseDraft">,
  context?: RunContext,
): McpSdkServerConfigWithInstance {
  const handlers = createTaskToolHandlers(store);
  const sessionHandlers = createSessionToolHandlers(topicSessions, context);
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
      tool(
        "session_report",
        SESSION_REPORT_DESCRIPTION,
        {
          summary: z
            .string()
            .min(1)
            .max(CLOSE_SUMMARY_MAX_LENGTH)
            .describe(`ここまでの内容の要約（${CLOSE_SUMMARY_MAX_LENGTH} 字以内）`),
          tasks: z
            .array(
              z.object({
                title: z.string().min(1).max(200).describe("やることの内容"),
                due: z.iso.date().optional().describe("期限（YYYY-MM-DD）。期限が無ければ省略"),
              }),
            )
            .max(CLOSE_TASKS_MAX)
            .optional()
            .describe(`まだ登録していないやること（${CLOSE_TASKS_MAX} 件まで）。無ければ省略`),
        },
        async (args) => sessionHandlers.sessionReport(args),
      ),
    ],
  });
}
