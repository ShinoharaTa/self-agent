// Gateway の discord.js 実装。人格ごとに 1 つ作る（docs/plan/personas.md）。
// トークンは process.env の人格ごとの変数（既定の人格は DISCORD_TOKEN）から直接読み、保持もログ出力もしない
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
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type SendableChannels,
  type StringSelectMenuInteraction,
  type TextChannel,
} from "discord.js";
import { DEFAULT_PERSONA_ID } from "../config.ts";
import {
  ALLOWED_MENTIONS,
  allowedMentionsFor,
  mentionPrefix,
  toButtonInteraction,
  toCommandData,
  toCommandInteraction,
  toDisplayName,
  toIncomingAttachments,
  toMentionInfo,
  toModal,
  toModalInteraction,
  toPayload,
  toSelectInteraction,
} from "./convert.ts";
import {
  type CommandDef,
  type Gateway,
  type GatewayHandlers,
  type IncomingMessage,
  type Interaction,
  type InteractionResponder,
  type ModalDef,
  type OutgoingMessage,
  type TextChannelOptions,
  UnknownChannelError,
} from "./gateway.ts";
import { splitMessage } from "./split.ts";

const TYPING_INTERVAL_MS = 8_000;
/** findNoticeChannels が返す候補の数の上限 */
const NOTICE_CHANNEL_CANDIDATES = 3;

/**
 * 発言者が Manage Server（Administrator を含む）を持つか。発言に member が付いていなければ undefined。
 * 権限を求められなかったとき（キャッシュの不足など）も undefined にして、発言の受け取りは止めない
 */
function authorCanManageGuild(message: Message): boolean | undefined {
  try {
    const member = message.member;
    return member === null ? undefined : member.permissions.has(PermissionFlagsBits.ManageGuild);
  } catch {
    return undefined;
  }
}

