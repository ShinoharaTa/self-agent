// スラッシュコマンド・ボタン・セレクト・モーダルの振り分け。発言の処理（handler.ts）とは別経路
import type { Config } from "../config.ts";
import type { CommandDef, Gateway, Interaction, InteractionResponder } from "../discord/gateway.ts";
import { helpCommand } from "./commands/help.ts";
import { createNewSessionCommand, type NewSessionDeps } from "./commands/new.ts";
import { createSetupCommand, type SetupDeps } from "./commands/setup.ts";

export const OWNER_ONLY_REPLY = "オーナー専用です";
export const UNKNOWN_REPLY = "不明な操作です";
export const INTERACTION_FAILURE_REPLY = "処理に失敗しました";

export type CommandInteraction = Extract<Interaction, { kind: "command" }>;
export type ComponentInteraction = Exclude<Interaction, { kind: "command" }>;

/** スラッシュコマンド 1 つ。commands/<name>.ts に 1 ファイルずつ置く */
export type CommandHandler = {
  def: CommandDef;
  handle(interaction: CommandInteraction, responder: InteractionResponder): Promise<void>;
};

/** ボタン・セレクト・モーダルを custom_id の名前空間（`<ns>:<action>:<channelId>` の ns）ごとに受ける */
export type ComponentHandler = {
  namespace: string;
  handle(interaction: ComponentInteraction, responder: InteractionResponder): Promise<void>;
};

/** /setup と /new は同じキュー（queue）を使う */
export type CommandDeps = SetupDeps & NewSessionDeps;

/** 登録するスラッシュコマンド */
export function createCommands(deps: CommandDeps): CommandHandler[] {
  return [helpCommand, createSetupCommand(deps), createNewSessionCommand(deps)];
}

/** 名前空間ごとのハンドラ（P2-1 では無し） */
export const COMPONENTS: readonly ComponentHandler[] = [];

export type InteractionDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "ownerUserId">;
  commands: readonly CommandHandler[];
  components: readonly ComponentHandler[];
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function namespaceOf(customId: string): string {
  const end = customId.indexOf(":");
  return end === -1 ? customId : customId.slice(0, end);
}

/** log 用。custom_id の残り（channelId）は出さない */
function describeInteraction(interaction: Interaction): string {
  return interaction.kind === "command"
    ? `/${interaction.name}`
    : `${interaction.kind} ${namespaceOf(interaction.customId)}`;
}

type ResponseState = "none" | "deferred" | "done";

/** 応答の状態を記録する。失敗時の返信を出すかどうかに使う（呼び出しが成功したものだけ数える） */
function trackResponses(responder: InteractionResponder): { responder: InteractionResponder; state: () => ResponseState } {
  let state: ResponseState = "none";
  return {
    state: () => state,
    responder: {
      defer: async (ephemeral) => {
        await responder.defer(ephemeral);
        state = "deferred";
      },
      reply: async (message) => {
        await responder.reply(message);
        state = "done";
      },
      update: async (message) => {
        await responder.update(message);
        state = "done";
      },
      showModal: async (modal) => {
        await responder.showModal(modal);
        state = "done";
      },
    },
  };
}

/** 許可したサーバーでオーナーが行った操作だけを処理する。返す Promise は reject しない（失敗は log に出す） */
export function createInteractionHandler(
  deps: InteractionDeps,
): (interaction: Interaction, responder: InteractionResponder) => Promise<void> {
  const { cfg, commands, components, log } = deps;

  const replyEphemeral = async (responder: InteractionResponder, text: string): Promise<void> => {
    try {
      await responder.reply({ text, ephemeral: true });
    } catch (error) {
      log(`操作への応答に失敗しました: ${describeError(error)}`);
    }
  };

  const dispatch = async (interaction: Interaction, responder: InteractionResponder): Promise<void> => {
    if (interaction.kind === "command") {
      const command = commands.find((candidate) => candidate.def.name === interaction.name);
      if (command === undefined) {
        log(`不明なコマンドです（${describeInteraction(interaction)}）`);
        await replyEphemeral(responder, UNKNOWN_REPLY);
        return;
      }
      await command.handle(interaction, responder);
      return;
    }
    const namespace = namespaceOf(interaction.customId);
    const component = components.find((candidate) => candidate.namespace === namespace);
    if (component === undefined) {
      log(`不明な操作です（${describeInteraction(interaction)}）`);
      await replyEphemeral(responder, UNKNOWN_REPLY);
      return;
    }
    await component.handle(interaction, responder);
  };

  return async (interaction, rawResponder) => {
    // DM・許可外のサーバーには応答もしない
    if (interaction.guildId === null || !cfg.allowedGuildIds.includes(interaction.guildId)) {
      log(`許可していないサーバーまたは DM からの操作を無視しました（${describeInteraction(interaction)}）`);
      return;
    }
    if (cfg.ownerUserId === undefined || interaction.userId !== cfg.ownerUserId) {
      await replyEphemeral(rawResponder, OWNER_ONLY_REPLY);
      return;
    }

    const { responder, state } = trackResponses(rawResponder);
    try {
      await dispatch(interaction, responder);
    } catch (error) {
      log(`操作の処理中にエラーが発生しました（${describeInteraction(interaction)}）: ${describeError(error)}`);
      // 応答済みなら追加で送らない。defer だけ済んでいれば保留中の応答を失敗の文面で埋める
      if (state() !== "done") await replyEphemeral(responder, INTERACTION_FAILURE_REPLY);
    }
  };
}

export type RegisterCommandsDeps = {
  cfg: Pick<Config, "allowedGuildIds">;
  gateway: Pick<Gateway, "isInGuild" | "registerGuildCommands">;
  commands: readonly CommandHandler[];
  log: (message: string) => void;
};

/** 許可したサーバーのうち Bot が参加しているものへコマンドを登録する（bulk overwrite）。失敗は log に出して次へ進む */
export async function registerCommands(deps: RegisterCommandsDeps): Promise<void> {
  const { cfg, gateway, commands, log } = deps;
  const defs = commands.map((command) => command.def);
  for (const guildId of cfg.allowedGuildIds) {
    if (!gateway.isInGuild(guildId)) {
      log(`Bot が参加していないサーバーのため、コマンド登録をスキップしました（guild=${guildId}）`);
      continue;
    }
    try {
      await gateway.registerGuildCommands(guildId, defs);
      log(`コマンドを登録しました（guild=${guildId}、${defs.length} 件）`);
    } catch (error) {
      log(`コマンドの登録に失敗しました（guild=${guildId}）: ${describeError(error)}`);
    }
  }
}
