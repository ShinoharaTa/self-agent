import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "../src/agent/runner.ts";
import type { MoveTarget } from "../src/app/channel-ops.ts";
import { HELP_TEXT } from "../src/app/commands/help.ts";
import { createSetupCommand, ensureGuildLayout, HOME_PANEL_TEXT, homePanelMessage } from "../src/app/commands/setup.ts";
import { createCommands, createComponents, createInteractionHandler } from "../src/app/interactions.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import type {
  Gateway,
  Interaction,
  InteractionResponder,
  ModalDef,
  OutgoingMessage,
  TextChannelOptions,
} from "../src/discord/gateway.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { InboxSummaryStore } from "../src/store/inbox-summaries.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";

const NOW = new Date("2026-10-02T00:12:00Z");

type GatewayCall =
  | { method: "createCategory"; guildId: string; name: string }
  | { method: "createTextChannel"; guildId: string; options: TextChannelOptions }
  | { method: "channelExists"; channelId: string }
  | { method: "moveChannel"; channelId: string; parentId: string };

/** ホームパネルの投稿・ピン留め・存在の確認（calls とは別に記録する） */
type PanelCall =
  | { method: "messageExists"; channelId: string; messageId: string }
  | { method: "sendMessage"; channelId: string; message: OutgoingMessage }
  | { method: "pinMessage"; channelId: string; messageId: string };

/**
 * 作ったチャンネルを覚えておき、channelExists はそれ（から消したものを除く）で答える（/new は new-session.test.ts）。
 * ホームパネルのメッセージは panelCalls に記録し、messageExists は投稿したもの（から消したものを除く）で答える
 */
class FakeGateway
  implements
    Pick<
      Gateway,
      | "createCategory"
      | "createTextChannel"
      | "channelExists"
      | "moveChannel"
      | "countChannelsIn"
      | "send"
      | "sendMessage"
      | "pinMessage"
      | "messageExists"
      | "deleteChannel"
    >
{
  calls: GatewayCall[] = [];
  panelCalls: PanelCall[] = [];
  /** Discord 上にあるメッセージ（channelId:messageId） */
  readonly messages = new Set<string>();
  /** sendMessage の直前に呼ばれる。投げればその投稿は失敗する */
  beforePost: () => void = () => {};
  /** pinMessage の直前に呼ばれる。投げればそのピン留めは失敗する */
  beforePin: () => void = () => {};
  /** messageExists の直前に呼ばれる。投げればその確認は失敗する */
  beforeMessageExists: () => void = () => {};
  private nextMessageId = 1;
  /** Discord 上にあるチャンネル */
  readonly alive = new Set<string>();
  /** 作成の直前に呼ばれる。投げればその作成は失敗する */
  beforeCreate: (name: string) => void = () => {};
  /** channelExists の直前に呼ばれる。投げればその確認は失敗する */
  beforeExists: () => void = () => {};
  private nextId = 1;

  async createCategory(guildId: string, name: string): Promise<string> {
    this.calls.push({ method: "createCategory", guildId, name });
    this.beforeCreate(name);
    return this.newId();
  }
  async createTextChannel(guildId: string, options: TextChannelOptions): Promise<string> {
    this.calls.push({ method: "createTextChannel", guildId, options });
    this.beforeCreate(options.name);
    return this.newId();
  }
  async channelExists(channelId: string): Promise<boolean> {
    this.calls.push({ method: "channelExists", channelId });
    this.beforeExists();
    return this.alive.has(channelId);
  }
  async moveChannel(channelId: string, parentId: string): Promise<void> {
    this.calls.push({ method: "moveChannel", channelId, parentId });
  }
  async countChannelsIn(): Promise<number> {
    throw new Error("想定外の呼び出し");
  }
  async deleteChannel(): Promise<void> {
    throw new Error("想定外の呼び出し");
  }
  async send(): Promise<void> {
    throw new Error("想定外の呼び出し");
  }
  async sendMessage(channelId: string, message: OutgoingMessage): Promise<string> {
    this.panelCalls.push({ method: "sendMessage", channelId, message });
    this.beforePost();
    const messageId = `msg-${this.nextMessageId++}`;
    this.messages.add(`${channelId}:${messageId}`);
    return messageId;
  }
  async pinMessage(channelId: string, messageId: string): Promise<void> {
    this.panelCalls.push({ method: "pinMessage", channelId, messageId });
    this.beforePin();
  }
  async messageExists(channelId: string, messageId: string): Promise<boolean> {
    this.panelCalls.push({ method: "messageExists", channelId, messageId });
    this.beforeMessageExists();
    return this.messages.has(`${channelId}:${messageId}`);
  }

  /** 呼び出し記録を空にする（2 回目の /setup の呼び出しだけを見るため） */
  reset(): void {
    this.calls = [];
    this.panelCalls = [];
  }

  private newId(): string {
    const id = `ch-${this.nextId++}`;
    this.alive.add(id);
    return id;
  }
}

