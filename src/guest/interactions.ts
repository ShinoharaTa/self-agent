// ゲスト Bot の操作の振り分け（docs/plan/guest-mode.md §3.1・§3.7）。既定の人格の interactions.ts とは別。
// ゲストのサーバーの /guest だけを処理し、それ以外（ボタン・ほかのコマンド・ゲストのサーバーの外・DM）は応答しない
import { INTERACTION_FAILURE_REPLY, type CommandHandler } from "../app/interactions.ts";
import type { Config } from "../config.ts";
import type { Interaction, InteractionResponder } from "../discord/gateway.ts";

export type GuestInteractionDeps = {
  cfg: Pick<Config, "guestGuildIds">;
  /** /guest（commands/guest.ts） */
  command: CommandHandler;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 返す Promise は reject しない（失敗は log に出す） */
export function createGuestInteractionHandler(
  deps: GuestInteractionDeps,
): (interaction: Interaction, responder: InteractionResponder) => Promise<void> {
  const { cfg, command, log } = deps;
  return async (interaction, responder) => {
    // DM・ゲストのサーバーの外には応答もしない
    if (interaction.guildId === null || !cfg.guestGuildIds.includes(interaction.guildId)) {
      log(`guest: ゲストのサーバーでない操作を無視しました（guild=${interaction.guildId ?? "DM"}）`);
      return;
    }
    if (interaction.kind !== "command" || interaction.name !== command.def.name) {
      log(`guest: 未対応の操作を無視しました（guild=${interaction.guildId}）`);
      return;
    }
    let replied = false;
    const tracked: InteractionResponder = {
      defer: (ephemeral) => responder.defer(ephemeral),
      deferUpdate: () => responder.deferUpdate(),
      showModal: (modal) => responder.showModal(modal),
      update: (message) => responder.update(message),
      reply: async (message) => {
        await responder.reply(message);
        replied = true;
      },
    };
    try {
      await command.handle(interaction, tracked);
    } catch (error) {
      log(`guest: /${command.def.name} の処理中にエラーが発生しました（guild=${interaction.guildId}）: ${describeError(error)}`);
      if (replied) return;
      try {
        await responder.reply({ text: INTERACTION_FAILURE_REPLY, ephemeral: true });
      } catch (replyError) {
        log(`guest: 操作への応答に失敗しました: ${describeError(replyError)}`);
      }
    }
  };
}
