import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { CcCloseResult, CcOpenResult, CcPickItem, CcResumeResult } from "../src/cc/channels.ts";
import type { CcChannelOrigin } from "../src/store/cc-channels.ts";
import {
  CC_TAKE_CANCELLED_TEXT,
  CC_TAKE_NONE_REPLY,
  CC_TAKE_POST_FAILED_REPLY,
  CC_TAKE_POSTED_REPLY,
  CC_TAKE_STALE_REPLY,
  type CcTakeoverGetter,
  CC_CANCEL_NONE_REPLY,
  CC_CANCEL_NOT_CHANNEL_REPLY,
  CC_NO_SESSIONS_REPLY,
  CC_NOT_SET_UP_REPLY,
  CC_UNAVAILABLE_REPLY,
  createCcCommand,
  createCcComponent,
  openResultReply,
} from "../src/app/commands/cc.ts";
import { type CommandDeps, createCommands, createInteractionHandler, OWNER_ONLY_REPLY } from "../src/app/interactions.ts";
import type { CcTakeoverConfirmResult, CcTakeoverProposeResult } from "../src/cc/takeover.ts";
import { takeoverButtons } from "../src/cc/takeover.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import { CcTakeoverStore } from "../src/store/cc-takeovers.ts";
import { tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { FakeResponder } from "./helpers/responder.ts";

const NOW = new Date("2026-11-05T00:00:00Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

const OPEN: Extract<Interaction, { kind: "command" }> = {
  kind: "command",
  name: "cc",
  subcommand: "open",
  options: {},
  guildId: "guild-1",
  channelId: "channel-1",
  userId: "owner-1",
  createdAt: NOW,
};

function pick(values: string[]): Extract<Interaction, { kind: "select" }> {
  return { kind: "select", customId: "cc:pick", values, guildId: "guild-1", channelId: "channel-1", userId: "owner-1", createdAt: NOW };
}

/** openChannel の呼び出しを記録し、決めた結果を返す偽の CcChannels */
function fakeChannels(items: CcPickItem[], result: CcOpenResult, cancelled: Record<string, number> = {}) {
  const opened: Array<{ guildId: string; sessionId: string; origin: CcChannelOrigin }> = [];
  return {
    opened,
    channels: {
      pickItems: () => items,
      cancelQueued: (channelId: string): number | undefined => cancelled[channelId],
      openChannel: async (guildId: string, sessionId: string, origin: CcChannelOrigin) => {
        opened.push({ guildId, sessionId, origin });
        return result;
      },
      close: (): CcCloseResult => ({ result: "not_channel" }),
      resume: async (): Promise<CcResumeResult> => ({ ok: false, reason: "stale" }),
      keepEnded: (): boolean => false,
      takePending: () => ({ ok: false as const, reason: "gone" as const }),
    },
  };
}

const ITEMS: CcPickItem[] = [
  { sessionId: S1, label: "alpha\nsession", state: "needs_input", dir: "alpha", hasChannel: false },
  { sessionId: S2, label: "x".repeat(150), state: "idle", dir: null, hasChannel: true },
];

test("/cc は ccChannels を渡したとき（SELF_AGENT_CC=1）だけ登録し、サブコマンドは open", () => {
  const without = createCommands({} as CommandDeps).map((handler) => handler.def.name);
  assert.equal(without.includes("cc"), false);
  const withCc = createCommands({ ccChannels: () => undefined, log: () => {} } as unknown as CommandDeps);
  assert.equal(withCc.at(-1)?.def.name, "cc");
  assert.deepEqual(withCc.at(-1)?.def.subcommands?.map((sub) => sub.name), ["open", "cancel", "close", "take"]);
  assert.equal(withCc.length, without.length + 1);
});

test("/cc open: 一覧のセレクト（cc:pick・25 件まで・名前とディレクトリとチャンネルの有無）を本人にだけ出す。連携が無い・/setup 前・0 件は断る", async () => {
  const { channels } = fakeChannels(ITEMS, { ok: false, reason: "failed" });
  let categoryId: string | null = "cat-cc";
  let current: typeof channels | undefined = channels;
  const command = createCcCommand({
    ccChannels: () => current,
    guildSettings: { ccCategoryId: () => categoryId },
    log: () => {},
  });
  const responder = new FakeResponder();
  await command.handle(OPEN, responder);
  assert.equal(responder.calls.length, 1);
  const reply = responder.replies[0]!;
  assert.equal(reply.ephemeral, true);
  const row = reply.components?.[0];
  assert.ok(row?.kind === "select");
  assert.equal(row.select.customId, "cc:pick");
  assert.deepEqual(
    row.select.options.map((option) => [option.value, option.label.length <= 100, option.description]),
    [
      [S1, true, "判断待ち・alpha"],
      [S2, true, "待機・チャンネルあり"],
    ],
  );
  assert.equal(row.select.options[0]!.label, "alpha session");

  categoryId = null;
  const notSetUp = new FakeResponder();
  await command.handle(OPEN, notSetUp);
  assert.deepEqual(notSetUp.replies, [{ text: CC_NOT_SET_UP_REPLY, ephemeral: true }]);

  categoryId = "cat-cc";
  current = { ...channels, pickItems: () => [] };
  const none = new FakeResponder();
  await command.handle(OPEN, none);
  assert.deepEqual(none.replies, [{ text: CC_NO_SESSIONS_REPLY, ephemeral: true }]);

  current = undefined;
  const unavailable = new FakeResponder();
  await command.handle(OPEN, unavailable);
  assert.deepEqual(unavailable.replies, [{ text: CC_UNAVAILABLE_REPLY, ephemeral: true }]);
});

test("cc:pick: 保留してから選んだセッションのチャンネルを origin command で作り、結果を本人にだけ返す", async () => {
  const { channels, opened } = fakeChannels(ITEMS, { ok: true, channelId: "chan-1", guildId: "guild-1" });
  const component = createCcComponent({ ccChannels: () => channels, gateway: new FakeGateway(), log: () => {} });
  const responder = new FakeResponder();
  await component.handle(pick([S1]), responder);
  assert.deepEqual(opened, [{ guildId: "guild-1", sessionId: S1, origin: "command" }]);
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: "チャンネルを作りました: <#chan-1>", ephemeral: true } },
  ]);
  // UUID でない値は例外（振り分けが「処理に失敗しました」にする）
  await assert.rejects(component.handle(pick(["../x"]), new FakeResponder()));
  // 連携が動いていなければ断る
  const off = createCcComponent({ ccChannels: () => undefined, gateway: new FakeGateway(), log: () => {} });
  const offResponder = new FakeResponder();
  await off.handle(pick([S1]), offResponder);
  assert.deepEqual(offResponder.replies, [{ text: CC_UNAVAILABLE_REPLY, ephemeral: true }]);
});

