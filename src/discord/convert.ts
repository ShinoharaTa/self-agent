// discord.js との間の変換のうち、discord.js のクラスを使わないもの（テストで JSON の期待値と比べる）。
// discord.js は型だけ import する（実行時には読み込まない）。そのため enum の代わりに Discord API の数値を使い、型で合っているかを確かめる
import type {
  ActionRowData,
  APIModalInteractionResponseCallbackData,
  ApplicationCommandOptionData,
  ApplicationCommandSubCommandData,
  ChatInputApplicationCommandData,
  MessageActionRowComponentData,
  MessageMentionOptions,
} from "discord.js";
import type {
  CommandDef,
  CommandOptionDef,
  ComponentRow,
  ImageMediaType,
  IncomingImage,
  IncomingMessage,
  Interaction,
  ModalDef,
  OutgoingMessage,
} from "./gateway.ts";

const COMPONENT_TYPE = { actionRow: 1, button: 2, stringSelect: 3, textInput: 4, label: 18 } as const;
const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;
const TEXT_INPUT_STYLE = { short: 1, paragraph: 2 } as const;
const COMMAND_OPTION_TYPE = { subcommand: 1, string: 3, integer: 4, boolean: 5 } as const;

// @everyone・ロール・他ユーザーへの通知は出さない（返信先への通知だけ残す）
export const ALLOWED_MENTIONS: MessageMentionOptions = { parse: [], repliedUser: true };

/** 本文の先頭に付けるメンション */
export function mentionPrefix(userId: string): string {
  return `<@${userId}> `;
}

/** mentionUserId があればそのユーザーだけを鳴らす（@everyone・ロールは鳴らさないまま）。無ければ ALLOWED_MENTIONS */
export function allowedMentionsFor(mentionUserId: string | undefined): MessageMentionOptions {
  return mentionUserId === undefined ? ALLOWED_MENTIONS : { parse: [], users: [mentionUserId], repliedUser: true };
}

/** 1 発言で渡す画像の上限 */
export const MAX_IMAGES_PER_MESSAGE = 4;
/** 1 枚の画像の大きさの上限（Discord の通常の上限に合わせる） */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 拡張子 → 形式（content type が無い添付のため） */
const IMAGE_EXTENSIONS: Record<string, ImageMediaType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/** 添付の形式。content type（`; …` の引数は除く）があればそれ、無ければ名前の拡張子で見る。渡せない形式なら undefined */
export function imageMediaType(contentType: string | null, name: string): ImageMediaType | undefined {
  if (contentType !== null && contentType.trim() !== "") {
    const type = contentType.split(";")[0]!.trim().toLowerCase();
    return Object.values(IMAGE_EXTENSIONS).find((known) => known === type);
  }
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  return extension === undefined ? undefined : IMAGE_EXTENSIONS[extension];
}

/** 添付の情報（discord.js の Attachment をそのまま渡せる形） */
export type AttachmentSource = {
  url: string;
  proxyURL: string;
  contentType: string | null;
  name: string;
  size: number;
  width: number | null;
  height: number | null;
};

/**
 * 発言の添付を、渡す画像（jpeg・png・webp・gif のうち MAX_IMAGE_BYTES 以下のものを、先頭から MAX_IMAGES_PER_MESSAGE 枚まで）と
 * 渡さない数（画像でない形式 / 上限を超える画像）に分ける。取得はしない
 */
export function toIncomingAttachments(
  attachments: Iterable<AttachmentSource>,
): Required<Pick<IncomingMessage, "images" | "skippedAttachments">> {
  const images: IncomingImage[] = [];
  let unsupported = 0;
  let overLimit = 0;
  for (const attachment of attachments) {
    const contentType = imageMediaType(attachment.contentType, attachment.name);
    if (contentType === undefined) {
      unsupported++;
      continue;
    }
    if (attachment.size > MAX_IMAGE_BYTES || images.length >= MAX_IMAGES_PER_MESSAGE) {
      overLimit++;
      continue;
    }
    images.push({
      url: attachment.url,
      proxyUrl: attachment.proxyURL,
      contentType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
    });
  }
  return { images, skippedAttachments: { unsupported, overLimit } };
}

