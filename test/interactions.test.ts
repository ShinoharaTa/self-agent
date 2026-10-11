import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP_TEXT, helpCommand } from "../src/app/commands/help.ts";
import {
  createCommands,
  createInteractionHandler,
  INTERACTION_FAILURE_REPLY,
  OWNER_ONLY_REPLY,
  registerCommands,
  UNKNOWN_REPLY,
  type CommandHandler,
  type ComponentHandler,
} from "../src/app/interactions.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import type { Interaction, InteractionResponder } from "../src/discord/gateway.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { FakeResponder } from "./helpers/responder.ts";

const cfg = { allowedGuildIds: ["guild-1", "guild-9"], ownerUserId: "owner-1" };
// 振り分けと登録の仕組みを見るので、依存の無い /help だけで足りる（/setup は setup.test.ts）
const COMMANDS: CommandHandler[] = [helpCommand];
const CREATED_AT = new Date("2026-10-02T00:12:00Z");

/** joined のサーバーに参加し、failing のサーバーではコマンドの登録に失敗する */
function fakeGateway(joined: readonly string[], failing: readonly string[] = []): FakeGateway {
  const gateway = new FakeGateway({ allow: ["isInGuild", "registerGuildCommands"] });
  gateway.joined = new Set(joined);
  gateway.beforeRegister = (guildId) => {
    if (failing.includes(guildId)) throw new Error("Missing Access");
  };
  return gateway;
}

type CommandInteraction = Extract<Interaction, { kind: "command" }>;
type ButtonInteraction = Extract<Interaction, { kind: "button" }>;

const BASE = { guildId: "guild-1", channelId: "channel-1", userId: "owner-1", createdAt: CREATED_AT };

function command(name: string, overrides: Partial<CommandInteraction> = {}): CommandInteraction {
  return { ...BASE, kind: "command", name, options: {}, ...overrides };
}

function button(customId: string, overrides: Partial<ButtonInteraction> = {}): ButtonInteraction {
  return { ...BASE, kind: "button", customId, ...overrides };
}

function setup(extra: { commands?: CommandHandler[]; components?: ComponentHandler[] } = {}) {
  const logs: string[] = [];
  const handle = createInteractionHandler({
    cfg,
    commands: [...COMMANDS, ...(extra.commands ?? [])],
    components: extra.components ?? [],
    log: (line) => logs.push(line),
  });
  return { logs, handle };
}

function failingCommand(name: string, before: (responder: InteractionResponder) => Promise<void>): CommandHandler {
  return {
    def: { name, description: "テスト用" },
    async handle(_interaction, responder) {
      await before(responder);
      throw new Error("boom");
    },
  };
}

test("/help は静的な案内を ephemeral で返す（許可リストにある別のサーバーでも）", async () => {
  const { logs, handle } = setup();

  for (const guildId of ["guild-1", "guild-9"]) {
    const responder = new FakeResponder();
    await handle(command("help", { guildId }), responder);
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: HELP_TEXT, ephemeral: true } }], guildId);
  }
  assert.deepEqual(logs, []);
});

test("HELP_TEXT は登録コマンドを全部説明している", (t) => {
  const stores = createStores(tempDb(t), () => CREATED_AT);
  const log = (): void => {};
  // コマンドの定義だけを見るので、どの処理も呼ばれない
  const commands = createCommands({
    cfg: { timeZone: "Asia/Tokyo", publicBaseUrl: undefined },
    gateway: new FakeGateway(),
    guildSettings: stores.guildSettings,
    topicSessions: stores.topicSessions,
    queue: new KeyedSerialQueue(1),
    channelOps: new RecordingChannelOps(),
    tasks: stores.tasks,
    usage: stores.usage,
    projects: stores.projects,
    projectsDir: join(tmpdir(), "self-agent-test-projects-unused"),
    turnQueue: new KeyedSerialQueue(1),
    turn: { ...stores, runner: { run: async () => assert.fail("想定外の呼び出し") }, log },
    inboxRotator: { rotateNow: async () => assert.fail("想定外の呼び出し") },
    log,
  });

  const lines = HELP_TEXT.split("\n");
  for (const { def } of commands) {
    assert.ok(lines.some((line) => line.startsWith(`\`/${def.name}\``) || line.startsWith(`\`/${def.name} `)), def.name);
  }
});

test("許可サーバーでもオーナー以外には ephemeral で「オーナー専用です」と返し、処理しない", async () => {
  let called = 0;
  const { handle } = setup({
    components: [
      {
        namespace: "test",
        async handle() {
          called++;
        },
      },
    ],
  });

  for (const interaction of [command("help", { userId: "someone-else" }), button("test:go:1", { userId: "someone-else" })]) {
    const responder = new FakeResponder();
    await handle(interaction, responder);
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: OWNER_ONLY_REPLY, ephemeral: true } }]);
  }
  assert.equal(called, 0);
});

test("オーナーが未設定なら誰の操作も処理しない", async () => {
  const logs: string[] = [];
  const handle = createInteractionHandler({
    cfg: { ...cfg, ownerUserId: undefined },
    commands: COMMANDS,
    components: [],
    log: (line) => logs.push(line),
  });
  const responder = new FakeResponder();

  await handle(command("help"), responder);

  assert.deepEqual(responder.calls, [{ method: "reply", message: { text: OWNER_ONLY_REPLY, ephemeral: true } }]);
});