type ResponderCall =
  | { method: "defer"; ephemeral: boolean }
  | { method: "deferUpdate" }
  | { method: "reply" | "update"; message: OutgoingMessage }
  | { method: "showModal"; modal: ModalDef };

class FakeResponder implements InteractionResponder {
  calls: ResponderCall[] = [];

  async defer(ephemeral: boolean): Promise<void> {
    this.calls.push({ method: "defer", ephemeral });
  }
  async deferUpdate(): Promise<void> {
    this.calls.push({ method: "deferUpdate" });
  }
  async reply(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "reply", message });
  }
  async update(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "update", message });
  }
  async showModal(modal: ModalDef): Promise<void> {
    this.calls.push({ method: "showModal", modal });
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

/** ChannelOpsQueue の代わりに、入れた移動を記録する */
class RecordingChannelOps {
  moves: Array<{ channelId: string; target: MoveTarget }> = [];

  enqueueMove(channelId: string, target: MoveTarget): void {
    this.moves.push({ channelId, target });
  }
  cancel(): void {
    throw new Error("想定外の呼び出し");
  }
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const gateway = new FakeGateway();
  const guildSettings = new GuildSettingsStore(db, () => NOW);
  const channelOps = new RecordingChannelOps();
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
  return { db, gateway, guildSettings, channelOps, logs, run };
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

const TOPICS: Record<string, string> = {
  inbox: "思いつきややることを書くと Bot が返事します",
  tasks: "タスクの一覧",
  system: "Bot の起動・エラー・利用状況の通知",
};

/** テキストチャンネル作成の呼び出し（topic 付き） */
function textChannel(name: string, parentId: string): GatewayCall {
  return { method: "createTextChannel", guildId: "guild-1", options: { name, parentId, topic: TOPICS[name] } };
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

test("初回: self-agent カテゴリ → #inbox/#tasks/#system → 進行中/待ち/完了 の順に作り、ID を保存してリンクを返す", async (t) => {
  const { gateway, guildSettings, logs, run } = setup(t);

  const text = await run();

  assert.deepEqual(gateway.calls, [
    { method: "createCategory", guildId: "guild-1", name: "self-agent" },
    {
      method: "createTextChannel",
      guildId: "guild-1",
      options: { name: "inbox", parentId: FIRST.home, topic: "思いつきややることを書くと Bot が返事します" },
    },
    {
      method: "createTextChannel",
      guildId: "guild-1",
      options: { name: "tasks", parentId: FIRST.home, topic: "タスクの一覧" },
    },
    {
      method: "createTextChannel",
      guildId: "guild-1",
      options: { name: "system", parentId: FIRST.home, topic: "Bot の起動・エラー・利用状況の通知" },
    },
    { method: "createCategory", guildId: "guild-1", name: "進行中" },
    { method: "createCategory", guildId: "guild-1", name: "待ち" },
    { method: "createCategory", guildId: "guild-1", name: "完了" },
  ]);
  assert.deepEqual(savedIds(guildSettings), FIRST);
  // 最後に #inbox へホームパネルを投稿してピン留めし、ID を保存する
  assert.deepEqual(gateway.panelCalls, [
    { method: "sendMessage", channelId: FIRST.inbox, message: homePanelMessage() },
    { method: "pinMessage", channelId: FIRST.inbox, messageId: "msg-1" },
  ]);
  assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, "msg-1");
  assert.equal(
    text,
    ["セットアップしました。", "作成: <#ch-1> <#ch-2> <#ch-3> <#ch-4> <#ch-5> <#ch-6> <#ch-7>"].join("\n"),
  );
  assert.deepEqual(logs, [
    "ホームパネルを #inbox に投稿してピン留めしました（guild=guild-1）",
    "/setup を実行しました（guild=guild-1、作成 7 件）",
  ]);
});

test("2 回目: すべて残っていれば存在を確認するだけで何も作らない", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.reset();

  const text = await run();

  assert.deepEqual(
    gateway.calls,
    Object.values(FIRST).map((channelId) => ({ method: "channelExists", channelId })),
  );
  assert.deepEqual(savedIds(guildSettings), FIRST);
  assert.equal(
    text,
    [
      "すべて揃っています。新しく作ったものはありません。",
      "既存: <#ch-1> <#ch-2> <#ch-3> <#ch-4> <#ch-5> <#ch-6> <#ch-7>",
    ].join("\n"),
  );
});

test("一部欠損: 消えた #inbox と 待ち だけを作り直し、残っているものはそのまま（カテゴリが残っていれば移動しない）", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.alive.delete(FIRST.inbox);
  gateway.alive.delete(FIRST.waiting);
  gateway.reset();

  const text = await run();

  assert.deepEqual(
    gateway.calls.filter((call) => call.method !== "channelExists"),
    [textChannel("inbox", FIRST.home), { method: "createCategory", guildId: "guild-1", name: "待ち" }],
  );
  assert.deepEqual(savedIds(guildSettings), { ...FIRST, inbox: "ch-8", waiting: "ch-9" });
  assert.equal(
    text,
    ["セットアップしました。", "作成: <#ch-8> <#ch-9>", "既存: <#ch-1> <#ch-3> <#ch-4> <#ch-5> <#ch-7>"].join("\n"),
  );
});

