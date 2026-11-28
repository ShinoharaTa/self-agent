import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalGateway } from "../src/discord/local-gateway.ts";
import { LocalIdStore } from "../src/store/local-places.ts";
import { tempDb } from "./helpers/db.ts";

const MESSAGE = { text: "こんにちは" };

test("LocalGateway.sendMessage: 毎回違う数字 21 桁（先頭が 1）を返す", async (t) => {
  const gateway = new LocalGateway(new LocalIdStore(tempDb(t)));
  const ids = [
    await gateway.sendMessage("100000000000000000001", MESSAGE),
    await gateway.sendMessage("100000000000000000001", MESSAGE),
    await gateway.sendMessage("100000000000000000002", { text: "ボタン付き", components: [] }),
  ];
  for (const id of ids) assert.match(id, /^1\d{20}$/);
  assert.equal(new Set(ids).size, ids.length);
});

test("LocalGateway.send: 投げずに解決し、連番を進めない（後の sendMessage は send を挟まないときと同じ続き番号）", async (t) => {
  const withSend = new LocalGateway(new LocalIdStore(tempDb(t)));
  const withoutSend = new LocalGateway(new LocalIdStore(tempDb(t)));
  await withSend.sendMessage("channel", MESSAGE);
  await withoutSend.sendMessage("channel", MESSAGE);
  assert.equal(await withSend.send("channel", "長い本文", "reply-to", "user"), undefined);
  await withSend.send("channel", "もう一度");
  assert.equal(await withSend.sendMessage("channel", MESSAGE), await withoutSend.sendMessage("channel", MESSAGE));
});

test("LocalGateway: 開始・終了・編集・ピン・リアクション・入力中は投げずに何もせず、messageExists・channelExists は true", async (t) => {
  const db = tempDb(t);
  const gateway = new LocalGateway(new LocalIdStore(db));
  await gateway.start({ onMessage: () => {}, onInteraction: () => {} });
  await gateway.editMessage("channel", "message", { text: "書き換え", components: [] });
  await gateway.pinMessage("channel", "message");
  await gateway.addReaction("channel", "message", "✅");
  await gateway.removeOwnReaction("channel", "message", "✅");
  const stopTyping = gateway.startTyping("channel");
  assert.equal(typeof stopTyping, "function");
  stopTyping();
  assert.equal(await gateway.messageExists("channel", "message"), true);
  assert.equal(await gateway.channelExists("channel"), true);
  await gateway.stop();
  // 何もしない操作は番号も取らない
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'local_ids'").get(), undefined);
});

test("LocalGateway: Discord のサーバーの形に触る操作は、それぞれ投げる（文にメソッド名だけを入れ、ID・本文は入れない）", async (t) => {
  const gateway = new LocalGateway(new LocalIdStore(tempDb(t)));
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["registerGuildCommands", () => gateway.registerGuildCommands("guild-9", [{ name: "help", description: "使い方" }])],
    ["createCategory", () => gateway.createCategory("guild-9", "カテゴリ名")],
    ["createTextChannel", () => gateway.createTextChannel("guild-9", { name: "話題名", parentId: "parent-9", topic: "トピック" })],
    ["setChannelTopic", () => gateway.setChannelTopic("channel-9", "トピック")],
    ["countChannelsIn", () => gateway.countChannelsIn("parent-9")],
    ["listChannelParents", () => gateway.listChannelParents("guild-9")],
    ["moveChannel", () => gateway.moveChannel("channel-9", "parent-9")],
    ["getParentId", () => gateway.getParentId("channel-9")],
    ["deleteChannel", () => gateway.deleteChannel("channel-9")],
  ];
  for (const [method, call] of calls) {
    await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `ローカルの場所では Discord の管理の操作を呼べません: ${method}`);
      return true;
    });
  }
  // isInGuild は型が同期なので、その場で投げる
  assert.throws(() => gateway.isInGuild("guild-9"), {
    message: "ローカルの場所では Discord の管理の操作を呼べません: isInGuild",
  });
});