/** 発言のメンションと返信の情報（discord.js の Message をそのまま渡せる形） */
export type MentionSource = {
  mentions: { users: { has(userId: string): boolean }; repliedUser: { id: string } | null };
  reference: unknown;
};

/**
 * 受け取った Bot（selfUserId。ログイン前で分からなければ undefined）がメンションされたかと、返信先の発言の author の ID。
 * メンションはユーザーとしてのものだけ（@everyone・ロールは mentions.users に入らない）。返信先の author は発言と一緒に届いたとき
 * （reference があり、repliedUser が分かる）だけ入れ、取りに行かない
 */
export function toMentionInfo(
  source: MentionSource,
  selfUserId: string | undefined,
): Pick<IncomingMessage, "mentionsMe" | "replyToAuthorId"> {
  const repliedUser = source.reference === null || source.reference === undefined ? null : source.mentions.repliedUser;
  return {
    mentionsMe: selfUserId !== undefined && source.mentions.users.has(selfUserId),
    ...(repliedUser === null ? {} : { replyToAuthorId: repliedUser.id }),
  };
}

export type DisplayNameSource = {
  member: { nickname: string | null } | null;
  author: { globalName: string | null; username: string };
};

/** 発言者の表示名。サーバーのニックネーム → グローバル名 → ユーザー名の順に、空でない最初のもの */
export function toDisplayName(source: DisplayNameSource): string {
  const nickname = source.member?.nickname;
  if (nickname !== null && nickname !== undefined && nickname !== "") return nickname;
  const globalName = source.author.globalName;
  if (globalName !== null && globalName !== "") return globalName;
  return source.author.username;
}

/** 受け付ける interaction の共通部分（discord.js の interaction をそのまま渡せる形） */
type InteractionSource = {
  guildId: string | null;
  channelId: string | null;
  user: { id: string };
  createdAt: Date;
};

function interactionBase(source: InteractionSource) {
  return {
    guildId: source.guildId,
    channelId: source.channelId,
    userId: source.user.id,
    createdAt: source.createdAt,
  };
}

type CommandOptionSource = { name: string; value?: string | number | boolean; options?: ReadonlyArray<CommandOptionSource> };

/**
 * スラッシュコマンド。値の無いオプションは入れない。サブコマンド（値が無く、中にオプションを持つもの）が選ばれていれば、その名前を
 * subcommand に、その中の値のあるオプションを options に入れる
 */
export function toCommandInteraction(
  source: InteractionSource & {
    commandName: string;
    options: { data: ReadonlyArray<CommandOptionSource> };
  },
): Interaction {
  const options: Record<string, string | number | boolean> = {};
  let subcommand: string | undefined;
  for (const option of source.options.data) {
    if (option.value !== undefined) {
      options[option.name] = option.value;
    } else if (option.options !== undefined && subcommand === undefined) {
      subcommand = option.name;
      for (const inner of option.options) {
        if (inner.value !== undefined) options[inner.name] = inner.value;
      }
    }
  }
  return {
    ...interactionBase(source),
    kind: "command",
    name: source.commandName,
    ...(subcommand === undefined ? {} : { subcommand }),
    options,
  };
}

/** message はボタンが付いていたメッセージ */
export function toButtonInteraction(
  source: InteractionSource & { customId: string; message: { id: string } },
): Interaction {
  return { ...interactionBase(source), kind: "button", customId: source.customId, messageId: source.message.id };
}

/** message はセレクトが付いていたメッセージ */
export function toSelectInteraction(
  source: InteractionSource & { customId: string; values: readonly string[]; message: { id: string } },
): Interaction {
  return {
    ...interactionBase(source),
    kind: "select",
    customId: source.customId,
    values: [...source.values],
    messageId: source.message.id,
  };
}

