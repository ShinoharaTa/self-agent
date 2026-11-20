import { test, type TestContext } from "node:test";
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
import {
  CC_TAKE_CANCELLED_TEXT,
  CC_TAKE_POST_FAILED_REPLY,
  CC_TAKE_POSTED_REPLY,
  CC_TAKE_STALE_REPLY,
  type CcTakeRuntime,
  TAKE_PICK_MAX,
  takeNoneReply,
  takeOptions,
  takePickPrompt,
} from "../src/app/commands/cc-take.ts";
import { type CommandDeps, createCommands, createInteractionHandler, OWNER_ONLY_REPLY } from "../src/app/interactions.ts";
import { type CcTakeable, type CcTakeoverConfirmResult, type CcTakeoverProposeResult, takeoverButtons } from "../src/cc/takeover.ts";
import { type TakeoverFailure, takeoverFailureText } from "../src/cc/takeover-rules.ts";
import { CcTakeoverStore } from "../src/store/cc-takeovers.ts";
import { tempDb } from "./helpers/db.ts";
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

test("/cc は ccChannels を渡したとき（SELF_AGENT_CC=1）だけ登録し、サブコマンドは take・open・cancel・close", () => {
  const without = createCommands({} as CommandDeps).map((handler) => handler.def.name);
  assert.equal(without.includes("cc"), false);
  const withCc = createCommands({ ccChannels: () => undefined, log: () => {} } as unknown as CommandDeps);
  assert.equal(withCc.at(-1)?.def.name, "cc");
  assert.deepEqual(withCc.at(-1)?.def.subcommands?.map((sub) => sub.name), ["take", "open", "cancel", "close"]);
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

/** 取り込みの入口の偽の口: 行は本物のストア、takeable・propose・confirm・cancel は呼び出しを記録する（cancel はストアの行も cancelled にする） */
function fakeTake(t: TestContext) {
  const takeovers = new CcTakeoverStore(tempDb(t), () => NOW);
  const gateway = new FakeGateway({ allow: ["sendMessage"], messageIdPrefix: "msg-" });
  const calls: string[] = [];
  const proposals: unknown[] = [];
  const state = {
    ready: true,
    items: [] as CcTakeable[],
    counts: { running: 0, waiting: 0 },
    rc: undefined as string | undefined,
    propose: { ok: false, reason: "busy", text: takeoverFailureText("busy", false) } as CcTakeoverProposeResult,
    confirm: { ok: true, channelId: "dest-1", text: "取り込みました → <#dest-1>", plainText: "完了", edited: true } as CcTakeoverConfirmResult,
  };
  const runtime: CcTakeRuntime = {
    takeover: {
      takeable: async () => {
        calls.push("takeable");
        return state.items;
      },
      propose: async (input) => {
        calls.push("propose");
        proposals.push(input);
        return state.propose;
      },
      confirm: async (id) => {
        calls.push(`confirm:${id}`);
        return state.confirm;
      },
      cancel: (id) => {
        calls.push(`cancel:${id}`);
        return takeovers.cancel(id);
      },
    },
    takeovers,
    gateway,
    ready: () => state.ready,
    counts: () => {
      calls.push("counts");
      return state.counts;
    },
    rcUrl: () => state.rc,
    timeZone: "Asia/Tokyo",
  };
  /** 確認待ちの行（既定は Discord の入口・確認は channel-1） */
  const row = (sessionId = S1, over: { entry?: "discord" | "web"; guildId?: string } = {}) =>
    takeovers.propose({
      sessionId,
      source: "alive",
      project: "alpha",
      guildId: over.guildId ?? "guild-1",
      entry: over.entry ?? "discord",
      // Web の行は確認のチャンネルを持たない（DB の CHECK）
      ...(over.entry === "web" ? {} : { confirmChannelId: "channel-1" }),
      permissionMode: "default",
    })!;
  return { takeovers, gateway, calls, proposals, state, runtime, getter: () => runtime, row };
}

const TAKE: Extract<Interaction, { kind: "command" }> = { ...OPEN, subcommand: "take" };

function takePick(values: string[]): Extract<Interaction, { kind: "select" }> {
  return { ...pick(values), customId: "cc:takepick" };
}

function takeButton(action: "go" | "no", id: number, over: Partial<Extract<Interaction, { kind: "button" }>> = {}): Extract<Interaction, { kind: "button" }> {
  return { kind: "button", customId: `cc:take:${action}:${id}`, guildId: "guild-1", channelId: "channel-1", userId: "owner-1", createdAt: NOW, ...over };
}

function item(n: number, over: Partial<CcTakeable> = {}): CcTakeable {
  return { sessionId: `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`, title: `題名 ${n}`, project: "alpha", alive: true, at: NOW.getTime(), ...over };
}

/** log に session_id・チャンネル ID・例外の文を出していない */
function assertTakeLogs(logs: readonly string[]): void {
  for (const line of logs) assert.doesNotMatch(line, /1111|2222|channel-|guild-|dest-|投稿できない|書き換えられない/, line);
}

test("/cc take: 連携が無ければ他のサブコマンドと同じ文。ccChannels が無くても take は動く", async (t) => {
  const f = fakeTake(t);
  for (const ccTakeover of [() => undefined, undefined]) {
    const off = createCcCommand({
      ccChannels: () => undefined,
      guildSettings: { ccCategoryId: () => "cat-cc" },
      ...(ccTakeover === undefined ? {} : { ccTakeover }),
      log: () => {},
    });
    const responder = new FakeResponder();
    await off.handle(TAKE, responder);
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: CC_UNAVAILABLE_REPLY, ephemeral: true } }]);
  }
  // チャンネルの操作（ccChannels）が無くても、/setup が無くても取り込みの候補は出す
  const command = createCcCommand({ ccChannels: () => undefined, guildSettings: { ccCategoryId: () => null }, ccTakeover: f.getter, log: () => {} });
  f.state.items = [item(1)];
  const responder = new FakeResponder();
  await command.handle(TAKE, responder);
  assert.deepEqual(f.calls, ["takeable", "counts"]);
  assert.equal(responder.replies[0]?.components?.[0]?.kind, "select");

  // 登録（createCommands）からも取り込みの口が渡る
  const registered = createCommands({ ccChannels: () => undefined, ccTakeover: f.getter, log: () => {} } as unknown as CommandDeps).at(-1)!;
  const viaRegistry = new FakeResponder();
  await registered.handle(TAKE, viaRegistry);
  assert.equal(viaRegistry.replies[0]?.components?.[0]?.kind, "select");
});

