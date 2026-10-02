import type { Config } from "../config.ts";
import type { IncomingMessage } from "../discord/gateway.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";

/** 発言を受け付けるチャンネルの種類（P2-3 で "session" を足す） */
export type ChannelKind = "inbox";

/** そのチャンネルが受け付け対象なら種類を、対象外なら null を返す */
export type ResolveChannel = (guildId: string, channelId: string) => ChannelKind | null;

/** 許可したサーバー（env の SELF_AGENT_ALLOWED_GUILD_IDS）の受け付け対象のチャンネルで、オーナー本人が書いた空でない発言だけを受け付ける（DM・bot・Webhook は弾く） */
export function isAccepted(
  event: IncomingMessage,
  cfg: Pick<Config, "allowedGuildIds" | "ownerUserId">,
  resolveChannel: ResolveChannel,
): boolean {
  return (
    event.guildId !== null &&
    cfg.allowedGuildIds.includes(event.guildId) &&
    event.authorId === cfg.ownerUserId &&
    !event.authorIsBot &&
    !event.isWebhook &&
    event.content.trim() !== "" &&
    // DB を引くのは他の条件をすべて満たしたときだけ
    resolveChannel(event.guildId, event.channelId) !== null
  );
}

/** /setup 済みのサーバーは DB の #inbox、guild_settings に行が無いサーバーだけ env の SELF_AGENT_INBOX_CHANNEL_ID を #inbox とみなす（env は P3 で廃止） */
export function createChannelResolver(
  cfg: Pick<Config, "inboxChannelId">,
  guildSettings: Pick<GuildSettingsStore, "get">,
): ResolveChannel {
  return (guildId, channelId) => {
    const settings = guildSettings.get(guildId);
    const inboxChannelId = settings === undefined ? cfg.inboxChannelId : settings.inboxChannelId;
    return channelId === inboxChannelId ? "inbox" : null;
  };
}

export type SetupStatusDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "inboxChannelId">;
  guildSettings: Pick<GuildSettingsStore, "get">;
  log: (message: string) => void;
};

/** 起動時に、/setup を実行していない許可サーバーを log に出す */
export function logUnconfiguredGuilds(deps: SetupStatusDeps): void {
  const { cfg, guildSettings, log } = deps;
  for (const guildId of cfg.allowedGuildIds) {
    if (guildSettings.get(guildId) !== undefined) continue;
    log(
      cfg.inboxChannelId === undefined
        ? `/setup が未実行です（guild=${guildId}）。/setup を実行するまで発言は受け付けません`
        : `/setup が未実行です（guild=${guildId}）。env の SELF_AGENT_INBOX_CHANNEL_ID を #inbox として使用中です`,
    );
  }
}
