// AgentRunner の Agent SDK 実装。query() を使うのはこのファイルだけ
import {
  query,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.ts";
import { buildQueryOptions } from "./query-options.ts";
import type { AgentRunner, RunInput, RunResult, TurnUsage } from "./runner.ts";

const ERROR_TEXT_LIMIT = 200;

/** ログ向けに 1 行・上限文字数に縮める */
function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > ERROR_TEXT_LIMIT ? `${oneLine.slice(0, ERROR_TEXT_LIMIT)}…` : oneLine;
}

function describeResultError(result: SDKResultMessage): string {
  if (result.subtype === "success") {
    return `success (is_error): ${shorten(result.result)}`;
  }
  return result.subtype;
}

export class SdkAgentRunner implements AgentRunner {
  private readonly cfg: Pick<Config, "model" | "workDir" | "claudeConfigDir" | "turnTimeoutSec">;
  private readonly createMcpServer: () => McpSdkServerConfigWithInstance;

  /**
   * MCP サーバーのインスタンスは同時に 1 つの query にしか接続できないため、run ごとに createMcpServer で作る。
   * ツール定義は毎回同じなのでプロンプトキャッシュには影響しない
   */
  constructor(
    cfg: Pick<Config, "model" | "workDir" | "claudeConfigDir" | "turnTimeoutSec">,
    createMcpServer: () => McpSdkServerConfigWithInstance,
  ) {
    this.cfg = cfg;
    this.createMcpServer = createMcpServer;
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
    const base = buildQueryOptions(this.cfg, this.createMcpServer());
    const options: Options =
      input.sessionId === undefined
        ? { ...base, abortController }
        : { ...base, abortController, resume: input.sessionId };
    // メインループの各ステップの usage を合算する。並列ツール呼び出しは同じ message.id を共有するので重複を除く
    const seenMessageIds = new Set<string>();
    const usage: TurnUsage = { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    let sessionId = input.sessionId;
    let result: SDKResultMessage | undefined;

    try {
      for await (const message of query({ prompt: input.prompt, options })) {
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
        if (message.type === "result") {
          result = message;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return { ok: false, errorMessage: "timeout", sessionId };
      }
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return { ok: false, errorMessage: `exception: ${shorten(text)}`, sessionId };
    }

    if (abortController.signal.aborted) {
      return { ok: false, errorMessage: "timeout", sessionId };
    }
    if (result === undefined) {
      return { ok: false, errorMessage: "result メッセージを受け取れませんでした", sessionId };
    }
    if (result.subtype !== "success" || result.is_error) {
      return { ok: false, errorMessage: describeResultError(result), sessionId: result.session_id };
    }
    return {
      ok: true,
      text: result.result,
      sessionId: result.session_id,
      usage,
      durationMs: result.duration_ms,
    };
  }
}
