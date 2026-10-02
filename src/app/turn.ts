// 1 チャンネルの 1 ターン（発言・/close 共通）。usage の記録、SDK セッションの保存、seed の付与、resume 失敗からの復旧
import type { AgentRunner, RunResult } from "../agent/runner.ts";
import type { ChannelSeedStore } from "../store/channel-seeds.ts";
import type { SessionStore } from "../store/sessions.ts";
import type { TopicSession, TopicSessionStore } from "../store/topic-sessions.ts";
import type { UsageStore } from "../store/usage.ts";

/**
 * resume 先の会話の記録が SDK 側に無いときのエラー文。CLI に "No conversation found with session ID: ..." があるのでそれに合わせている。
 * 実機でどの形（result の errors か例外か）で届くかは未確認（#4 で確認待ち）
 */
export const RESUME_FAILURE_PATTERN = /No conversation found/i;

export const RESUME_SEED_HEADER = "前の会話の記録が切れたため、要約から再開します。";

export type TurnDeps = {
  runner: AgentRunner;
  /** channelId → SDK の session_id */
  sessions: SessionStore;
  seeds: ChannelSeedStore;
  /** 復旧の seed に要約（無ければ題名）を入れるため */
  topicSessions: Pick<TopicSessionStore, "get">;
  usage: UsageStore;
  log: (message: string) => void;
};

export type ChannelTurn = {
  guildId: string;
  channelId: string;
  prompt: string;
};

/** resume 失敗のあとに入れる seed。セッション以外（#inbox）は要約も題名も無いので入れない */
export function resumeSeed(session: TopicSession | undefined): string | undefined {
  if (session === undefined) return undefined;
  return session.summary === null
    ? `${RESUME_SEED_HEADER}\n題名: ${session.title}`
    : `${RESUME_SEED_HEADER}\n${session.summary}`;
}

/**
 * チャンネルで 1 ターン実行する（会話の key は channelId）。呼び出し側で同じチャンネルのターンを直列にしておくこと。
 * - SDK セッションがあれば resume する。無く seed があれば prompt の先頭に付け、成功したら消す
 * - resume が「会話の記録が無い」で失敗したら SDK セッションを捨て、seed（要約）を入れて、sessionId 無しで 1 回だけやり直す
 * 返す結果の失敗は呼び出し側で返信・log する
 */
export async function runChannelTurn(deps: TurnDeps, turn: ChannelTurn): Promise<RunResult> {
  const { runner, sessions, seeds, topicSessions, usage, log } = deps;
  const key = turn.channelId;
  const context = { guildId: turn.guildId, channelId: turn.channelId };

  const runOnce = async (prompt: string, sessionId: string | undefined): Promise<RunResult> => {
    const result = await runner.run({ prompt, sessionId, context });
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
    } else {
      usage.record({ key, sessionId: result.sessionId, ok: false });
    }
    return result;
  };

  const sessionId = sessions.get(key);
  if (sessionId !== undefined) {
    const result = await runOnce(turn.prompt, sessionId);
    if (result.ok || !RESUME_FAILURE_PATTERN.test(result.errorMessage)) return result;
    // 実機の文言の確認のため、元のエラー文も出す
    log(`resume に失敗したため、SDK セッションを捨てて新しいセッションで 1 回だけやり直します: ${result.errorMessage}`);
    sessions.delete(key);
    const seed = resumeSeed(topicSessions.get(turn.channelId));
    if (seed !== undefined) seeds.set(key, seed);
  }

  const seed = seeds.get(key);
  const result = await runOnce(seed === undefined ? turn.prompt : `${seed}\n\n${turn.prompt}`, undefined);
  if (result.ok && seed !== undefined) seeds.delete(key);
  return result;
}
