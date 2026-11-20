import { test } from "node:test";
import assert from "node:assert/strict";
import type { CcCloseResult, CcOpenResult, CcPickItem, CcResumeResult } from "../src/cc/channels.ts";
import type { CcChannelOrigin } from "../src/store/cc-channels.ts";
import {
  CC_CANCEL_NONE_REPLY,
  CC_CANCEL_NOT_CHANNEL_REPLY,
  CC_NO_SESSIONS_REPLY,
  CC_NOT_SET_UP_REPLY,
  CC_UNAVAILABLE_REPLY,
  createCcCommand,
  createCcComponent,
  openResultReply,
} from "../src/app/commands/cc.ts";
import { type CommandDeps, createCommands, createInteractionHandler } from "../src/app/interactions.ts";
import type { Interaction } from "../src/discord/gateway.ts";
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
  assert.deepEqual(withCc.at(-1)?.def.subcommands?.map((sub) => sub.name), ["open", "cancel", "close"]);
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

test("cc:q: origin sdk の質問も pick → 次の問 → 最後の問で answerQuestion まで通り、answered は Claude Code のチャンネルを作らない", async (t) => {
  const { createPermissionPoster, questionPlacesByOrigin } = await import("../src/agent/permission-bridge.ts");
  const { ccPermissionAnsweredHandler } = await import("../src/cc/channels.ts");
  const { CcPermissionHold } = await import("../src/cc/permission-hold.ts");
  const { CcQuestionFlow } = await import("../src/cc/question-flow.ts");
  const { CcPermissionStore } = await import("../src/store/cc-permissions.ts");
  const { createStores, tempDb } = await import("./helpers/db.ts");
  const db = tempDb(t);
  const now = () => NOW;
  const stores = createStores(db, now);
  stores.topicSessions.create({ channelId: "channel-1", guildId: "guild-1", title: "作業", categoryId: "cat-1" });
  stores.topicSessions.setProject("channel-1", "alpha", "default");
  const permissions = new CcPermissionStore(db, now);
  const hold = new CcPermissionHold({
    cfg: { ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 },
    store: permissions,
    known: () => false,
    now,
    timers: { after: () => () => undefined },
    log: () => {},
  });
  const gateway = new FakeGateway({ allow: ["sendMessage", "editMessage"] });
  const poster = createPermissionPoster({
    gateway,
    permissions,
    topicSessions: stores.topicSessions,
    cfg: { ownerUserId: "owner-1", workspaceDir: "/w" },
    home: "/h",
    holdSec: 300,
    questionHoldSec: 900,
    log: () => {},
  });
  const input = {
    questions: [
      { question: "どちらにしますか", header: "案", options: [{ label: "A 案" }, { label: "B 案" }], multiSelect: false },
      { question: "いつにしますか", header: "日", options: [{ label: "今日" }, { label: "明日" }], multiSelect: false },
    ],
  };
  const row = permissions.add({
    sessionId: S1,
    requestHash: "h",
    toolName: "AskUserQuestion",
    summary: "質問 2 問: どちらにしますか",
    permissionMode: "default",
    state: "pending",
    origin: "sdk",
    questionInput: JSON.stringify(input),
  });
  const closing = hold.holdExternal(row, 900_000);
  await poster.post({ guildId: "guild-1", channelId: "channel-1", kind: "session" }, row);
  const ensured: string[] = [];
  const places = questionPlacesByOrigin({
    permissions,
    sdk: poster,
    hook: {
      pendingQuestion: () => assert.fail("hook の口は使わない"),
      questionStepMessage: () => assert.fail("hook の口は使わない"),
    },
  });
  const answeredHandler = ccPermissionAnsweredHandler({
    permissions,
    channels: () => ({ ensureFor: async (sessionId: string) => void ensured.push(sessionId) }) as never,
    log: () => {},
  });
  // 途中の答えはプロセスの中に 1 つ（main と同じ）
  const flow = new CcQuestionFlow();
  const component = createCcComponent({
    ccPermissionButtons: () => ({
      answer: (id, decision) => hold.answer(id, decision, "discord"),
      resolvedMessage: (id) => poster.resolvedMessage(id),
      // main と同じく guildId の null は undefined に
      answered: (id, guildId) => answeredHandler(id, guildId ?? undefined),
      questions: {
        flow,
        pendingQuestion: places.pendingQuestion,
        answerQuestion: (id, requestHash, picks) => hold.answerQuestion(id, requestHash, picks, "discord"),
        stepMessage: places.stepMessage,
      },
    }),
    gateway,
    log: () => {},
  });
  const press = (customId: string): Extract<Interaction, { kind: "button" }> => ({
    kind: "button",
    customId,
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "owner-1",
    createdAt: NOW,
  });
  const first = new FakeResponder();
  await component.handle(press(`cc:q:pick:${row.id}:0:1`), first);
  assert.equal(first.calls.length, 1);
  const step = first.calls[0]!;
  assert.ok(step.method === "update" && step.message.text.includes("答え済み:\n1. 「案」B 案") && step.message.text.includes("質問 2/2「日」"));
  assert.ok(step.method === "update" && !step.message.text.includes("端末"), step.method === "update" ? step.message.text : "");
  assert.equal(permissions.get(row.id)?.state, "pending");
  const last = new FakeResponder();
  await component.handle(press(`cc:q:pick:${row.id}:1:0`), last);
  const final = await closing;
  assert.equal(final.state, "allowed");
  assert.equal(final.via, "discord");
  assert.deepEqual(final.answers, { どちらにしますか: "B 案", いつにしますか: "今日" });
  const done = last.calls[0]!;
  assert.ok(done.method === "update" && done.message.text.endsWith("答えました（Discord）:\n1. 「案」B 案\n2. 「日」今日"), JSON.stringify(done));
  assert.deepEqual(ensured, []);
});
