import { type Config, DEFAULT_PERSONA_ID, type PersonaConfig } from "../../config.ts";
import type { CommandDef, Gateway, InteractionResponder } from "../../discord/gateway.ts";
import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import type { TopicSessionStore } from "../../store/topic-sessions.ts";
import type { CommandHandler } from "../interactions.ts";
import type { PersonaRouter } from "../personas.ts";
import type { KeyedSerialQueue } from "../queue.ts";
import {
  createTopicSession,
  type NewSessionResult,
  openTopicSession,
  type SessionOwner,
  sessionChannelName,
  sessionTopic,
  toChannelName,
  welcomeText,
} from "../session-ops.ts";

// セッションを作る処理は session-ops.ts に置き（Web と共有する）、ここから re-export する（循環 import を避ける）
export { createTopicSession, type NewSessionResult, type SessionOwner, sessionChannelName, sessionTopic, toChannelName, welcomeText };

export const NOT_SET_UP_REPLY = "先に /setup を実行してください";
export const EMPTY_TITLE_REPLY = "題名を入力してください";

/** 題名の文字数（Discord 側で検証する。/new とホームパネルのモーダルで共通） */
export const TITLE_MAX_LENGTH = 100;

/** 設定した人格のうち、id が既定の人格でないものを SessionOwner にする。既定の人格・設定に無い id は undefined（既定の人格のセッション） */
export function sessionOwnerOf(
  personas: readonly Pick<PersonaConfig, "id" | "name">[] | undefined,
  id: string | undefined,
): SessionOwner | undefined {
  if (id === undefined || id === DEFAULT_PERSONA_ID) return undefined;
  const persona = personas?.find((candidate) => candidate.id === id);
  return persona === undefined ? undefined : { id: persona.id, name: persona.name };
}

export type NewSessionDeps = {
  /** personas は足した人格（/new の persona の選択肢）。無ければ今と同じ（引数なし・すべて既定の人格） */
  cfg?: Partial<Pick<Config, "personas">>;
  gateway: Pick<Gateway, "createCategory" | "createTextChannel" | "channelExists" | "countChannelsIn" | "send">;
  /** 最初の投稿をするチャンネルの持ち主の Bot。無ければ gateway（既定の人格の Bot） */
  personas?: Pick<PersonaRouter, "gatewayFor">;
  guildSettings: GuildSettingsStore;
  topicSessions: TopicSessionStore;
  /** /setup と同じキュー。同じサーバーの /setup・/new を 1 つずつ実行する（key は layoutQueueKey） */
  queue: KeyedSerialQueue;
  log: (message: string) => void;
};

/**
 * 題名からセッションを作り、そのリンクを本人にだけ表示する（/new とホームパネルの [新しいセッション] のモーダルで共通）。
 * 空白だけの題名は作らずに案内する → 保留 → session-ops.ts の openTopicSession（/setup と同じキューで作成 → 最初の投稿（チャンネルの持ち主の Bot））→ リンクを返す。
 * via は log の主語（「/new で」など）。owner は作る人格（省略は既定の人格）
 */
export async function startTopicSession(
  guildId: string,
  rawTitle: string,
  responder: InteractionResponder,
  deps: NewSessionDeps,
  via: string,
  owner?: SessionOwner,
): Promise<void> {
  // Discord への作成が複数回ありうるので、受け付けたら（空の題名でなければ）保留する
  const result = await openTopicSession(guildId, rawTitle, owner, deps, via, () => responder.defer(true));
  switch (result.result) {
    case "empty_title":
      await responder.reply({ text: EMPTY_TITLE_REPLY, ephemeral: true });
      return;
    case "not_set_up":
      await responder.reply({ text: NOT_SET_UP_REPLY, ephemeral: true });
      return;
    case "created":
      await responder.reply({ text: `<#${result.channelId}> を作りました`, ephemeral: true });
      return;
  }
}

/** /new の人格の引数の名前 */
export const PERSONA_OPTION = "persona";

/** /new の定義。足した人格があるときだけ、人格を選ぶ任意の引数（選択肢は表示名。省略は既定の人格）を足す */
export function newCommandDef(personas: readonly Pick<PersonaConfig, "id" | "name">[] = []): CommandDef {
  return {
    name: "new",
    description: "セッション用のチャンネルを作ります（そのチャンネルで話しかけると会話が続きます）",
    options: [
      {
        type: "string",
        name: "title",
        description: "セッションの題名（チャンネル名と topic に使います）",
        required: true,
        minLength: 1,
        maxLength: TITLE_MAX_LENGTH,
      },
      ...(personas.length === 0
        ? []
        : [
            {
              type: "string" as const,
              name: PERSONA_OPTION,
              description: "話す相手（省略すると既定の人格）",
              choices: personas.map((persona) => ({ name: persona.name, value: persona.id })),
            },
          ]),
    ],
  };
}

/** `/new 題名 [persona]`: セッション用のチャンネルを進行中カテゴリに作り、そのリンクを本人にだけ表示する */
export function createNewSessionCommand(deps: NewSessionDeps): CommandHandler {
  const personas = deps.cfg?.personas ?? [];
  return {
    def: newCommandDef(personas),
    async handle(interaction, responder) {
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で /new が呼ばれました");
      const rawTitle = interaction.options.title;
      if (typeof rawTitle !== "string") throw new Error("/new の題名がありません");
      const personaId = interaction.options[PERSONA_OPTION];
      if (personaId !== undefined && typeof personaId !== "string") throw new Error("/new の人格が不正です");
      const owner = sessionOwnerOf(personas, personaId);
      // 選択肢に無い人格（設定から外した後の古い選択肢など）では作らない
      if (personaId !== undefined && personaId !== DEFAULT_PERSONA_ID && owner === undefined) {
        throw new Error("/new の人格が設定にありません");
      }
      await startTopicSession(guildId, rawTitle, responder, deps, "/new で", owner);
    },
  };
}
