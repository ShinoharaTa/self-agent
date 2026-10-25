// ゲストの発言の受付判定（docs/plan/guest-mode.md §3.2 の fail-closed の規則）。純関数。
// この判定を通った発言だけを、index.ts が handler.ts のターンに渡す（通らなければ黙って捨てる）
import type { IncomingMessage } from "../discord/gateway.ts";
import type { GuestChannel } from "../store/guest.ts";
import { GUEST_PERSONA_ID } from "./constants.ts";

export type GuestAccessInput = {
  message: Pick<
    IncomingMessage,
    "guildId" | "channelId" | "authorIsBot" | "isWebhook" | "persona" | "mentionsMe" | "replyToAuthorId"
  >;
  /** 発言のサーバーが guest_guilds で許可済みか（呼び出し側が GuestGuildStore.isAllowed で引く。DM は false） */
  guildAllowed: boolean;
  /** その発言のチャンネルの guest_channels の行（無ければ undefined） */
  channel: GuestChannel | undefined;
  /** ゲスト Bot のユーザー ID（ログイン前で分からなければ undefined） */
  botUserId: string | undefined;
};

/**
 * ゲストのターンを動かしてよい発言か。次のすべてを満たすときだけ true（どれか分からなければ false）:
 * (1) サーバーが guest_guilds で許可済み（認証コードで許可され、取り消されていない）、(2) guest_channels にそのサーバー・チャンネルの有効な行がある、
 * (3) ゲスト Bot の Gateway から届いた、(4) 発言者が Bot・Webhook でない、
 * (5) ゲスト Bot がメンションされたか、ゲスト Bot の発言への返信
 */
export function acceptsGuestMessage(input: GuestAccessInput): boolean {
  const { message, guildAllowed, channel, botUserId } = input;
  const guildId = message.guildId;
  if (guildId === null || !guildAllowed) return false;
  if (channel === undefined || channel.disabledAt !== null) return false;
  if (channel.channelId !== message.channelId || channel.guildId !== guildId) return false;
  if (message.persona !== GUEST_PERSONA_ID) return false;
  if (message.authorIsBot || message.isWebhook) return false;
  if (message.mentionsMe === true) return true;
  return botUserId !== undefined && message.replyToAuthorId !== undefined && message.replyToAuthorId === botUserId;
}
