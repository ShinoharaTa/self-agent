import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createSetupCommand, ensureGuildLayout, homePanelMessage } from "../src/app/commands/setup.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway, type GatewayCall } from "./helpers/gateway.ts";
import { FakeResponder } from "./helpers/responder.ts";

const NOW = new Date("2026-10-02T00:12:00Z");

/**
 * 作ったチャンネルを覚えておき、channelExists はそれ（から消したものを除く）で答える（/new は new-session.test.ts）。
 * ホームパネルのメッセージの呼び出しは panelCalls に分けて見て、messageExists は投稿したもの（から消したものを除く）で答える
 */
class SetupGateway extends FakeGateway {
  constructor() {
    super({
      record: ["createCategory", "createTextChannel", "channelExists", "moveChannel", "messageExists", "sendMessage", "pinMessage"],
      messageIdPrefix: "msg-",
    });
  }

  /** チャンネルの作成・存在の確認・移動（テキストチャンネルの topic の文言は見ない） */
  get channelCalls(): GatewayCall[] {
    return this.callsOf("createCategory", "createTextChannel", "channelExists", "moveChannel").map((call) =>
      call.method === "createTextChannel"
        ? { ...call, options: { name: call.options.name, parentId: call.options.parentId } }
        : call,
    );
  }
  /** ホームパネルの投稿・ピン留め・存在の確認 */
  get panelCalls(): GatewayCall[] {
    return this.callsOf("messageExists", "sendMessage", "pinMessage");
  }
}

const SETUP: Extract<Interaction, { kind: "command" }> = {
  kind: "command",
  name: "setup",
  options: {},
  guildId: "guild-1",
  channelId: "channel-1",
  userId: "owner-1",
  createdAt: NOW,
};

function setup(t: TestContext) {
  const db = tempDb(t);
  const gateway = new SetupGateway();
  const { guildSettings } = createStores(db, () => NOW);
  const logs: string[] = [];
  const command = createSetupCommand({
    gateway,
    guildSettings,
    queue: new KeyedSerialQueue(1),
    log: (line) => logs.push(line),
  });
  /** /setup を 1 回実行し、ephemeral の返信本文を返す */
  const run = async (): Promise<string> => {
    const responder = new FakeResponder();
    await command.handle(SETUP, responder);
    assert.equal(responder.calls.length, 2);
    assert.deepEqual(responder.calls[0], { method: "defer", ephemeral: true });
    const reply = responder.calls[1]!;
    assert.equal(reply.method, "reply");
    assert.equal(reply.message.ephemeral, true);
    return reply.message.text;
  };
  return { gateway, guildSettings, logs, run };
}

/** 初回の /setup で作られる ID（作る順に ch-1 から振られる） */
const FIRST = {
  home: "ch-1",
  inbox: "ch-2",
  tasks: "ch-3",
  system: "ch-4",
  active: "ch-5",
  waiting: "ch-6",
  done: "ch-7",
};

/** テキストチャンネル作成の呼び出し（topic を除く） */
function textChannel(name: string, parentId: string): GatewayCall {
  return { method: "createTextChannel", guildId: "guild-1", options: { name, parentId } };
}

function savedIds(guildSettings: GuildSettingsStore) {
  const settings = guildSettings.get("guild-1");
  return {
    home: settings?.homeCategoryId,
    inbox: settings?.inboxChannelId,
    tasks: settings?.tasksChannelId,
    system: settings?.systemChannelId,
    active: guildSettings.getStateCategory("guild-1", "active", 1),
    waiting: guildSettings.getStateCategory("guild-1", "waiting", 1),
    done: guildSettings.getStateCategory("guild-1", "done", 1),
  };
}

/** log にチャンネル ID・メッセージ ID を出していない */
function assertNoIds(logs: readonly string[]): void {
  for (const line of logs) assert.doesNotMatch(line, /ch-\d|msg-\d/, line);
}

