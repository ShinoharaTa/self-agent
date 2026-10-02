import type { AgentRunner, RunResult } from "../agent/runner.ts";
import type { Config } from "../config.ts";
import type { Gateway, IncomingMessage } from "../discord/gateway.ts";
import type { ChannelSeedStore } from "../store/channel-seeds.ts";
import type { SessionStore } from "../store/sessions.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";
import type { UsageStore } from "../store/usage.ts";
import { acceptedChannel, type ResolveChannel } from "./access.ts";
import { buildTurnPrompt } from "./prompt.ts";
import type { KeyedSerialQueue } from "./queue.ts";
import { runChannelTurn, type TurnDeps } from "./turn.ts";

export const FAILURE_REPLY = "処理に失敗しました。時間をおいてもう一度送ってください。";
export const EMPTY_REPLY = "（返答が空でした）";

export type HandlerDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "ownerUserId" | "timeZone">;
  /** 受け付け対象のチャンネルか（DB の設定、無ければ env の #inbox。/new で作ったセッション） */
  resolveChannel: ResolveChannel;
  gateway: Gateway;
  runner: AgentRunner;
  sessions: SessionStore;
  /** 次のターンの prompt の先頭に付ける文（resume 失敗の復旧など） */
  seeds: ChannelSeedStore;
  /** セッションの題名と最終発言の時刻、resume 失敗時の要約 */
  topicSessions: Pick<TopicSessionStore, "touch" | "get">;
  usage: UsageStore;
  /** ターンのキュー（key は channelId）。/close のターンも同じキューに入れる */
  queue: KeyedSerialQueue;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 受け付けた発言を 1 ターンとして処理する。返す Promise は reject しない（失敗は log に出す） */
export function createHandler(deps: HandlerDeps): (event: IncomingMessage) => Promise<void> {
  const { cfg, resolveChannel, gateway, runner, sessions, seeds, topicSessions, usage, queue, log } = deps;
  const turnDeps: TurnDeps = { runner, sessions, seeds, topicSessions, usage, log };

  /** 返信の失敗は log に出して終える（再試行しない） */
  const reply = async (event: IncomingMessage, text: string): Promise<void> => {
    try {
      await gateway.send(event.channelId, text, event.id);
    } catch (error) {
      log(`返信に失敗しました: ${describeError(error)}`);
    }
  };

  /** channelName は prompt の日時ヘッダに入れるチャンネル名 */
  const handleTurn = async (event: IncomingMessage, guildId: string, channelName: string): Promise<void> => {
    const stopTyping = gateway.startTyping(event.channelId);
    let result: RunResult;
    try {
      // 会話の単位はチャンネル（key は channelId）
      result = await runChannelTurn(turnDeps, {
        guildId,
        channelId: event.channelId,
        // 日時はキュー待ちでずれないよう、発言の時刻を使う
        prompt: buildTurnPrompt(event.content, event.createdAt, cfg.timeZone, channelName),
      });
    } finally {
      stopTyping();
    }

    if (result.ok) {
      await reply(event, result.text.trim() === "" ? EMPTY_REPLY : result.text);
      return;
    }

    log(`ターンが失敗しました: ${result.errorMessage}`);
    await reply(event, FAILURE_REPLY);
  };

  return async (event) => {
    try {
      // 受付判定は DB を引くので try の中で行う
      const kind = acceptedChannel(event, cfg, resolveChannel);
      // 受け付けた発言は必ずサーバー内（guildId は null でない）
      if (kind === null || event.guildId === null) return;
      const guildId = event.guildId;
      let channelName = "inbox";
      if (kind === "session") {
        // 最終発言の時刻はキュー待ちの前に記録する。日時ヘッダには題名を出す
        const session = topicSessions.touch(event.channelId);
        if (session === undefined) return;
        channelName = session.title;
      }
      await queue.run(event.channelId, () => handleTurn(event, guildId, channelName));
    } catch (error) {
      log(`ターンの処理中にエラーが発生しました: ${describeError(error)}`);
    }
  };
}
