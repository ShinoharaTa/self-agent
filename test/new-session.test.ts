import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP_TEXT } from "../src/app/commands/help.ts";
import {
  createNewSessionCommand,
  EMPTY_TITLE_REPLY,
  NOT_SET_UP_REPLY,
  toChannelName,
  welcomeText,
} from "../src/app/commands/new.ts";
import { createSetupCommand, ensureGuildLayout } from "../src/app/commands/setup.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import type {
  Gateway,
  Interaction,
  InteractionResponder,
  ModalDef,
  OutgoingMessage,
  TextChannelOptions,
} from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";

const NOW = new Date("2026-10-02T00:12:00Z");

type GatewayCall =
  | { method: "createCategory"; guildId: string; name: string }
  | { method: "createTextChannel"; guildId: string; options: TextChannelOptions }
  | { method: "channelExists"; channelId: string }
  | { method: "countChannelsIn"; categoryId: string }
  | { method: "moveChannel"; channelId: string; parentId: string }
  | { method: "send"; channelId: string; text: string };

/** 作ったチャンネルとその置き場所を覚えておき、channelExists・countChannelsIn はそれで答える */
class FakeGateway
  implements Pick<Gateway, "createCategory" | "createTextChannel" | "channelExists" | "moveChannel" | "countChannelsIn" | "send">
{
  calls: GatewayCall[] = [];
  /** Discord 上にあるチャンネル */
  readonly alive = new Set<string>();
  /** カテゴリに手動で置かれたチャンネルの数（countChannelsIn に足す） */
  readonly manual = new Map<string, number>();
  /** send の直前に呼ばれる。投げればその送信は失敗する */
  beforeSend: () => void = () => {};
  /** テキストチャンネル → 置いたカテゴリ */
  private readonly parents = new Map<string, string>();
  private nextId = 1;

  async createCategory(guildId: string, name: string): Promise<string> {
    this.calls.push({ method: "createCategory", guildId, name });
    return this.newId();
  }
  async createTextChannel(guildId: string, options: TextChannelOptions): Promise<string> {
    this.calls.push({ method: "createTextChannel", guildId, options });
    const id = this.newId();
    this.parents.set(id, options.parentId);
    return id;
  }
  async channelExists(channelId: string): Promise<boolean> {
    this.calls.push({ method: "channelExists", channelId });
    return this.alive.has(channelId);
  }
  async countChannelsIn(categoryId: string): Promise<number> {
    this.calls.push({ method: "countChannelsIn", categoryId });
    let count = this.manual.get(categoryId) ?? 0;
    for (const [channelId, parentId] of this.parents) {
      if (parentId === categoryId && this.alive.has(channelId)) count++;
    }
    return count;
  }
  async moveChannel(channelId: string, parentId: string): Promise<void> {
    this.calls.push({ method: "moveChannel", channelId, parentId });
    this.parents.set(channelId, parentId);
  }
  async send(channelId: string, text: string): Promise<void> {
    this.beforeSend();
    this.calls.push({ method: "send", channelId, text });
  }

  reset(): void {
    this.calls = [];
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

/** 受け取った key を記録する（/setup と /new が同じ key を使うかを見る） */
class RecordingQueue extends KeyedSerialQueue {
  keys: string[] = [];

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.keys.push(key);
    return super.run(key, fn);
  }
}

type CommandInteraction = Extract<Interaction, { kind: "command" }>;

const BASE = { guildId: "guild-1", channelId: "channel-1", userId: "owner-1", createdAt: NOW };

function newInteraction(title: string): CommandInteraction {
  return { ...BASE, kind: "command", name: "new", options: { title } };
}

const SETUP: CommandInteraction = { ...BASE, kind: "command", name: "setup", options: {} };

/** /setup で作られる ID（作る順に ch-1 から振られる） */
const LAYOUT = { home: "ch-1", inbox: "ch-2", tasks: "ch-3", system: "ch-4", active: "ch-5", waiting: "ch-6", done: "ch-7" };

function setup(t: TestContext, queue: KeyedSerialQueue = new KeyedSerialQueue(1)) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const gateway = new FakeGateway();
  const guildSettings = new GuildSettingsStore(db, () => NOW);
  const topicSessions = new TopicSessionStore(db, () => NOW);
  const logs: string[] = [];
  const deps = { gateway, guildSettings, topicSessions, queue, log: (line: string) => logs.push(line) };
  const command = createNewSessionCommand(deps);
  /** /new を 1 回実行し、応答の呼び出しを返す */
  const runNew = async (title: string): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await command.handle(newInteraction(title), responder);
    return responder.calls;
  };
  /** /setup 済みにする（LAYOUT の ID）。呼び出し記録は消す */
  const setUp = async (): Promise<void> => {
    const result = await ensureGuildLayout("guild-1", deps);
    assert.equal(result.failure, null);
    gateway.reset();
  };
  const sessionCount = (): number => Number(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.n);
  return { gateway, guildSettings, topicSessions, logs, deps, runNew, setUp, sessionCount };
}

