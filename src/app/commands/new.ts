import { type Config, DEFAULT_PERSONA_ID, type PersonaConfig } from "../../config.ts";
import type { CommandDef, Gateway, InteractionResponder } from "../../discord/gateway.ts";
import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import type { TopicSessionStore } from "../../store/topic-sessions.ts";
import type { CommandHandler } from "../interactions.ts";
import type { PersonaRouter } from "../personas.ts";
import type { KeyedSerialQueue } from "../queue.ts";
import { listProjects } from "../../cc/starter.ts";
import {
  checkSessionProject,
  createTopicSession,
  type NewSessionResult,
  openTopicSession,
  type ProjectSessionGate,
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
/** /new の project が使えない（形・symlink・守る場所など。cc/starter.ts の projectDir を通らない） */
export const PROJECT_INVALID_REPLY = "そのプロジェクトは使えません";
/** /new の project と足した人格は同時に使えない（U1） */
export const PROJECT_PERSONA_REPLY = "プロジェクトのセッションは既定の人格だけです";
/** 共有の link（npm run unify-setup）が済んでいない */
export const PROJECT_NOT_SET_UP_REPLY = "設定が済んでいません（unify-setup）";

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
  /** プロジェクトのセッション（docs/plan/unify.md §5.2。SELF_AGENT_CC=1 のときだけ）。無ければ /new に project の引数を出さない */
  projectSessions?: ProjectSessionGate;
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
  projectDir?: string,
): Promise<void> {
  // Discord への作成が複数回ありうるので、受け付けたら（空の題名でなければ）保留する
  const result = await openTopicSession(guildId, rawTitle, owner, deps, via, () => responder.defer(true), projectDir);
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
/** /new のプロジェクトの引数の名前 */
export const PROJECT_OPTION = "project";
/** Discord の選択肢の数の上限。これを超えるプロジェクトは選択肢を出さず文字列で受ける */
export const PROJECT_CHOICES_MAX = 25;

/**
 * /new の定義。足した人格があるときだけ、人格を選ぶ任意の引数（選択肢は表示名。省略は既定の人格）を足す。
 * projects（SELF_AGENT_WORKSPACE_DIR の直下で使えるもの。SELF_AGENT_CC=1 のときだけ）が 1 つ以上あれば、プロジェクトの任意の引数を足す
 * （25 件までは選択肢、それより多ければ文字列で受けて検証する）
 */
export function newCommandDef(personas: readonly Pick<PersonaConfig, "id" | "name">[] = [], projects: readonly string[] = []): CommandDef {
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
      ...(projects.length === 0
        ? []
        : [
            {
              type: "string" as const,
              name: PROJECT_OPTION,
              description: "プロジェクト（ワークスペースの直下。Claude Code と同じ装備で動きます）",
              ...(projects.length > PROJECT_CHOICES_MAX
                ? { maxLength: 64 }
                : { choices: projects.map((name) => ({ name, value: name })) }),
            },
          ]),
    ],
  };
}

/**
 * `/new 題名 [persona] [project]`: セッション用のチャンネルを進行中カテゴリに作り、そのリンクを本人にだけ表示する。
 * project があれば、足した人格との組み合わせ・共有の link が済んでいない・使えない名前を本人にだけ断ってから、プロジェクトのセッションを作る
 */
export function createNewSessionCommand(deps: NewSessionDeps): CommandHandler {
  const personas = deps.cfg?.personas ?? [];
  // 選択肢は登録のときに 1 回読む（後で増えたものは再起動まで出ない。文字列で受けたときと同じく、作るときに検証し直す）
  const projects = deps.projectSessions === undefined ? [] : listProjects(deps.projectSessions.places);
  return {
    def: newCommandDef(personas, projects),
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
      const project = interaction.options[PROJECT_OPTION];
      if (project !== undefined && typeof project !== "string") throw new Error("/new のプロジェクトが不正です");
      if (project === undefined) {
        await startTopicSession(guildId, rawTitle, responder, deps, "/new で", owner);
        return;
      }
      if (owner !== undefined) {
        await responder.reply({ text: PROJECT_PERSONA_REPLY, ephemeral: true });
        return;
      }
      const checked = deps.projectSessions === undefined ? undefined : checkSessionProject(project, deps.projectSessions);
      if (checked === undefined || !checked.ok) {
        const text = checked?.ok === false && checked.reason === "not_set_up" ? PROJECT_NOT_SET_UP_REPLY : PROJECT_INVALID_REPLY;
        await responder.reply({ text, ephemeral: true });
        return;
      }
      await startTopicSession(guildId, rawTitle, responder, deps, "/new で", undefined, checked.projectDir);
    },
  };
}
