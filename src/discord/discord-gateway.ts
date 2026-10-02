// Gateway の discord.js 実装。トークンは process.env.DISCORD_TOKEN から直接読み、保持もログ出力もしない
import {
  type ActionRowData,
  type APIModalInteractionResponseCallbackData,
  type ApplicationCommandOptionData,
  ApplicationCommandOptionType,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type ChatInputApplicationCommandData,
  type ChatInputCommandInteraction,
  Client,
  ComponentType,
  DiscordAPIError,
  type Interaction as DiscordInteraction,
  Events,
  GatewayIntentBits,
  type Guild,
  type Message,
  type MessageActionRowComponentData,
  MessageFlags,
  type MessageMentionOptions,
  type ModalSubmitInteraction,
  RESTJSONErrorCodes,
  type SendableChannels,
  type StringSelectMenuInteraction,
  TextInputStyle,
} from "discord.js";
import type {
  CommandDef,
  ComponentRow,
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

function toInteraction(interaction: SupportedInteraction): Interaction {
  const base = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    createdAt: interaction.createdAt,
  };
  if (interaction.isChatInputCommand()) {
    const options: Record<string, string | number | boolean> = {};
    for (const option of interaction.options.data) {
      if (option.value !== undefined) options[option.name] = option.value;
    }
    return { ...base, kind: "command", name: interaction.commandName, options };
  }
  if (interaction.isButton()) {
    return { ...base, kind: "button", customId: interaction.customId };
  }
  if (interaction.isStringSelectMenu()) {
    return { ...base, kind: "select", customId: interaction.customId, values: [...interaction.values] };
  }
  const fields: Record<string, string> = {};
  for (const [customId, field] of interaction.fields.fields) {
    if (field.type === ComponentType.TextInput) fields[customId] = field.value;
  }
  return { ...base, kind: "modal", customId: interaction.customId, fields };
}

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
} as const;

function toComponents(rows: readonly ComponentRow[]): ActionRowData<MessageActionRowComponentData>[] {
  return rows.map((row) => ({
    type: ComponentType.ActionRow,
    components:
      row.kind === "buttons"
        ? row.buttons.map((button) => ({
            type: ComponentType.Button,
            customId: button.customId,
            label: button.label,
            style: BUTTON_STYLES[button.style ?? "secondary"],
            disabled: button.disabled ?? false,
          }))
        : [
            {
              type: ComponentType.StringSelect,
              customId: row.select.customId,
              placeholder: row.select.placeholder,
              minValues: row.select.minValues,
              maxValues: row.select.maxValues,
              options: row.select.options,
            },
          ],
  }));
}

/** reply / followUp / editReply / update 共通の本文。components を省略したら送らない（update では元のまま残る） */
function toPayload(message: OutgoingMessage) {
  return {
    content: message.text,
    allowedMentions: ALLOWED_MENTIONS,
    ...(message.components === undefined ? {} : { components: toComponents(message.components) }),
  };
}

/** テキスト入力は Label で包む（ActionRow で包む形は Discord 側で非推奨） */
function toModal(modal: ModalDef): APIModalInteractionResponseCallbackData {
  return {
    custom_id: modal.customId,
    title: modal.title,
    components: modal.fields.map((field) => ({
      type: ComponentType.Label,
      label: field.label,
      component: {
        type: ComponentType.TextInput,
        custom_id: field.customId,
        style: field.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short,
        required: field.required ?? true,
        max_length: field.maxLength,
        placeholder: field.placeholder,
        value: field.value,
      },
    })),
  };
}

function toCommandData(def: CommandDef): ChatInputApplicationCommandData {
  const options = (def.options ?? []).map((option): ApplicationCommandOptionData => {
    const common = { name: option.name, description: option.description, required: option.required ?? false };
    switch (option.type) {
      case "string":
        return { ...common, type: ApplicationCommandOptionType.String };
      case "integer":
        return { ...common, type: ApplicationCommandOptionType.Integer };
      case "boolean":
        return { ...common, type: ApplicationCommandOptionType.Boolean };
    }
  });
  return { name: def.name, description: def.description, options };
}

class DiscordResponder implements InteractionResponder {
  private readonly interaction: SupportedInteraction;

  constructor(interaction: SupportedInteraction) {
    this.interaction = interaction;
  }

  async defer(ephemeral: boolean): Promise<void> {
    await this.interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  }

  async reply(message: OutgoingMessage): Promise<void> {
    const interaction = this.interaction;
    const flags = message.ephemeral === true ? MessageFlags.Ephemeral : undefined;
    if (interaction.replied) {
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
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
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
      // キャッシュではなく Discord に問い合わせる（/setup でしか使わない）
      await this.client.channels.fetch(channelId, { force: true });
      return true;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) return false;
      throw error;
    }
  }

  async moveChannel(channelId: string, parentId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || channel.isDMBased() || channel.isThread() || channel.type === ChannelType.GuildCategory) {
      throw new Error("カテゴリへ移せないチャンネルです");
    }
    // 既定の lockPermissions: true は移動先の overwrite を書き込む（Manage Roles が要る）ので使わない
    await channel.setParent(parentId, { lockPermissions: false });
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