/** /new が成功したときの応答 */
function created(channelId: string): ResponderCall[] {
  return [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: `<#${channelId}> を作りました`, ephemeral: true } },
  ];
}

test("toChannelName: 前後の空白を除き、空白の連続（全角を含む）を - 1 つにする", () => {
  assert.equal(toChannelName("  旅行の計画  "), "旅行の計画");
  assert.equal(toChannelName("旅行 の　計画"), "旅行-の-計画");
  assert.equal(toChannelName("a  \t\n　b"), "a-b");
});

test("toChannelName: ASCII の記号は - と _ 以外を除き、日本語と全角の記号はそのまま残す", () => {
  assert.equal(toChannelName("a!\"#$%&'()*+,./:;<=>?@[\\]^`{|}~b"), "ab");
  assert.equal(toChannelName("snake_case-name"), "snake_case-name");
  assert.equal(toChannelName("「設計」レビュー！"), "「設計」レビュー！");
  assert.equal(toChannelName("v1.2 リリース"), "v12-リリース");
});

test("toChannelName: ASCII の英字だけを小文字にする", () => {
  assert.equal(toChannelName("Hello World"), "hello-world");
  assert.equal(toChannelName("ＡＢＣ Ä"), "ＡＢＣ-Ä");
});

test("toChannelName: - の連続を 1 つにし、先頭・末尾の - を除く", () => {
  assert.equal(toChannelName("a - b"), "a-b");
  assert.equal(toChannelName("--a--b--"), "a-b");
  // 記号を除いた跡の空白同士もつながる
  assert.equal(toChannelName("a ! b"), "a-b");
  assert.equal(toChannelName("! a !"), "a");
});

test("toChannelName: 100 字で切り、サロゲートペアは割らない", () => {
  assert.equal(toChannelName("a".repeat(150)), "a".repeat(100));
  assert.equal(toChannelName("あ".repeat(100) + "い"), "あ".repeat(100));
  // 100 単位目がペアの前半なら、その文字ごと落とす
  assert.equal(toChannelName("a".repeat(99) + "😀"), "a".repeat(99));
  assert.equal(toChannelName("😀".repeat(60)), "😀".repeat(50));
});

test("toChannelName: 正規化して空になれば session", () => {
  assert.equal(toChannelName("!!!"), "session");
  assert.equal(toChannelName("   "), "session");
  assert.equal(toChannelName(" - ! - "), "session");
});

test("/new: 進行中に空きがあればそこにチャンネルを作って保存し、最初の投稿をしてリンクを ephemeral で返す", async (t) => {
  const { gateway, topicSessions, logs, runNew, setUp } = setup(t);
  await setUp();
  // 最初の投稿の時点で sessions に保存済み
  gateway.beforeSend = () => assert.equal(topicSessions.get("ch-8")?.state, "active");

  const calls = await runNew("旅行の計画 Vol.2");

  assert.deepEqual(gateway.calls, [
    { method: "channelExists", channelId: LAYOUT.active },
    { method: "countChannelsIn", categoryId: LAYOUT.active },
    {
      method: "createTextChannel",
      guildId: "guild-1",
      options: { name: "旅行の計画-vol2", parentId: LAYOUT.active, topic: "旅行の計画 Vol.2" },
    },
    { method: "send", channelId: "ch-8", text: "セッション「旅行の計画 Vol.2」を始めました。ここで話しかけてください。" },
  ]);
  assert.deepEqual(calls, created("ch-8"));
  assert.deepEqual(topicSessions.get("ch-8"), {
    channelId: "ch-8",
    guildId: "guild-1",
    title: "旅行の計画 Vol.2",
    state: "active",
    categoryId: LAYOUT.active,
    createdAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
    waitingSince: null,
    closedAt: null,
  });
  assert.deepEqual(logs, ["/new でセッションを作りました（guild=guild-1）"]);
});

