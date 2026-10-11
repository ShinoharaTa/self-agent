import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { RunContext } from "../src/agent/runner.ts";
import { createMemoryToolHandlers } from "../src/agent/tools.ts";
import {
  createMemoryUndoComponent,
  createNotifyMemoryChange,
  MEMORY_UNDONE_TEXT,
  memoryNotice,
} from "../src/app/commands/memory-undo.ts";
import type { Interaction, OutgoingMessage } from "../src/discord/gateway.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";

const NOW = new Date("2026-10-07T00:00:00.000Z");
const CONTEXT: RunContext = { guildId: "guild-1", channelId: "topic-1", kind: "session" };

function press(customId: string): Extract<Interaction, { kind: "button" }> {
  return {
    kind: "button",
    customId,
    guildId: "guild-1",
    channelId: "topic-1",
    userId: "owner-1",
    createdAt: NOW,
    messageId: "message-1",
  };
}

/** 記憶のツールを、知らせを実際の投稿の形（memoryNotice）で受ける偽 Gateway につなぐ */
function setup(t: TestContext) {
  const db = tempDb(t);
  const { memories } = createStores(db, () => NOW);
  const sent: Array<[string, OutgoingMessage]> = [];
  const gateway = {
    beforeSend: (): void => {},
    sendMessage: async (channelId: string, message: OutgoingMessage): Promise<string> => {
      gateway.beforeSend();
      sent.push([channelId, message]);
      return `message-${sent.length}`;
    },
  };
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const tools = createMemoryToolHandlers(
    { memories, notifyMemoryChange: createNotifyMemoryChange({ gateway, log }) },
    CONTEXT,
  );
  const component = createMemoryUndoComponent({ memories, log });
  const run = async (customId: string): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await component.handle(press(customId), responder);
    return responder.calls;
  };
  /** 最後に投稿した知らせの [取り消す] の custom_id */
  const lastUndo = (): string => {
    const message = sent.at(-1)?.[1];
    const row = message?.components?.[0];
    assert.ok(row?.kind === "buttons");
    return row.buttons[0]!.customId;
  };
  const active = (): string[] => memories.list().map((memory) => memory.text);
  return { memories, gateway, sent, logs, tools, component, run, lastUndo, active };
}

const UNDONE = [{ method: "update", message: { text: MEMORY_UNDONE_TEXT, components: [] } }];

test("知らせ: 記憶した・置き換えた・忘れたら、run のチャンネルに変えた記憶の文と [取り消す] を投稿する（custom_id は 100 字以内）", async (t) => {
  const { sent, tools } = setup(t);

  await tools.memorySave({ text: "住んでいる地域: 東京都練馬区" });
  await tools.memorySave({ text: "住んでいる地域: 東京都杉並区", replace_id: 1 });
  await tools.memoryForget({ id: 2 });

  assert.equal(sent.length, 3);
  assert.ok(sent.every(([channelId]) => channelId === "topic-1"));
  const texts = sent.map(([, message]) => message.text);
  assert.ok(texts[0]!.includes("住んでいる地域: 東京都練馬区"));
  assert.ok(texts[1]!.includes("住んでいる地域: 東京都杉並区"));
  assert.ok(texts[2]!.includes("住んでいる地域: 東京都杉並区"));
  assert.notEqual(texts[2], texts[1]);
  for (const [, message] of sent) {
    const row = message.components?.[0];
    assert.ok(row?.kind === "buttons" && row.buttons.length === 1);
  }

  // 大きな id でも custom_id は 100 字以内に収まる
  const notice = memoryNotice({
    kind: "saved",
    added: { id: 2 ** 31, text: "a", channelId: null, createdAt: "", deletedAt: null },
    removed: { id: 2 ** 31 - 1, text: "b", channelId: null, createdAt: "", deletedAt: "" },
  });
  const row = notice.components?.[0];
  assert.ok(row?.kind === "buttons" && row.buttons[0]!.customId.length <= 100);
});