test("初回: self-agent カテゴリ → #inbox/#tasks/#system → 進行中/待ち/完了 の順に作り、ID を保存してリンクを返す", async (t) => {
  const { gateway, guildSettings, logs, run } = setup(t);

  const text = await run();

  assert.deepEqual(gateway.channelCalls, [
    { method: "createCategory", guildId: "guild-1", name: "self-agent" },
    textChannel("inbox", FIRST.home),
    textChannel("tasks", FIRST.home),
    textChannel("system", FIRST.home),
    { method: "createCategory", guildId: "guild-1", name: "進行中" },
    { method: "createCategory", guildId: "guild-1", name: "待ち" },
    { method: "createCategory", guildId: "guild-1", name: "完了" },
  ]);
  // テキストチャンネルにはどれも topic を付ける
  for (const call of gateway.callsOf("createTextChannel")) {
    assert.ok(call.method === "createTextChannel" && (call.options.topic ?? "").length > 0, JSON.stringify(call));
  }
  assert.deepEqual(savedIds(guildSettings), FIRST);
  // 最後に #inbox へホームパネルを投稿してピン留めし、ID を保存する
  assert.deepEqual(gateway.panelCalls, [
    { method: "sendMessage", channelId: FIRST.inbox, message: homePanelMessage() },
    { method: "pinMessage", channelId: FIRST.inbox, messageId: "msg-1" },
  ]);
  assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, "msg-1");
  assert.match(text, /^セットアップしました。\n作成: <#ch-1> <#ch-2> <#ch-3> <#ch-4> <#ch-5> <#ch-6> <#ch-7>$/);
  assert.equal(logs.length, 2);
  assertNoIds(logs);
});

test("2 回目: すべて残っていれば存在を確認するだけで何も作らない", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.reset();

  const text = await run();

  assert.deepEqual(
    gateway.channelCalls,
    Object.values(FIRST).map((channelId) => ({ method: "channelExists", channelId })),
  );
  assert.deepEqual(savedIds(guildSettings), FIRST);
  assert.match(text, /^すべて揃っています。/);
  assert.ok(text.includes("既存: <#ch-1> <#ch-2> <#ch-3> <#ch-4> <#ch-5> <#ch-6> <#ch-7>"));
});

test("一部欠損: 消えた #inbox と 待ち だけを作り直し、残っているものはそのまま（カテゴリが残っていれば移動しない）", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.alive.delete(FIRST.inbox);
  gateway.alive.delete(FIRST.waiting);
  gateway.reset();

  const text = await run();

  assert.deepEqual(
    gateway.channelCalls.filter((call) => call.method !== "channelExists"),
    [textChannel("inbox", FIRST.home), { method: "createCategory", guildId: "guild-1", name: "待ち" }],
  );
  assert.deepEqual(savedIds(guildSettings), { ...FIRST, inbox: "ch-8", waiting: "ch-9" });
  assert.ok(text.includes("作成: <#ch-8> <#ch-9>\n既存: <#ch-1> <#ch-3> <#ch-4> <#ch-5> <#ch-7>"));
});

test("一部欠損: self-agent カテゴリだけ消えていたら作り直し、残っている #inbox/#tasks/#system をそこへ移す", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.alive.delete(FIRST.home);
  gateway.reset();

  const text = await run();

  assert.deepEqual(gateway.channelCalls, [
    { method: "channelExists", channelId: FIRST.home },
    { method: "createCategory", guildId: "guild-1", name: "self-agent" },
    { method: "channelExists", channelId: FIRST.inbox },
    { method: "moveChannel", channelId: FIRST.inbox, parentId: "ch-8" },
    { method: "channelExists", channelId: FIRST.tasks },
    { method: "moveChannel", channelId: FIRST.tasks, parentId: "ch-8" },
    { method: "channelExists", channelId: FIRST.system },
    { method: "moveChannel", channelId: FIRST.system, parentId: "ch-8" },
    { method: "channelExists", channelId: FIRST.active },
    { method: "channelExists", channelId: FIRST.waiting },
    { method: "channelExists", channelId: FIRST.done },
  ]);
  assert.deepEqual(savedIds(guildSettings), { ...FIRST, home: "ch-8" });
  assert.ok(text.includes("作成: <#ch-8>\n既存: <#ch-2> <#ch-3> <#ch-4> <#ch-5> <#ch-6> <#ch-7>"));
});

test("一部欠損: カテゴリと #tasks が消えていたら、#tasks は新しいカテゴリに作り、残りは移す", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.alive.delete(FIRST.home);
  gateway.alive.delete(FIRST.tasks);
  gateway.reset();

  await run();

  assert.deepEqual(
    gateway.channelCalls.filter((call) => call.method !== "channelExists"),
    [
      { method: "createCategory", guildId: "guild-1", name: "self-agent" },
      { method: "moveChannel", channelId: FIRST.inbox, parentId: "ch-8" },
      textChannel("tasks", "ch-8"),
      { method: "moveChannel", channelId: FIRST.system, parentId: "ch-8" },
    ],
  );
  assert.deepEqual(savedIds(guildSettings), { ...FIRST, home: "ch-8", tasks: "ch-9" });
});