test("一部欠損: self-agent カテゴリだけ消えていたら作り直し、残っている #inbox/#tasks/#system をそこへ移す", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.alive.delete(FIRST.home);
  gateway.reset();

  const text = await run();

  assert.deepEqual(gateway.calls, [
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
  assert.equal(
    text,
    ["セットアップしました。", "作成: <#ch-8>", "既存: <#ch-2> <#ch-3> <#ch-4> <#ch-5> <#ch-6> <#ch-7>"].join("\n"),
  );
});

test("一部欠損: カテゴリと #tasks が消えていたら、#tasks は新しいカテゴリに作り、残りは移す", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.alive.delete(FIRST.home);
  gateway.alive.delete(FIRST.tasks);
  gateway.reset();

  await run();

  assert.deepEqual(
    gateway.calls.filter((call) => call.method !== "channelExists"),
    [
      { method: "createCategory", guildId: "guild-1", name: "self-agent" },
      { method: "moveChannel", channelId: FIRST.inbox, parentId: "ch-8" },
      textChannel("tasks", "ch-8"),
      { method: "moveChannel", channelId: FIRST.system, parentId: "ch-8" },
    ],
  );
  assert.deepEqual(savedIds(guildSettings), { ...FIRST, home: "ch-8", tasks: "ch-9" });
});