test("openResultReply: 結果ごとの応答", () => {
  assert.equal(openResultReply({ ok: false, reason: "exists", channelId: "chan-1", guildId: "g" }), "このセッションのチャンネルは既にあります: <#chan-1>");
  assert.match(openResultReply({ ok: false, reason: "not_in_tmux" }), /tmux の外/);
  assert.match(openResultReply({ ok: false, reason: "not_set_up" }), /\/setup/);
  assert.match(openResultReply({ ok: false, reason: "full" }), /満杯/);
  assert.match(openResultReply({ ok: false, reason: "not_found" }), /一覧にありません/);
  assert.match(openResultReply({ ok: false, reason: "failed" }), /作れませんでした/);
});

test("/cc cancel: Claude Code のチャンネルの中ならそのセッションの届け待ちをやめて件数を本人にだけ返す。0 件・チャンネルの外は断る", async () => {
  const { channels } = fakeChannels(ITEMS, { ok: false, reason: "failed" }, { "cc-chan": 2, "cc-empty": 0 });
  const command = createCcCommand({ ccChannels: () => channels, guildSettings: { ccCategoryId: () => "cat-cc" }, log: () => {} });
  const replies: string[] = [];
  for (const channelId of ["cc-chan", "cc-empty", "channel-1"]) {
    const responder = new FakeResponder();
    await command.handle({ ...OPEN, subcommand: "cancel", channelId }, responder);
    assert.equal(responder.replies.length, 1);
    assert.equal(responder.replies[0]!.ephemeral, true);
    replies.push(responder.replies[0]!.text);
  }
  assert.deepEqual(replies, ["届け待ちの 2 件を送るのをやめました", CC_CANCEL_NONE_REPLY, CC_CANCEL_NOT_CHANNEL_REPLY]);
});

