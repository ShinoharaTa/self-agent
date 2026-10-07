// 1 チャンネルの 1 ターン（発言・/close 共通）。usage の記録、SDK セッションの保存、seed の付与、resume 失敗からの復旧
import type { AgentRunner, RunResult } from "../agent/runner.ts";
import type { ChannelSeedStore } from "../store/channel-seeds.ts";
import type { InboxSummary, InboxSummaryStore } from "../store/inbox-summaries.ts";
import type { SdkSessionStore } from "../store/sdk-sessions.ts";
import type { TopicSession, TopicSessionStore } from "../store/topic-sessions.ts";
import type { UsageStore } from "../store/usage.ts";
import { rotatedSeed } from "./summary.ts";

/**
 * resume 先の会話の記録が SDK 側に無いときのエラー文。CLI に "No conversation found with session ID: ..." があるのでそれに合わせている。
 * 実機でどの形（result の errors か例外か）で届くかは未確認（#4 で確認待ち）
 */
export const RESUME_FAILURE_PATTERN = /No conversation found/i;

/**
 * 同じ SDK セッションでの resume が、結果（result）が届かずにこの回数続けて失敗したら、RESUME_FAILURE_PATTERN に一致しなくても捨ててやり直す
 * （文言が想定と違う・例外で届くなどで、そのチャンネルが失敗し続けるのを防ぐ）。タイムアウトと、結果が届いた失敗は数えない
 */
export const RESUME_FAILURE_LIMIT = 3;

/** 手順数の上限で止まった失敗。result.subtype がこの文字列で始まる */
export const MAX_TURNS_ERROR_PREFIX = "error_max_turns";

/** 数えない失敗（重い処理で時間がかかっただけで、セッションは壊れていない） */
const TIMEOUT_ERROR = "timeout";

export const RESUME_SEED_HEADER = "前の会話の記録が切れたため、要約から再開します。";

export type TurnDeps = {
  runner: AgentRunner;
  /** channelId → SDK の session_id */
  sessions: SdkSessionStore;
  seeds: ChannelSeedStore;
  /** 復旧の seed に要約（無ければ題名）を入れるため */
  topicSessions: Pick<TopicSessionStore, "get">;
  /** #inbox（セッションでないチャンネル）の復旧の seed に、そのサーバーの直近の #inbox の要約を入れるため */
  inboxSummaries: Pick<InboxSummaryStore, "latest">;
  usage: UsageStore;
  log: (message: string) => void;
};

export type ChannelTurn = {
  guildId: string;
  channelId: string;
  prompt: string;
  /** このターンで WebFetch に取得を許す URL。オーナーの発言のターンだけその発言の URL、それ以外（/close など）は空 */
  allowedUrls: readonly string[];
};

/**
 * resume 失敗のあとに入れる seed。セッションはその要約（無ければ題名）、セッションでないチャンネル（#inbox）は
 * そのサーバーの直近の #inbox の要約（切り替えたときと同じ形）。#inbox の要約がまだ無ければ入れない
 */
export function resumeSeed(session: TopicSession | undefined, inboxSummary: InboxSummary | undefined): string | undefined {
  if (session === undefined) return inboxSummary === undefined ? undefined : rotatedSeed(inboxSummary.summary);
  return session.summary === null
    ? `${RESUME_SEED_HEADER}\n題名: ${session.title}`
    : `${RESUME_SEED_HEADER}\n${session.summary}`;
}

