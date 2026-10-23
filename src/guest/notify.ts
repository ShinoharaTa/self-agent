// ゲストの知らせ（docs/plan/guest-mode.md §6）。オーナーのサーバー（/setup 済み）の #system に、既定の人格の Bot で 1 行出す。
// 本文に入れるのはゲストのサーバーの ID と数だけ（チャンネル ID は入れない）。失敗は log だけ
import { SHELL_NOTICE_TIMEOUT_MS, withTimeout } from "../app/shell-state.ts";
import type { Config } from "../config.ts";
import type { Gateway } from "../discord/gateway.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import { GUEST_MAX_CHANNELS_PER_GUILD } from "./constants.ts";

export function guestEnabledNotice(guildId: string, active: number): string {
  return `ゲスト: サーバー ${guildId} でチャンネルを有効化しました（${active}/${GUEST_MAX_CHANNELS_PER_GUILD}）`;
}

export function guestDisabledNotice(guildId: string, active: number): string {
  return `ゲスト: サーバー ${guildId} でチャンネルを無効化しました（${active}/${GUEST_MAX_CHANNELS_PER_GUILD}）`;
}

export function guestLeftNotice(guildId: string, disabled: number): string {
  return `ゲスト: サーバー ${guildId} から外されました（有効なチャンネル ${disabled} 件を無効にしました）`;
}

export function guestNotJoinedNotice(guildId: string, disabled: number): string {
  return `ゲスト: サーバー ${guildId} に参加していないため、有効なチャンネル ${disabled} 件を無効にしました`;
}

export type GuestNotifyDeps = {
  /** 知らせを投稿するサーバー（オーナーのサーバー） */
  cfg: Pick<Config, "allowedGuildIds">;
  /** 投稿先（#system） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  /** 既定の人格の Bot */
  gateway: Pick<Gateway, "sendMessage">;
  log: (message: string) => void;
  /** 既定は SHELL_NOTICE_TIMEOUT_MS */
  timeoutMs?: number;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** /setup 済み（#system がある）のオーナーのサーバーに 1 回ずつ投稿する。やり直さない。reject しない */
export function createGuestNotifier(deps: GuestNotifyDeps): (text: string) => Promise<void> {
  const { cfg, guildSettings, gateway, log } = deps;
  return async (text) => {
    for (const guildId of cfg.allowedGuildIds) {
      try {
        const systemChannelId = guildSettings.get(guildId)?.systemChannelId ?? null;
        if (systemChannelId === null) continue;
        await withTimeout(gateway.sendMessage(systemChannelId, { text }), deps.timeoutMs ?? SHELL_NOTICE_TIMEOUT_MS);
      } catch (error) {
        log(`guest: #system への知らせの投稿に失敗しました（guild=${guildId}）: ${describeError(error)}`);
      }
    }
  };
}
