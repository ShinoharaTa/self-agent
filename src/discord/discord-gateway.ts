// Gateway の discord.js 実装。トークンは process.env.DISCORD_TOKEN から直接読み、保持もログ出力もしない
import {
  type ButtonInteraction,
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  DiscordAPIError,
  type Interaction as DiscordInteraction,
  Events,
  GatewayIntentBits,
  type Guild,
  type Message,
  MessageFlags,
  type ModalSubmitInteraction,
  RESTJSONErrorCodes,
  type SendableChannels,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  ALLOWED_MENTIONS,
  toButtonInteraction,
  toCommandData,
  toCommandInteraction,
  toModal,
  toModalInteraction,
  toPayload,
  toSelectInteraction,
} from "./convert.ts";
import type {
  CommandDef,
  Gateway,
  GatewayHandlers,
  IncomingMessage,
  Interaction,
  InteractionResponder,
  ModalDef,
  OutgoingMessage,
  TextChannelOptions,
} from "./gateway.ts";
import { splitMessage } from "./split.ts";

const TYPING_INTERVAL_MS = 8_000;

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

/** 受け付ける interaction の種類（それ以外の autocomplete・コンテキストメニュー等は無視する） */
type SupportedInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

function isSupported(interaction: DiscordInteraction): interaction is SupportedInteraction {
  return (
    interaction.isChatInputCommand() ||
    interaction.isButton() ||
    interaction.isStringSelectMenu() ||
    interaction.isModalSubmit()
  );
}

/** 種類の判定は discord.js のメソッドで行い、値の取り出しは convert.ts に任せる */
function toInteraction(interaction: SupportedInteraction): Interaction {
  if (interaction.isChatInputCommand()) return toCommandInteraction(interaction);
  if (interaction.isButton()) return toButtonInteraction(interaction);
  if (interaction.isStringSelectMenu()) return toSelectInteraction(interaction);
  return toModalInteraction(interaction);
}

class DiscordResponder implements InteractionResponder {
  private readonly interaction: SupportedInteraction;
  /** deferUpdate で保留したか。保留中の応答（editReply）は元メッセージになるので、reply は追加のメッセージにする */
  private updateDeferred = false;

  constructor(interaction: SupportedInteraction) {
    this.interaction = interaction;
  }

  async defer(ephemeral: boolean): Promise<void> {
    await this.interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  }

