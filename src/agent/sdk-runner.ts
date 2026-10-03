// AgentRunner の Agent SDK 実装。query() を使うのはこのファイルだけ
import {
  query,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.ts";
import { buildQueryOptions } from "./query-options.ts";
import type { AgentRunner, Compaction, RunContext, RunInput, RunResult, TurnUsage } from "./runner.ts";

/** query() の形。テストでは偽のストリームを返す関数に差し替える */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

const ERROR_TEXT_LIMIT = 200;
/** Claude の子プロセスの stderr のうち保持する末尾の文字数 */
const STDERR_KEEP_LENGTH = 2000;

/** ログ向けに 1 行・上限文字数に縮める */
function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > ERROR_TEXT_LIMIT ? `${oneLine.slice(0, ERROR_TEXT_LIMIT)}…` : oneLine;
}

/** stderr を 1 行にして末尾の上限文字数だけ残す（空なら空文字）。サロゲートペアの途中から始まれば後半も落とす */
function stderrTail(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= ERROR_TEXT_LIMIT) return oneLine;
  let tail = oneLine.slice(-ERROR_TEXT_LIMIT);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return `…${tail}`;
}

/**
 * result のエラーを 1 行にする。errors があれば添える（resume 失敗の文言などを handler が判定できるように残す）。
 * result の本文（result.result）は会話の内容を含みうるので、is_error でも入れない
 */
export function describeResultError(result: SDKResultMessage): string {
  if (result.subtype === "success") {
    return "success (is_error)";
  }
  const errors = result.errors.filter((error) => error.trim() !== "");
  return errors.length === 0 ? result.subtype : `${result.subtype}: ${shorten(errors.join(" / "))}`;
}

/** ツール呼び出しの記録。hooks を Options に入れ、count でそのターンの回数を読む */
export type ToolCallRecorder = {
  hooks: NonNullable<Options["hooks"]>;
  count(): number;
};

/**
 * ツール呼び出しを数え、ツール名と所要時間（取れなければ名前だけ）を log に出す。失敗した呼び出しも数え、失敗として出す。
 * ツールの入力・出力・エラーの中身は log に出さない。hooks は SDK 側（クライアント）で呼ばれるだけなので、プロンプトキャッシュには影響しない
 */
export function createToolCallRecorder(log: (message: string) => void): ToolCallRecorder {
  let calls = 0;
  const duration = (ms: number | undefined): string => (typeof ms === "number" ? `（${ms} ms）` : "");
  const onToolUse: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse") {
      calls++;
      log(`ツールを呼び出しました: ${input.tool_name}${duration(input.duration_ms)}`);
    } else if (input.hook_event_name === "PostToolUseFailure") {
      calls++;
      log(`ツールの呼び出しが失敗しました: ${input.tool_name}${duration(input.duration_ms)}`);
    }
    return {};
  };
  return {
    hooks: { PostToolUse: [{ hooks: [onToolUse] }], PostToolUseFailure: [{ hooks: [onToolUse] }] },
    count: () => calls,
  };
}

export class SdkAgentRunner implements AgentRunner {
  private readonly cfg: Pick<Config, "model" | "workDir" | "claudeConfigDir" | "turnTimeoutSec" | "effort">;
  private readonly createMcpServer: (context?: RunContext) => McpSdkServerConfigWithInstance;
  private readonly log: (message: string) => void;
  private readonly queryFn: QueryFn;

  /**
   * MCP サーバーのインスタンスは同時に 1 つの query にしか接続できないため、run ごとに createMcpServer で作る。
   * ツール定義は毎回同じ（ハンドラが参照する context だけが変わる）なのでプロンプトキャッシュには影響しない。
   * log はツール呼び出しの記録に使う。queryFn は省略すれば SDK の query（テストで差し替える）
   */
  constructor(
    cfg: Pick<Config, "model" | "workDir" | "claudeConfigDir" | "turnTimeoutSec" | "effort">,
    createMcpServer: (context?: RunContext) => McpSdkServerConfigWithInstance,
    log: (message: string) => void,
    queryFn: QueryFn = query,
  ) {
    this.cfg = cfg;
    this.createMcpServer = createMcpServer;
    this.log = log;
    this.queryFn = queryFn;
  }

