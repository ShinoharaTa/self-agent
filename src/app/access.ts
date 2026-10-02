import type { Config } from "../config.ts";
import type { IncomingMessage } from "../discord/gateway.ts";

/** 許可したギルドの #inbox で、オーナー本人が書いた空でない発言だけを受け付ける（DM・bot・Webhook は弾く） */
export function isAccepted(
  event: IncomingMessage,
  cfg: Pick<Config, "guildId" | "inboxChannelId" | "ownerUserId">,
): boolean {
  return (
    event.guildId === cfg.guildId &&
    event.channelId === cfg.inboxChannelId &&
    event.authorId === cfg.ownerUserId &&
    !event.authorIsBot &&
    !event.isWebhook &&
    event.content.trim() !== ""
  );
}