  async deferUpdate(): Promise<void> {
    const interaction = this.interaction;
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      await interaction.deferUpdate();
    } else if (interaction.isModalSubmit() && interaction.isFromMessage()) {
      await interaction.deferUpdate();
    } else {
      throw new Error("deferUpdate はボタン・セレクト・メッセージから開いたモーダルにだけ使えます");
    }
    this.updateDeferred = true;
  }

  async reply(message: OutgoingMessage): Promise<void> {
    const interaction = this.interaction;
    const flags = message.ephemeral === true ? MessageFlags.Ephemeral : undefined;
    if (interaction.replied || this.updateDeferred) {
      await interaction.followUp({ ...toPayload(message), flags });
    } else if (interaction.deferred) {
      // 公開範囲は defer 時に決まっているので flags は渡さない
      await interaction.editReply(toPayload(message));
    } else {
      await interaction.reply({ ...toPayload(message), flags });
    }
  }

  async update(message: OutgoingMessage): Promise<void> {
    const interaction = this.interaction;
    if (this.updateDeferred) {
      // deferUpdate の後は、保留中の応答（元メッセージ）を書き換える
      await interaction.editReply(toPayload(message));
    } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
      await interaction.update(toPayload(message));
    } else if (interaction.isModalSubmit() && interaction.isFromMessage()) {
      await interaction.update(toPayload(message));
    } else {
      throw new Error("update はボタン・セレクト・メッセージから開いたモーダルにだけ使えます");
    }
  }

  async showModal(modal: ModalDef): Promise<void> {
    const interaction = this.interaction;
    if (interaction.isModalSubmit()) {
      throw new Error("モーダル送信への応答でモーダルは開けません");
    }
    await interaction.showModal(toModal(modal));
  }
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

  async start(handlers: GatewayHandlers): Promise<void> {
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
      handlers.onMessage(toIncoming(message));
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!isSupported(interaction)) {
        console.error(`discord: 未対応の操作を無視しました（type=${interaction.type}）`);
        return;
      }
      handlers.onInteraction(toInteraction(interaction), new DiscordResponder(interaction));
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

  async sendMessage(channelId: string, message: OutgoingMessage): Promise<string> {
    const channel = await this.sendableChannel(channelId);
    const sent = await channel.send(toPayload(message));
    return sent.id;
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.sendableChannel(channelId);
    await channel.messages.pin(messageId);
  }

  async messageExists(channelId: string, messageId: string): Promise<boolean> {
    try {
      // キャッシュではなく Discord に問い合わせる（/setup でしか使わない）
      const channel = await this.sendableChannel(channelId);
      await channel.messages.fetch({ message: messageId, force: true });
      return true;
    } catch (error) {
      if (
        error instanceof DiscordAPIError &&
        (error.code === RESTJSONErrorCodes.UnknownMessage || error.code === RESTJSONErrorCodes.UnknownChannel)
      ) {
        return false;
      }
      throw error;
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

  isInGuild(guildId: string): boolean {
    return this.client.guilds.cache.has(guildId);
  }

  async registerGuildCommands(guildId: string, defs: readonly CommandDef[]): Promise<void> {
    await this.guild(guildId).commands.set(defs.map(toCommandData));
  }

  // permissionOverwrites は渡さない（非公開にしない。Bot にはサーバー全体の Manage Channels を付ける前提）
  async createCategory(guildId: string, name: string): Promise<string> {
    const category = await this.guild(guildId).channels.create({ name, type: ChannelType.GuildCategory });
    return category.id;
  }

  async createTextChannel(guildId: string, options: TextChannelOptions): Promise<string> {
    const channel = await this.guild(guildId).channels.create({
      name: options.name,
      type: ChannelType.GuildText,
      parent: options.parentId,
      topic: options.topic,
    });
    return channel.id;
  }

  async channelExists(channelId: string): Promise<boolean> {
    try {
      // キャッシュではなく Discord に問い合わせる（/setup と /new でしか使わない）
      await this.client.channels.fetch(channelId, { force: true });
      return true;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) return false;
      throw error;
    }
  }

  async countChannelsIn(categoryId: string): Promise<number> {
    const category = await this.client.channels.fetch(categoryId);
    if (category === null || category.type !== ChannelType.GuildCategory) {
      throw new Error("カテゴリではありません");
    }
    // category.children（キャッシュ）ではなく、サーバーの全チャンネルを Discord から取り直して数える
    const channels = await category.guild.channels.fetch();
    return channels.filter((channel) => channel !== null && channel.parentId === categoryId).size;
  }

  async moveChannel(channelId: string, parentId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || channel.isDMBased() || channel.isThread() || channel.type === ChannelType.GuildCategory) {
      throw new Error("カテゴリへ移せないチャンネルです");
    }
    // 既定の lockPermissions: true は移動先の overwrite を書き込む（Manage Roles が要る）ので使わない
    await channel.setParent(parentId, { lockPermissions: false });
  }

  async getParentId(channelId: string): Promise<string | null> {
    // 手で動かされていることがあるので、キャッシュではなく Discord に問い合わせる
    const channel = await this.client.channels.fetch(channelId, { force: true });
    if (channel === null || channel.isDMBased()) {
      throw new Error("サーバーのチャンネルではありません");
    }
    return channel.parentId;
  }

  async deleteChannel(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel === null || channel.isDMBased() || channel.isThread() || channel.type === ChannelType.GuildCategory) {
        throw new Error("削除できないチャンネルです");
      }
      await channel.delete();
    } catch (error) {
      // 手で消されていた（取得・削除のどちらで分かっても）なら、消えているので成功とみなす
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) return;
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private guild(guildId: string): Guild {
    const guild = this.client.guilds.cache.get(guildId);
    if (guild === undefined) {
      throw new Error("参加していないサーバーです");
    }
    return guild;
  }

  private async sendableChannel(channelId: string): Promise<SendableChannels> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || !channel.isSendable()) {
      throw new Error("送信できないチャンネルです");
    }
    return channel;
  }
}
