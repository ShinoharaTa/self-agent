// #inbox（足した人格の #<NAME> も）の session_open ツールの処理。歯止め（#inbox・#<NAME> だけ・同じ題名・1 日の上限・前回からの間隔）を確かめてから、
// /new と同じ作成処理でセッションを作る。作ったセッションの持ち主は呼ばれたチャンネルの持ち主の人格
import type { OpenSession, SessionOpenResult } from "../agent/tools.ts";
import { type Config, DEFAULT_PERSONA_ID } from "../config.ts";
import type { ChannelSeedStore } from "../store/channel-seeds.ts";
import type { ResolveChannel } from "./access.ts";
import { createTopicSession, sessionOwnerOf, toChannelName, type NewSessionDeps } from "./commands/new.ts";
import { layoutQueueKey, personaInboxName } from "./commands/setup.ts";
import type { PersonaRouter } from "./personas.ts";
import { startOfLocalDay } from "./time.ts";

/** 前回の自動作成（session_open）からこの時間が経つまでは作らない */
export const AUTO_SESSION_COOLDOWN_MS = 15 * 60 * 1000;

export const AUTO_SESSION_LIMIT_MESSAGE = "今日はこれ以上自動で作れません。/new で作ってください";
export const AUTO_SESSION_COOLDOWN_MESSAGE = "少し時間をおいてください。急ぐなら /new で作れます";

/** 新しいチャンネルの最初のターンの prompt の先頭に付ける文（seed） */
export function inboxSeed(context: string): string {
  return `#inbox からの続き:\n${context}`;
}

/** session_open で作ったチャンネルの最初の投稿。from は呼ばれたチャンネルの名前（足した人格は #<NAME>） */
export function inboxWelcomeText(title: string, from: string = "inbox"): string {
  return `セッション「${title}」を始めました。#${from} の話の続きです。`;
}

export type SessionOpenDeps = {
  /** timeZone は 1 日の区切り、autoSessionPerDay は 1 日に作れる数（全人格で合算）、personas は足した人格（チャンネル名の接頭辞） */
  cfg: Pick<Config, "timeZone" | "autoSessionPerDay"> & Partial<Pick<Config, "personas">>;
  /** 呼ばれたチャンネルが #inbox・#<NAME> か（発言の受付と同じ判定） */
  resolveChannel: ResolveChannel;
  gateway: NewSessionDeps["gateway"];
  /** 呼ばれたチャンネルの持ち主（作るセッションの持ち主）と、最初の投稿をする持ち主の Bot。無ければすべて既定の人格 */
  personas?: Pick<PersonaRouter, "ownerOf" | "gatewayFor">;
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
 * session_open の処理を作る。#inbox・#<NAME> 以外 → not_available。同じサーバーに同じ人格・同じ正規化題名（toChannelName）の進行中・待ちのセッションがあれば、
 * 作らずに existing。今日（timeZone の日付）session_open で作った数が上限に達していれば limit、前回の session_open から 15 分未満なら cooldown。
 * 通れば /new と同じ作成処理で、呼ばれたチャンネルの持ち主の人格のセッションとして作り、seed（#inbox での文脈）を入れ、最初の投稿をして created。
 * /setup 前なら not_set_up。上限と間隔は全サーバー・全人格の session_open で作ったもの（sessions.origin = inbox）を数え、/new で作ったものは数えない
 */
export function createOpenSession(deps: SessionOpenDeps): OpenSession {
  const { cfg, resolveChannel, gateway, personas, topicSessions, seeds, queue, now, log } = deps;

  const checkAndCreate = async (
    guildId: string,
    personaId: string,
    title: string,
    context: string,
  ): Promise<SessionOpenResult> => {
    const name = toChannelName(title);
    const existing = topicSessions
      .listOpen(guildId)
      .find(
        (session) =>
          (topicSessions.personaOf(session.channelId) ?? DEFAULT_PERSONA_ID) === personaId &&
          toChannelName(session.title) === name,
      );
    if (existing !== undefined) return { result: "existing", channelId: existing.channelId };
    const at = now();
    if (topicSessions.countCreatedSince("inbox", startOfLocalDay(at, cfg.timeZone)) >= cfg.autoSessionPerDay) {
      return { result: "limit", message: AUTO_SESSION_LIMIT_MESSAGE };
    }
    const last = topicSessions.lastCreatedAt("inbox");
    if (last !== undefined && at.getTime() - last.getTime() < AUTO_SESSION_COOLDOWN_MS) {
      return { result: "cooldown", message: AUTO_SESSION_COOLDOWN_MESSAGE };
    }
    const created = await createTopicSession(guildId, title, deps, "inbox", sessionOwnerOf(cfg.personas, personaId));
    // 新しいチャンネルの発言を受け付ける前に入れておく（SDK セッションが無い最初のターンの prompt の先頭に付く）
    if (created.result === "created") seeds.set(created.channelId, inboxSeed(context));
    return created;
  };

  return async (args, context) => {
    if (context === undefined || resolveChannel(context.guildId, context.channelId) !== "inbox") {
      return { result: "not_available" };
    }
    const { guildId } = context;
    // 作るセッションの持ち主は、呼ばれたチャンネル（#inbox・#<NAME>）の持ち主の人格
    const personaId = personas?.ownerOf(context.channelId) ?? DEFAULT_PERSONA_ID;
    const owner = sessionOwnerOf(cfg.personas, personaId);
    // 確認と作成は /setup・/new と同じ key で 1 つずつ実行する（同じターンで並べて呼ばれても、確認の後に作った分を数える）
    const result = await queue.run(layoutQueueKey(guildId), () =>
      checkAndCreate(guildId, owner?.id ?? DEFAULT_PERSONA_ID, args.title, args.context),
    );
    if (result.result !== "created") return result;
    log(`#inbox からセッションを作りました（guild=${guildId}${owner === undefined ? "" : `、人格 ${owner.id}`}）`);
    try {
      // 最初の投稿は作ったセッションの持ち主の Bot が行う
      await (personas?.gatewayFor(result.channelId) ?? gateway).send(
        result.channelId,
        inboxWelcomeText(args.title, owner === undefined ? "inbox" : personaInboxName(owner)),
      );
    } catch (error) {
      // チャンネルと DB の行はできているので、作れたことにする
      log(`セッションの最初の投稿に失敗しました: ${describeError(error)}`);
    }
    return result;
  };
}