test("/cc take: 保留してから、取り込める物だけの cc:takepick を本人にだけ出す（題名・待機か終了・プロジェクト・時刻。25 件まで、超えた分は件数の行）", async (t) => {
  const f = fakeTake(t);
  const logs: string[] = [];
  const command = createCcCommand({ ccChannels: () => undefined, guildSettings: { ccCategoryId: () => "cat-cc" }, ccTakeover: f.getter, log: (line) => void logs.push(line) });
  f.state.items = [
    item(1, { title: "alpha\n  session" }),
    item(2, { title: "終わった物", project: "beta", alive: false, at: undefined }),
    ...Array.from({ length: 25 }, (_, n) => item(n + 3)),
  ];
  f.state.counts = { running: 1, waiting: 2 };
  const responder = new FakeResponder();
  await command.handle(TAKE, responder);
  assert.deepEqual(responder.calls[0], { method: "defer", ephemeral: true });
  assert.equal(responder.calls.length, 2);
  const reply = responder.replies[0]!;
  assert.equal(reply.ephemeral, true);
  assert.equal(
    reply.text,
    "取り込むセッションを選んでください（端末の Claude Code を終わらせて、新しいチャンネルで続けます）\n新しい順の 25 件です（ほか 2 件）\n実行中 1・判断待ち 2 は選べません",
  );
  const row = reply.components?.[0];
  assert.ok(row?.kind === "select");
  assert.equal(row.select.customId, "cc:takepick");
  assert.deepEqual([row.select.minValues, row.select.maxValues], [1, 1]);
  assert.equal(row.select.options.length, TAKE_PICK_MAX);
  assert.deepEqual(row.select.options.slice(0, 2), [
    { label: "alpha session", value: item(1).sessionId, description: "待機・alpha・11-05 09:00" },
    { label: "終わった物", value: item(2).sessionId, description: "終了・beta" },
  ]);
  assert.equal(row.select.options.at(-1)?.value, item(25).sessionId);
  assert.deepEqual(f.calls, ["takeable", "counts"]);
  assert.deepEqual(logs, []);
});

