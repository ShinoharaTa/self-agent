import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { STALE_TEXT } from "../src/app/commands/delete.ts";
import {
  createConfirmKbDelete,
  createKbDeleteComponent,
  KB_KEPT_TEXT,
  kbDeletedText,
  kbDeletePrompt,
} from "../src/app/commands/kb-delete.ts";
import type { Interaction, OutgoingMessage } from "../src/discord/gateway.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";

const NOW = new Date("2026-10-07T00:00:00.000Z");

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

/** 1 番目の項目の削除の確認（kbDeletePrompt）のボタンを label で押す（custom_id は確認のものを使う） */
function fromPrompt(label: string): Extract<Interaction, { kind: "button" }> {
  const row = kbDeletePrompt({ id: 1, title: "SQLite の全文検索" }).components?.[0];
  assert.ok(row?.kind === "buttons");
  const button = row.buttons.find((candidate) => candidate.label === label);
  assert.ok(button !== undefined, label);
  return press(button.customId);
}

function setup(t: TestContext) {
  const db = tempDb(t);
  const { knowledge } = createStores(db, () => NOW);
  knowledge.add({ url: "https://example.com/a", urlKey: "https://example.com/a", title: "SQLite の全文検索", summary: "s" });
  knowledge.add({ title: "残る項目", summary: "s" });
  const logs: string[] = [];
  const component = createKbDeleteComponent({ knowledge, log: (line) => logs.push(line) });
  const run = async (interaction: Exclude<Interaction, { kind: "command" }>): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await component.handle(interaction, responder);
    return responder.calls;
  };
  return { knowledge, logs, component, run };
}

test("確認の投稿: 題名と id の確認に [削除する][やめる] を付けて run のチャンネルに投稿する。投稿に失敗したら投げる", async () => {
  const prompt = kbDeletePrompt({ id: 12, title: "SQLite の全文検索" });
  assert.ok(prompt.text.includes("SQLite の全文検索（#12）"));

  const sent: Array<[string, OutgoingMessage]> = [];
  const confirm = createConfirmKbDelete({
    gateway: {
      sendMessage: async (channelId, message) => {
        sent.push([channelId, message]);
        return "message-1";
      },
    },
  });
  await confirm({ id: 12, title: "SQLite の全文検索" }, { guildId: "guild-1", channelId: "topic-1", kind: "session" });
  assert.deepEqual(sent, [["topic-1", prompt]]);

  // 投稿に失敗したら投げる
  const failing = createConfirmKbDelete({
    gateway: {
      sendMessage: async () => {
        throw new Error("Missing Access");
      },
    },
  });
  await assert.rejects(
    failing({ id: 12, title: "t" }, { guildId: "guild-1", channelId: "topic-1", kind: "session" }),
    /Missing Access/,
  );
});

test("[削除する]: 項目を消し、確認メッセージを「<題名>（#id）を削除しました」に書き換えてボタンを外す。log に題名は出さない", async (t) => {
  const { knowledge, logs, run } = setup(t);

  assert.deepEqual(await run(fromPrompt("削除する")), [
    { method: "update", message: { text: kbDeletedText({ id: 1, title: "SQLite の全文検索" }), components: [] } },
  ]);
  assert.equal(knowledge.get(1), undefined);
  // 検索にも出ない（FTS も消える）
  assert.deepEqual(
    knowledge.search("全文検索").entries.map((entry) => entry.id),
    [],
  );
  assert.ok(knowledge.get(2) !== undefined);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0]!.includes("SQLite"));
});

test("[やめる]: 何も消さず「やめました」に書き換えてボタンを外す", async (t) => {
  const { knowledge, logs, run } = setup(t);

  assert.deepEqual(await run(fromPrompt("やめる")), [
    { method: "update", message: { text: KB_KEPT_TEXT, components: [] } },
  ]);
  assert.ok(knowledge.get(1) !== undefined);
  assert.deepEqual(logs, []);
});

test("既に無い項目（削除済み・2 回目の [削除する]・知らない id）は何もせず「古くなっています」にする", async (t) => {
  const { knowledge, run } = setup(t);
  await run(press("kb:del:1"));

  const stale = [{ method: "update", message: { text: STALE_TEXT, components: [] } }];
  assert.deepEqual(await run(press("kb:del:1")), stale);
  assert.deepEqual(await run(press("kb:keep:1")), stale);
  assert.deepEqual(await run(press("kb:del:99")), stale);
  assert.ok(knowledge.get(2) !== undefined);
});

test("kb の不明な操作（id 無し・数でない id・知らない action・セレクト）は例外にする", async (t) => {
  const { component, knowledge } = setup(t);
  const responder = new FakeResponder();

  for (const customId of ["kb:del", "kb:del:", "kb:del:abc", "kb:del:0", "kb:del:-1", "kb:del:1.5", "kb:open:1"]) {
    await assert.rejects(component.handle(press(customId), responder), Error, customId);
  }
  await assert.rejects(
    component.handle(
      { kind: "select", customId: "kb:del:1", values: ["1"], guildId: "guild-1", channelId: "topic-1", userId: "owner-1", createdAt: NOW },
      responder,
    ),
  );
  assert.deepEqual(responder.calls, []);
  assert.ok(knowledge.get(1) !== undefined);
  assert.equal(component.namespace, "kb");
});
