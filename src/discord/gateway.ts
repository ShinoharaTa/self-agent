// Discord との境界。discord.js を import しない（実装は discord-gateway.ts、テストでは偽物に差し替える）

export type IncomingMessage = {
  id: string;
  channelId: string;
  /** DM では null */
  guildId: string | null;
  authorId: string;
  authorIsBot: boolean;
  isWebhook: boolean;
  content: string;
  createdAt: Date;
};

export interface Gateway {
  start(onMessage: (message: IncomingMessage) => void): Promise<void>;
  /** 長い本文は分割して送る。replyToId があれば最初の塊だけその発言への返信にする */
  send(channelId: string, text: string, replyToId?: string): Promise<void>;
  /** 入力中表示を始め、止める関数を返す */
  startTyping(channelId: string): () => void;
  stop(): Promise<void>;
}