test("/new: 進行中を ordinal の昇順に見て、50 未満の最初のカテゴリに作る", async (t) => {
  const { gateway, guildSettings, topicSessions, runNew, setUp } = setup(t);
  await setUp();
  const second = await gateway.createCategory("guild-1", "進行中 2");
  const third = await gateway.createCategory("guild-1", "進行中 3");
  // 保存の順と ordinal の順が違っても ordinal で並べる
  guildSettings.setStateCategory("guild-1", "active", 3, third);
  guildSettings.setStateCategory("guild-1", "active", 2, second);
  gateway.manual.set(LAYOUT.active, 50);
  gateway.manual.set(second, 49);
  gateway.reset();

  const calls = await runNew("設計");

  assert.deepEqual(gateway.calls.slice(0, 4), [
    { method: "channelExists", channelId: LAYOUT.active },
    { method: "countChannelsIn", categoryId: LAYOUT.active },
    { method: "channelExists", channelId: second },
    { method: "countChannelsIn", categoryId: second },
  ]);
  assert.deepEqual(gateway.calls[4], {
    method: "createTextChannel",
    guildId: "guild-1",
    options: { name: "設計", parentId: second, topic: "設計" },
  });
  assert.equal(gateway.calls.filter((call) => call.method === "createCategory").length, 0);
  assert.equal(topicSessions.get("ch-10")?.categoryId, second);
  assert.deepEqual(calls, created("ch-10"));
});

test("/new: 進行中がすべて満杯なら「進行中 2」を作って保存し、そこに作る。次は 進行中 2 の空きを使う", async (t) => {
  const { gateway, guildSettings, topicSessions, logs, runNew, setUp } = setup(t);
  await setUp();
  gateway.manual.set(LAYOUT.active, 50);

  const calls = await runNew("満杯のあと");

  assert.deepEqual(gateway.calls, [
    { method: "channelExists", channelId: LAYOUT.active },
    { method: "countChannelsIn", categoryId: LAYOUT.active },
    { method: "createCategory", guildId: "guild-1", name: "進行中 2" },
    {
      method: "createTextChannel",
      guildId: "guild-1",
      options: { name: "満杯のあと", parentId: "ch-8", topic: "満杯のあと" },
    },
    { method: "send", channelId: "ch-9", text: welcomeText("満杯のあと") },
  ]);
  assert.deepEqual(guildSettings.listStateCategories("guild-1", "active"), [
    { ordinal: 1, categoryId: LAYOUT.active },
    { ordinal: 2, categoryId: "ch-8" },
  ]);
  assert.equal(topicSessions.get("ch-9")?.categoryId, "ch-8");
  assert.deepEqual(calls, created("ch-9"));
  assert.ok(logs.includes("進行中カテゴリに空きが無いため「進行中 2」を作りました（guild=guild-1）"));

  gateway.reset();
  await runNew("次");

  assert.deepEqual(
    gateway.calls.filter((call) => call.method !== "send"),
    [
      { method: "channelExists", channelId: LAYOUT.active },
      { method: "countChannelsIn", categoryId: LAYOUT.active },
      { method: "channelExists", channelId: "ch-8" },
      { method: "countChannelsIn", categoryId: "ch-8" },
      { method: "createTextChannel", guildId: "guild-1", options: { name: "次", parentId: "ch-8", topic: "次" } },
    ],
  );
});