test("途中で失敗したら作った分は保存して失敗を返し（ホームパネルは投稿しない）、次の /setup で続きから作る", async (t) => {
  const { gateway, guildSettings, logs, run } = setup(t);
  gateway.beforeCreate = (name) => {
    if (name === "tasks") throw new Error("Missing Permissions");
  };

  const failed = await run();

  assert.deepEqual(savedIds(guildSettings), {
    home: FIRST.home,
    inbox: FIRST.inbox,
    tasks: null,
    system: null,
    active: undefined,
    waiting: undefined,
    done: undefined,
  });
  assert.match(failed, /^途中で失敗しました: Missing Permissions\n/);
  assert.ok(failed.includes("作成: <#ch-1> <#ch-2>"));
  assert.deepEqual(gateway.panelCalls, []);
  assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, null);
  assert.equal(logs.length, 1);
  assertNoIds(logs);

  gateway.beforeCreate = () => {};
  gateway.reset();
  const resumed = await run();

  assert.deepEqual(gateway.channelCalls, [
    { method: "channelExists", channelId: FIRST.home },
    { method: "channelExists", channelId: FIRST.inbox },
    textChannel("tasks", FIRST.home),
    textChannel("system", FIRST.home),
    { method: "createCategory", guildId: "guild-1", name: "進行中" },
    { method: "createCategory", guildId: "guild-1", name: "待ち" },
    { method: "createCategory", guildId: "guild-1", name: "完了" },
  ]);
  // 失敗した tasks の作成では ID が振られていない（ch-3 から続く）
  assert.deepEqual(savedIds(guildSettings), FIRST);
  assert.ok(resumed.includes("作成: <#ch-3> <#ch-4> <#ch-5> <#ch-6> <#ch-7>\n既存: <#ch-1> <#ch-2>"));
});

test("存在の確認が「無い」以外で失敗したら、作り直さずに失敗を返す", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.beforeExists = () => {
    throw new Error("Missing Access");
  };
  gateway.reset();

  const text = await run();

  assert.deepEqual(gateway.channelCalls, [{ method: "channelExists", channelId: FIRST.home }]);
  assert.deepEqual(savedIds(guildSettings), FIRST);
  assert.match(text, /^途中で失敗しました: Missing Access\n/);
});

test("同じサーバーで 2 回同時に実行しても、作るのは 1 セット分だけ", async (t) => {
  const { gateway, guildSettings, run } = setup(t);

  const [first, second] = await Promise.all([run(), run()]);

  const creates = gateway.channelCalls.filter(
    (call) => call.method === "createCategory" || call.method === "createTextChannel",
  );
  assert.equal(creates.length, 7);
  // 後の実行は先の実行が保存した ID を確認するだけ
  assert.deepEqual(
    gateway.channelCalls.slice(7),
    Object.values(FIRST).map((channelId) => ({ method: "channelExists", channelId })),
  );
  assert.deepEqual(savedIds(guildSettings), FIRST);
  assert.match(first, /^セットアップしました。/);
  assert.match(second, /^すべて揃っています。/);
});

test("ensureGuildLayout: サーバーごとに別々に作って保存する", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.reset();

  const result = await ensureGuildLayout("guild-2", { gateway, guildSettings });

  assert.equal(result.failure, null);
  assert.deepEqual(result.existing, []);
  assert.deepEqual(result.created, ["ch-8", "ch-9", "ch-10", "ch-11", "ch-12", "ch-13", "ch-14"]);
  assert.ok(
    gateway.channelCalls.every(
      (call) => (call.method === "createCategory" || call.method === "createTextChannel") && call.guildId === "guild-2",
    ),
  );
  assert.equal(guildSettings.get("guild-2")?.inboxChannelId, "ch-9");
  assert.deepEqual(savedIds(guildSettings), FIRST);
});