test("/cc take: 候補が無ければ『取り込めるセッションがありません（実行中 N・判断待ち M）。』、準備ができていなければ not_ready の文で一覧を読まない", async (t) => {
  const f = fakeTake(t);
  const command = createCcCommand({ ccChannels: () => undefined, guildSettings: { ccCategoryId: () => "cat-cc" }, ccTakeover: f.getter, log: () => {} });
  f.state.counts = { running: 2, waiting: 1 };
  const none = new FakeResponder();
  await command.handle(TAKE, none);
  assert.deepEqual(none.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: "取り込めるセッションがありません（実行中 2・判断待ち 1）。", ephemeral: true } },
  ]);

  f.calls.length = 0;
  f.state.ready = false;
  f.state.items = [item(1)];
  const notReady = new FakeResponder();
  await command.handle(TAKE, notReady);
  assert.deepEqual(notReady.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: takeoverFailureText("not_ready", false), ephemeral: true } },
  ]);
  assert.deepEqual(f.calls, []);
});

test("takeOptions・takePickPrompt・takeNoneReply: 空白の畳み込み・100 字・空の題名はプロジェクト・時刻なし・件数の行の有無", () => {
  const [long, blank, untimed, wide] = takeOptions(
    [
      item(1, { title: `  ${"あ".repeat(150)}  ` }),
      item(2, { title: " \n\t " }),
      item(3, { title: "a\t\tb", alive: false, at: undefined }),
      item(4, { project: "p".repeat(150) }),
    ],
    "Asia/Tokyo",
  );
  assert.equal(long!.label, `${"あ".repeat(99)}…`);
  assert.equal(blank!.label, "alpha");
  assert.equal(untimed!.label, "a b");
  assert.equal(untimed!.description, "終了・alpha");
  assert.equal(wide!.description.length, 100);
  assert.ok(wide!.description.startsWith("待機・ppp"));
  assert.equal(takeOptions(Array.from({ length: 30 }, (_, n) => item(n + 1)), "Asia/Tokyo").length, 25);

  const head = "取り込むセッションを選んでください（端末の Claude Code を終わらせて、新しいチャンネルで続けます）";
  assert.equal(takePickPrompt(3, 3, 0, 0), head);
  assert.equal(takePickPrompt(25, 26, 0, 0), `${head}\n新しい順の 25 件です（ほか 1 件）`);
  assert.equal(takePickPrompt(2, 2, 0, 1), `${head}\n実行中 0・判断待ち 1 は選べません`);
  assert.equal(takeNoneReply(0, 0), "取り込めるセッションがありません（実行中 0・判断待ち 0）。");
});

test("cc:takepick: 保留してから propose（entry discord・打ったチャンネルが confirmChannelId）。通ったら確認の文とボタンをそのチャンネルに出して setConfirmMessage、本人には『…出しました』", async (t) => {
  const f = fakeTake(t);
  const component = createCcComponent({ ccTakeover: f.getter, gateway: new FakeGateway(), log: () => {} });
  const first = f.row();
  const message = { text: "確認の文", components: takeoverButtons(first.id) };
  f.state.propose = { ok: true, id: first.id, message, plainText: "確認の文" };
  const responder = new FakeResponder();
  await component.handle(takePick([S1]), responder);
  assert.deepEqual(f.proposals, [{ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "channel-1" }]);
  assert.deepEqual(f.gateway.posts, [{ channelId: "channel-1", messageId: "msg-1", message }]);
  assert.equal(f.takeovers.get(first.id)?.confirmMessageId, "msg-1");
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: CC_TAKE_POSTED_REPLY, ephemeral: true } },
  ]);
});

