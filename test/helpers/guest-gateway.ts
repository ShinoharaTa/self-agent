// ゲストの層（guest/index.ts の GuestGateway）の偽物。start で handlers を受け取り、送信・定型文・権限の取得を記録する

import type { CommandDef, GatewayHandlers, OutgoingMessage } from "../../src/discord/gateway.ts";
import type { GuestGateway } from "../../src/guest/index.ts";

export class FakeGuestGateway implements GuestGateway {
  handlers: GatewayHandlers | undefined;
  /** 参加しているサーバー */
  joined = new Set<string>();
  registered: Array<{ guildId: string; defs: readonly CommandDef[] }> = [];
  stopped = 0;
  startError: Error | undefined;
  /** true ならログインが終わらない */
  hang = false;
  /** 送れた send */
  sent: Array<{ channelId: string; text: string; replyToId?: string }> = [];
  /** 送れた sendMessage（返した ID 付き） */
  posts: Array<{ channelId: string; messageId: string; message: OutgoingMessage }> = [];
  /** findNoticeChannels・sendMessage（失敗を含む）・messageExists・memberCanManageGuild の呼び出しの順 */
  calls: string[] = [];
  /** サーバー → findNoticeChannels の答え（無ければ空） */
  noticeChannels = new Map<string, string[]>();
  /** sendMessage が投げるチャンネル */
  failingChannels = new Set<string>();
  /** messageExists の答え（channelId:messageId があれば true） */
  messages = new Set<string>();
  /** messageExists が投げる */
  messageExistsError: Error | undefined;
  /** memberCanManageGuild の答え */
  canManage = false;
  /** send が投げる */
  sendError: Error | undefined;
  private nextMessage = 1;

  async start(handlers: GatewayHandlers): Promise<void> {
    if (this.hang) await new Promise<void>(() => {});
    if (this.startError !== undefined) throw this.startError;
    this.handlers = handlers;
  }
  async stop(): Promise<void> {
    this.stopped++;
  }
  isInGuild(guildId: string): boolean {
    return this.joined.has(guildId);
  }
  listGuildIds(): string[] {
    return [...this.joined];
  }
  async registerGuildCommands(guildId: string, defs: readonly CommandDef[]): Promise<void> {
    this.registered.push({ guildId, defs });
  }
  async send(channelId: string, text: string, replyToId?: string): Promise<void> {
    if (this.sendError !== undefined) throw this.sendError;
    this.sent.push({ channelId, text, ...(replyToId === undefined ? {} : { replyToId }) });
  }
  async sendMessage(channelId: string, message: OutgoingMessage): Promise<string> {
    this.calls.push(`sendMessage:${channelId}`);
    if (this.failingChannels.has(channelId)) throw new Error("Missing Permissions");
    const messageId = `m-notice-${this.nextMessage++}`;
    this.posts.push({ channelId, messageId, message });
    this.messages.add(`${channelId}:${messageId}`);
    return messageId;
  }
  async messageExists(channelId: string, messageId: string): Promise<boolean> {
    this.calls.push("messageExists");
    if (this.messageExistsError !== undefined) throw this.messageExistsError;
    return this.messages.has(`${channelId}:${messageId}`);
  }
  async findNoticeChannels(guildId: string): Promise<string[]> {
    this.calls.push(`findNoticeChannels:${guildId}`);
    return this.noticeChannels.get(guildId) ?? [];
  }
  async memberCanManageGuild(guildId: string): Promise<boolean> {
    this.calls.push(`memberCanManageGuild:${guildId}`);
    return this.canManage;
  }
  startTyping(): () => void {
    return () => {};
  }
  selfUserId(): string | undefined {
    return "bot-1";
  }
}
