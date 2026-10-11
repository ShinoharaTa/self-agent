import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createNewSessionCommand,
  EMPTY_TITLE_REPLY,
  NOT_SET_UP_REPLY,
  toChannelName,
  welcomeText,
} from "../src/app/commands/new.ts";
import { createSetupCommand, ensureGuildLayout } from "../src/app/commands/setup.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";

const NOW = new Date("2026-10-02T00:12:00Z");

type CommandInteraction = Extract<Interaction, { kind: "command" }>;

const BASE = { guildId: "guild-1", channelId: "channel-1", userId: "owner-1", createdAt: NOW };

function newInteraction(title: string): CommandInteraction {
  return { ...BASE, kind: "command", name: "new", options: { title } };
}

const SETUP: CommandInteraction = { ...BASE, kind: "command", name: "setup", options: {} };

/** /setup で作られる ID（作る順に ch-1 から振られる） */
const LAYOUT = { home: "ch-1", inbox: "ch-2", tasks: "ch-3", system: "ch-4", active: "ch-5", waiting: "ch-6", done: "ch-7" };

function setup(t: TestContext, queue: KeyedSerialQueue = new KeyedSerialQueue(1)) {
  const db = tempDb(t);
  // 作ったチャンネルとその置き場所で channelExists・countChannelsIn・getParentId に答える（getParentId は記録しない）。
  // /setup の最後のホームパネル（sendMessage・pinMessage・messageExists）も記録しない（ホームパネルは setup.test.ts）
  const gateway = new FakeGateway({
    allow: ["getParentId", "sendMessage", "pinMessage", "messageExists"],
    record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn", "moveChannel", "send"],
  });
  const { guildSettings, topicSessions } = createStores(db, () => NOW);
  const logs: string[] = [];
  // /setup の親のずれの修復はここでは起きない（作ったチャンネルはすべて self-agent カテゴリにある）
  const channelOps = { enqueueMove: () => assert.fail("想定外の移動") };
  const deps = { gateway, guildSettings, topicSessions, queue, channelOps, log: (line: string) => logs.push(line) };
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

test("toChannelName: 題名をチャンネル名に正規化する", () => {
  const cases: Array<[label: string, title: string, name: string]> = [
    ["前後の空白を除く", "  旅行の計画  ", "旅行の計画"],
    ["空白の連続（全角を含む）は - 1 つ", "旅行 の　計画", "旅行-の-計画"],
    ["タブ・改行も空白", "a  \t\n　b", "a-b"],
    ["ASCII の記号は - と _ 以外を除く", "a!\"#$%&'()*+,./:;<=>?@[\\]^`{|}~b", "ab"],
    ["- と _ は残す", "snake_case-name", "snake_case-name"],
    ["日本語と全角の記号はそのまま", "「設計」レビュー！", "「設計」レビュー！"],
    ["記号を除いてから空白を - に", "v1.2 リリース", "v12-リリース"],
    ["ASCII の英字だけを小文字に", "Hello World", "hello-world"],
    ["全角英字・ASCII 以外は小文字にしない", "ＡＢＣ Ä", "ＡＢＣ-Ä"],
    ["- の連続を 1 つに", "a - b", "a-b"],
    ["先頭・末尾の - を除く", "--a--b--", "a-b"],
    ["記号を除いた跡の空白同士もつながる", "a ! b", "a-b"],
    ["記号を除いた跡の先頭・末尾", "! a !", "a"],
    ["100 字で切る", "a".repeat(150), "a".repeat(100)],
    ["100 字で切る（日本語）", "あ".repeat(100) + "い", "あ".repeat(100)],
    // 100 単位目がペアの前半なら、その文字ごと落とす
    ["サロゲートペアは割らない", "a".repeat(99) + "😀", "a".repeat(99)],
    ["サロゲートペアだけ", "😀".repeat(60), "😀".repeat(50)],
    ["切った末尾に - が残らない", `${"あ".repeat(99)} x`, "あ".repeat(99)],
    ["記号だけなら session", "!!!", "session"],
    ["空白だけなら session", "   ", "session"],
    ["- と記号と空白だけなら session", " - ! - ", "session"],
  ];

  for (const [label, title, name] of cases) assert.equal(toChannelName(title), name, label);
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
    { method: "send", channelId: "ch-8", text: welcomeText("旅行の計画 Vol.2") },
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
    summary: null,
    origin: "command",
    deletePromptMessageId: null,
    deletedAt: null,
    renewedSummary: null,
    renewedAt: null,
  });
  assert.equal(logs.length, 1);
  assert.ok(!logs[0]!.includes("ch-8"));
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
  assert.ok(logs.some((line) => line.includes("進行中 2")));

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

test("/new: 作れる進行中カテゴリが無ければ、次の番号の「進行中 n」を作る（消えた 1 つ目は数えるが作り直さない）", async (t) => {
  const cases: Array<{ label: string; full: number[]; gone: number[]; name: string; ordinal: number }> = [
    { label: "進行中 1・2 が満杯", full: [1, 2], gone: [], name: "進行中 3", ordinal: 3 },
    { label: "進行中 1 つだけで消えていた", full: [], gone: [1], name: "進行中 2", ordinal: 2 },
  ];

  for (const { label, full, gone, name, ordinal } of cases) {
    const { gateway, guildSettings, runNew, setUp } = setup(t);
    await setUp();
    const categories = [LAYOUT.active];
    if (full.includes(2)) {
      const second = await gateway.createCategory("guild-1", "進行中 2");
      guildSettings.setStateCategory("guild-1", "active", 2, second);
      categories.push(second);
    }
    for (const index of full) gateway.manual.set(categories[index - 1]!, 50);
    for (const index of gone) gateway.alive.delete(categories[index - 1]!);
    gateway.reset();

    await runNew("x");

    assert.deepEqual(
      gateway.calls.filter((call) => call.method === "createCategory"),
      [{ method: "createCategory", guildId: "guild-1", name }],
      label,
    );
    assert.equal(guildSettings.listStateCategories("guild-1", "active").at(-1)?.ordinal, ordinal, label);
    assert.equal(guildSettings.getStateCategory("guild-1", "active", 1), LAYOUT.active, label);
  }
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
  assert.ok(logs.some((line) => line.includes("見つからない")));
});

test("/new: /setup 前（guild_settings が無い、または 進行中 が無い）なら作らずに案内を ephemeral で返す", async (t) => {
  const { gateway, guildSettings, runNew, sessionCount } = setup(t);

  const none = await runNew("x");

  assert.deepEqual(none, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: NOT_SET_UP_REPLY, ephemeral: true } },
  ]);

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
  assert.equal(logs.length, 2);
  assert.match(logs[1]!, /Missing Access/);
});

