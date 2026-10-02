import type { AgentRunner, RunResult } from "../agent/runner.ts";
import type { Config } from "../config.ts";
import type { Gateway, IncomingMessage } from "../discord/gateway.ts";
import type { SessionStore } from "../store/sessions.ts";
import type { UsageStore } from "../store/usage.ts";
import { isAccepted } from "./access.ts";
import { buildTurnPrompt } from "./prompt.ts";
import type { KeyedSerialQueue } from "./queue.ts";

export const FAILURE_REPLY = "処理に失敗しました。時間をおいてもう一度送ってください。";
export const EMPTY_REPLY = "（返答が空でした）";

export type HandlerDeps = {
  cfg: Pick<Config, "guildId" | "inboxChannelId" | "ownerUserId" | "timeZone">;
  gateway: Gateway;
  runner: AgentRunner;
  sessions: SessionStore;
  usage: UsageStore;
  queue: KeyedSerialQueue;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 受け付けた発言を 1 ターンとして処理する。返す Promise は reject しない（失敗は log に出す） */
export function createHandler(deps: HandlerDeps): (event: IncomingMessage) => Promise<void> {
  const { cfg, gateway, runner, sessions, usage, queue, log } = deps;

  /** 返信の失敗は log に出して終える（再試行しない） */
  const reply = async (event: IncomingMessage, text: string): Promise<void> => {
    try {
      await gateway.send(event.channelId, text, event.id);
    } catch (error) {
      log(`返信に失敗しました: ${describeError(error)}`);
    }
  };

  const handleTurn = async (event: IncomingMessage): Promise<void> => {
    // P1 の会話単位はチャンネル（P2 でスレッドになる）
    const key = event.channelId;
    const stopTyping = gateway.startTyping(event.channelId);
    let result: RunResult;
    try {
      result = await runner.run({
        // 日時はキュー待ちでずれないよう、発言の時刻を使う
        prompt: buildTurnPrompt(event.content, event.createdAt, cfg.timeZone),
        sessionId: sessions.get(key),
      });
    } finally {
      stopTyping();
    }

    if (result.ok) {
      usage.record({
        key,
        sessionId: result.sessionId,
        ok: true,
        durationMs: result.durationMs,
        inputTokens: result.usage.inputTokens,
        cacheReadInputTokens: result.usage.cacheReadInputTokens,
        cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
      });
      sessions.set(key, result.sessionId);
      await reply(event, result.text.trim() === "" ? EMPTY_REPLY : result.text);
      return;
    }

    log(`ターンが失敗しました: ${result.errorMessage}`);
    usage.record({ key, sessionId: result.sessionId, ok: false });
    await reply(event, FAILURE_REPLY);
  };

  return async (event) => {
    if (!isAccepted(event, cfg)) return;
    try {
      await queue.run(event.channelId, () => handleTurn(event));
    } catch (error) {
      log(`ターンの処理中にエラーが発生しました: ${describeError(error)}`);
    }
  };
}
