import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryToolHandlers } from "../src/agent/tools.ts";
import {
  createMemoryUndoComponent,
  createNotifyMemoryChange,
  MEMORY_UNDONE_TEXT,
  memoryNotice,
} from "../src/app/commands/memory-undo.ts";
import type { Interaction, InteractionResponder, ModalDef, OutgoingMessage } from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { MemoryStore } from "../src/store/memories.ts";

const NOW = new Date("2026-10-07T00:00:00.000Z");
const CONTEXT = { guildId: "guild-1", channelId: "topic-1" };

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
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const memories = new MemoryStore(db, () => NOW);
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

const UNDONE = [{ method: "update", message: { text: "（取り消しました）", components: [] } }];

test("知らせ: 記憶したら「（記憶しました: …）」と [取り消す]（mem:undo:<追加した id>:0）を run のチャンネルに投稿する", async (t) => {
  const { sent, tools } = setup(t);

  await tools.memorySave({ text: "住んでいる地域: 東京都練馬区" });

  assert.deepEqual(sent, [
    [
      "topic-1",
      {
        text: "（記憶しました: 住んでいる地域: 東京都練馬区）",
        components: [{ kind: "buttons", buttons: [{ customId: "mem:undo:1:0", label: "取り消す" }] }],
      },
    ],
  ]);
});

test("知らせ: replace_id なら「（記憶しました: 新しい文）」と mem:undo:<新しい id>:<元の id>、忘れたら「（忘れました: …）」と mem:undo:0:<id>", async (t) => {
  const { sent, tools, lastUndo } = setup(t);
  await tools.memorySave({ text: "住んでいる地域: 東京都練馬区" });

  await tools.memorySave({ text: "住んでいる地域: 東京都杉並区", replace_id: 1 });
  assert.equal(sent.at(-1)?.[1].text, "（記憶しました: 住んでいる地域: 東京都杉並区）");
  assert.equal(lastUndo(), "mem:undo:2:1");

  await tools.memoryForget({ id: 2 });
  assert.equal(sent.at(-1)?.[1].text, "（忘れました: 住んでいる地域: 東京都杉並区）");
  assert.equal(lastUndo(), "mem:undo:0:2");
  assert.ok(sent.every(([channelId]) => channelId === "topic-1"));

  // custom_id は 100 字以内に収まる
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

  assert.equal((await tools.memorySave({ text: "a" })).content[0].text, JSON.stringify({ result: "saved", id: 1 }));
  assert.deepEqual(active(), ["a"]);
  assert.equal((await tools.memoryForget({ id: 1 })).content[0].text, JSON.stringify({ result: "forgotten" }));
  assert.deepEqual(active(), []);
  assert.deepEqual(logs, [
    "記憶の変更の知らせの投稿に失敗しました: Missing Access",
    "記憶の変更の知らせの投稿に失敗しました: Missing Access",
  ]);
  // 本文は log に出さない
  assert.ok(logs.every((line) => !line.includes("（記憶しました")));
});

test("[取り消す]（記憶した）: 追加した記憶を論理削除し、知らせを「（取り消しました）」にしてボタンを外す。2 回押しても同じ結果", async (t) => {
  const { tools, run, lastUndo, active, logs } = setup(t);
  await tools.memorySave({ text: "残す" });
  await tools.memorySave({ text: "取り消す" });
  const undo = lastUndo();

  assert.deepEqual(await run(undo), UNDONE);
  assert.deepEqual(active(), ["残す"]);
  assert.deepEqual(await run(undo), UNDONE);
  assert.deepEqual(active(), ["残す"]);
  assert.equal(MEMORY_UNDONE_TEXT, "（取り消しました）");
  // 変えたときだけ log に出す（本文は出さない）
  assert.deepEqual(logs, ["[取り消す] で記憶の変更を取り消しました"]);
});

test("[取り消す]（置き換えた）: 新しい記憶を消して元の記憶を戻す。2 回押しても同じ結果", async (t) => {
  const { tools, run, lastUndo, active } = setup(t);
  await tools.memorySave({ text: "住んでいる地域: 東京都練馬区" });
  await tools.memorySave({ text: "住んでいる地域: 東京都杉並区", replace_id: 1 });
  const undo = lastUndo();

  assert.deepEqual(await run(undo), UNDONE);
  assert.deepEqual(active(), ["住んでいる地域: 東京都練馬区"]);
  assert.deepEqual(await run(undo), UNDONE);
  assert.deepEqual(active(), ["住んでいる地域: 東京都練馬区"]);
});

test("[取り消す]（忘れた）: 消した記憶を戻す。2 回押しても同じ結果で、件数の上限は確かめない", async (t) => {
  const { memories, tools, run, lastUndo, active } = setup(t);
  await tools.memorySave({ text: "戻す" });
  await tools.memoryForget({ id: 1 });
  const undo = lastUndo();
  // 消した後に上限まで記憶していても戻す
  for (let i = 0; i < 20; i++) memories.add(`記憶 ${i}`);

  assert.deepEqual(await run(undo), UNDONE);
  assert.equal(memories.countActive(), 21);
  assert.ok(active().includes("戻す"));
  assert.deepEqual(await run(undo), UNDONE);
  assert.equal(memories.countActive(), 21);
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