test("cc:perm（CC11）: 答えたら押したサーバーで answered を呼ぶ（チャンネルを作る）。古い押下では呼ばない", async () => {
  const answered: Array<[number, string | null]> = [];
  let ok = true;
  const component = createCcComponent({
    ccPermissionButtons: () => ({
      answer: () => (ok ? { ok: true, state: "allowed" } : { ok: false, reason: "stale" }),
      resolvedMessage: () => undefined,
      answered: (id, guildId) => void answered.push([id, guildId]),
    }),
    gateway: new FakeGateway(),
    log: () => {},
  });
  const press = (): Extract<Interaction, { kind: "button" }> => ({
    kind: "button",
    customId: "cc:perm:allow:7",
    guildId: "guild-1",
    channelId: "system-1",
    userId: "owner-1",
    createdAt: new Date(0),
  });
  await component.handle(press(), new FakeResponder());
  assert.deepEqual(answered, [[7, "guild-1"]]);
  ok = false;
  await component.handle(press(), new FakeResponder());
  assert.deepEqual(answered, [[7, "guild-1"]]);
});

test("cc:q:*（Q2）: モーダルの送信・セレクトも名前空間 cc で cc のハンドラに届く。ボタンの口が無ければ本人にだけ古い", async () => {
  const handle = createInteractionHandler({
    cfg: { allowedGuildIds: ["guild-1"], ownerUserId: "owner-1" },
    commands: [],
    components: [createCcComponent({ gateway: new FakeGateway(), log: () => {} })],
    log: () => {},
  });
  const base = { guildId: "guild-1", channelId: "channel-1", userId: "owner-1", createdAt: NOW };
  for (const interaction of [
    { ...base, kind: "modal", customId: "cc:q:text:1:0", fields: { text: "x" } },
    { ...base, kind: "select", customId: "cc:q:sel:1:0", values: ["0"] },
    { ...base, kind: "button", customId: "cc:q:drop:1" },
  ] as Interaction[]) {
    const responder = new FakeResponder();
    await handle(interaction, responder);
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: "この操作は古くなっています", ephemeral: true } }], interaction.kind);
  }
});