test("cc:takepick: 断られたらその文を本人にだけ返し、何も出さない（実行中・判断待ち・tmux の外・直下でない の 4 つの文）。判断待ちは RC のリンクを足す", async (t) => {
  const f = fakeTake(t);
  const component = createCcComponent({ ccTakeover: f.getter, gateway: new FakeGateway(), log: () => {} });
  f.state.rc = "https://claude.ai/code/rc-1";
  for (const code of ["busy", "waiting", "not_in_tmux", "outside_workspace"] as const satisfies readonly TakeoverFailure[]) {
    const text = takeoverFailureText(code, false);
    f.state.propose = { ok: false, reason: code, text };
    const responder = new FakeResponder();
    await component.handle(takePick([S1]), responder);
    assert.deepEqual(
      responder.calls,
      [
        { method: "defer", ephemeral: true },
        { method: "reply", message: { text: code === "waiting" ? `${text}\nhttps://claude.ai/code/rc-1` : text, ephemeral: true, suppressEmbeds: true } },
      ],
      code,
    );
  }
  // RC のリンクが無ければ文だけ
  f.state.rc = undefined;
  f.state.propose = { ok: false, reason: "waiting", text: takeoverFailureText("waiting", false) };
  const noLink = new FakeResponder();
  await component.handle(takePick([S1]), noLink);
  assert.equal(noLink.replies[0]?.text, takeoverFailureText("waiting", false));
  assert.deepEqual(f.gateway.posts, []);
  assert.ok(!f.calls.some((call) => call.startsWith("cancel")));
});

test("cc:takepick: 確認の投稿に失敗したら cancel して本人にだけ断り、log は番号と例外の種類だけ", async (t) => {
  const f = fakeTake(t);
  const logs: string[] = [];
  const component = createCcComponent({ ccTakeover: f.getter, gateway: new FakeGateway(), log: (line) => void logs.push(line) });
  const row = f.row();
  f.state.propose = { ok: true, id: row.id, message: { text: "確認の文", components: takeoverButtons(row.id) }, plainText: "確認の文" };
  f.gateway.beforeSendMessage = () => {
    throw new Error("channel-1 に投稿できない");
  };
  const responder = new FakeResponder();
  await component.handle(takePick([S1]), responder);
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: CC_TAKE_POST_FAILED_REPLY, ephemeral: true } },
  ]);
  assert.equal(f.takeovers.get(row.id)?.state, "cancelled");
  assert.equal(f.takeovers.get(row.id)?.confirmMessageId, null);
  assert.deepEqual(f.calls, ["propose", `cancel:${row.id}`]);
  assert.deepEqual(logs, [`Claude Code: 取り込みの確認を出せませんでした（#${row.id}、Error）`]);
  assertTakeLogs(logs);
});

test("cc:takepick: セレクトでない・値が UUID でない・複数の値は投げる。連携が無ければ他と同じ文", async (t) => {
  const f = fakeTake(t);
  const component = createCcComponent({ ccTakeover: f.getter, gateway: new FakeGateway(), log: () => {} });
  await assert.rejects(component.handle({ ...takeButton("go", 1), customId: "cc:takepick" }, new FakeResponder()));
  await assert.rejects(component.handle(takePick(["../x"]), new FakeResponder()));
  await assert.rejects(component.handle(takePick([S1, S2]), new FakeResponder()));
  await assert.rejects(component.handle(takePick([]), new FakeResponder()));
  await assert.rejects(component.handle({ ...takePick([S1]), channelId: null }, new FakeResponder()));
  assert.deepEqual(f.calls, []);
  for (const ccTakeover of [() => undefined, undefined]) {
    const off = createCcComponent({ ...(ccTakeover === undefined ? {} : { ccTakeover }), gateway: new FakeGateway(), log: () => {} });
    const responder = new FakeResponder();
    await off.handle(takePick([S1]), responder);
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: CC_UNAVAILABLE_REPLY, ephemeral: true } }]);
  }
});