test("知らせの投稿に失敗しても記憶の変更は残し、log に出して saved・forgotten を返す", async (t) => {
  const { gateway, logs, tools, active } = setup(t);
  gateway.beforeSend = () => {
    throw new Error("Missing Access");
  };

  assert.equal((await tools.memorySave({ text: "住所は練馬区" })).content[0].text, JSON.stringify({ result: "saved", id: 1 }));
  assert.deepEqual(active(), ["住所は練馬区"]);
  assert.equal((await tools.memoryForget({ id: 1 })).content[0].text, JSON.stringify({ result: "forgotten" }));
  assert.deepEqual(active(), []);
  assert.equal(logs.length, 2);
  // 本文は log に出さない
  for (const line of logs) assert.ok(!line.includes("練馬区"), line);
});

test("[取り消す]: 記憶した・置き換えた・忘れた変更を戻し、知らせを「（取り消しました）」にしてボタンを外す。2 回押しても同じ結果", async (t) => {
  const cases: Array<{
    label: string;
    change: (env: ReturnType<typeof setup>) => Promise<void>;
    expected: (env: ReturnType<typeof setup>) => void;
  }> = [
    {
      // 追加した記憶を論理削除する
      label: "記憶した",
      change: async ({ tools }) => {
        await tools.memorySave({ text: "残す" });
        await tools.memorySave({ text: "取り消す" });
      },
      expected: ({ active }) => assert.deepEqual(active(), ["残す"]),
    },
    {
      // 新しい記憶を消して元の記憶を戻す
      label: "置き換えた",
      change: async ({ tools }) => {
        await tools.memorySave({ text: "住んでいる地域: 東京都練馬区" });
        await tools.memorySave({ text: "住んでいる地域: 東京都杉並区", replace_id: 1 });
      },
      expected: ({ active }) => assert.deepEqual(active(), ["住んでいる地域: 東京都練馬区"]),
    },
    {
      // 消した後に上限まで記憶していても戻す（件数の上限は確かめない）
      label: "忘れた",
      change: async ({ memories, tools }) => {
        await tools.memorySave({ text: "戻す" });
        await tools.memoryForget({ id: 1 });
        for (let i = 0; i < 20; i++) memories.add(`記憶 ${i}`);
      },
      expected: ({ memories, active }) => {
        assert.equal(memories.countActive(), 21);
        assert.ok(active().includes("戻す"));
      },
    },
  ];

  for (const { label, change, expected } of cases) {
    const env = setup(t);
    await change(env);
    const undo = env.lastUndo();

    assert.deepEqual(await env.run(undo), UNDONE, label);
    expected(env);
    assert.deepEqual(await env.run(undo), UNDONE, label);
    expected(env);
    // 変えたときだけ log に出す
    assert.equal(env.logs.length, 1, label);
  }
});

test("[取り消す]: 既に消えている記憶・知らない id でも何も変えずに「（取り消しました）」にする", async (t) => {
  const { tools, run, active, logs } = setup(t);
  await tools.memorySave({ text: "a" });

  assert.deepEqual(await run("mem:undo:99:0"), UNDONE);
  assert.deepEqual(await run("mem:undo:0:99"), UNDONE);
  // 有効な記憶を「消した側」に指定しても何も変えない
  assert.deepEqual(await run("mem:undo:0:1"), UNDONE);
  assert.deepEqual(active(), ["a"]);
  assert.deepEqual(logs, []);
});

test("mem の不明な操作（id 無し・数でない id・両方 0・知らない action・セレクト）は例外にする", async (t) => {
  const { component, active, tools } = setup(t);
  await tools.memorySave({ text: "a" });
  const responder = new FakeResponder();

  for (const customId of ["mem:undo", "mem:undo:1", "mem:undo:1:", "mem:undo:a:0", "mem:undo:-1:0", "mem:undo:0:0", "mem:redo:1:0"]) {
    await assert.rejects(component.handle(press(customId), responder), Error, customId);
  }
  await assert.rejects(
    component.handle(
      { kind: "select", customId: "mem:undo:1:0", values: ["1"], guildId: "guild-1", channelId: "topic-1", userId: "owner-1", createdAt: NOW },
      responder,
    ),
  );
  assert.deepEqual(responder.calls, []);
  assert.deepEqual(active(), ["a"]);
  assert.equal(component.namespace, "mem");
});