test("/new: 進行中 1・2 が満杯なら「進行中 3」を作る", async (t) => {
  const { gateway, guildSettings, runNew, setUp } = setup(t);
  await setUp();
  const second = await gateway.createCategory("guild-1", "進行中 2");
  guildSettings.setStateCategory("guild-1", "active", 2, second);
  gateway.manual.set(LAYOUT.active, 50);
  gateway.manual.set(second, 50);
  gateway.reset();

  await runNew("x");

  assert.deepEqual(
    gateway.calls.filter((call) => call.method === "createCategory"),
    [{ method: "createCategory", guildId: "guild-1", name: "進行中 3" }],
  );
  assert.equal(guildSettings.getStateCategory("guild-1", "active", 3), "ch-9");
});

test("/new: Discord 上で消えた進行中カテゴリは数えずに飛ばし、作り直さない", async (t) => {
  const { gateway, guildSettings, topicSessions, logs, runNew, setUp } = setup(t);
  await setUp();
  const second = await gateway.createCategory("guild-1", "進行中 2");
  guildSettings.setStateCategory("guild-1", "active", 2, second);
  gateway.alive.delete(LAYOUT.active);
  gateway.reset();

  const calls = await runNew("消えたあと");

  assert.deepEqual(gateway.calls.slice(0, 4), [
    { method: "channelExists", channelId: LAYOUT.active },
    { method: "channelExists", channelId: second },
    { method: "countChannelsIn", categoryId: second },
    {
      method: "createTextChannel",
      guildId: "guild-1",
      options: { name: "消えたあと", parentId: second, topic: "消えたあと" },
    },
  ]);
  assert.equal(gateway.calls.filter((call) => call.method === "createCategory").length, 0);
  // 消えたカテゴリの行はそのまま（作り直すのは /setup）
  assert.equal(guildSettings.getStateCategory("guild-1", "active", 1), LAYOUT.active);
  assert.equal(topicSessions.get("ch-9")?.categoryId, second);
  assert.deepEqual(calls, created("ch-9"));
  assert.ok(logs.includes("進行中カテゴリ（1 番目）が見つからないため飛ばしました（guild=guild-1）"));
});

test("/new: 進行中カテゴリが 1 つだけで消えていたら、「進行中」ではなく「進行中 2」を作る", async (t) => {
  const { gateway, guildSettings, runNew, setUp } = setup(t);
  await setUp();
  gateway.alive.delete(LAYOUT.active);

  await runNew("x");

  assert.deepEqual(
    gateway.calls.filter((call) => call.method === "createCategory"),
    [{ method: "createCategory", guildId: "guild-1", name: "進行中 2" }],
  );
  assert.deepEqual(guildSettings.listStateCategories("guild-1", "active"), [
    { ordinal: 1, categoryId: LAYOUT.active },
    { ordinal: 2, categoryId: "ch-8" },
  ]);
});

test("/new: /setup 前（guild_settings が無い、または 進行中 が無い）なら作らずに案内を ephemeral で返す", async (t) => {
  const { gateway, guildSettings, runNew, sessionCount } = setup(t);

  const none = await runNew("x");

  assert.deepEqual(none, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: NOT_SET_UP_REPLY, ephemeral: true } },
  ]);
  assert.equal(NOT_SET_UP_REPLY, "先に /setup を実行してください");

  // /setup が途中で止まり、進行中カテゴリがまだ無い
  guildSettings.setChannel("guild-1", "homeCategoryId", "home-1");
  guildSettings.setStateCategory("guild-1", "waiting", 1, "waiting-1");
  const partial = await runNew("x");

  assert.deepEqual(partial, none);
  assert.deepEqual(gateway.calls, []);
  assert.equal(sessionCount(), 0);
});

test("/new: 最初の投稿に失敗しても log に出し、リンクは返す", async (t) => {
  const { gateway, topicSessions, logs, runNew, setUp } = setup(t);
  await setUp();
  gateway.beforeSend = () => {
    throw new Error("Missing Access");
  };

  const calls = await runNew("x");

  assert.deepEqual(calls, created("ch-8"));
  assert.equal(topicSessions.get("ch-8")?.title, "x");
  assert.deepEqual(logs, [
    "/new でセッションを作りました（guild=guild-1）",
    "セッションの最初の投稿に失敗しました: Missing Access",
  ]);
});

