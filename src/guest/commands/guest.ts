// /guest（docs/plan/guest-mode.md §3.2・§6）。ゲスト Bot だけが、ゲストのサーバーだけに登録する。
// on・off でそのチャンネルを有効・無効にし、status で有効なチャンネルと今日のサーバーの残り回数を本人にだけ出す。オーナー（SELF_AGENT_OWNER_ID）だけが使える
import { formatDate } from "../../app/time.ts";
import { type CommandHandler, OWNER_ONLY_REPLY } from "../../app/interactions.ts";
import type { Config } from "../../config.ts";
import type { CommandDef } from "../../discord/gateway.ts";
import type { GuestStore } from "../../store/guest.ts";
import type { SdkSessionStore } from "../../store/sdk-sessions.ts";
import { GUEST_BOT_NAME, GUEST_MAX_CHANNELS_PER_GUILD, guestSessionKey } from "../constants.ts";
import { guestDisabledNotice, guestEnabledNotice } from "../notify.ts";

export const GUEST_ON_REPLY = `このチャンネルで ${GUEST_BOT_NAME} をメンションすると答えます。**この Bot は AI です。** ファイル・Web・コマンドは使えません（会話だけ）。`;
export const GUEST_LIMIT_REPLY = `このサーバーで有効にできるチャンネルは ${GUEST_MAX_CHANNELS_PER_GUILD} つまでです`;
export const GUEST_ALREADY_ENABLED_REPLY = "このチャンネルは有効です";
export const GUEST_OFF_REPLY = "このチャンネルでは答えなくなりました";
export const GUEST_NOT_ENABLED_REPLY = "このチャンネルは有効ではありません";
export const GUEST_NO_CHANNEL_REPLY = "チャンネルで実行してください";

export const GUEST_COMMAND_DEF: CommandDef = {
  name: "guest",
  description: `${GUEST_BOT_NAME} が答えるチャンネルの設定（オーナー専用）`,
  subcommands: [
    { name: "on", description: `このチャンネルで ${GUEST_BOT_NAME} が答えるようにする` },
    { name: "off", description: "このチャンネルで答えないようにする" },
    { name: "status", description: "有効なチャンネルと今日の残り回数" },
  ],
};

export type GuestCommandDeps = {
  cfg: Pick<Config, "ownerUserId" | "timeZone" | "guestTurnsPerDay">;
  guest: Pick<GuestStore, "enable" | "disable" | "listActive" | "countActive" | "countTurns">;
  /** /guest on で、そのチャンネルの SDK セッション（`guest:<channelId>`）を捨てる */
  sessions: Pick<SdkSessionStore, "delete">;
  /** オーナーのサーバーの #system への知らせ（notify.ts。reject しない） */
  notify: (text: string) => Promise<void>;
  now: () => Date;
  log: (message: string) => void;
};

/** status の本文 */
export function guestStatusText(channelIds: readonly string[], remaining: number, perDay: number): string {
  const channels =
    channelIds.length === 0
      ? "有効なチャンネルはありません"
      : [`有効なチャンネル（${channelIds.length}/${GUEST_MAX_CHANNELS_PER_GUILD}）:`, ...channelIds.map((id) => `<#${id}>`)].join("\n");
  return `${channels}\n今日の残り回数: ${remaining}/${perDay}`;
}

/** サーバーの確かめ（ゲストのサーバーか）は呼び出し側（guest/interactions.ts）が行う */
export function createGuestCommand(deps: GuestCommandDeps): CommandHandler {
  const { cfg, guest, sessions, notify, now, log } = deps;
  return {
    def: GUEST_COMMAND_DEF,
    async handle(interaction, responder) {
      if (cfg.ownerUserId === undefined || interaction.userId !== cfg.ownerUserId) {
        await responder.reply({ text: OWNER_ONLY_REPLY, ephemeral: true });
        return;
      }
      const { guildId, channelId } = interaction;
      if (guildId === null || channelId === null) {
        await responder.reply({ text: GUEST_NO_CHANNEL_REPLY, ephemeral: true });
        return;
      }
      switch (interaction.subcommand) {
        case "on": {
          const result = guest.enable(guildId, channelId);
          if (result.result === "limit") {
            await responder.reply({ text: GUEST_LIMIT_REPLY, ephemeral: true });
            return;
          }
          if (result.result === "already_enabled") {
            await responder.reply({ text: GUEST_ALREADY_ENABLED_REPLY, ephemeral: true });
            return;
          }
          // 開き直したら前の会話は続けない
          sessions.delete(guestSessionKey(channelId));
          log(`guest: チャンネルを有効化しました（guild=${guildId}、${result.active}/${GUEST_MAX_CHANNELS_PER_GUILD}）`);
          // 応答に失敗しても、DB は変わっているので知らせは出す（応答は 3 秒以内なので知らせより先に）
          try {
            await responder.reply({ text: GUEST_ON_REPLY });
          } finally {
            await notify(guestEnabledNotice(guildId, result.active));
          }
          return;
        }
        case "off": {
          if (!guest.disable(channelId, "command")) {
            await responder.reply({ text: GUEST_NOT_ENABLED_REPLY, ephemeral: true });
            return;
          }
          const active = guest.countActive(guildId);
          log(`guest: チャンネルを無効化しました（guild=${guildId}、${active}/${GUEST_MAX_CHANNELS_PER_GUILD}）`);
          try {
            await responder.reply({ text: GUEST_OFF_REPLY });
          } finally {
            await notify(guestDisabledNotice(guildId, active));
          }
          return;
        }
        case "status": {
          const channelIds = guest.listActive(guildId).map((channel) => channel.channelId);
          const used = guest.countTurns(guildId, formatDate(now(), cfg.timeZone));
          const remaining = Math.max(0, cfg.guestTurnsPerDay - used);
          await responder.reply({ text: guestStatusText(channelIds, remaining, cfg.guestTurnsPerDay), ephemeral: true });
          return;
        }
        default:
          throw new Error("不明なサブコマンドです");
      }
    },
  };
}