/** 取り込みの偽の口: 行は本物のストア、propose・confirm・cancel は呼び出しを記録する（cancel はストアの行も cancelled にする） */
function fakeTakeover(t: TestContext) {
  const takeovers = new CcTakeoverStore(tempDb(t), () => NOW);
  const gateway = new FakeGateway({ allow: ["sendMessage"], messageIdPrefix: "msg-" });
  const calls: string[] = [];
  let proposeResult: CcTakeoverProposeResult = { ok: false, reason: "not_channel", text: "チャンネルでない" };
  let takeable: string[] = [];
  let confirmResult: CcTakeoverConfirmResult = { ok: true, text: "取り込みました", plainText: "取り込みました", edited: true };
  const runtime = {
    takeover: {
      propose: async (input: { channelId: string; entry: string }): Promise<CcTakeoverProposeResult> => {
        calls.push(`propose:${input.channelId}:${input.entry}`);
        return proposeResult;
      },
      confirm: async (id: number): Promise<CcTakeoverConfirmResult> => {
        calls.push(`confirm:${id}`);
        return confirmResult;
      },
      cancel: (id: number): boolean => {
        calls.push(`cancel:${id}`);
        return takeovers.cancel(id);
      },
      takeableSessions: async (candidates: () => readonly string[]): Promise<string[]> => {
        calls.push("tick");
        const sessionIds = candidates();
        calls.push(`takeable:${sessionIds.length}`);
        return sessionIds.filter((id) => takeable.includes(id));
      },
    },
    takeovers,
    gateway,
    ownerUserId: "owner-1" as string | undefined,
  };
  /** 確認待ちの行を作る（チャンネルは cc-chan） */
  const row = (sessionId = S1) =>
    takeovers.propose({
      sessionId,
      source: "alive",
      project: "alpha",
      guildId: "guild-1",
      channelId: "cc-chan",
      entry: "discord",
      permissionMode: "default",
    })!;
  return {
    takeovers,
    gateway,
    calls,
    runtime,
    getter: (() => runtime) as CcTakeoverGetter,
    row,
    setPropose: (result: CcTakeoverProposeResult) => {
      proposeResult = result;
    },
    setConfirm: (result: CcTakeoverConfirmResult) => {
      confirmResult = result;
    },
    setTakeable: (ids: string[]) => {
      takeable = ids;
    },
  };
}

const TAKE: Extract<Interaction, { kind: "command" }> = { ...OPEN, subcommand: "take", channelId: "cc-chan" };

function takeButton(action: "go" | "no", id: number, over: Partial<Extract<Interaction, { kind: "button" }>> = {}): Extract<Interaction, { kind: "button" }> {
  return { kind: "button", customId: `cc:take:${action}:${id}`, guildId: "guild-1", channelId: "cc-chan", userId: "owner-1", createdAt: NOW, ...over };
}

test("/cc take: 連携が無ければ他のサブコマンドと同じ文。断られたら propose の文を本人にだけ返し、何も出さない", async (t) => {
  const f = fakeTakeover(t);
  const { channels } = fakeChannels(ITEMS, { ok: false, reason: "failed" });
  const off = createCcCommand({ ccChannels: () => channels, guildSettings: { ccCategoryId: () => "cat-cc" }, ccTakeover: () => undefined, log: () => {} });
  const offResponder = new FakeResponder();
  await off.handle(TAKE, offResponder);
  assert.deepEqual(offResponder.calls, [{ method: "reply", message: { text: CC_UNAVAILABLE_REPLY, ephemeral: true } }]);

  const command = createCcCommand({ ccChannels: () => channels, guildSettings: { ccCategoryId: () => "cat-cc" }, ccTakeover: f.getter, log: () => {} });
  f.setPropose({ ok: false, reason: "in_progress", text: "断りの文" });
  const refused = new FakeResponder();
  await command.handle(TAKE, refused);
  assert.deepEqual(refused.replies, [{ text: "断りの文", ephemeral: true }]);
  assert.deepEqual(f.calls, ["propose:cc-chan:discord"]);
  assert.equal(f.gateway.posts.length, 0);
});