  async run(input: RunInput): Promise<RunResult> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), this.cfg.turnTimeoutSec * 1000);
    try {
      return await this.runQuery(input, abortController);
    } finally {
      clearTimeout(timer);
    }
  }

  private async runQuery(input: RunInput, abortController: AbortController): Promise<RunResult> {
    const base = buildQueryOptions(this.cfg, this.createMcpServer(input.context));
    // ツール呼び出しの回数はターンごとに数えるので、hooks も run ごとに作って足す
    const tools = createToolCallRecorder(this.log);
    // 子プロセスの stderr は末尾だけ保持し、例外で終わったときに errorMessage に添える（中身を log に直接は出さない）
    let stderr = "";
    const onStderr = (data: string): void => {
      stderr = (stderr + data).slice(-STDERR_KEEP_LENGTH);
    };
    const options: Options =
      input.sessionId === undefined
        ? { ...base, abortController, hooks: tools.hooks, stderr: onStderr }
        : { ...base, abortController, hooks: tools.hooks, stderr: onStderr, resume: input.sessionId };
    // メインループの各ステップの usage を合算する。並列ツール呼び出しは同じ message.id を共有するので重複を除く
    const seenMessageIds = new Set<string>();
    const usage: TurnUsage = { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    // メインループの最後のステップの入力（合算しない）
    let contextTokens = 0;
    let sessionId = input.sessionId;
    let result: SDKResultMessage | undefined;
    let compacted: Compaction | undefined;

    try {
      for await (const message of this.queryFn({ prompt: input.prompt, options })) {
        if ("session_id" in message && typeof message.session_id === "string") {
          sessionId = message.session_id;
        }
        if (
          message.type === "assistant" &&
          message.parent_tool_use_id === null &&
          !seenMessageIds.has(message.message.id)
        ) {
          seenMessageIds.add(message.message.id);
          const stepUsage = message.message.usage;
          usage.inputTokens += stepUsage.input_tokens;
          usage.cacheReadInputTokens += stepUsage.cache_read_input_tokens ?? 0;
          usage.cacheCreationInputTokens += stepUsage.cache_creation_input_tokens ?? 0;
          contextTokens =
            stepUsage.input_tokens + (stepUsage.cache_read_input_tokens ?? 0) + (stepUsage.cache_creation_input_tokens ?? 0);
        }
        // 会話が長くなり SDK が古い部分を要約した。1 ターンに複数回あれば最後のもの
        if (message.type === "system" && message.subtype === "compact_boundary") {
          const metadata = message.compact_metadata;
          compacted = {
            trigger: metadata.trigger,
            ...(typeof metadata.pre_tokens === "number" ? { preTokens: metadata.pre_tokens } : {}),
          };
        }
        if (message.type === "result") {
          result = message;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return { ok: false, errorMessage: "timeout", sessionId, sessionRecorded: false, toolCalls: tools.count() };
      }
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const tail = stderrTail(stderr);
      return {
        ok: false,
        errorMessage: tail === "" ? `exception: ${shorten(text)}` : `exception: ${shorten(text)}（stderr: ${tail}）`,
        sessionId,
        sessionRecorded: false,
        toolCalls: tools.count(),
      };
    }

    if (abortController.signal.aborted) {
      return { ok: false, errorMessage: "timeout", sessionId, sessionRecorded: false, toolCalls: tools.count() };
    }
    if (result === undefined) {
      return {
        ok: false,
        errorMessage: "result メッセージを受け取れませんでした",
        sessionId,
        sessionRecorded: false,
        toolCalls: tools.count(),
      };
    }
    if (result.subtype !== "success" || result.is_error) {
      // result まで届いたので SDK は会話を記録している（error_max_turns なら途中のツール呼び出しも含む）
      return {
        ok: false,
        errorMessage: describeResultError(result),
        sessionId: result.session_id,
        sessionRecorded: true,
        toolCalls: tools.count(),
      };
    }
    return {
      ok: true,
      text: result.result,
      sessionId: result.session_id,
      usage,
      durationMs: result.duration_ms,
      ...(compacted === undefined ? {} : { compacted }),
      toolCalls: tools.count(),
      contextTokens,
    };
  }
}
