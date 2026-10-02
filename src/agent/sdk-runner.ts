// AgentRunner の Agent SDK 実装。query() を使うのはこのファイルだけ
import {
  query,
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

/** ログ向けに 1 行・上限文字数に縮める */
function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > ERROR_TEXT_LIMIT ? `${oneLine.slice(0, ERROR_TEXT_LIMIT)}…` : oneLine;
}

/** result のエラーを 1 行にする。errors があれば添える（resume 失敗の文言などを handler が判定できるように残す） */
export function describeResultError(result: SDKResultMessage): string {
  if (result.subtype === "success") {
    return `success (is_error): ${shorten(result.result)}`;
  }
  const errors = result.errors.filter((error) => error.trim() !== "");
  return errors.length === 0 ? result.subtype : `${result.subtype}: ${shorten(errors.join(" / "))}`;
}

export class SdkAgentRunner implements AgentRunner {
  private readonly cfg: Pick<Config, "model" | "workDir" | "claudeConfigDir" | "turnTimeoutSec" | "effort">;
  private readonly createMcpServer: (context?: RunContext) => McpSdkServerConfigWithInstance;
  private readonly queryFn: QueryFn;

  /**
   * MCP サーバーのインスタンスは同時に 1 つの query にしか接続できないため、run ごとに createMcpServer で作る。
   * ツール定義は毎回同じ（ハンドラが参照する context だけが変わる）なのでプロンプトキャッシュには影響しない。
   * queryFn は省略すれば SDK の query（テストで差し替える）
   */
  constructor(
    cfg: Pick<Config, "model" | "workDir" | "claudeConfigDir" | "turnTimeoutSec" | "effort">,
    createMcpServer: (context?: RunContext) => McpSdkServerConfigWithInstance,
    queryFn: QueryFn = query,
  ) {
    this.cfg = cfg;
    this.createMcpServer = createMcpServer;
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
    const options: Options =
      input.sessionId === undefined
        ? { ...base, abortController }
        : { ...base, abortController, resume: input.sessionId };
    // メインループの各ステップの usage を合算する。並列ツール呼び出しは同じ message.id を共有するので重複を除く
    const seenMessageIds = new Set<string>();
    const usage: TurnUsage = { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
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
        return { ok: false, errorMessage: "timeout", sessionId, sessionRecorded: false };
      }
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return { ok: false, errorMessage: `exception: ${shorten(text)}`, sessionId, sessionRecorded: false };
    }

    if (abortController.signal.aborted) {
      return { ok: false, errorMessage: "timeout", sessionId, sessionRecorded: false };
    }
    if (result === undefined) {
      return { ok: false, errorMessage: "result メッセージを受け取れませんでした", sessionId, sessionRecorded: false };
    }
    if (result.subtype !== "success" || result.is_error) {
      // result まで届いたので SDK は会話を記録している（error_max_turns なら途中のツール呼び出しも含む）
      return {
        ok: false,
        errorMessage: describeResultError(result),
        sessionId: result.session_id,
        sessionRecorded: true,
      };
    }
    return {
      ok: true,
      text: result.result,
      sessionId: result.session_id,
      usage,
      durationMs: result.duration_ms,
      ...(compacted === undefined ? {} : { compacted }),
    };
  }
}
