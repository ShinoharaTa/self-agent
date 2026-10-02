import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "../src/agent/runner.ts";
import type { MoveTarget } from "../src/app/channel-ops.ts";
import { HELP_TEXT } from "../src/app/commands/help.ts";
import { createSetupCommand, ensureGuildLayout } from "../src/app/commands/setup.ts";
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

/**
 * 作ったチャンネルを覚えておき、channelExists はそれ（から消したものを除く）で答える（/new は new-session.test.ts）。
 * getParentId は作成・移動で記録した親で答え、calls ではなく parentChecks に記録する
 */
class FakeGateway
  implements
    Pick<
      Gateway,
      "createCategory" | "createTextChannel" | "channelExists" | "moveChannel" | "getParentId" | "countChannelsIn" | "send"
    >
{
  calls: GatewayCall[] = [];
  /** getParentId で問い合わせたチャンネル */
  parentChecks: string[] = [];
  /** Discord 上にあるチャンネル */
  readonly alive = new Set<string>();
  /** テキストチャンネル → 今の親カテゴリ（手で動かされたことにするときは直接書き換える） */
  readonly parents = new Map<string, string | null>();
  /** getParentId の直前に呼ばれる。投げればその確認は失敗する */
  beforeParent: (channelId: string) => void = () => {};
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
    const id = this.newId();
    this.parents.set(id, options.parentId);
    return id;
  }
  async channelExists(channelId: string): Promise<boolean> {
    this.calls.push({ method: "channelExists", channelId });
    this.beforeExists();
    return this.alive.has(channelId);
  }
  async moveChannel(channelId: string, parentId: string): Promise<void> {
    this.calls.push({ method: "moveChannel", channelId, parentId });
    this.parents.set(channelId, parentId);
  }
  async getParentId(channelId: string): Promise<string | null> {
    this.parentChecks.push(channelId);
    this.beforeParent(channelId);
    return this.parents.get(channelId) ?? null;
  }
  async countChannelsIn(): Promise<number> {
    throw new Error("想定外の呼び出し");
  }
  async send(): Promise<void> {
    throw new Error("想定外の呼び出し");
  }

  /** 呼び出し記録を空にする（2 回目の /setup の呼び出しだけを見るため） */
  reset(): void {
    this.calls = [];
    this.parentChecks = [];
  }

  private newId(): string {
    const id = `ch-${this.nextId++}`;
    this.alive.add(id);
    return id;
  }
}

type ResponderCall =
  | { method: "defer"; ephemeral: boolean }
  | { method: "reply" | "update"; message: OutgoingMessage }
  | { method: "showModal"; modal: ModalDef };

class FakeResponder implements InteractionResponder {
  calls: ResponderCall[] = [];

  async defer(ephemeral: boolean): Promise<void> {
    this.calls.push({ method: "defer", ephemeral });
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
    channelOps,
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
  assert.equal(guildSettings.get("guild-1")?.homePanelMessageId, null);
  assert.equal(
    text,
    ["セットアップしました。", "作成: <#ch-1> <#ch-2> <#ch-3> <#ch-4> <#ch-5> <#ch-6> <#ch-7>"].join("\n"),
  );
  assert.deepEqual(logs, ["/setup を実行しました（guild=guild-1、作成 7 件）"]);
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
  const commands = createCommands({
    gateway,
    guildSettings,
    topicSessions,
    queue: new KeyedSerialQueue(1),
    channelOps,
    tasks,
    turnQueue: new KeyedSerialQueue(1),
    turn: {
      runner,
      sessions: new SdkSessionStore(db, () => NOW),
      seeds: new ChannelSeedStore(db, () => NOW),
      topicSessions,
      usage: new UsageStore(db, () => NOW),
      log,
    },
    log,
  });
  assert.deepEqual(
    commands.map((command) => command.def.name),
    ["help", "setup", "new", "close"],
  );
  const handle = createInteractionHandler({
    cfg: { allowedGuildIds: ["guild-1"], ownerUserId: "owner-1" },
    commands,
    components: createComponents({ topicSessions, tasks, channelOps, log }),
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

test("親のずれ: 初回と、すべて self-agent カテゴリにあるときは移動を入れない", async (t) => {
  const { gateway, channelOps, run } = setup(t);
  await run();
  assert.deepEqual(gateway.parentChecks, [FIRST.inbox, FIRST.tasks, FIRST.system]);
  gateway.reset();

  await run();

  assert.deepEqual(gateway.parentChecks, [FIRST.inbox, FIRST.tasks, FIRST.system]);
  assert.deepEqual(channelOps.moves, []);
});

test("親のずれ: self-agent カテゴリの外にある #inbox・#system だけ、self-agent カテゴリへの移動を ChannelOpsQueue に入れる", async (t) => {
  const { gateway, channelOps, logs, run } = setup(t);
  await run();
  // 手で動かされた・カテゴリを作り直した回に移動が失敗した
  gateway.parents.set(FIRST.inbox, FIRST.done);
  gateway.parents.set(FIRST.system, null);
  gateway.reset();
  logs.length = 0;

  const text = await run();

  assert.deepEqual(channelOps.moves, [
    { channelId: FIRST.inbox, target: { kind: "category", categoryId: FIRST.home } },
    { channelId: FIRST.system, target: { kind: "category", categoryId: FIRST.home } },
  ]);
  // /setup 自身は移動しない（ChannelOpsQueue が後で順に行う）
  assert.equal(gateway.calls.filter((call) => call.method === "moveChannel").length, 0);
  assert.match(text, /^すべて揃っています。/);
  assert.deepEqual(logs, [
    "self-agent カテゴリの外にあるチャンネル 2 件を戻します（guild=guild-1）",
    "/setup を実行しました（guild=guild-1、作成 0 件）",
  ]);
});

test("親のずれ: カテゴリを作り直して移せたなら、移動は入れない", async (t) => {
  const { gateway, channelOps, run } = setup(t);
  await run();
  gateway.alive.delete(FIRST.home);
  gateway.reset();

  await run();

  assert.deepEqual(gateway.parentChecks, [FIRST.inbox, FIRST.tasks, FIRST.system]);
  assert.deepEqual(channelOps.moves, []);
});

test("親のずれ: 途中で失敗した回は確認しない。確認に失敗したチャンネルは log に出して次へ進む", async (t) => {
  const { gateway, channelOps, logs, run } = setup(t);
  gateway.beforeCreate = (name) => {
    if (name === "完了") throw new Error("Missing Permissions");
  };
  await run();
  assert.deepEqual(gateway.parentChecks, []);

  gateway.beforeCreate = () => {};
  gateway.parents.set(FIRST.tasks, null);
  gateway.beforeParent = (channelId) => {
    if (channelId === FIRST.inbox) throw new Error("Missing Access");
  };
  logs.length = 0;
  await run();

  assert.deepEqual(gateway.parentChecks, [FIRST.inbox, FIRST.tasks, FIRST.system]);
  assert.deepEqual(channelOps.moves, [{ channelId: FIRST.tasks, target: { kind: "category", categoryId: FIRST.home } }]);
  assert.ok(logs.includes("親カテゴリの確認に失敗しました（guild=guild-1）: Missing Access"));
});