test("/cc take（チャンネルの外。T4）: 取り込めるセッションだけの cc:takepick を本人にだけ出す。候補なし・/setup 前・連携なしは断る", async (t) => {
  const f = fakeTakeover(t);
  const { channels } = fakeChannels(ITEMS, { ok: false, reason: "failed" });
  let categoryId: string | null = "cat-cc";
  let current: typeof channels | undefined = channels;
  const command = createCcCommand({ ccChannels: () => current, guildSettings: { ccCategoryId: () => categoryId }, ccTakeover: f.getter, log: () => {} });
  const outside = { ...TAKE, channelId: "channel-1" };
  f.setTakeable([S2]);
  const responder = new FakeResponder();
  await command.handle(outside, responder);
  assert.equal(responder.calls[0]?.method, "defer");
  const reply = responder.replies[0]!;
  assert.equal(reply.ephemeral, true);
  const row = reply.components?.[0];
  assert.ok(row?.kind === "select");
  assert.equal(row.select.customId, "cc:takepick");
  assert.deepEqual(row.select.options.map((option) => [option.value, option.description]), [[S2, "待機・チャンネルあり"]]);
  // 一覧を読み直して（tick）から候補を取る
  assert.deepEqual(f.calls, ["propose:channel-1:discord", "tick", "takeable:2"]);

  f.setTakeable([]);
  const none = new FakeResponder();
  await command.handle(outside, none);
  assert.deepEqual(none.replies, [{ text: CC_TAKE_NONE_REPLY, ephemeral: true }]);

  categoryId = null;
  const notSetUp = new FakeResponder();
  await command.handle(outside, notSetUp);
  assert.deepEqual(notSetUp.replies, [{ text: CC_NOT_SET_UP_REPLY, ephemeral: true }]);

  categoryId = "cat-cc";
  current = undefined;
  const unavailable = new FakeResponder();
  await command.handle(outside, unavailable);
  assert.deepEqual(unavailable.replies, [{ text: CC_UNAVAILABLE_REPLY, ephemeral: true }]);
  assert.equal(f.gateway.posts.length, 0);
});

function takePick(sessionId: string): Extract<Interaction, { kind: "select" }> {
  return { ...pick([sessionId]), customId: "cc:takepick" };
}

test("cc:takepick（T4）: 選んだセッションのチャンネルを作り（既にあればそれ）、そこに確認を出す。作れない・断られた・投稿の失敗（cancel）はその文", async (t) => {
  const f = fakeTakeover(t);
  let result: CcOpenResult = { ok: true, channelId: "cc-chan", guildId: "guild-1" };
  const { channels, opened } = fakeChannels(ITEMS, result);
  const current = { ...channels, openChannel: async (guildId: string, sessionId: string, origin: CcChannelOrigin) => (opened.push({ guildId, sessionId, origin }), result) };
  const logs: string[] = [];
  const component = createCcComponent({ ccChannels: () => current, ccTakeover: f.getter, gateway: f.gateway, log: (line) => void logs.push(line) });
  const first = f.row();
  const message = { text: "確認の文", components: takeoverButtons(first.id) };
  f.setPropose({ ok: true, id: first.id, message, plainText: message.text });
  const responder = new FakeResponder();
  await component.handle(takePick(S1), responder);
  assert.deepEqual(opened, [{ guildId: "guild-1", sessionId: S1, origin: "command" }]);
  assert.deepEqual(f.gateway.posts, [{ channelId: "cc-chan", messageId: "msg-1", message }]);
  assert.equal(f.takeovers.get(first.id)?.confirmMessageId, "msg-1");
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: "<#cc-chan> に取り込みの確認を出しました。", ephemeral: true } },
  ]);

  // 既にあればそのチャンネル
  result = { ok: false, reason: "exists", channelId: "cc-old", guildId: "guild-1" };
  f.setPropose({ ok: false, reason: "busy", text: "断りの文" });
  const refused = new FakeResponder();
  await component.handle(takePick(S1), refused);
  assert.deepEqual(refused.replies, [{ text: "断りの文", ephemeral: true }]);
  assert.equal(f.calls.at(-1), "propose:cc-old:discord");

  // 作れない
  result = { ok: false, reason: "not_in_tmux" };
  const failedOpen = new FakeResponder();
  const before = f.calls.length;
  await component.handle(takePick(S1), failedOpen);
  assert.deepEqual(failedOpen.replies, [{ text: openResultReply(result), ephemeral: true }]);
  assert.equal(f.calls.length, before);

  // 投稿に失敗: cancel
  result = { ok: true, channelId: "cc-chan", guildId: "guild-1" };
  const second = f.row(S2);
  f.setPropose({ ok: true, id: second.id, message: { text: "確認の文", components: takeoverButtons(second.id) }, plainText: "確認の文" });
  f.gateway.beforeSendMessage = () => {
    throw new Error("cc-chan に投稿できない");
  };
  const failedPost = new FakeResponder();
  await component.handle(takePick(S2), failedPost);
  assert.deepEqual(failedPost.replies, [{ text: CC_TAKE_POST_FAILED_REPLY, ephemeral: true }]);
  assert.equal(f.takeovers.get(second.id)?.state, "cancelled");
  for (const line of logs) assert.doesNotMatch(line, /cc-chan|投稿できない/, line);

  // UUID でない値は例外、連携が無ければ断る
  await assert.rejects(component.handle(takePick("../x"), new FakeResponder()));
  const off = createCcComponent({ ccChannels: () => current, ccTakeover: () => undefined, gateway: f.gateway, log: () => {} });
  const offResponder = new FakeResponder();
  await off.handle(takePick(S1), offResponder);
  assert.deepEqual(offResponder.replies, [{ text: CC_UNAVAILABLE_REPLY, ephemeral: true }]);
});

