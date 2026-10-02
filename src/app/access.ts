import type { Config } from "../config.ts";
import type { IncomingMessage } from "../discord/gateway.ts";

/** 許可したサーバー（env の SELF_AGENT_ALLOWED_GUILD_IDS）の #inbox で、オーナー本人が書いた空でない発言だけを受け付ける（DM・bot・Webhook は弾く） */
export function isAccepted(
  event: IncomingMessage,
  cfg: Pick<Config, "allowedGuildIds" | "inboxChannelId" | "ownerUserId">,
): boolean {
  return (
    event.guildId !== null &&
    cfg.allowedGuildIds.includes(event.guildId) &&
    event.channelId === cfg.inboxChannelId &&
    event.authorId === cfg.ownerUserId &&
    !event.authorIsBot &&
    !event.isWebhook &&
    event.content.trim() !== ""
  );
}