test("途中で失敗したら作った分は保存して失敗を返し、次の /setup で続きから作る", async (t) => {
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
  assert.equal(
    failed,
    [
      "途中で失敗しました: Missing Permissions",
      "もう一度 /setup を実行すると、続きから作ります。",
      "作成: <#ch-1> <#ch-2>",
    ].join("\n"),
  );
  assert.deepEqual(logs, ["/setup が途中で失敗しました（guild=guild-1、作成 2 件）: Missing Permissions"]);

  gateway.beforeCreate = () => {};
  gateway.reset();
  const resumed = await run();

  assert.deepEqual(gateway.calls, [
    { method: "channelExists", channelId: FIRST.home },
    { method: "channelExists", channelId: FIRST.inbox },
    textChannel("tasks", FIRST.home),
    textChannel("system", FIRST.home),
    { method: "createCategory", guildId: "guild-1", name: "進行中" },
    { method: "createCategory", guildId: "guild-1", name: "待ち" },
    { method: "createCategory", guildId: "guild-1", name: "完了" },
  ]);
  // 失敗した tasks の作成では ID が振られていない（ch-3 から続く）
  assert.deepEqual(savedIds(guildSettings), {
    home: FIRST.home,
    inbox: FIRST.inbox,
    tasks: "ch-3",
    system: "ch-4",
    active: "ch-5",
    waiting: "ch-6",
    done: "ch-7",
  });
  assert.equal(
    resumed,
    ["セットアップしました。", "作成: <#ch-3> <#ch-4> <#ch-5> <#ch-6> <#ch-7>", "既存: <#ch-1> <#ch-2>"].join("\n"),
  );
});

test("存在の確認が「無い」以外で失敗したら、作り直さずに失敗を返す", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.beforeExists = () => {
    throw new Error("Missing Access");
  };
  gateway.reset();

  const text = await run();

  assert.deepEqual(gateway.calls, [{ method: "channelExists", channelId: FIRST.home }]);
  assert.deepEqual(savedIds(guildSettings), FIRST);
  assert.match(text, /^途中で失敗しました: Missing Access\n/);
});

test("同じサーバーで 2 回同時に実行しても、作るのは 1 セット分だけ", async (t) => {
  const { gateway, guildSettings, run } = setup(t);

  const [first, second] = await Promise.all([run(), run()]);

  const creates = gateway.calls.filter(
    (call) => call.method === "createCategory" || call.method === "createTextChannel",
  );
  assert.equal(creates.length, 7);
  // 後の実行は先の実行が保存した ID を確認するだけ
  assert.deepEqual(
    gateway.calls.slice(7),
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
    gateway.calls.every(
      (call) => (call.method === "createCategory" || call.method === "createTextChannel") && call.guildId === "guild-2",
    ),
  );
  assert.equal(guildSettings.get("guild-2")?.inboxChannelId, "ch-9");
  assert.deepEqual(savedIds(guildSettings), FIRST);
});