test("/new と /setup は同じキューの同じ key（layout:<guildId>）で直列に実行する", async (t) => {
  const queue = new RecordingQueue(1);
  const { deps, runNew, setUp } = setup(t, queue);
  await setUp();

  await createSetupCommand(deps).handle(SETUP, new FakeResponder());
  await runNew("x");

  assert.deepEqual(queue.keys, ["layout:guild-1", "layout:guild-1"]);
});

test("/setup の実行中に /new が来たら、/setup が終わるのを待ってから作る", async (t) => {
  // 別の key なら同時に 2 つ動けるキュー。同じ key なので /new は /setup の後になる
  const { gateway, topicSessions, deps, runNew } = setup(t, new KeyedSerialQueue(2));
  const setupResponder = new FakeResponder();

  const [, newCalls] = await Promise.all([createSetupCommand(deps).handle(SETUP, setupResponder), runNew("x")]);

  // /setup の 7 件の作成がすべて終わってから /new が空きを探す
  assert.deepEqual(
    gateway.calls.slice(0, 7).map((call) => call.method),
    [
      "createCategory",
      "createTextChannel",
      "createTextChannel",
      "createTextChannel",
      "createCategory",
      "createCategory",
      "createCategory",
    ],
  );
  assert.deepEqual(gateway.calls.slice(7), [
    { method: "channelExists", channelId: LAYOUT.active },
    { method: "countChannelsIn", categoryId: LAYOUT.active },
    { method: "createTextChannel", guildId: "guild-1", options: { name: "x", parentId: LAYOUT.active, topic: "x" } },
    { method: "send", channelId: "ch-8", text: welcomeText("x") },
  ]);
  assert.deepEqual(newCalls, created("ch-8"));
  assert.equal(topicSessions.get("ch-8")?.categoryId, LAYOUT.active);
  const setupReply = setupResponder.calls[1];
  assert.ok(setupReply?.method === "reply");
  assert.match(setupReply.message.text, /^セットアップしました。/);
});

test("/new を同時に 2 回実行しても、2 つ目は 1 つ目を数えてから空きを探す", async (t) => {
  const { gateway, topicSessions, runNew, setUp } = setup(t, new KeyedSerialQueue(2));
  await setUp();
  gateway.manual.set(LAYOUT.active, 49);

  const [first, second] = await Promise.all([runNew("1 つ目"), runNew("2 つ目")]);

  assert.deepEqual(first, created("ch-8"));
  assert.equal(topicSessions.get("ch-8")?.categoryId, LAYOUT.active);
  // 1 つ目で 進行中 が 50 になったので 進行中 2（ch-9）を作ってそこに置く
  assert.deepEqual(second, created("ch-10"));
  assert.equal(topicSessions.get("ch-10")?.categoryId, "ch-9");
});

test("/new のコマンド定義: 題名は必須の文字列で 1〜100 字", (t) => {
  const { deps } = setup(t);
  const { def } = createNewSessionCommand(deps);
  assert.equal(def.name, "new");
  assert.deepEqual(def.options, [
    {
      type: "string",
      name: "title",
      description: "セッションの題名（チャンネル名と topic に使います）",
      required: true,
      minLength: 1,
      maxLength: 100,
    },
  ]);
});

test("/help に /new の説明がある", () => {
  assert.match(HELP_TEXT, /^`\/new /m);
});

test("toChannelName: 100 字で切った末尾に - が残らない", () => {
  const name = toChannelName(`${"あ".repeat(99)} x`);
  assert.equal(name, "あ".repeat(99));
});

test("/new: 空白だけの題名は作らずに案内する", async (t) => {
  const { gateway, runNew, setUp, sessionCount } = setup(t);
  await setUp();
  const calls = await runNew(" 　 ");
  assert.deepEqual(calls, [{ method: "reply", message: { text: EMPTY_TITLE_REPLY, ephemeral: true } }]);
  assert.equal(sessionCount(), 0);
  assert.equal(gateway.calls.length, 0);
});

test("/new: 題名の前後の空白は除いて topic とあいさつに使う", async (t) => {
  const { gateway, runNew, setUp } = setup(t);
  await setUp();
  await runNew("  旅行の計画  ");
  const createCall = gateway.calls.find((call) => call.method === "createTextChannel");
  assert.ok(createCall);
  assert.equal(JSON.stringify(createCall).includes("\"topic\":\"旅行の計画\""), true);
});