test("/new: チャンネルを作った後の DB 保存に失敗したら、作ったチャンネルの ID を log に出して投げ直す", async (t) => {
  const { gateway, topicSessions, logs, runNew, setUp, sessionCount } = setup(t);
  await setUp();
  t.mock.method(topicSessions, "create", () => {
    throw new Error("database is locked");
  });

  await assert.rejects(runNew("x"), /database is locked/);

  assert.equal(gateway.calls.filter((call) => call.method === "createTextChannel").length, 1);
  assert.equal(gateway.calls.filter((call) => call.method === "send").length, 0);
  assert.equal(sessionCount(), 0);
  // 手で消せるよう、作ったチャンネルの ID だけは log に出す
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /ch-8/);
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
  assert.deepEqual(
    def.options?.map(({ type, name, required, minLength, maxLength }) => ({ type, name, required, minLength, maxLength })),
    [{ type: "string", name: "title", required: true, minLength: 1, maxLength: 100 }],
  );
});

test("/new: 空白だけの題名は作らずに案内する", async (t) => {
  const { gateway, runNew, setUp, sessionCount } = setup(t);
  await setUp();
  const calls = await runNew(" 　 ");
  assert.deepEqual(calls, [{ method: "reply", message: { text: EMPTY_TITLE_REPLY, ephemeral: true } }]);
  assert.equal(sessionCount(), 0);
  assert.equal(gateway.calls.length, 0);
});