test("/setup はコマンドとして登録され、オーナーの操作で振り分けられる", async (t) => {
  const { db, gateway, guildSettings, channelOps } = setup(t);
  const logs: string[] = [];
  const log = (line: string): number => logs.push(line);
  const topicSessions = new TopicSessionStore(db, () => NOW);
  const tasks = new TaskStore(db, () => NOW);
  const runner: AgentRunner = { run: async () => assert.fail("想定外の呼び出し") };
  const turnQueue = new KeyedSerialQueue(1);
  const turn = {
    runner,
    sessions: new SdkSessionStore(db, () => NOW),
    seeds: new ChannelSeedStore(db, () => NOW),
    topicSessions,
    inboxSummaries: new InboxSummaryStore(db, () => NOW),
    usage: new UsageStore(db, () => NOW),
    log,
  };
  const layoutQueue = new KeyedSerialQueue(1);
  const commands = createCommands({
    cfg: { timeZone: "Asia/Tokyo" },
    gateway,
    guildSettings,
    topicSessions,
    queue: layoutQueue,
    channelOps,
    tasks,
    usage: turn.usage,
    turnQueue,
    turn,
    log,
  });
  assert.deepEqual(
    commands.map((command) => command.def.name),
    ["help", "setup", "new", "close", "wait", "sessions", "tasks", "usage"],
  );
  const components = createComponents({
    cfg: { deleteAfterDays: 30 },
    gateway,
    guildSettings,
    topicSessions,
    sessions: turn.sessions,
    seeds: turn.seeds,
    queue: layoutQueue,
    tasks,
    channelOps,
    turnQueue,
    turn,
    log,
  });
  assert.deepEqual(
    components.map((component) => component.namespace),
    ["close", "wait", "tasks", "home", "del"],
  );
  const handle = createInteractionHandler({
    cfg: { allowedGuildIds: ["guild-1"], ownerUserId: "owner-1" },
    commands,
    components,
    log,
  });

  const stranger = new FakeResponder();
  await handle({ ...SETUP, userId: "someone-else" }, stranger);
  assert.equal(gateway.calls.length, 0);

  const owner = new FakeResponder();
  await handle(SETUP, owner);
  assert.equal(gateway.calls.length, 7);
  assert.equal(guildSettings.get("guild-1")?.inboxChannelId, FIRST.inbox);
  assert.deepEqual(owner.calls[0], { method: "defer", ephemeral: true });
});

test("/help に /setup の説明がある", () => {
  assert.match(HELP_TEXT, /^`\/setup` /m);
});

test("ホームパネル: 本文と [新しいセッション][タスク一覧][待ちのセッション] のボタン（home:new / home:tasks / home:waiting）", () => {
  assert.equal(HOME_PANEL_TEXT, "self-agent のホーム。ボタンかスラッシュコマンドで操作できます。");
  assert.deepEqual(homePanelMessage(), {
    text: HOME_PANEL_TEXT,
    components: [
      {
        kind: "buttons",
        buttons: [
          { customId: "home:new", label: "新しいセッション", style: "primary" },
          { customId: "home:tasks", label: "タスク一覧" },
          { customId: "home:waiting", label: "待ちのセッション" },
        ],
      },
    ],
  });
});

test("ホームパネル: 2 回目の /setup でメッセージがまだあれば、確認するだけで投稿もピン留めもしない", async (t) => {
  const { gateway, guildSettings, logs, run } = setup(t);
  await run();
  gateway.reset();
  logs.length = 0;

  const text = await run();

  assert.deepEqual(gateway.panelCalls, [{ method: "messageExists", channelId: FIRST.inbox, messageId: "msg-1" }]);
  assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, "msg-1");
  assert.match(text, /^すべて揃っています。/);
  assert.deepEqual(logs, ["/setup を実行しました（guild=guild-1、作成 0 件）"]);
});

test("ホームパネル: メッセージが消えていたら、次の /setup で投稿し直してピン留めし、新しい ID を保存する", async (t) => {
  const { gateway, guildSettings, logs, run } = setup(t);
  await run();
  gateway.messages.delete(`${FIRST.inbox}:msg-1`);
  gateway.reset();
  logs.length = 0;

  const text = await run();

  assert.deepEqual(gateway.panelCalls, [
    { method: "messageExists", channelId: FIRST.inbox, messageId: "msg-1" },
    { method: "sendMessage", channelId: FIRST.inbox, message: homePanelMessage() },
    { method: "pinMessage", channelId: FIRST.inbox, messageId: "msg-2" },
  ]);
  assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, "msg-2");
  // カテゴリ・チャンネルは揃っているので、返信は変わらない
  assert.match(text, /^すべて揃っています。/);
  assert.deepEqual(logs, [
    "ホームパネルを #inbox に投稿してピン留めしました（guild=guild-1）",
    "/setup を実行しました（guild=guild-1、作成 0 件）",
  ]);
});

