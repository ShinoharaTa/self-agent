import { type Config, DEFAULT_PERSONA_ID, type PersonaConfig } from "../../config.ts";
import { normalizeChannelName } from "../../discord/channel-name.ts";
import type { CommandDef, Gateway, InteractionResponder } from "../../discord/gateway.ts";
import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import type { TopicSessionOrigin, TopicSessionStore } from "../../store/topic-sessions.ts";
import { findStateCategory } from "../categories.ts";
import type { CommandHandler } from "../interactions.ts";
import type { PersonaRouter } from "../personas.ts";
import type { KeyedSerialQueue } from "../queue.ts";
import { layoutQueueKey } from "./setup.ts";

export const NOT_SET_UP_REPLY = "先に /setup を実行してください";
export const EMPTY_TITLE_REPLY = "題名を入力してください";

/** /setup が作る最初の進行中カテゴリ */
const FIRST_ORDINAL = 1;

/** 題名の文字数（Discord 側で検証する。/new とホームパネルのモーダルで共通） */
export const TITLE_MAX_LENGTH = 100;
/** 正規化して空になった題名のチャンネル名 */
const FALLBACK_CHANNEL_NAME = "session";

/**
 * 題名をチャンネル名にする。前後の空白を除く → 空白の連続を `-` に → `-` と `_` 以外の ASCII 記号を除く →
 * ASCII 英字を小文字に → `-` の連続を 1 つに、先頭・末尾の `-` を除く → 100 字で切る → 空なら `session`。日本語はそのまま残す
 */
export function toChannelName(title: string): string {
  const name = normalizeChannelName(title);
  return name === "" ? FALLBACK_CHANNEL_NAME : name;
}

/** セッションを作る人格（既定の人格以外）。チャンネル名の接頭辞と topic に表示名を使う */
export type SessionOwner = Pick<PersonaConfig, "id" | "name">;

/** セッションのチャンネル名。既定の人格は題名だけ（今のまま）、足した人格は `<NAME>-<題名>`（どちらも toChannelName の規則で 100 字まで） */
export function sessionChannelName(title: string, owner?: SessionOwner): string {
  if (owner === undefined) return toChannelName(title);
  return toChannelName(`${normalizeChannelName(owner.name)}-${toChannelName(title)}`);
}

/** セッションのチャンネルの topic。既定の人格は題名だけ（今のまま）、足した人格は題名に表示名を添える */
export function sessionTopic(title: string, owner?: SessionOwner): string {
  return owner === undefined ? title : `${title}（${owner.name}）`;
}

/** 設定した人格のうち、id が既定の人格でないものを SessionOwner にする。既定の人格・設定に無い id は undefined（既定の人格のセッション） */
export function sessionOwnerOf(
  personas: readonly Pick<PersonaConfig, "id" | "name">[] | undefined,
  id: string | undefined,
): SessionOwner | undefined {
  if (id === undefined || id === DEFAULT_PERSONA_ID) return undefined;
  const persona = personas?.find((candidate) => candidate.id === id);
  return persona === undefined ? undefined : { id: persona.id, name: persona.name };
}

export function welcomeText(title: string): string {
  return `セッション「${title}」を始めました。ここで話しかけてください。`;
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

export type NewSessionResult = { result: "not_set_up" } | { result: "created"; channelId: string };

/**
 * 空きのある進行中カテゴリにセッション用のチャンネルを作り、sessions に保存する。/setup 前（進行中カテゴリが無い）なら何もしない。
 * origin は作られ方（/new・ホームパネルは command、#inbox・#<NAME> の session_open は inbox）。
 * owner は作る人格（チャンネルの持ち主。省略は既定の人格）。足した人格ならチャンネル名に `<NAME>-` を付け、topic に表示名を添える
 */
export async function createTopicSession(
  guildId: string,
  title: string,
  deps: Pick<NewSessionDeps, "gateway" | "guildSettings" | "topicSessions" | "log">,
  origin: TopicSessionOrigin = "command",
  owner?: SessionOwner,
): Promise<NewSessionResult> {
  const { gateway, guildSettings, topicSessions, log } = deps;
  if (
    guildSettings.get(guildId) === undefined ||
    guildSettings.getStateCategory(guildId, "active", FIRST_ORDINAL) === undefined
  ) {
    return { result: "not_set_up" };
  }
  const categoryId = await findStateCategory(guildId, "active", deps);
  // name・topic は作成時にだけ設定し、以後変更しない
  const channelId = await gateway.createTextChannel(guildId, {
    name: sessionChannelName(title, owner),
    parentId: categoryId,
    topic: sessionTopic(title, owner),
  });
  try {
    topicSessions.create({ channelId, guildId, title, categoryId, origin, ...(owner === undefined ? {} : { persona: owner.id }) });
  } catch (error) {
    // チャンネルだけが Discord に残る。手で消せるよう、ログにチャンネル ID を出す（ログ方針の例外）
    log(
      `セッションのチャンネルを作りましたが DB への保存に失敗しました（guild=${guildId}、channel=${channelId}）: ${describeError(error)}`,
    );
    throw error;
  }
  return { result: "created", channelId };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 題名からセッションを作り、そのリンクを本人にだけ表示する（/new とホームパネルの [新しいセッション] のモーダルで共通）。
 * 空白だけの題名は作らずに案内する → 保留 → /setup と同じキューで作成 → 最初の投稿（チャンネルの持ち主の Bot）→ リンクを返す。
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
  const { gateway, personas, queue, log } = deps;
  // 空白だけの題名は Discord の min_length・必須の検証を通ってしまうので、ここで弾く
  const title = rawTitle.trim();
  if (title === "") {
    await responder.reply({ text: EMPTY_TITLE_REPLY, ephemeral: true });
    return;
  }
  // Discord への作成が複数回ありうるので、先に保留する
  await responder.defer(true);
  // 同時に走ると空きの数え方がずれるので、/setup と同じ key で 1 つずつ実行する
  const result = await queue.run(layoutQueueKey(guildId), () => createTopicSession(guildId, title, deps, "command", owner));
  if (result.result === "not_set_up") {
    await responder.reply({ text: NOT_SET_UP_REPLY, ephemeral: true });
    return;
  }
  log(`${via}セッションを作りました（guild=${guildId}${owner === undefined ? "" : `、人格 ${owner.id}`}）`);
  try {
    // 最初の投稿はチャンネルの持ち主の Bot が行う（足した人格のセッションはその人格の Bot）
    await (personas?.gatewayFor(result.channelId) ?? gateway).send(result.channelId, welcomeText(title));
  } catch (error) {
    // チャンネルと DB の行はできているので、失敗の返信にはしない
    log(`セッションの最初の投稿に失敗しました: ${describeError(error)}`);
  }
  await responder.reply({ text: `<#${result.channelId}> を作りました`, ephemeral: true });
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