/** snowflake の比較（桁数 → 文字列） */
function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function toIncoming(message: Message, persona: string, selfUserId: string | undefined): IncomingMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    isWebhook: message.webhookId !== null && message.webhookId !== undefined,
    content: message.content,
    createdAt: message.createdAt,
    // 添付は情報だけ（取得は受け付けた後に app 側で行う）
    ...toIncomingAttachments(message.attachments.values()),
    persona,
    // メンション・返信先（ゲスト Bot の受付判定だけが読む）
    ...toMentionInfo(message, selfUserId, authorCanManageGuild(message)),
    // 表示名（ゲストのターンの prompt だけが読む）
    authorDisplayName: toDisplayName(message),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnknownChannel(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel;
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
  if (interaction.isChatInputCommand()) {
    // 権限は Discord が計算して付けてくる（DM では null）
    return toCommandInteraction(interaction, interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? null);
  }
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

/** どの人格の Bot か。省略すれば既定の人格（DISCORD_TOKEN） */
export type DiscordGatewayOptions = {
  /** 人格の id。受け取った発言に付ける（access.ts の持ち主の判定） */
  persona?: string;
  /** トークンの変数名（値は start で process.env から読む） */
  tokenEnv?: string;
  /** Bot がサーバーから外された（GuildDelete。一時的に使えなくなったときは呼ばない）。ゲスト Bot だけが使う */
  onGuildLeave?: (guildId: string) => void;
  /** Bot が新しいサーバーに入った（GuildCreate。再起動・再接続では鳴らない）。ゲスト Bot だけが使う（GU4b で配線する） */
  onGuildJoin?: (guildId: string) => void;
  /** 許可していない（第 1 引数に無い）サーバーに参加していたら log で警告するか。既定 true。ゲスト Bot は false（許可は DB で持つ） */
  warnOnUnlistedGuild?: boolean;
};

export class DiscordGateway implements Gateway {
  /** 許可していないサーバーに入っていたら警告する（メッセージは handler 側の受付判定で弾く） */
  private readonly allowedGuildIds: readonly string[];
  private readonly persona: string;
  private readonly tokenEnv: string;
  private readonly onGuildLeave: ((guildId: string) => void) | undefined;
  private readonly onGuildJoin: ((guildId: string) => void) | undefined;
  private readonly warnOnUnlistedGuild: boolean;
  /** log の前置き（既定の人格は今までどおり `discord:`、足した人格は `discord(<id>):`） */
  private readonly prefix: string;
  /** Discord に接続しているか（ready・再開で true、切断・再接続中で false。start 前とログインの失敗も false） */
  private isConnected = false;

  constructor(allowedGuildIds: readonly string[], options: DiscordGatewayOptions = {}) {
    this.allowedGuildIds = allowedGuildIds;
    this.persona = options.persona ?? DEFAULT_PERSONA_ID;
    this.tokenEnv = options.tokenEnv ?? "DISCORD_TOKEN";
    this.onGuildLeave = options.onGuildLeave;
    this.onGuildJoin = options.onGuildJoin;
    this.warnOnUnlistedGuild = options.warnOnUnlistedGuild ?? true;
    this.prefix = this.persona === DEFAULT_PERSONA_ID ? "discord:" : `discord(${this.persona}):`;
  }

  /** Discord に接続しているか（#system の知らせに使う） */
  connected(): boolean {
    return this.isConnected;
  }

  /** この Bot のユーザー ID（ログイン前は undefined）。ゲスト Bot の受付判定（返信先がこの Bot か）に使う */
  selfUserId(): string | undefined {
    return this.client.user?.id;
  }

  private warnIfNotAllowed(guildId: string): void {
    if (this.warnOnUnlistedGuild && !this.allowedGuildIds.includes(guildId)) {
      console.error(`${this.prefix} 許可していないサーバーに参加しています（guild=${guildId}）。このサーバーでは反応しません`);
    }
  }

  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  async start(handlers: GatewayHandlers): Promise<void> {
    const token = process.env[this.tokenEnv];
    if (token === undefined || token === "") {
      throw new Error(`${this.tokenEnv} が設定されていません`);
    }
    this.client.on(Events.Error, (error) => {
      console.error(`${this.prefix} ${describeError(error)}`);
    });
    // 接続の状態（discord.js は切れても自分で再接続する）
    this.client.on(Events.ShardReady, () => {
      this.isConnected = true;
    });
    this.client.on(Events.ShardResume, () => {
      this.isConnected = true;
    });
    this.client.on(Events.ShardDisconnect, () => {
      this.isConnected = false;
    });
    this.client.on(Events.ShardReconnecting, () => {
      this.isConnected = false;
    });
    const onGuildJoin = this.onGuildJoin;
    this.client.on(Events.GuildCreate, (guild) => {
      this.warnIfNotAllowed(guild.id);
      onGuildJoin?.(guild.id);
    });
    // サーバーから外された（discord.js は一時的に使えなくなったときは GuildUnavailable を出し、GuildDelete は出さない）
    const onGuildLeave = this.onGuildLeave;
    if (onGuildLeave !== undefined) {
      this.client.on(Events.GuildDelete, (guild) => {
        onGuildLeave(guild.id);
      });
    }
    this.client.on(Events.MessageCreate, (message) => {
      handlers.onMessage(toIncoming(message, this.persona, this.client.user?.id));
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!isSupported(interaction)) {
        console.error(`${this.prefix} 未対応の操作を無視しました（type=${interaction.type}）`);
        return;
      }
      handlers.onInteraction(toInteraction(interaction), new DiscordResponder(interaction));
    });
    const ready = new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, () => resolve());
    });
    await this.client.login(token);
    await ready;
    this.isConnected = true;
    for (const guildId of this.client.guilds.cache.keys()) {
      this.warnIfNotAllowed(guildId);
    }
    console.log(`${this.prefix} 接続しました`);
  }

  async send(channelId: string, text: string, replyToId?: string, mentionUserId?: string): Promise<void> {
    const channel = await this.sendableChannel(channelId);
    // メンションは分割の前に付ける（最初の塊に入り、2000 字の上限も守られる）
    const content = mentionUserId === undefined ? text : `${mentionPrefix(mentionUserId)}${text}`;
    for (const [index, chunk] of splitMessage(content).entries()) {
      // 鳴らすのは最初の塊だけ
      const allowedMentions = index === 0 ? allowedMentionsFor(mentionUserId) : ALLOWED_MENTIONS;
      if (index === 0 && replyToId !== undefined) {
        // 元の発言が消えていても投稿する
        await channel.send({
          content: chunk,
          allowedMentions,
          reply: { messageReference: replyToId, failIfNotExists: false },
        });
      } else {
        await channel.send({ content: chunk, allowedMentions });
      }
    }
  }

  async sendMessage(channelId: string, message: OutgoingMessage): Promise<string> {
    const channel = await this.sendableChannel(channelId);
    const sent = await channel.send(toPayload(message));
    return sent.id;
  }

  async editMessage(channelId: string, messageId: string, message: OutgoingMessage): Promise<void> {
    const channel = await this.sendableChannel(channelId);
    await channel.messages.edit(messageId, toPayload(message));
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
        console.error(`${this.prefix} 入力中表示に失敗しました: ${describeError(error)}`);
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

  /** 参加しているサーバーの ID（start 後に使う。キャッシュの鍵） */
  listGuildIds(): string[] {
    return [...this.client.guilds.cache.keys()];
  }

  /**
   * 定型文の投稿先の候補（docs/plan/guest-mode.md §3.2.4）。チャンネルの ID を順に最大 3 つ: (a) システムメッセージのチャンネル、
   * (b) テキストチャンネルを「親カテゴリの位置（カテゴリなしが先）→ 自身の位置 → id」の順に。どちらも Bot が View Channel と
   * Send Messages を両方持つものだけ。参加していない・Bot 自身の member を取れなければ空
   */
  async findNoticeChannels(guildId: string): Promise<string[]> {
    const guild = this.client.guilds.cache.get(guildId);
    if (guild === undefined) return [];
    let me = guild.members.me;
    if (me === null) {
      try {
        me = await guild.members.fetchMe();
      } catch (error) {
        console.error(`${this.prefix} Bot のメンバー情報を取れませんでした（guild=${guildId}）: ${describeError(error)}`);
        return [];
      }
    }
    const member = me;
    const canPost = (channel: TextChannel): boolean =>
      channel.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    const candidates: string[] = [];
    const system = guild.systemChannel;
    if (system !== null && canPost(system)) candidates.push(system.id);
    const position = (channel: TextChannel): number => (channel.parent === null ? -1 : channel.parent.rawPosition);
    const texts = [...guild.channels.cache.values()]
      .filter((channel): channel is TextChannel => channel.type === ChannelType.GuildText)
      .sort((a, b) => position(a) - position(b) || a.rawPosition - b.rawPosition || compareIds(a.id, b.id));
    for (const channel of texts) {
      if (candidates.length >= NOTICE_CHANNEL_CANDIDATES) break;
      if (!candidates.includes(channel.id) && canPost(channel)) candidates.push(channel.id);
    }
    return candidates.slice(0, NOTICE_CHANNEL_CANDIDATES);
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
      // キャッシュではなく Discord に問い合わせる（/setup・/new と、リマインドの投稿に失敗したときに使う）
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
    const parents = await this.listChannelParents(category.guildId);
    let count = 0;
    for (const parentId of parents.values()) if (parentId === categoryId) count++;
    return count;
  }

  async listChannelParents(guildId: string): Promise<Map<string, string | null>> {
    // guild.channels.fetch() はスレッドを返さない（スレッドは fetchActiveThreads で別に取る）
    const channels = await this.guild(guildId).channels.fetch();
    const parents = new Map<string, string | null>();
    for (const [channelId, channel] of channels) {
      if (channel !== null) parents.set(channelId, channel.parentId);
    }
    return parents;
  }

  async moveChannel(channelId: string, parentId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel === null || channel.isDMBased() || channel.isThread() || channel.type === ChannelType.GuildCategory) {
        throw new Error("カテゴリへ移せないチャンネルです");
      }
      // 既定の lockPermissions: true は移動先の overwrite を書き込む（Manage Roles が要る）ので使わない
      await channel.setParent(parentId, { lockPermissions: false });
    } catch (error) {
      // 手で消されていた（取得・移動のどちらで分かっても）
      if (isUnknownChannel(error)) throw new UnknownChannelError();
      throw error;
    }
  }

  async getParentId(channelId: string): Promise<string | null> {
    try {
      // 手で動かされていることがあるので、キャッシュではなく Discord に問い合わせる
      const channel = await this.client.channels.fetch(channelId, { force: true });
      if (channel === null || channel.isDMBased()) {
        throw new Error("サーバーのチャンネルではありません");
      }
      return channel.parentId;
    } catch (error) {
      if (isUnknownChannel(error)) throw new UnknownChannelError();
      throw error;
    }
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
    this.isConnected = false;
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