/** モーダル送信。テキスト入力の値だけを customId → 入力値で取り出す */
export function toModalInteraction(
  source: InteractionSource & {
    customId: string;
    fields: { fields: Iterable<readonly [string, { type: number; value?: unknown }]> };
  },
): Interaction {
  const fields: Record<string, string> = {};
  for (const [customId, field] of source.fields.fields) {
    if (field.type === COMPONENT_TYPE.textInput && typeof field.value === "string") fields[customId] = field.value;
  }
  return { ...interactionBase(source), kind: "modal", customId: source.customId, fields };
}

export function toComponents(rows: readonly ComponentRow[]): ActionRowData<MessageActionRowComponentData>[] {
  return rows.map((row) => ({
    type: COMPONENT_TYPE.actionRow,
    components:
      row.kind === "buttons"
        ? row.buttons.map((button) => ({
            type: COMPONENT_TYPE.button,
            customId: button.customId,
            label: button.label,
            style: BUTTON_STYLE[button.style ?? "secondary"],
            disabled: button.disabled ?? false,
          }))
        : [
            {
              type: COMPONENT_TYPE.stringSelect,
              customId: row.select.customId,
              placeholder: row.select.placeholder,
              minValues: row.select.minValues,
              maxValues: row.select.maxValues,
              options: row.select.options,
            },
          ],
  }));
}

/**
 * reply / followUp / editReply / update 共通の本文。components を省略したら送らない（update では元のまま残る）。
 * mentionUserId があれば本文の先頭にメンションを付け、そのユーザーだけを鳴らす
 */
export function toPayload(message: OutgoingMessage) {
  const { mentionUserId } = message;
  return {
    content: mentionUserId === undefined ? message.text : `${mentionPrefix(mentionUserId)}${message.text}`,
    allowedMentions: allowedMentionsFor(mentionUserId),
    ...(message.components === undefined ? {} : { components: toComponents(message.components) }),
  };
}

/** テキスト入力は Label で包む（ActionRow で包む形は Discord 側で非推奨） */
export function toModal(modal: ModalDef): APIModalInteractionResponseCallbackData {
  return {
    custom_id: modal.customId,
    title: modal.title,
    components: modal.fields.map((field) => ({
      type: COMPONENT_TYPE.label,
      label: field.label,
      component: {
        type: COMPONENT_TYPE.textInput,
        custom_id: field.customId,
        style: field.style === "paragraph" ? TEXT_INPUT_STYLE.paragraph : TEXT_INPUT_STYLE.short,
        required: field.required ?? true,
        max_length: field.maxLength,
        placeholder: field.placeholder,
        value: field.value,
      },
    })),
  };
}

function toOptionData(option: CommandOptionDef): ApplicationCommandOptionData {
  const common = { name: option.name, description: option.description, required: option.required ?? false };
  switch (option.type) {
    case "string":
      return {
        ...common,
        type: COMMAND_OPTION_TYPE.string,
        minLength: option.minLength,
        maxLength: option.maxLength,
        ...(option.choices === undefined ? {} : { choices: option.choices }),
      };
    case "integer":
      return { ...common, type: COMMAND_OPTION_TYPE.integer, minValue: option.minValue, maxValue: option.maxValue };
    case "boolean":
      return { ...common, type: COMMAND_OPTION_TYPE.boolean };
  }
}

export function toCommandData(def: CommandDef): ChatInputApplicationCommandData {
  if (def.subcommands !== undefined) {
    const options = def.subcommands.map(
      (subcommand): ApplicationCommandOptionData => ({
        type: COMMAND_OPTION_TYPE.subcommand,
        name: subcommand.name,
        description: subcommand.description,
        options: (subcommand.options ?? []).map(toOptionData) as ApplicationCommandSubCommandData["options"],
      }),
    );
    return { name: def.name, description: def.description, options };
  }
  return { name: def.name, description: def.description, options: (def.options ?? []).map(toOptionData) };
}
