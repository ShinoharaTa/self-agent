// #inbox の session_open ツールの処理。歯止め（#inbox だけ・同じ題名・1 日の上限・前回からの間隔）を確かめてから、/new と同じ作成処理でセッションを作る
import type { OpenSession, SessionOpenResult } from "../agent/tools.ts";
import type { Config } from "../config.ts";
import type { ChannelSeedStore } from "../store/channel-seeds.ts";
import type { ResolveChannel } from "./access.ts";
import { createTopicSession, toChannelName, type NewSessionDeps } from "./commands/new.ts";
import { layoutQueueKey } from "./commands/setup.ts";
import { startOfLocalDay } from "./commands/usage.ts";

/** 前回の自動作成（session_open）からこの時間が経つまでは作らない */
export const AUTO_SESSION_COOLDOWN_MS = 15 * 60 * 1000;

export const AUTO_SESSION_LIMIT_MESSAGE = "今日はこれ以上自動で作れません。/new で作ってください";
export const AUTO_SESSION_COOLDOWN_MESSAGE = "少し時間をおいてください。急ぐなら /new で作れます";

/** 新しいチャンネルの最初のターンの prompt の先頭に付ける文（seed） */
export function inboxSeed(context: string): string {
  return `#inbox からの続き:\n${context}`;
}

/** session_open で作ったチャンネルの最初の投稿 */
export function inboxWelcomeText(title: string): string {
  return `セッション「${title}」を始めました。#inbox の話の続きです。`;
}

export type SessionOpenDeps = {
  /** timeZone は 1 日の区切り、autoSessionPerDay は 1 日に作れる数 */
  cfg: Pick<Config, "timeZone" | "autoSessionPerDay">;
  /** 呼ばれたチャンネルが #inbox か（発言の受付と同じ判定） */
  resolveChannel: ResolveChannel;
  gateway: NewSessionDeps["gateway"];
  guildSettings: NewSessionDeps["guildSettings"];
  topicSessions: NewSessionDeps["topicSessions"];
  seeds: Pick<ChannelSeedStore, "set">;
  /** /setup・/new と同じキュー（key は layoutQueueKey） */
  queue: NewSessionDeps["queue"];
  now: () => Date;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * session_open の処理を作る。#inbox 以外 → not_available。同じサーバーに同じ正規化題名（toChannelName）の進行中・待ちのセッションがあれば、
 * 作らずに existing。今日（timeZone の日付）session_open で作った数が上限に達していれば limit、前回の session_open から 15 分未満なら cooldown。
 * 通れば /new と同じ作成処理で作り、seed（#inbox での文脈）を入れ、最初の投稿をして created。/setup 前なら not_set_up。
 * 上限と間隔は全サーバーの session_open で作ったもの（sessions.origin = inbox）を数え、/new で作ったものは数えない
 */
export function createOpenSession(deps: SessionOpenDeps): OpenSession {
  const { cfg, resolveChannel, gateway, topicSessions, seeds, queue, now, log } = deps;

  const checkAndCreate = async (guildId: string, title: string, context: string): Promise<SessionOpenResult> => {
    const name = toChannelName(title);
    const existing = topicSessions.listOpen(guildId).find((session) => toChannelName(session.title) === name);
    if (existing !== undefined) return { result: "existing", channelId: existing.channelId };
    const at = now();
    if (topicSessions.countCreatedSince("inbox", startOfLocalDay(at, cfg.timeZone)) >= cfg.autoSessionPerDay) {
      return { result: "limit", message: AUTO_SESSION_LIMIT_MESSAGE };
    }
    const last = topicSessions.lastCreatedAt("inbox");
    if (last !== undefined && at.getTime() - last.getTime() < AUTO_SESSION_COOLDOWN_MS) {
      return { result: "cooldown", message: AUTO_SESSION_COOLDOWN_MESSAGE };
    }
    const created = await createTopicSession(guildId, title, deps, "inbox");
    // 新しいチャンネルの発言を受け付ける前に入れておく（SDK セッションが無い最初のターンの prompt の先頭に付く）
    if (created.result === "created") seeds.set(created.channelId, inboxSeed(context));
    return created;
  };

  return async (args, context) => {
    if (context === undefined || resolveChannel(context.guildId, context.channelId) !== "inbox") {
      return { result: "not_available" };
    }
    const { guildId } = context;
    // 確認と作成は /setup・/new と同じ key で 1 つずつ実行する（同じターンで並べて呼ばれても、確認の後に作った分を数える）
    const result = await queue.run(layoutQueueKey(guildId), () => checkAndCreate(guildId, args.title, args.context));
    if (result.result !== "created") return result;
    log(`#inbox からセッションを作りました（guild=${guildId}）`);
    try {
      await gateway.send(result.channelId, inboxWelcomeText(args.title));
    } catch (error) {
      // チャンネルと DB の行はできているので、作れたことにする
      log(`セッションの最初の投稿に失敗しました: ${describeError(error)}`);
    }
    return result;
  };
}