test("cc:take: 別のチャンネル・別のサーバー・Web の行（entry web）・確認待ちでない・行が無い・連携が無いは本人にだけ『この確認はもう使えません。』で、confirm も cancel も呼ばない", async (t) => {
  const f = fakeTake(t);
  const component = createCcComponent({ ccTakeover: f.getter, gateway: new FakeGateway(), log: () => {} });
  const stale = [{ method: "reply", message: { text: CC_TAKE_STALE_REPLY, ephemeral: true } }];
  const row = f.row();
  const web = f.row(S2, { entry: "web" });
  const otherGuild = f.row("33333333-3333-4333-8333-333333333333", { guildId: "guild-2" });
  const cancelled = f.row("55555555-5555-4555-8555-555555555555");
  f.takeovers.cancel(cancelled.id);
  for (const action of ["go", "no"] as const) {
    for (const [label, interaction] of [
      ["別のチャンネル", takeButton(action, row.id, { channelId: "other-chan" })],
      ["別のサーバー", takeButton(action, row.id, { guildId: "guild-2" })],
      ["別のサーバーの行", takeButton(action, otherGuild.id)],
      ["Web の行", takeButton(action, web.id)],
      ["Web の行（チャンネルの外から）", takeButton(action, web.id, { channelId: null })],
      ["確認待ちでない", takeButton(action, cancelled.id)],
      ["無い行", takeButton(action, 999)],
    ] as const) {
      const responder = new FakeResponder();
      await component.handle(interaction, responder);
      assert.deepEqual(responder.calls, stale, `${action} ${label}`);
    }
  }
  for (const ccTakeover of [() => undefined, undefined]) {
    const off = createCcComponent({ ...(ccTakeover === undefined ? {} : { ccTakeover }), gateway: new FakeGateway(), log: () => {} });
    const responder = new FakeResponder();
    await off.handle(takeButton("go", row.id), responder);
    assert.deepEqual(responder.calls, stale);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.takeovers.get(row.id)?.state, "awaiting_confirm");
});

test("cc:take:go は先に保留してから confirm。stale なら本人にだけ断る。edited が false なら押された 1 通を結果の文に書き換えてボタンを外す（それも失敗したら log だけ）", async (t) => {
  const f = fakeTake(t);
  const logs: string[] = [];
  const component = createCcComponent({ ccTakeover: f.getter, gateway: new FakeGateway(), log: (line) => void logs.push(line) });
  const row = f.row();
  const press = async (): Promise<FakeResponder> => {
    const responder = new FakeResponder();
    responder.afterDeferUpdate = () => void f.calls.push("deferUpdate");
    await component.handle(takeButton("go", row.id), responder);
    return responder;
  };
  // 本体が確認の文を書き換えた
  const done = await press();
  assert.deepEqual(done.calls, [{ method: "deferUpdate" }]);
  assert.deepEqual(f.calls, ["deferUpdate", `confirm:${row.id}`]);

  f.state.confirm = { ok: false, reason: "stale" };
  const again = await press();
  assert.deepEqual(again.calls, [{ method: "deferUpdate" }, { method: "reply", message: { text: CC_TAKE_STALE_REPLY, ephemeral: true } }]);

  // 書き換えられなかった（成功・期限切れ・失敗）: 押された 1 通を結果の文にする
  for (const result of [
    { ok: true, channelId: "dest-1", text: "取り込みました → <#dest-1>", plainText: "完了", edited: false },
    { ok: false, reason: "expired", text: "期限切れ", plainText: "期限切れ", edited: false },
    { ok: false, reason: "busy", text: "実行中", plainText: "実行中", edited: false },
  ] as CcTakeoverConfirmResult[]) {
    f.state.confirm = result;
    const responder = await press();
    assert.deepEqual(responder.calls, [{ method: "deferUpdate" }, { method: "update", message: { text: "text" in result ? result.text : "", components: [] } }]);
  }
  assert.deepEqual(logs, []);

  // それも失敗したら log だけ（投げない）
  f.state.confirm = { ok: true, channelId: "dest-1", text: "取り込みました → <#dest-1>", plainText: "完了", edited: false };
  const failing = new FakeResponder();
  failing.beforeUpdate = () => {
    throw new Error("channel-1 を書き換えられない");
  };
  await component.handle(takeButton("go", row.id), failing);
  assert.deepEqual(failing.calls, [{ method: "deferUpdate" }]);
  assert.deepEqual(logs, [`Claude Code: 取り込みの結果を確認の文に出せませんでした（#${row.id}、Error）`]);
  assertTakeLogs(logs);
});

