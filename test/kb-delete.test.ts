import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_TEXT } from "../src/app/commands/delete.ts";
import {
  createConfirmKbDelete,
  createKbDeleteComponent,
  KB_KEPT_TEXT,
  kbDeletedText,
  kbDeletePrompt,
} from "../src/app/commands/kb-delete.ts";
import type { Interaction, InteractionResponder, ModalDef, OutgoingMessage } from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { KnowledgeStore } from "../src/store/knowledge.ts";

const NOW = new Date("2026-10-07T00:00:00.000Z");

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

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const knowledge = new KnowledgeStore(db, () => NOW);
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

test("確認の投稿: 「<題名>（#id）を削除しますか？」と [削除する]（kb:del:<id>）[やめる]（kb:keep:<id>）。run のチャンネルに投稿する", async () => {
  const prompt = kbDeletePrompt({ id: 12, title: "SQLite の全文検索" });
  assert.deepEqual(prompt, {
    text: "SQLite の全文検索（#12）を削除しますか？",
    components: [
      {
        kind: "buttons",
        buttons: [
          { customId: "kb:del:12", label: "削除する", style: "danger" },
          { customId: "kb:keep:12", label: "やめる" },
        ],
      },
    ],
  });

  const sent: Array<[string, OutgoingMessage]> = [];
  const confirm = createConfirmKbDelete({
    gateway: {
      sendMessage: async (channelId, message) => {
        sent.push([channelId, message]);
        return "message-1";
      },
    },
  });
  await confirm({ id: 12, title: "SQLite の全文検索" }, { guildId: "guild-1", channelId: "topic-1" });
  assert.deepEqual(sent, [["topic-1", prompt]]);

  // 投稿に失敗したら投げる
  const failing = createConfirmKbDelete({
    gateway: {
      sendMessage: async () => {
        throw new Error("Missing Access");
      },
    },
  });
  await assert.rejects(failing({ id: 12, title: "t" }, { guildId: "guild-1", channelId: "topic-1" }), /Missing Access/);
});

test("[削除する]: 項目を消し、確認メッセージを「<題名>（#id）を削除しました」に書き換えてボタンを外す。log に題名は出さない", async (t) => {
  const { knowledge, logs, run } = setup(t);

  assert.deepEqual(await run(press("kb:del:1")), [
    { method: "update", message: { text: "SQLite の全文検索（#1）を削除しました", components: [] } },
  ]);
  assert.equal(kbDeletedText({ id: 1, title: "SQLite の全文検索" }), "SQLite の全文検索（#1）を削除しました");
  assert.equal(knowledge.get(1), undefined);
  // 検索にも出ない（FTS も消える）
  assert.deepEqual(
    knowledge.search("全文検索").entries.map((entry) => entry.id),
    [],
  );
  assert.ok(knowledge.get(2) !== undefined);
  assert.deepEqual(logs, ["[削除する] でナレッジベースの項目を削除しました"]);
});

test("[やめる]: 何も消さず「やめました」に書き換えてボタンを外す", async (t) => {
  const { knowledge, logs, run } = setup(t);

  assert.deepEqual(await run(press("kb:keep:1")), [
    { method: "update", message: { text: KB_KEPT_TEXT, components: [] } },
  ]);
  assert.equal(KB_KEPT_TEXT, "やめました");
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
  assert.ok(STALE_TEXT.includes("古くなっています"));
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