/** ターンの結果を usage_log に記録する（成功ならトークン・compaction・最後のステップの入力も）。compaction が起きたら log に出す */
export function recordTurnUsage(deps: Pick<TurnDeps, "usage" | "log">, key: string, result: RunResult): void {
  const { usage, log } = deps;
  if (!result.ok) {
    usage.record({ key, sessionId: result.sessionId, ok: false, toolCalls: result.toolCalls });
    return;
  }
  usage.record({
    key,
    sessionId: result.sessionId,
    ok: true,
    durationMs: result.durationMs,
    inputTokens: result.usage.inputTokens,
    cacheReadInputTokens: result.usage.cacheReadInputTokens,
    cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
    compacted: result.compacted !== undefined,
    toolCalls: result.toolCalls,
    contextTokens: result.contextTokens,
  });
  if (result.compacted !== undefined) {
    const { trigger, preTokens } = result.compacted;
    log(`会話が長くなったため SDK が古い部分を要約しました（trigger=${trigger}、要約前 ${preTokens ?? "?"} トークン）`);
  }
}

/**
 * チャンネルで 1 ターン実行する（会話の key は channelId）。呼び出し側で同じチャンネルのターンを直列にしておくこと。
 * - SDK セッションがあれば resume する。無く seed があれば prompt の先頭に付け、成功したら消す
 * - 失敗しても SDK が会話を記録していれば（result まで届いた失敗）、その session_id を残して次のターンで続ける
 * - resume が「会話の記録が無い」で失敗したとき、または同じセッションで結果の届かない失敗（タイムアウトを除く）が RESUME_FAILURE_LIMIT 回続いたときは、
 *   SDK セッションを捨て、seed（要約）を入れて、sessionId 無しで 1 回だけやり直す
 * 返す結果の失敗は呼び出し側で返信・log する
 */
export async function runChannelTurn(deps: TurnDeps, turn: ChannelTurn): Promise<RunResult> {
  const { runner, sessions, seeds, topicSessions, inboxSummaries, log } = deps;
  const key = turn.channelId;
  const context = { guildId: turn.guildId, channelId: turn.channelId };

  const runOnce = async (prompt: string, sessionId: string | undefined): Promise<RunResult> => {
    // seed を付けてやり直すときも、取得を許すのはオーナーの発言の URL だけ
    const result = await runner.run({ prompt, sessionId, context, allowedUrls: turn.allowedUrls });
    recordTurnUsage(deps, key, result);
    if (result.ok) {
      sessions.set(key, result.sessionId);
    } else {
      // 途中まで（task_add 済みなど）の文脈を次のターンに残す。同じセッションなら失敗の回数はそのまま
      if (result.sessionRecorded && result.sessionId !== undefined && result.sessionId !== sessions.get(key)) {
        sessions.set(key, result.sessionId);
      }
    }
    return result;
  };

  const sessionId = sessions.get(key);
  if (sessionId !== undefined) {
    const result = await runOnce(turn.prompt, sessionId);
    if (result.ok) return result;
    // 数えるのは結果が届かなかった失敗だけ。結果が届いた失敗（API エラー・手順数の上限など）は SDK が会話を読めた証拠で、
    // タイムアウトは時間がかかっただけで会話自体は生きている
    const countable = !result.sessionRecorded && result.errorMessage !== TIMEOUT_ERROR;
    const failures = countable ? sessions.recordFailure(key) : 0;
    // 実機の文言の確認のため、どちらも元のエラー文を出す
    if (RESUME_FAILURE_PATTERN.test(result.errorMessage)) {
      log(`resume に失敗したため、SDK セッションを捨てて新しいセッションで 1 回だけやり直します: ${result.errorMessage}`);
    } else if (failures >= RESUME_FAILURE_LIMIT) {
      log(
        `連続失敗のため（${failures} 回）、SDK セッションを捨てて新しいセッションで 1 回だけやり直します: ${result.errorMessage}`,
      );
    } else {
      return result;
    }
    sessions.delete(key);
    const session = topicSessions.get(turn.channelId);
    const seed = resumeSeed(session, session === undefined ? inboxSummaries.latest(turn.guildId) : undefined);
    if (seed !== undefined) seeds.set(key, seed);
  }

  const seed = seeds.get(key);
  const result = await runOnce(seed === undefined ? turn.prompt : `${seed}\n\n${turn.prompt}`, undefined);
  if (result.ok && seed !== undefined) seeds.delete(key);
  return result;
}