test("/cc take: 通ったら確認の文とボタンをそのチャンネルに出して setConfirmMessage。投稿に失敗したら cancel して本人にだけ断る", async (t) => {
  const f = fakeTakeover(t);
  const logs: string[] = [];
  const command = createCcCommand({ ccChannels: () => undefined, guildSettings: { ccCategoryId: () => "cat-cc" }, ccTakeover: f.getter, log: (line) => void logs.push(line) });
  const first = f.row();
  const message = { text: "確認の文", components: takeoverButtons(first.id) };
  f.setPropose({ ok: true, id: first.id, message, plainText: message.text });
  const responder = new FakeResponder();
  await command.handle(TAKE, responder);
  assert.deepEqual(f.gateway.posts, [{ channelId: "cc-chan", messageId: "msg-1", message }]);
  assert.equal(f.takeovers.get(first.id)?.confirmMessageId, "msg-1");
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: CC_TAKE_POSTED_REPLY, ephemeral: true } },
  ]);
  assert.deepEqual(
    takeoverButtons(first.id)[0],
    { kind: "buttons", buttons: [{ customId: `cc:take:go:${first.id}`, label: "取り込む", style: "primary" }, { customId: `cc:take:no:${first.id}`, label: "やめる" }] },
  );

  // 投稿に失敗: 確認待ちのまま残さない
  const second = f.row(S2);
  f.setPropose({ ok: true, id: second.id, message: { text: "確認の文", components: takeoverButtons(second.id) }, plainText: "確認の文" });
  f.gateway.beforeSendMessage = () => {
    throw new Error("cc-chan に投稿できない");
  };
  const failed = new FakeResponder();
  await command.handle(TAKE, failed);
  assert.deepEqual(failed.replies, [{ text: CC_TAKE_POST_FAILED_REPLY, ephemeral: true }]);
  assert.equal(f.takeovers.get(second.id)?.state, "cancelled");
  assert.equal(f.takeovers.get(second.id)?.confirmMessageId, null);
  assert.ok(f.calls.includes(`cancel:${second.id}`));
  for (const line of logs) assert.doesNotMatch(line, /cc-chan|投稿できない/, line);
});