test("ホームパネル: 2 回目の /setup では、メッセージが残っていれば確認だけ・消えていたら投稿し直す・#inbox を作り直したら新しい #inbox に投稿し直す", async (t) => {
  const cases: Array<{
    label: string;
    arrange: (gateway: SetupGateway) => void;
    panel: GatewayCall[];
    savedId: string;
  }> = [
    {
      label: "残っている",
      arrange: () => {},
      panel: [{ method: "messageExists", channelId: FIRST.inbox, messageId: "msg-1" }],
      savedId: "msg-1",
    },
    {
      label: "メッセージが消えた",
      arrange: (gateway) => gateway.messages.delete(`${FIRST.inbox}:msg-1`),
      panel: [
        { method: "messageExists", channelId: FIRST.inbox, messageId: "msg-1" },
        { method: "sendMessage", channelId: FIRST.inbox, message: homePanelMessage() },
        { method: "pinMessage", channelId: FIRST.inbox, messageId: "msg-2" },
      ],
      savedId: "msg-2",
    },
    {
      // 新しい #inbox は ch-8。前のメッセージはそこには無い
      label: "#inbox を作り直した",
      arrange: (gateway) => gateway.alive.delete(FIRST.inbox),
      panel: [
        { method: "messageExists", channelId: "ch-8", messageId: "msg-1" },
        { method: "sendMessage", channelId: "ch-8", message: homePanelMessage() },
        { method: "pinMessage", channelId: "ch-8", messageId: "msg-2" },
      ],
      savedId: "msg-2",
    },
  ];

  for (const { label, arrange, panel, savedId } of cases) {
    const { gateway, guildSettings, logs, run } = setup(t);
    await run();
    arrange(gateway);
    gateway.reset();
    logs.length = 0;

    await run();

    assert.deepEqual(gateway.panelCalls, panel, label);
    assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, savedId, label);
    // 投稿し直したときだけ log に出す
    assert.equal(logs.length, panel.length === 1 ? 1 : 2, label);
    assertNoIds(logs);
  }
});

test("ホームパネル: ピン留め・投稿・存在の確認に失敗しても /setup の失敗にはしない（投稿・確認の失敗は返信に 1 行足す）", async (t) => {
  const cases: Array<{
    label: string;
    /** 初回の /setup を成功させてから失敗させるか */
    afterFirst: boolean;
    inject: (gateway: SetupGateway) => void;
    methods: string[];
    savedId: string | null;
    replyLine: boolean;
    /** 失敗を外した次の /setup のホームパネルの呼び出し */
    next: string[];
  }> = [
    {
      // 投稿と保存は残すので、次は投稿し直さない
      label: "ピン留め",
      afterFirst: false,
      inject: (gateway) => {
        gateway.beforePin = () => {
          throw new Error("Missing Permissions");
        };
      },
      methods: ["sendMessage", "pinMessage"],
      savedId: "msg-1",
      replyLine: false,
      next: ["messageExists"],
    },
    {
      // 保存した ID が無いので、次は確認せずに投稿する（失敗した投稿では ID が振られていない）
      label: "投稿",
      afterFirst: false,
      inject: (gateway) => {
        gateway.beforeSendMessage = () => {
          throw new Error("Missing Access");
        };
      },
      methods: ["sendMessage"],
      savedId: null,
      replyLine: true,
      next: ["sendMessage", "pinMessage"],
    },
    {
      label: "存在の確認",
      afterFirst: true,
      inject: (gateway) => {
        gateway.beforeMessageExists = () => {
          throw new Error("Missing Access");
        };
      },
      methods: ["messageExists"],
      savedId: "msg-1",
      replyLine: true,
      next: ["messageExists"],
    },
  ];

  for (const { label, afterFirst, inject, methods, savedId, replyLine, next } of cases) {
    const { gateway, guildSettings, logs, run } = setup(t);
    if (afterFirst) await run();
    gateway.reset();
    logs.length = 0;
    inject(gateway);

    const text = await run();

    assert.deepEqual(gateway.panelCalls.map((call) => call.method), methods, label);
    assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, savedId, label);
    assert.doesNotMatch(text, /^途中で失敗しました/, label);
    assert.equal(/\nホームパネルの投稿に失敗しました: Missing \w+$/.test(text), replyLine, label);
    // 失敗の log と /setup の log
    assert.equal(logs.length, 2, label);
    assertNoIds(logs);

    gateway.beforePin = () => {};
    gateway.beforeSendMessage = () => {};
    gateway.beforeMessageExists = () => {};
    gateway.reset();
    await run();
    assert.deepEqual(gateway.panelCalls.map((call) => call.method), next, label);
  }
});
