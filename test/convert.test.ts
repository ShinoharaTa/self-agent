import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toButtonInteraction,
  toCommandData,
  toCommandInteraction,
  toComponents,
  toModal,
  toModalInteraction,
  toPayload,
  toSelectInteraction,
} from "../src/discord/convert.ts";

const NOW = new Date("2026-10-02T00:12:00Z");

/** discord.js の interaction のうち、変換が読む部分 */
const SOURCE = { guildId: "guild-1", channelId: "channel-1", user: { id: "owner-1" }, createdAt: NOW };
const BASE = { guildId: "guild-1", channelId: "channel-1", userId: "owner-1", createdAt: NOW };

/** Discord に送る形（undefined のキーは送られない） */
function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("toCommandInteraction: コマンド名と値のあるオプションだけを取り出す", () => {
  const interaction = toCommandInteraction({
    ...SOURCE,
    commandName: "new",
    options: {
      data: [
        { name: "title", value: "旅行の計画" },
        { name: "count", value: 3 },
        { name: "public", value: false },
        // サブコマンドなど値の無いもの
        { name: "group" },
      ],
    },
  });
  assert.deepEqual(interaction, {
    ...BASE,
    kind: "command",
    name: "new",
    options: { title: "旅行の計画", count: 3, public: false },
  });
});

test("toCommandInteraction: DM（guildId が null）もそのまま渡す", () => {
  const interaction = toCommandInteraction({ ...SOURCE, guildId: null, channelId: null, commandName: "help", options: { data: [] } });
  assert.deepEqual(interaction, { ...BASE, guildId: null, channelId: null, kind: "command", name: "help", options: {} });
});

test("toButtonInteraction・toSelectInteraction: custom_id と選んだ値（配列は写す）、付いていたメッセージの ID", () => {
  assert.deepEqual(toButtonInteraction({ ...SOURCE, customId: "close:all:topic-1", message: { id: "message-1" } }), {
    ...BASE,
    kind: "button",
    customId: "close:all:topic-1",
    messageId: "message-1",
  });

  const values = ["1", "3"];
  const select = toSelectInteraction({ ...SOURCE, customId: "close:sel:topic-1", values, message: { id: "message-2" } });
  assert.deepEqual(select, {
    ...BASE,
    kind: "select",
    customId: "close:sel:topic-1",
    values: ["1", "3"],
    messageId: "message-2",
  });
  assert.ok(select.kind === "select");
  assert.notEqual(select.values, values);
});

test("toModalInteraction: テキスト入力（type 4）の値だけを customId → 値で取り出す", () => {
  const interaction = toModalInteraction({
    ...SOURCE,
    customId: "edit:title:topic-1",
    fields: {
      fields: new Map<string, { type: number; value?: unknown; values?: string[] }>([
        ["title", { type: 4, value: "新しい題名" }],
        ["memo", { type: 4, value: "" }],
        // セレクト（type 3）とチェックボックス（type 23）は入れない
        ["kind", { type: 3, values: ["a"] }],
        ["agree", { type: 23, value: true }],
      ]),
    },
  });
  assert.deepEqual(interaction, {
    ...BASE,
    kind: "modal",
    customId: "edit:title:topic-1",
    fields: { title: "新しい題名", memo: "" },
  });
});

test("toComponents: ボタンの行（style の既定は secondary、disabled の既定は false）とセレクトの行", () => {
  const rows = toComponents([
    {
      kind: "buttons",
      buttons: [
        { customId: "close:all:topic-1", label: "すべて登録", style: "primary" },
        { customId: "close:pick:topic-1", label: "選んで登録" },
        { customId: "close:none:topic-1", label: "登録しない", style: "danger", disabled: true },
        { customId: "x:ok", label: "OK", style: "success" },
      ],
    },
    {
      kind: "select",
      select: {
        customId: "close:sel:topic-1",
        placeholder: "登録するものを選ぶ",
        minValues: 0,
        maxValues: 2,
        options: [
          { label: "買い物", value: "0" },
          { label: "予約", value: "1", description: "金曜まで" },
        ],
      },
    },
  ]);
  assert.deepEqual(json(rows), [
    {
      type: 1,
      components: [
        { type: 2, customId: "close:all:topic-1", label: "すべて登録", style: 1, disabled: false },
        { type: 2, customId: "close:pick:topic-1", label: "選んで登録", style: 2, disabled: false },
        { type: 2, customId: "close:none:topic-1", label: "登録しない", style: 4, disabled: true },
        { type: 2, customId: "x:ok", label: "OK", style: 3, disabled: false },
      ],
    },
    {
      type: 1,
      components: [
        {
          type: 3,
          customId: "close:sel:topic-1",
          placeholder: "登録するものを選ぶ",
          minValues: 0,
          maxValues: 2,
          options: [
            { label: "買い物", value: "0" },
            { label: "予約", value: "1", description: "金曜まで" },
          ],
        },
      ],
    },
  ]);
});

test("toPayload: 通知は返信先だけ。components を省略したらキーごと送らず、[] なら取り除く", () => {
  assert.deepEqual(json(toPayload({ text: "了解" })), {
    content: "了解",
    allowedMentions: { parse: [], repliedUser: true },
  });
  assert.equal("components" in toPayload({ text: "了解" }), false);
  assert.deepEqual(json(toPayload({ text: "閉じました", components: [], ephemeral: true })), {
    content: "閉じました",
    allowedMentions: { parse: [], repliedUser: true },
    components: [],
  });
  assert.deepEqual(json(toPayload({ text: "x", components: [{ kind: "buttons", buttons: [{ customId: "a:b", label: "B" }] }] })), {
    content: "x",
    allowedMentions: { parse: [], repliedUser: true },
    components: [{ type: 1, components: [{ type: 2, customId: "a:b", label: "B", style: 2, disabled: false }] }],
  });
});

test("toModal: テキスト入力は Label（type 18）で包む。style の既定は short、required の既定は true", () => {
  const modal = toModal({
    customId: "edit:title:topic-1",
    title: "題名を変える",
    fields: [
      { customId: "title", label: "題名", maxLength: 100, value: "旅行の計画" },
      { customId: "memo", label: "メモ", style: "paragraph", required: false, placeholder: "任意" },
    ],
  });
  assert.deepEqual(json(modal), {
    custom_id: "edit:title:topic-1",
    title: "題名を変える",
    components: [
      {
        type: 18,
        label: "題名",
        component: { type: 4, custom_id: "title", style: 1, required: true, max_length: 100, value: "旅行の計画" },
      },
      {
        type: 18,
        label: "メモ",
        component: { type: 4, custom_id: "memo", style: 2, required: false, placeholder: "任意" },
      },
    ],
  });
});

test("toCommandData: オプションの型（string 3・integer 4・boolean 5）と、required の既定は false", () => {
  const data = toCommandData({
    name: "new",
    description: "セッション用のチャンネルを作ります",
    options: [
      { type: "string", name: "title", description: "題名", required: true, minLength: 1, maxLength: 100 },
      { type: "integer", name: "count", description: "件数" },
      { type: "boolean", name: "public", description: "公開", required: false },
    ],
  });
  assert.deepEqual(json(data), {
    name: "new",
    description: "セッション用のチャンネルを作ります",
    options: [
      { name: "title", description: "題名", required: true, type: 3, minLength: 1, maxLength: 100 },
      { name: "count", description: "件数", required: false, type: 4 },
      { name: "public", description: "公開", required: false, type: 5 },
    ],
  });
  assert.deepEqual(json(toCommandData({ name: "help", description: "使い方" })), {
    name: "help",
    description: "使い方",
    options: [],
  });
});