test("cc:take: オーナー以外・別のチャンネル・確認待ちでない・連携が無いと本人にだけ「この確認はもう使えません。」で、何も呼ばない", async (t) => {
  const f = fakeTakeover(t);
  const component = createCcComponent({ ccTakeover: f.getter, gateway: new FakeGateway(), log: () => {} });
  const row = f.row();
  const stale = [{ method: "reply", message: { text: CC_TAKE_STALE_REPLY, ephemeral: true } }];
  for (const [label, interaction] of [
    ["オーナー以外", takeButton("go", row.id, { userId: "someone" })],
    ["別のチャンネル", takeButton("go", row.id, { channelId: "other-chan" })],
    ["無い行", takeButton("no", row.id + 1)],
  ] as const) {
    const responder = new FakeResponder();
    await component.handle(interaction, responder);
    assert.deepEqual(responder.calls, stale, label);
  }
  f.runtime.ownerUserId = undefined;
  const noOwner = new FakeResponder();
  await component.handle(takeButton("go", row.id), noOwner);
  assert.deepEqual(noOwner.calls, stale);
  f.runtime.ownerUserId = "owner-1";
  const off = createCcComponent({ ccTakeover: () => undefined, gateway: new FakeGateway(), log: () => {} });
  const offResponder = new FakeResponder();
  await off.handle(takeButton("go", row.id), offResponder);
  assert.deepEqual(offResponder.calls, stale);
  assert.deepEqual(f.calls, []);
  assert.equal(f.takeovers.get(row.id)?.state, "awaiting_confirm");

  // 確認待ちでない（やめた後）
  f.takeovers.cancel(row.id);
  for (const action of ["go", "no"] as const) {
    const responder = new FakeResponder();
    await component.handle(takeButton(action, row.id), responder);
    assert.deepEqual(responder.calls, stale, action);
  }
  assert.deepEqual(f.calls, []);
  await assert.rejects(component.handle(takeButton("go", 0), new FakeResponder()));
  await assert.rejects(component.handle({ ...takeButton("go", row.id), customId: "cc:take:yes:1" }, new FakeResponder()));
});

test("cc:take:go は先に保留してから confirm（結果の文は CcTakeover が出す。stale なら本人にだけ断る）。no は cancel して確認の文を書き換えボタンを外す", async (t) => {
  const f = fakeTakeover(t);
  const component = createCcComponent({ ccTakeover: f.getter, gateway: new FakeGateway(), log: () => {} });
  const row = f.row();
  const go = new FakeResponder();
  await component.handle(takeButton("go", row.id), go);
  assert.deepEqual(go.calls, [{ method: "deferUpdate" }]);
  assert.deepEqual(f.calls, [`confirm:${row.id}`]);

  f.setConfirm({ ok: false, reason: "stale" });
  const again = new FakeResponder();
  await component.handle(takeButton("go", row.id), again);
  assert.deepEqual(again.calls, [{ method: "deferUpdate" }, { method: "reply", message: { text: CC_TAKE_STALE_REPLY, ephemeral: true } }]);

  const no = new FakeResponder();
  await component.handle(takeButton("no", row.id), no);
  assert.deepEqual(no.calls, [{ method: "update", message: { text: CC_TAKE_CANCELLED_TEXT, components: [] } }]);
  assert.equal(f.takeovers.get(row.id)?.state, "cancelled");
  assert.deepEqual(f.calls, [`confirm:${row.id}`, `confirm:${row.id}`, `cancel:${row.id}`]);
});

test("cc:take・/cc take（T3b の受け入れ）: オーナー以外の操作は振り分けの前に断られ、propose・confirm・cancel も投稿も起こさない", async (t) => {
  const f = fakeTakeover(t);
  const row = f.row();
  f.setPropose({ ok: true, id: row.id, message: { text: "確認の文", components: takeoverButtons(row.id) }, plainText: "確認の文" });
  const handle = createInteractionHandler({
    cfg: { allowedGuildIds: ["guild-1"], ownerUserId: "owner-1" },
    commands: [createCcCommand({ ccChannels: () => undefined, guildSettings: { ccCategoryId: () => "cat-cc" }, ccTakeover: f.getter, log: () => {} })],
    components: [createCcComponent({ ccTakeover: f.getter, gateway: new FakeGateway(), log: () => {} })],
    log: () => {},
  });
  for (const interaction of [
    { ...TAKE, userId: "someone" },
    takeButton("go", row.id, { userId: "someone" }),
    takeButton("no", row.id, { userId: "someone" }),
  ] as Interaction[]) {
    const responder = new FakeResponder();
    await handle(interaction, responder);
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: OWNER_ONLY_REPLY, ephemeral: true } }], interaction.kind);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.gateway.posts.length, 0);
  assert.equal(f.takeovers.get(row.id)?.state, "awaiting_confirm");
});
