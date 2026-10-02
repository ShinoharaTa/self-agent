import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_TEXT, helpCommand } from "../src/app/commands/help.ts";
import {
  createInteractionHandler,
  INTERACTION_FAILURE_REPLY,
  OWNER_ONLY_REPLY,
  registerCommands,
  UNKNOWN_REPLY,
  type CommandHandler,
  type ComponentHandler,
} from "../src/app/interactions.ts";
import type {
  CommandDef,
  Gateway,
  Interaction,
  InteractionResponder,
  ModalDef,
  OutgoingMessage,
} from "../src/discord/gateway.ts";

const cfg = { allowedGuildIds: ["guild-1", "guild-9"], ownerUserId: "owner-1" };
// 振り分けと登録の仕組みを見るので、依存の無い /help だけで足りる（/setup は setup.test.ts）
const COMMANDS: CommandHandler[] = [helpCommand];
const CREATED_AT = new Date("2026-10-02T00:12:00Z");

type ResponderCall =
  | { method: "defer"; ephemeral: boolean }
  | { method: "deferUpdate" }
  | { method: "reply" | "update"; message: OutgoingMessage }
  | { method: "showModal"; modal: ModalDef };

class FakeResponder implements InteractionResponder {
  calls: ResponderCall[] = [];
  /** reply の直前に呼ばれる。投げればその応答は失敗する */
  beforeReply: () => void = () => {};

  async defer(ephemeral: boolean): Promise<void> {
    this.calls.push({ method: "defer", ephemeral });
  }
  async deferUpdate(): Promise<void> {
    this.calls.push({ method: "deferUpdate" });
  }
  async reply(message: OutgoingMessage): Promise<void> {
    this.beforeReply();
    this.calls.push({ method: "reply", message });
  }
  async update(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "update", message });
  }
  async showModal(modal: ModalDef): Promise<void> {
    this.calls.push({ method: "showModal", modal });
  }
}

class FakeGateway implements Pick<Gateway, "isInGuild" | "registerGuildCommands"> {
  registered: Array<{ guildId: string; defs: readonly CommandDef[] }> = [];
  private readonly joined: readonly string[];
  private readonly failing: readonly string[];

  constructor(joined: readonly string[], failing: readonly string[] = []) {
    this.joined = joined;
    this.failing = failing;
  }

  isInGuild(guildId: string): boolean {
    return this.joined.includes(guildId);
  }
  async registerGuildCommands(guildId: string, defs: readonly CommandDef[]): Promise<void> {
    if (this.failing.includes(guildId)) throw new Error("Missing Access");
    this.registered.push({ guildId, defs });
  }
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

test("/help は静的な案内を ephemeral で返す", async () => {
  const { logs, handle } = setup();
  const responder = new FakeResponder();

  await handle(command("help"), responder);

  assert.deepEqual(responder.calls, [{ method: "reply", message: { text: HELP_TEXT, ephemeral: true } }]);
  assert.deepEqual(logs, []);
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

test("許可リストにある別のサーバーでも処理する", async () => {
  const { handle } = setup();
  const responder = new FakeResponder();

  await handle(command("help", { guildId: "guild-9" }), responder);

  assert.deepEqual(responder.calls, [{ method: "reply", message: { text: HELP_TEXT, ephemeral: true } }]);
});

test("未知のコマンドは log に出して ephemeral で「不明な操作です」と返す", async () => {
  const { logs, handle } = setup();
  const responder = new FakeResponder();

  await handle(command("nope"), responder);

  assert.deepEqual(responder.calls, [{ method: "reply", message: { text: UNKNOWN_REPLY, ephemeral: true } }]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /不明なコマンドです（\/nope）/);
});

test("未知の customId は log に出して ephemeral で「不明な操作です」と返す（log に channelId は出さない）", async () => {
  const { logs, handle } = setup();
  const interactions: Interaction[] = [
    button("zzz:go:123456"),
    { ...BASE, kind: "select", customId: "zzz:pick:123456", values: ["1"] },
    { ...BASE, kind: "modal", customId: "zzz:new", fields: { title: "題名" } },
  ];

  for (const interaction of interactions) {
    const responder = new FakeResponder();
    await handle(interaction, responder);
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: UNKNOWN_REPLY, ephemeral: true } }]);
  }
  assert.deepEqual(logs, ["不明な操作です（button zzz）", "不明な操作です（select zzz）", "不明な操作です（modal zzz）"]);
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

test("ハンドラが未応答のまま例外を投げたら log に出し、ephemeral で「処理に失敗しました」と返す", async () => {
  const { logs, handle } = setup({ commands: [failingCommand("broken", async () => {})] });
  const responder = new FakeResponder();

  await handle(command("broken"), responder);

  assert.deepEqual(responder.calls, [{ method: "reply", message: { text: INTERACTION_FAILURE_REPLY, ephemeral: true } }]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /\/broken.*boom/);
});

test("defer だけ済んでいれば、保留中の応答を「処理に失敗しました」で埋める", async () => {
  const { handle } = setup({ commands: [failingCommand("broken", (responder) => responder.defer(true))] });
  const responder = new FakeResponder();

  await handle(command("broken"), responder);

  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: INTERACTION_FAILURE_REPLY, ephemeral: true } },
  ]);
});

test("deferUpdate だけ済んでいれば、ephemeral で「処理に失敗しました」と返す", async () => {
  const { handle } = setup({
    components: [
      {
        namespace: "broken",
        async handle(_interaction, responder) {
          await responder.deferUpdate();
          throw new Error("boom");
        },
      },
    ],
  });
  const responder = new FakeResponder();

  await handle(button("broken:go:1"), responder);

  assert.deepEqual(responder.calls, [
    { method: "deferUpdate" },
    { method: "reply", message: { text: INTERACTION_FAILURE_REPLY, ephemeral: true } },
  ]);
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
  const gateway = new FakeGateway(["guild-1", "guild-other"]);
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
  const gateway = new FakeGateway(["guild-1", "guild-9"], ["guild-1"]);
  const logs: string[] = [];

  await registerCommands({ cfg, gateway, commands: COMMANDS, log: (line) => logs.push(line) });

  assert.deepEqual(
    gateway.registered.map((entry) => entry.guildId),
    ["guild-9"],
  );
  assert.match(logs[0]!, /登録に失敗しました（guild=guild-1）: Missing Access/);
});