test("DM・許可していないサーバーからの操作には応答せず、log だけ出す", async () => {
  const { logs, handle } = setup();

  for (const guildId of [null, "guild-2"]) {
    const responder = new FakeResponder();
    await handle(command("help", { guildId }), responder);
    await handle(button("test:go:1", { guildId }), responder);
    assert.deepEqual(responder.calls, [], String(guildId));
  }
  assert.equal(logs.length, 4);
  for (const line of logs) assert.match(line, /無視しました/);
});

test("未知のコマンド・customId は log に出して ephemeral で「不明な操作です」と返す（log に channelId は出さない）", async () => {
  const { logs, handle } = setup();
  const interactions: Interaction[] = [
    command("nope"),
    button("zzz:go:123456"),
    { ...BASE, kind: "select", customId: "zzz:pick:123456", values: ["1"] },
    { ...BASE, kind: "modal", customId: "zzz:new", fields: { title: "題名" } },
  ];

  for (const interaction of interactions) {
    const responder = new FakeResponder();
    await handle(interaction, responder);
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: UNKNOWN_REPLY, ephemeral: true } }], interaction.kind);
  }
  assert.equal(logs.length, 4);
  for (const line of logs) assert.ok(!line.includes("123456") && !line.includes("channel-1"), line);
});

test("customId は名前空間でハンドラに振り分ける", async () => {
  const received: Interaction[] = [];
  const { handle } = setup({
    components: [
      { namespace: "a", handle: async () => assert.fail("別の名前空間に渡った") },
      {
        namespace: "ab",
        async handle(interaction, responder) {
          received.push(interaction);
          await responder.update({ text: "更新しました", components: [] });
        },
      },
    ],
  });
  const responder = new FakeResponder();

  await handle(button("ab:go:123"), responder);

  assert.deepEqual(received, [button("ab:go:123")]);
  assert.deepEqual(responder.calls, [{ method: "update", message: { text: "更新しました", components: [] } }]);
});

test("ハンドラが例外を投げたら log に出し、未応答・defer・deferUpdate だけ済んでいるなら「処理に失敗しました」で応答する", async () => {
  const cases: Array<{ label: string; interaction: Interaction; before: (responder: InteractionResponder) => Promise<void>; head: unknown[] }> = [
    { label: "未応答", interaction: command("broken"), before: async () => {}, head: [] },
    {
      // 保留中の応答を埋める
      label: "defer",
      interaction: command("broken"),
      before: (responder) => responder.defer(true),
      head: [{ method: "defer", ephemeral: true }],
    },
    {
      label: "deferUpdate",
      interaction: button("broken:go:1"),
      before: (responder) => responder.deferUpdate(),
      head: [{ method: "deferUpdate" }],
    },
  ];

  for (const { label, interaction, before, head } of cases) {
    const { logs, handle } = setup({
      commands: [failingCommand("broken", before)],
      components: [
        {
          namespace: "broken",
          async handle(_interaction, responder) {
            await before(responder);
            throw new Error("boom");
          },
        },
      ],
    });
    const responder = new FakeResponder();

    await handle(interaction, responder);

    assert.deepEqual(
      responder.calls,
      [...head, { method: "reply", message: { text: INTERACTION_FAILURE_REPLY, ephemeral: true } }],
      label,
    );
    assert.equal(logs.length, 1, label);
    assert.match(logs[0]!, /boom/, label);
  }
});

test("応答済みのあとに例外が出たら追加で送らず、log だけ出す", async () => {
  const { logs, handle } = setup({
    commands: [failingCommand("broken", (responder) => responder.reply({ text: "途中まで", ephemeral: true }))],
  });
  const responder = new FakeResponder();

  await handle(command("broken"), responder);

  assert.deepEqual(responder.calls, [{ method: "reply", message: { text: "途中まで", ephemeral: true } }]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /boom/);
});

test("失敗の返信まで失敗しても reject せず log に出す", async () => {
  const { logs, handle } = setup({ commands: [failingCommand("broken", async () => {})] });
  const responder = new FakeResponder();
  responder.beforeReply = () => {
    throw new Error("Unknown interaction");
  };

  await handle(command("broken"), responder);

  assert.deepEqual(responder.calls, []);
  assert.equal(logs.length, 2);
  assert.match(logs[0]!, /boom/);
  assert.match(logs[1]!, /応答に失敗しました: Unknown interaction/);
});

test("起動時の登録は許可サーバーのうち参加しているものだけに行い、参加していなければ log を出してスキップする", async () => {
  const gateway = fakeGateway(["guild-1", "guild-other"]);
  const logs: string[] = [];

  await registerCommands({ cfg, gateway, commands: COMMANDS, log: (line) => logs.push(line) });

  assert.deepEqual(gateway.registered, [{ guildId: "guild-1", defs: COMMANDS.map((c) => c.def) }]);
  assert.deepEqual(
    gateway.registered[0]!.defs.map((def) => def.name),
    ["help"],
  );
  assert.equal(logs.length, 2);
  assert.match(logs[0]!, /登録しました（guild=guild-1/);
  assert.match(logs[1]!, /スキップしました（guild=guild-9）/);
});

test("1 つのサーバーで登録に失敗しても log に出して残りを続ける", async () => {
  const gateway = fakeGateway(["guild-1", "guild-9"], ["guild-1"]);
  const logs: string[] = [];

  await registerCommands({ cfg, gateway, commands: COMMANDS, log: (line) => logs.push(line) });

  assert.deepEqual(
    gateway.registered.map((entry) => entry.guildId),
    ["guild-9"],
  );
  assert.match(logs[0]!, /登録に失敗しました（guild=guild-1）: Missing Access/);
});
