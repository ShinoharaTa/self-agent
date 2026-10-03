// タスクツールとセッションのツール。ハンドラは SDK に依存せずストアだけを使う（session_open は Discord への作成があるので app 側の実装を受け取る）。
// 末尾の createTaskTools・createTaskMcpServer が SDK への薄いアダプタ
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
export type SessionOpenArgs = { title: string; context: string };

/** session_open の結果（そのまま JSON にしてモデルに返す） */
export type SessionOpenResult =
  | { result: "not_available" }
  | { result: "not_set_up" }
  | { result: "existing"; channelId: string }
  | { result: "limit"; message: string }
  | { result: "cooldown"; message: string }
  | { result: "created"; channelId: string };

/**
 * session_open の処理。Discord にチャンネルを作るので app 側（src/app/session-open.ts）で実装して渡す。
 * context はこの run のチャンネル（#inbox 以外なら not_available を返す）
 */
export type OpenSession = (args: SessionOpenArgs, context: RunContext | undefined) => Promise<SessionOpenResult>;

/** session_open の題名の文字数の上限（/new の題名と同じ） */
export const SESSION_OPEN_TITLE_MAX_LENGTH = 100;
/** session_open の context の文字数の上限 */
export const SESSION_OPEN_CONTEXT_MAX_LENGTH = 400;

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
  "登録前に task_list で同じものが無いか確かめる。" +
  "期限が分かるときは due に YYYY-MM-DD で渡す。登録したタスクの id・title・due を返す。";
const TASK_LIST_DESCRIPTION =
  "登録済みのタスクを期限の早い順（期限なしは最後）に返す。タスクの一覧や残っていることを聞かれたとき、" +
  "完了にするタスクの id を確かめたいときに使う。";
const TASK_COMPLETE_DESCRIPTION =
  "タスクを完了にする。オーナーが何かを終えたと言ったときに使う。" +
  "存在しない id や既に完了しているタスクなら、その旨（not_found / already_done）を返す。";
const SESSION_REPORT_DESCRIPTION =
  "セッションのチャンネルを閉じるときに、ここまでの要約と、まだ登録していないやることの候補を報告する。" +
  "/close で頼まれたときだけ、1 回だけ使う。tasks はオーナーが確認してから登録するので、ここに入れたものを task_add で登録しない。" +
  "セッション以外のチャンネルでは not_available を返す。";
// 使いどころと結果ごとの扱いはシステムプロンプトと揃える。システムプロンプトは SDK がセッション初回に記録して以後変わらないため、
// 既存の #inbox のセッションにはここだけが届く（ツールの説明は毎ターン送られる）。可変値（上限の数など）は入れない
const SESSION_OPEN_DESCRIPTION =
  "#inbox での相談が 3 往復以上続きそう、または設計・調べもの・計画など腰を据えた話題になりそうなときに、" +
  "その話題専用のセッション（チャンネル）を作る。単発のタスク登録や短い質問では使わない。" +
  "作ったら返事にチャンネルのリンク（<#チャンネルID>）を書き、続きはそのチャンネルで話すよう伝える。" +
  "existing を返したら（同じ題名のセッションが既にある）、そのチャンネルを案内する。" +
  "limit や cooldown を返したら、message を伝えて /new を案内する。not_set_up を返したら /setup を案内する。";

/**
 * MCP サーバーに載せるツールの一覧。どのチャンネルの run でも定義（名前・説明・入力の形）は同じで、
 * ハンドラが見る context だけが変わる（ツール集合は全セッション共通で固定する）
 */
export function createTaskTools(
  store: TaskStore,
  topicSessions: Pick<TopicSessionStore, "get" | "saveCloseDraft">,
  openSession: OpenSession,
  context?: RunContext,
) {
  const handlers = createTaskToolHandlers(store);
  const sessionHandlers = createSessionToolHandlers(topicSessions, context);
  return [
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
    tool(
      "session_open",
      SESSION_OPEN_DESCRIPTION,
      {
        // 前後の空白は除く（/new と同じ）。空白だけの題名は検証で弾く
        title: z
          .string()
          .trim()
          .min(1)
          .max(SESSION_OPEN_TITLE_MAX_LENGTH)
          .describe(`セッションの題名（チャンネル名と topic に使う。${SESSION_OPEN_TITLE_MAX_LENGTH} 字以内）`),
        context: z
          .string()
          .min(1)
          .max(SESSION_OPEN_CONTEXT_MAX_LENGTH)
          .describe(
            `#inbox でのここまでの話の要点（${SESSION_OPEN_CONTEXT_MAX_LENGTH} 字以内）。新しいチャンネルの最初のターンに渡す`,
          ),
      },
      // Discord にチャンネルを作り終えるまで待つ（ターンのタイムアウト内に収まる前提）
      async (args) => textResult(await openSession(args, context)),
    ),
  ];
}

export function createTaskMcpServer(
  store: TaskStore,
  topicSessions: Pick<TopicSessionStore, "get" | "saveCloseDraft">,
  openSession: OpenSession,
  context?: RunContext,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    alwaysLoad: true,
    tools: createTaskTools(store, topicSessions, openSession, context),
  });
}