test("cc:take:no は cancel して確認の文を『取り込みをやめました。』に書き換えボタンを外す。cancel できなければ断る", async (t) => {
  const f = fakeTake(t);
  const logs: string[] = [];
  const component = createCcComponent({ ccTakeover: f.getter, gateway: new FakeGateway(), log: (line) => void logs.push(line) });
  const row = f.row();
  const no = new FakeResponder();
  await component.handle(takeButton("no", row.id), no);
  assert.deepEqual(no.calls, [{ method: "update", message: { text: CC_TAKE_CANCELLED_TEXT, components: [] } }]);
  assert.equal(f.takeovers.get(row.id)?.state, "cancelled");
  assert.deepEqual(f.calls, [`cancel:${row.id}`]);

  // 確認待ちに見えても cancel が通らなければ（同時に押された）断る
  const second = f.row(S2);
  f.runtime.takeover = { ...f.runtime.takeover, cancel: (id) => (f.calls.push(`cancel:${id}`), false) };
  const lost = new FakeResponder();
  await component.handle(takeButton("no", second.id), lost);
  assert.deepEqual(lost.calls, [{ method: "reply", message: { text: CC_TAKE_STALE_REPLY, ephemeral: true } }]);

  // 書き換えに失敗しても投げず、log だけ
  f.runtime.takeover = { ...f.runtime.takeover, cancel: () => true };
  const failing = new FakeResponder();
  failing.beforeUpdate = () => {
    throw new Error("channel-1 を書き換えられない");
  };
  await component.handle(takeButton("no", second.id), failing);
  assert.deepEqual(failing.calls, []);
  assert.deepEqual(logs, [`Claude Code: 取り込みの確認の文を書き換えられませんでした（#${second.id}、Error）`]);
  assertTakeLogs(logs);
  assert.ok(!f.calls.some((call) => call.startsWith("confirm")));
});

test("cc:take の形の違う custom_id（id が数でない・部品が多い・ボタンでない）は投げる", async (t) => {
  const f = fakeTake(t);
  const component = createCcComponent({ ccTakeover: f.getter, gateway: new FakeGateway(), log: () => {} });
  const row = f.row();
  for (const customId of ["cc:take:go:abc", `cc:take:go:${row.id}:1`, "cc:take:go", `cc:take:yes:${row.id}`, "cc:take:go:0", `cc:take:no:-${row.id}`]) {
    await assert.rejects(component.handle({ ...takeButton("go", row.id), customId }, new FakeResponder()), customId);
  }
  await assert.rejects(component.handle({ ...takePick([S1]), customId: `cc:take:go:${row.id}` }, new FakeResponder()));
  assert.deepEqual(f.calls, []);
});

test("cc:take・/cc take: オーナー以外の操作は振り分けの前に断られ、takeable・propose・confirm・cancel も投稿も起こさない", async (t) => {
  const f = fakeTake(t);
  const row = f.row();
  f.state.items = [item(1)];
  f.state.propose = { ok: true, id: row.id, message: { text: "確認の文", components: takeoverButtons(row.id) }, plainText: "確認の文" };
  const handle = createInteractionHandler({
    cfg: { allowedGuildIds: ["guild-1"], ownerUserId: "owner-1" },
    commands: [createCcCommand({ ccChannels: () => undefined, guildSettings: { ccCategoryId: () => "cat-cc" }, ccTakeover: f.getter, log: () => {} })],
    components: [createCcComponent({ ccTakeover: f.getter, gateway: new FakeGateway(), log: () => {} })],
    log: () => {},
  });
  for (const interaction of [
    { ...TAKE, userId: "someone" },
    { ...takePick([S1]), userId: "someone" },
    takeButton("go", row.id, { userId: "someone" }),
    takeButton("no", row.id, { userId: "someone" }),
  ] as Interaction[]) {
    const responder = new FakeResponder();
    await handle(interaction, responder);
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: OWNER_ONLY_REPLY, ephemeral: true } }], interaction.kind);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.gateway.posts, []);
  assert.equal(f.takeovers.get(row.id)?.state, "awaiting_confirm");
});
