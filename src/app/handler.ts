import type { AgentRunner, RunResult } from "../agent/runner.ts";
import type { Config } from "../config.ts";
import type { Gateway, IncomingMessage } from "../discord/gateway.ts";
import type { ChannelSeedStore } from "../store/channel-seeds.ts";
import type { InboxSummaryStore } from "../store/inbox-summaries.ts";
import type { SdkSessionStore } from "../store/sdk-sessions.ts";
import type { TopicSession, TopicSessionStore } from "../store/topic-sessions.ts";
import type { UsageStore } from "../store/usage.ts";
import { acceptedChannel, type ResolveChannel } from "./access.ts";
import type { ChannelOpsQueue } from "./channel-ops.ts";
import { buildTurnPrompt } from "./prompt.ts";
import type { KeyedSerialQueue } from "./queue.ts";
import { applySessionEvent } from "./session-state.ts";
import { MAX_TURNS_ERROR_PREFIX, runChannelTurn, type TurnDeps } from "./turn.ts";

export const FAILURE_REPLY = "処理に失敗しました。時間をおいてもう一度送ってください。";
/** 1 ターンのツール呼び出しの上限（maxTurns）で止まったとき。会話は残っているので、もう一度送れば続きから進む */
export const MAX_TURNS_REPLY = "途中までで止めました（手順が多すぎました）。続ける場合はもう一度送ってください。";
export const EMPTY_REPLY = "（返答が空でした）";
/** そのターンで compaction が起きたとき、返信の末尾に足す 1 行 */
export const COMPACTED_NOTE = "（会話が長くなったため、古い部分を要約しました）";
/** 発言で待ち・完了から進行中に戻したターンの、返信の先頭に足す 1 行（成功したときだけ） */
export const REVIVED_NOTE = "（進行中に戻しました）";

export type HandlerDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "ownerUserId" | "timeZone">;
  /** 受け付け対象のチャンネルか（DB の設定、無ければ env の #inbox。/new で作ったセッション） */
  resolveChannel: ResolveChannel;
  gateway: Gateway;
  runner: AgentRunner;
  sessions: SdkSessionStore;
  /** 次のターンの prompt の先頭に付ける文（resume 失敗の復旧など） */
  seeds: ChannelSeedStore;
  /** セッションの題名と最終発言の時刻、resume 失敗時の要約。待ち・完了のセッションは発言で進行中に戻す */
  topicSessions: Pick<TopicSessionStore, "touch" | "get" | "setActive" | "setWaiting">;
  /** #inbox の resume 失敗時の seed（直近の #inbox の要約） */
  inboxSummaries: Pick<InboxSummaryStore, "latest">;
  /** 進行中に戻したセッションを進行中カテゴリへ移す */
  channelOps: Pick<ChannelOpsQueue, "enqueueMove">;
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
  const { cfg, resolveChannel, gateway, runner, sessions, seeds, topicSessions, inboxSummaries, channelOps, usage, queue, log } =
    deps;
  const turnDeps: TurnDeps = { runner, sessions, seeds, topicSessions, inboxSummaries, usage, log };

  /** セッションが待ち・完了なら進行中に戻して進行中カテゴリへ移す（知らせは返信の先頭に付ける）。戻したら true */
  const revive = (session: Pick<TopicSession, "channelId" | "guildId" | "state">): boolean => {
    if (applySessionEvent(session, "message", { topicSessions, channelOps }).move === null) return false;
    log(`発言があったためセッションを進行中に戻しました（guild=${session.guildId}）`);
    return true;
  };

  /** 返信の失敗は log に出して終える（再試行しない） */
  const reply = async (event: IncomingMessage, text: string): Promise<void> => {
    try {
      await gateway.send(event.channelId, text, event.id);
    } catch (error) {
      log(`返信に失敗しました: ${describeError(error)}`);
    }
  };

  /**
   * channelName は prompt の日時ヘッダに入れるチャンネル名。isSession はセッションのチャンネルか、revivedBeforeQueue はキュー待ちの前に進行中に戻したか。
   * セッションはキュー待ちの間に変わりうる（/close の確定で完了になる等）ので、ここで読み直して待ち・完了なら改めて進行中に戻す
   */
  const handleTurn = async (
    event: IncomingMessage,
    guildId: string,
    channelName: string,
    isSession: boolean,
    revivedBeforeQueue: boolean,
  ): Promise<void> => {
    const current = isSession ? topicSessions.get(event.channelId) : undefined;
    const revived = (current !== undefined && revive(current)) || revivedBeforeQueue;
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
      let text = result.text.trim() === "" ? EMPTY_REPLY : result.text;
      if (revived) text = `${REVIVED_NOTE}\n${text}`;
      await reply(event, result.compacted === undefined ? text : `${text}\n${COMPACTED_NOTE}`);
      return;
    }

    log(`ターンが失敗しました: ${result.errorMessage}`);
    // sdk-runner は result の失敗を subtype から書き始める
    await reply(event, result.errorMessage.startsWith(MAX_TURNS_ERROR_PREFIX) ? MAX_TURNS_REPLY : FAILURE_REPLY);
  };

  return async (event) => {
    try {
      // 受付判定は DB を引くので try の中で行う
      const kind = acceptedChannel(event, cfg, resolveChannel);
      // 受け付けた発言は必ずサーバー内（guildId は null でない）
      if (kind === null || event.guildId === null) return;
      const guildId = event.guildId;
      let channelName = "inbox";
      let revived = false;
      if (kind === "session") {
        // 最終発言の時刻はキュー待ちの前に記録する。日時ヘッダには題名を出す
        const session = topicSessions.touch(event.channelId);
        if (session === undefined) return;
        channelName = session.title;
        // 待ち・完了なら進行中に戻して進行中カテゴリへ移す（ターンは通常どおり行い、返信の先頭で知らせる）
        revived = revive(session);
      }
      await queue.run(event.channelId, () => handleTurn(event, guildId, channelName, kind === "session", revived));
    } catch (error) {
      log(`ターンの処理中にエラーが発生しました: ${describeError(error)}`);
    }
  };
}
