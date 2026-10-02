// discord.js との間の変換のうち、discord.js のクラスを使わないもの（テストで JSON の期待値と比べる）。
// discord.js は型だけ import する（実行時には読み込まない）。そのため enum の代わりに Discord API の数値を使い、型で合っているかを確かめる
import type {
  ActionRowData,
  APIModalInteractionResponseCallbackData,
  ApplicationCommandOptionData,
  ChatInputApplicationCommandData,
  MessageActionRowComponentData,
  MessageMentionOptions,
} from "discord.js";
import type { CommandDef, ComponentRow, Interaction, ModalDef, OutgoingMessage } from "./gateway.ts";

const COMPONENT_TYPE = { actionRow: 1, button: 2, stringSelect: 3, textInput: 4, label: 18 } as const;
const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 } as const;
const TEXT_INPUT_STYLE = { short: 1, paragraph: 2 } as const;
const COMMAND_OPTION_TYPE = { string: 3, integer: 4, boolean: 5 } as const;

// @everyone・ロール・他ユーザーへの通知は出さない（返信先への通知だけ残す）
export const ALLOWED_MENTIONS: MessageMentionOptions = { parse: [], repliedUser: true };

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

/** スラッシュコマンド。値の無いオプション（サブコマンド等）は入れない */
export function toCommandInteraction(
  source: InteractionSource & {
    commandName: string;
    options: { data: ReadonlyArray<{ name: string; value?: string | number | boolean }> };
  },
): Interaction {
  const options: Record<string, string | number | boolean> = {};
  for (const option of source.options.data) {
    if (option.value !== undefined) options[option.name] = option.value;
  }
  return { ...interactionBase(source), kind: "command", name: source.commandName, options };
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

/** reply / followUp / editReply / update 共通の本文。components を省略したら送らない（update では元のまま残る） */
export function toPayload(message: OutgoingMessage) {
  return {
    content: message.text,
    allowedMentions: ALLOWED_MENTIONS,
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

export function toCommandData(def: CommandDef): ChatInputApplicationCommandData {
  const options = (def.options ?? []).map((option): ApplicationCommandOptionData => {
    const common = { name: option.name, description: option.description, required: option.required ?? false };
    switch (option.type) {
      case "string":
        return {
          ...common,
          type: COMMAND_OPTION_TYPE.string,
          minLength: option.minLength,
          maxLength: option.maxLength,
        };
      case "integer":
        return { ...common, type: COMMAND_OPTION_TYPE.integer };
      case "boolean":
        return { ...common, type: COMMAND_OPTION_TYPE.boolean };
    }
  });
  return { name: def.name, description: def.description, options };
}