test("ホームパネル: #inbox を作り直したら、新しい #inbox に投稿し直す", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.alive.delete(FIRST.inbox);
  gateway.reset();

  await run();

  // 新しい #inbox は ch-8。前のメッセージはそこには無い
  assert.deepEqual(gateway.panelCalls, [
    { method: "messageExists", channelId: "ch-8", messageId: "msg-1" },
    { method: "sendMessage", channelId: "ch-8", message: homePanelMessage() },
    { method: "pinMessage", channelId: "ch-8", messageId: "msg-2" },
  ]);
  assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, "msg-2");
});

test("ホームパネル: ピン留めに失敗しても投稿と保存は残し、log に出す（返信は変わらない）。次の /setup では投稿し直さない", async (t) => {
  const { gateway, guildSettings, logs, run } = setup(t);
  gateway.beforePin = () => {
    throw new Error("Missing Permissions");
  };

  const text = await run();

  assert.deepEqual(
    gateway.panelCalls.map((call) => call.method),
    ["sendMessage", "pinMessage"],
  );
  assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, "msg-1");
  assert.equal(
    text,
    ["セットアップしました。", "作成: <#ch-1> <#ch-2> <#ch-3> <#ch-4> <#ch-5> <#ch-6> <#ch-7>"].join("\n"),
  );
  assert.deepEqual(logs, [
    "ホームパネルを #inbox に投稿しましたが、ピン留めに失敗しました（guild=guild-1）: Missing Permissions",
    "/setup を実行しました（guild=guild-1、作成 7 件）",
  ]);

  gateway.reset();
  await run();

  assert.deepEqual(gateway.panelCalls, [{ method: "messageExists", channelId: FIRST.inbox, messageId: "msg-1" }]);
});

test("ホームパネル: 投稿に失敗したら log に出して返信に 1 行足す（/setup の失敗にはしない）。次の /setup で投稿する", async (t) => {
  const { gateway, guildSettings, logs, run } = setup(t);
  gateway.beforePost = () => {
    throw new Error("Missing Access");
  };

  const text = await run();

  assert.deepEqual(
    gateway.panelCalls.map((call) => call.method),
    ["sendMessage"],
  );
  assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, null);
  assert.equal(
    text,
    [
      "セットアップしました。",
      "作成: <#ch-1> <#ch-2> <#ch-3> <#ch-4> <#ch-5> <#ch-6> <#ch-7>",
      "ホームパネルの投稿に失敗しました: Missing Access",
    ].join("\n"),
  );
  assert.deepEqual(logs, [
    "ホームパネルの投稿に失敗しました（guild=guild-1）: Missing Access",
    "/setup を実行しました（guild=guild-1、作成 7 件）",
  ]);

  gateway.beforePost = () => {};
  gateway.reset();
  await run();

  // 保存した ID が無いので、確認せずに投稿する
  assert.deepEqual(
    gateway.panelCalls.map((call) => call.method),
    ["sendMessage", "pinMessage"],
  );
  // 失敗した投稿では ID が振られていない
  assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, "msg-1");
});

test("ホームパネル: 存在の確認が「無い」以外で失敗したら、投稿し直さずに返信に 1 行足す", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  await run();
  gateway.beforeMessageExists = () => {
    throw new Error("Missing Access");
  };
  gateway.reset();

  const text = await run();

  assert.deepEqual(
    gateway.panelCalls.map((call) => call.method),
    ["messageExists"],
  );
  assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, "msg-1");
  assert.match(text, /\nホームパネルの投稿に失敗しました: Missing Access$/);
});

test("ホームパネル: /setup が途中で失敗した回は投稿しない", async (t) => {
  const { gateway, guildSettings, run } = setup(t);
  gateway.beforeCreate = (name) => {
    if (name === "完了") throw new Error("Missing Permissions");
  };

  await run();

  assert.deepEqual(gateway.panelCalls, []);
  assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, null);
});
