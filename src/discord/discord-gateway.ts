// Gateway の discord.js 実装。トークンは process.env.DISCORD_TOKEN から直接読み、保持もログ出力もしない
import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type MessageMentionOptions,
  type SendableChannels,
} from "discord.js";
import type { Gateway, IncomingMessage } from "./gateway.ts";
import { splitMessage } from "./split.ts";

const TYPING_INTERVAL_MS = 8_000;

// @everyone・ロール・他ユーザーへの通知は出さない（返信先への通知だけ残す）
const ALLOWED_MENTIONS: MessageMentionOptions = { parse: [], repliedUser: true };

function toIncoming(message: Message): IncomingMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    isWebhook: message.webhookId !== null && message.webhookId !== undefined,
    content: message.content,
    createdAt: message.createdAt,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DiscordGateway implements Gateway {
  /** 許可していないサーバーに入っていたら警告する（メッセージは handler 側の受付判定で弾く） */
  private readonly allowedGuildIds: readonly string[];

  constructor(allowedGuildIds: readonly string[]) {
    this.allowedGuildIds = allowedGuildIds;
  }

  private warnIfNotAllowed(guildId: string): void {
    if (!this.allowedGuildIds.includes(guildId)) {
      console.error(`discord: 許可していないサーバーに参加しています（guild=${guildId}）。このサーバーでは反応しません`);
    }
  }

  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    const token = process.env.DISCORD_TOKEN;
    if (token === undefined || token === "") {
      throw new Error("DISCORD_TOKEN が設定されていません");
    }
    this.client.on(Events.Error, (error) => {
      console.error(`discord: ${describeError(error)}`);
    });
    this.client.on(Events.GuildCreate, (guild) => {
      this.warnIfNotAllowed(guild.id);
    });
    this.client.on(Events.MessageCreate, (message) => {
      onMessage(toIncoming(message));
    });
    const ready = new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, () => resolve());
    });
    await this.client.login(token);
    await ready;
    for (const guildId of this.client.guilds.cache.keys()) {
      this.warnIfNotAllowed(guildId);
    }
    console.log("discord: 接続しました");
  }

  async send(channelId: string, text: string, replyToId?: string): Promise<void> {
    const channel = await this.sendableChannel(channelId);
    for (const [index, chunk] of splitMessage(text).entries()) {
      if (index === 0 && replyToId !== undefined) {
        // 元の発言が消えていても投稿する
        await channel.send({
          content: chunk,
          allowedMentions: ALLOWED_MENTIONS,
          reply: { messageReference: replyToId, failIfNotExists: false },
        });
      } else {
        await channel.send({ content: chunk, allowedMentions: ALLOWED_MENTIONS });
      }
    }
  }

  startTyping(channelId: string): () => void {
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        const channel = await this.sendableChannel(channelId);
        if (!stopped) await channel.sendTyping();
      } catch (error) {
        console.error(`discord: 入力中表示に失敗しました: ${describeError(error)}`);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), TYPING_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private async sendableChannel(channelId: string): Promise<SendableChannels> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || !channel.isSendable()) {
      throw new Error("送信できないチャンネルです");
    }
    return channel;
  }
}
