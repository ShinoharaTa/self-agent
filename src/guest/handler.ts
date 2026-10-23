// ゲストのターン（docs/plan/guest-mode.md §3.4・§3.5・§6）。受付判定（access.ts）を通った発言だけを受け取り、上限を確かめてから
// ゲスト専用のキュー（key は channelId）で 1 ターン動かし、返事をそのチャンネルに返す。記憶・seed・ナレッジ・context は付けない。
// 会話は 1 チャンネル = 1 SDK セッション（key `guest:<channelId>`）で、ターン数・会話の大きさ・経過時間で要約せずに捨てる。
// log はサーバー ID まで（チャンネル ID・ユーザー ID・本文・表示名は出さない）
import type { AgentRunner, RunResult } from "../agent/runner.ts";
import { buildTurnPrompt } from "../app/prompt.ts";
import { KeyedSerialQueue } from "../app/queue.ts";
import { formatDate } from "../app/time.ts";
import { ABORTED_ERROR, RESUME_FAILURE_PATTERN, recordTurnUsage, TIMEOUT_ERROR } from "../app/turn.ts";
import type { Config } from "../config.ts";
import type { Gateway, IncomingMessage } from "../discord/gateway.ts";
import type { GuestStore } from "../store/guest.ts";
import type { SdkSessionStore } from "../store/sdk-sessions.ts";
import type { UsageStore } from "../store/usage.ts";
import {
  GUEST_MAX_CONTENT_CHARS,
  GUEST_MAX_QUEUE,
  GUEST_MIN_INTERVAL_SEC,
  GUEST_PERSONA_ID,
  GUEST_RESUME_FAILURE_LIMIT,
  GUEST_SESSION_MAX_AGE_HOURS,
  guestSessionKey,
} from "./constants.ts";

export const GUEST_TOO_LONG_REPLY = "2,000 字までです。短くして送ってください。";
export const GUEST_GUILD_LIMIT_REPLY = "今日の回数の上限に達しました。明日またどうぞ。";
export const GUEST_USER_LIMIT_REPLY = "あなたの今日の回数の上限に達しました。";
export const GUEST_BUSY_REPLY = "混み合っています。少し待ってもう一度送ってください。";
export const GUEST_FAILURE_REPLY = "今は答えられません。時間をおいてもう一度送ってください。";
export const GUEST_EMPTY_REPLY = "（返答が空でした）";

/** usage_log の kind と、トークンの log のラベル */
export const GUEST_USAGE_KIND = "guest";

/** ヘッダのチャンネル名（固定の論理名。実際のチャンネル名は渡さない） */
const GUEST_CHANNEL_LABEL = "guest";

/** 表示名が無い・空のときにヘッダに入れる名前 */
const UNKNOWN_DISPLAY_NAME = "（不明）";

export type GuestHandlerDeps = {
  cfg: Pick<
    Config,
    | "timeZone"
    | "guestTurnsPerDay"
    | "guestUserTurnsPerDay"
    | "guestMaxConcurrent"
    | "guestSessionMaxTurns"
    | "guestSessionMaxInputTokens"
  >;
  guest: Pick<GuestStore, "get" | "countTurns" | "countUserTurns" | "recordTurn" | "bumpSession" | "resetSession">;
  /** key `guest:<channelId>` の SDK セッション */
  sessions: Pick<SdkSessionStore, "get" | "set" | "delete">;
  /** usage_log（kind guest・persona guest）と、直近の成功したターンの会話の大きさ */
  usage: UsageStore;
  /** ゲストの runner（guest/query-options.ts の createGuestRunner） */
  runner: AgentRunner;
  /** ゲスト Bot（返事と入力中表示） */
  gateway: Pick<Gateway, "send" | "startTyping">;
  now: () => Date;
  log: (message: string) => void;
};

