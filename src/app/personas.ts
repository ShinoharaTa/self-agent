// 人格（docs/plan/personas.md §2.2）の Bot と runner への振り分け。チャンネルの持ち主の人格は 1 つで、入口のチャンネルは persona_channels、
// セッションのチャンネルは sessions.persona で引き、どちらにも無ければ既定の人格。
// 返事・途中経過・入力中表示・リマインドの投稿・記憶の知らせ・kb_delete の確認は持ち主の Bot（gatewayFor）、
// カテゴリ・チャンネルの作成・移動・削除、ピン留め、#system、再同期、コマンドの登録は既定の人格の Bot（admin）が行う
import type { AgentRunner } from "../agent/runner.ts";
import { DEFAULT_PERSONA_ID, type Engine } from "../config.ts";
import type { Gateway, InteractionResponder, OutgoingMessage } from "../discord/gateway.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";

/** ターンを動かす人格。engine は実際に動かすエンジン（usage に記録する。codex の人格も codex のエンジンができるまでは claude） */
export type TurnPersona = { id: string; engine: Engine; runner: AgentRunner };

/** 1 つの人格の Bot と runner */
export type PersonaRuntime = TurnPersona & {
  /** 表示名（#system の知らせに使う） */
  name: string;
  gateway: Gateway;
  /** その Bot が Discord に接続しているか（リマインドの投稿先を選ぶのに使う） */
  connected: () => boolean;
};

/** 持ち主の Bot で行う投稿（返事・途中経過・入力中表示・リマインド・記憶の知らせ・kb_delete の確認） */
export type OwnerPosts = Pick<Gateway, "send" | "sendMessage" | "editMessage" | "startTyping">;

export type PersonaRouterDeps = {
  /** 動かす人格（設定の順）。最初は既定の人格 */
  personas: readonly PersonaRuntime[];
  /** 入口のチャンネル（#inbox・#tasks・#<NAME>）の持ち主 */
  guildSettings: Pick<GuildSettingsStore, "personaOfChannel">;
  /** セッションのチャンネルの持ち主 */
  topicSessions: Pick<TopicSessionStore, "personaOf">;
};

export class PersonaRouter {
  private readonly deps: PersonaRouterDeps;
  private readonly byId: ReadonlyMap<string, PersonaRuntime>;
  private readonly defaultPersona: PersonaRuntime;

  constructor(deps: PersonaRouterDeps) {
    const first = deps.personas[0];
    if (first === undefined || first.id !== DEFAULT_PERSONA_ID) throw new Error("最初の人格は既定の人格にしてください");
    this.deps = deps;
    this.defaultPersona = first;
    this.byId = new Map(deps.personas.map((persona) => [persona.id, persona]));
  }

  /** 既定の人格の Bot（管理の操作・#system・コマンドの登録） */
  get admin(): Gateway {
    return this.defaultPersona.gateway;
  }

  /** 動かす人格（設定の順。最初は既定の人格） */
  get all(): readonly PersonaRuntime[] {
    return this.deps.personas;
  }

  /**
   * チャンネルの持ち主の人格の id。persona_channels（入口）→ sessions.persona（セッション）の順に引き、どちらにも無ければ既定の人格。
   * 設定から外した人格のチャンネルも既定の人格のものとして扱う
   */
  ownerOf(channelId: string): string {
    const id = this.deps.guildSettings.personaOfChannel(channelId) ?? this.deps.topicSessions.personaOf(channelId);
    return id !== undefined && this.byId.has(id) ? id : DEFAULT_PERSONA_ID;
  }

  /** チャンネルの持ち主の人格 */
  runtimeFor(channelId: string): PersonaRuntime {
    return this.byId.get(this.ownerOf(channelId)) ?? this.defaultPersona;
  }

  /** チャンネルの持ち主の Bot */
  gatewayFor(channelId: string): Gateway {
    return this.runtimeFor(channelId).gateway;
  }

  /** チャンネルの持ち主の Bot が Discord に接続しているか */
  ownerConnected(channelId: string): boolean {
    return this.runtimeFor(channelId).connected();
  }

  /** チャンネルの持ち主の人格の runner（ターンはこれで動かす） */
  turnPersona(channelId: string): TurnPersona {
    const { id, engine, runner } = this.runtimeFor(channelId);
    return { id, engine, runner };
  }

  /** 投稿のたびにチャンネルの持ち主の Bot を選ぶ Gateway（handler・リマインド・記憶の知らせ・kb_delete の確認に渡す） */
  ownerPosts(): OwnerPosts {
    return {
      send: (channelId, text, replyToId, mentionUserId) =>
        this.gatewayFor(channelId).send(channelId, text, replyToId, mentionUserId),
      sendMessage: (channelId, message) => this.gatewayFor(channelId).sendMessage(channelId, message),
      editMessage: (channelId, messageId, message) => this.gatewayFor(channelId).editMessage(channelId, messageId, message),
      startTyping: (channelId) => this.gatewayFor(channelId).startTyping(channelId),
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 持ち主の Bot がチャンネルに結果を投稿したときの、コマンドへの応答（本人にだけ） */
export const POSTED_BY_OWNER_REPLY = "結果をこのチャンネルに投稿しました";

/** ターンを動かすコマンド（/close・/renew）の結果の出し方 */
export type CommandResponse = {
  /** ターンの前に保留する（LLM のターンは 3 秒を超える） */
  defer(): Promise<void>;
  /** ターンの結果を出す */
  show(message: OutgoingMessage): Promise<void>;
};

/**
 * ターンを動かすコマンドの結果の出し方。コマンドは既定の人格のアプリだけが受けるので、持ち主が既定の人格（か channelId が無い・振り分けが無い）なら
 * 今までどおり公開で保留して応答に出す。それ以外の人格のチャンネルでは、本人にだけ見える形で保留し、結果は持ち主の Bot がチャンネルに投稿して、
 * 応答には投稿した旨だけを出す（interaction への応答は受けたアプリから返す）。
 * 持ち主の Bot の投稿に失敗したら、結果（ボタンを含む）をそのまま本人にだけの応答に出す（ボタンは既定のアプリで受けられる）。
 * 投稿できた後の応答の失敗（期限切れなど）は log だけにする（「処理に失敗しました」で上書きしない）
 */
export function commandResponse(
  personas: Pick<PersonaRouter, "ownerOf" | "gatewayFor"> | undefined,
  channelId: string | null,
  responder: InteractionResponder,
  log: (message: string) => void,
): CommandResponse {
  if (personas === undefined || channelId === null || personas.ownerOf(channelId) === DEFAULT_PERSONA_ID) {
    return { defer: () => responder.defer(false), show: (message) => responder.reply(message) };
  }
  return {
    defer: () => responder.defer(true),
    show: async (message) => {
      try {
        await personas.gatewayFor(channelId).sendMessage(channelId, message);
      } catch (error) {
        log(`持ち主の Bot で結果を投稿できなかったため、応答に出します: ${describeError(error)}`);
        await responder.reply(message);
        return;
      }
      try {
        await responder.reply({ text: POSTED_BY_OWNER_REPLY });
      } catch (error) {
        log(`結果を投稿した後の応答に失敗しました: ${describeError(error)}`);
      }
    },
  };
}