export type GuestHandler = {
  /**
   * 受付判定を通った発言を処理する。botUserId はゲスト Bot のユーザー ID（本文からメンションを除くのに使う）。
   * 返す Promise は、断る文面の返信か、ターンの返事が終わる（無視したならすぐ）と resolve する。reject しない
   */
  handleMessage: (message: IncomingMessage, botUserId: string | undefined) => Promise<void>;
  /** 実行中・待っているターンが無くなったら resolve する */
  idle: () => Promise<void>;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 本文からゲスト Bot へのメンション（`<@id>`・`<@!id>`）を除いて trim する */
export function stripBotMention(content: string, botUserId: string | undefined): string {
  if (botUserId === undefined) return content.trim();
  return content.split(`<@${botUserId}>`).join("").split(`<@!${botUserId}>`).join("").trim();
}

/** ヘッダに入れる表示名。改行・制御文字は空白に、角括弧は全角にする（ヘッダの形を崩させない）。空なら「（不明）」 */
export function headerDisplayName(name: string | undefined): string {
  const cleaned = (name ?? "")
    .replace(/[\u0000-\u001f\u007f\s]+/g, " ")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］")
    .trim();
  return cleaned === "" ? UNKNOWN_DISPLAY_NAME : cleaned;
}

/** ゲストのターンの prompt。`[<日時> #guest 発言者: <表示名>]\n<本文>` */
export function buildGuestPrompt(content: string, displayName: string | undefined, at: Date, timeZone: string): string {
  return buildTurnPrompt(content, at, timeZone, `${GUEST_CHANNEL_LABEL} 発言者: ${headerDisplayName(displayName)}`);
}

export function createGuestHandler(deps: GuestHandlerDeps): GuestHandler {
  const { cfg, guest, sessions, usage, runner, gateway, now, log } = deps;
  const queue = new KeyedSerialQueue(cfg.guestMaxConcurrent);
  /** キューで枠・同じチャンネルの前のターンを待っているターンの数 */
  let waiting = 0;
  /** サーバー・ユーザーごとの、前に反応した（ターンを受け付けたか、断る文面を返した）時刻（ミリ秒）。プロセス内だけ */
  const lastSeen = new Map<string, number>();
  /** チャンネルごとの、resume の結果の届かない失敗（タイムアウト・中断を除く）が続いた回数。成功・捨てたら消す。プロセス内だけ */
  const resumeFailures = new Map<string, number>();
  const intervalMs = GUEST_MIN_INTERVAL_SEC * 1000;

  /** 連投か。古い記録はついでに消す */
  const tooSoon = (key: string, at: number): boolean => {
    for (const [seenKey, seenAt] of lastSeen) {
      if (at - seenAt >= intervalMs) lastSeen.delete(seenKey);
    }
    const previous = lastSeen.get(key);
    return previous !== undefined && at - previous < intervalMs;
  };

  const reply = async (message: IncomingMessage, text: string): Promise<void> => {
    try {
      await gateway.send(message.channelId, text, message.id);
    } catch (error) {
      log(`guest: 返信に失敗しました（guild=${message.guildId}）: ${describeError(error)}`);
    }
  };

  /**
   * ターンの前に、捨てる条件（ターン数・会話の大きさ・経過時間・resume の連続失敗）のどれかに当たる SDK セッションを捨てる。今の session_id を返す
   */
  const currentSession = (channelId: string, at: Date): string | undefined => {
    const key = guestSessionKey(channelId);
    const channel = guest.get(channelId);
    const sessionId = sessions.get(key);
    if (sessionId === undefined) {
      // SDK セッションが無いのに数が残っていれば戻す（次の成功したターンから数え直す）
      if (channel !== undefined && (channel.sessionTurns !== 0 || channel.sessionStartedAt !== null)) guest.resetSession(channelId);
      return undefined;
    }
    const startedAt = channel?.sessionStartedAt ?? null;
    const expired =
      (channel !== undefined && channel.sessionTurns >= cfg.guestSessionMaxTurns) ||
      (usage.latestOkAfter(key, undefined)?.contextTokens ?? 0) > cfg.guestSessionMaxInputTokens ||
      (startedAt !== null && at.getTime() - new Date(startedAt).getTime() >= GUEST_SESSION_MAX_AGE_HOURS * 3_600_000) ||
      (resumeFailures.get(channelId) ?? 0) >= GUEST_RESUME_FAILURE_LIMIT;
    if (!expired) return sessionId;
    sessions.delete(key);
    guest.resetSession(channelId);
    resumeFailures.delete(channelId);
    return undefined;
  };

  /** 1 回 run して usage を記録し、成功なら SDK セッションを保存する */
  const runOnce = async (channelId: string, prompt: string, sessionId: string | undefined): Promise<RunResult> => {
    const key = guestSessionKey(channelId);
    const result = await runner.run({ prompt, ...(sessionId === undefined ? {} : { sessionId }) });
    recordTurnUsage({ usage, log: (line) => log(`guest: ${line}`) }, key, GUEST_USAGE_KIND, result, {
      id: GUEST_PERSONA_ID,
      engine: "claude",
    });
    if (result.ok) sessions.set(key, result.sessionId);
    return result;
  };

  /** resume の失敗を数える。数えるのは結果の届かなかった失敗だけ（タイムアウト・中断は数えない）。成功なら 0 に戻す */
  const countResumeFailure = (channelId: string, result: RunResult): void => {
    if (result.ok) {
      resumeFailures.delete(channelId);
      return;
    }
    if (result.sessionRecorded || result.errorMessage === TIMEOUT_ERROR || result.errorMessage === ABORTED_ERROR) return;
    resumeFailures.set(channelId, (resumeFailures.get(channelId) ?? 0) + 1);
  };

  /** 1 ターン（キューの中）。返事を返すまで。today は上限の判定に使った日（SELF_AGENT_TZ の YYYY-MM-DD）で、guest_turns にもこの日で数える */
  const runTurn = async (message: IncomingMessage, guildId: string, content: string, today: string): Promise<void> => {
    const { channelId } = message;
    // 待っている間に無効にされたチャンネルでは動かさない
    const channel = guest.get(channelId);
    if (channel === undefined || channel.disabledAt !== null) return;
    const stopTyping = gateway.startTyping(channelId);
    try {
      const startedAt = now();
      const prompt = buildGuestPrompt(content, message.authorDisplayName, startedAt, cfg.timeZone);
      const sessionId = currentSession(channelId, startedAt);
      let result = await runOnce(channelId, prompt, sessionId);
      if (!result.ok && sessionId !== undefined && RESUME_FAILURE_PATTERN.test(result.errorMessage)) {
        log(`guest: resume に失敗したため、SDK セッションを捨てて新しいセッションで 1 回だけやり直します（guild=${guildId}）`);
        sessions.delete(guestSessionKey(channelId));
        guest.resetSession(channelId);
        resumeFailures.delete(channelId);
        result = await runOnce(channelId, prompt, undefined);
      } else if (sessionId !== undefined) {
        countResumeFailure(channelId, result);
        if ((resumeFailures.get(channelId) ?? 0) >= GUEST_RESUME_FAILURE_LIMIT) {
          log(`guest: resume の失敗が ${GUEST_RESUME_FAILURE_LIMIT} 回続いたため、次のターンは新しいセッションで始めます（guild=${guildId}）`);
        }
      }
      if (!result.ok) {
        log(`guest: ターンが失敗しました（guild=${guildId}）: ${result.errorMessage}`);
        await reply(message, GUEST_FAILURE_REPLY);
        return;
      }
      // 数えるのは成功したターンだけ
      guest.bumpSession(channelId);
      guest.recordTurn(guildId, message.authorId, today);
      await reply(message, result.text.trim() === "" ? GUEST_EMPTY_REPLY : result.text);
    } finally {
      stopTyping();
    }
  };

  const handle = async (message: IncomingMessage, botUserId: string | undefined): Promise<void> => {
    const guildId = message.guildId;
    if (guildId === null) return;
    const at = message.createdAt.getTime();
    const seenKey = `${guildId}:${message.authorId}`;
    // 連投は返事も log も無し
    if (tooSoon(seenKey, at)) return;
    const content = stripBotMention(message.content, botUserId);
    if (content.length > GUEST_MAX_CONTENT_CHARS) {
      lastSeen.set(seenKey, at);
      await reply(message, GUEST_TOO_LONG_REPLY);
      return;
    }
    // 添付だけ（本文が空）は無視する
    if (content === "") return;
    lastSeen.set(seenKey, at);
    const today = formatDate(message.createdAt, cfg.timeZone);
    if (guest.countTurns(guildId, today) >= cfg.guestTurnsPerDay) {
      await reply(message, GUEST_GUILD_LIMIT_REPLY);
      return;
    }
    if (guest.countUserTurns(guildId, message.authorId, today) >= cfg.guestUserTurnsPerDay) {
      await reply(message, GUEST_USER_LIMIT_REPLY);
      return;
    }
    if (waiting >= GUEST_MAX_QUEUE) {
      await reply(message, GUEST_BUSY_REPLY);
      return;
    }
    waiting++;
    let started = false;
    const start = (): void => {
      if (started) return;
      started = true;
      waiting--;
    };
    try {
      await queue.run(message.channelId, async () => {
        start();
        await runTurn(message, guildId, content, today);
      });
    } catch (error) {
      log(`guest: ターンの処理に失敗しました（guild=${guildId}）: ${describeError(error)}`);
      await reply(message, GUEST_FAILURE_REPLY);
    } finally {
      start();
    }
  };

  return {
    handleMessage: async (message, botUserId) => {
      try {
        await handle(message, botUserId);
      } catch (error) {
        log(`guest: 発言の処理に失敗しました（guild=${message.guildId ?? "DM"}）: ${describeError(error)}`);
      }
    },
    idle: () => queue.idle(),
  };
}
